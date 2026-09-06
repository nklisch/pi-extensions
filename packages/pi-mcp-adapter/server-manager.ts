import { isDeepStrictEqual } from "node:util";
import { stat } from "node:fs/promises";
import { isTemporarilyUnavailable } from "./server-availability.ts";
import {
  Client,
  SdkHttpError,
  SdkError,
  SdkErrorCode,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type GetPromptResult,
  type ReadResourceResult,
  type RequestOptions,
  type UrlElicitationRequiredError,
  type VersionNegotiationOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { UnixSocketClientTransport } from "./unix-socket-transport.ts";
import { probeMcpEndpoint } from "./mcp-probe.ts";
import {
  isServerDisabled,
  type McpTool,
  type McpResource,
  type McpPrompt,
  type ServerDefinition,
  type ServerStreamResultPatchNotification,
  type Transport,
  type McpTraceSettings,
  SERVER_STREAM_RESULT_PATCH_METHOD,
  serverStreamResultPatchNotificationSchema,
} from "./types.ts";
import { resolveNpxBinary } from "./npx-resolver.ts";
import { createJsonSchemaValidator } from "./json-schema-validator.ts";
import { logger } from "./logger.ts";
import { McpOAuthProvider } from "./mcp-oauth-provider.ts";
import { extractOAuthConfig, supportsOAuth, type McpOAuthRuntime } from "./mcp-auth-flow.ts";
import { inspectAuthForUrl, type AuthStorageOptions } from "./mcp-auth.ts";
import { registerSamplingHandler, type ServerSamplingConfig } from "./sampling-handler.ts";
import {
  handleUrlElicitation,
  registerElicitationHandler,
  type ServerElicitationConfig,
} from "./elicitation-handler.ts";
import {
  resolveBearerToken,
  resolveCommandSecret,
  resolveCommandSecretsRecord,
  resolveConfigPath,
  resolveServerUrl,
  formatTerminalError,
  invokeContainedCallback,
  truncateAtWord,
} from "./utils.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import {
  createMcpTraceWriter,
  isMcpTraceEnabled,
  McpTraceWriter,
  type McpTraceObserver,
  traceTransportKind,
  wrapTransportWithMcpTrace,
} from "./mcp-trace.ts";

const MAX_CAPTURED_STDERR_BYTES = 8 * 1024;
const MAX_CAPTURED_STDERR_LINES = 3;
const abortCleanupPromises = new WeakMap<object, Promise<void>>();

type HttpAuthProviderState =
  | { status: "disabled" }
  | { status: "implicit-deferred" }
  | { status: "explicit"; provider: McpOAuthProvider }
  | { status: "implicit-challenged"; provider: McpOAuthProvider };

function isUnauthorizedHttpError(error: unknown): boolean {
  return error instanceof UnauthorizedError || (error instanceof SdkHttpError && error.status === 401);
}

function shouldFallbackToSse(error: unknown, definition: ServerDefinition): boolean {
  if (definition.protocolVersion === "2026-07-28") return false;
  return error instanceof SdkHttpError && [404, 405, 406, 415].includes(error.status);
}

function resolveVersionNegotiation(definition: ServerDefinition): VersionNegotiationOptions | undefined {
  switch (definition.protocolVersion) {
    case undefined:
    case "legacy":
      return undefined;
    case "auto":
      return { mode: "auto" };
    case "2026-07-28":
      return { mode: { pin: "2026-07-28" } };
    default:
      throw new Error(`Invalid MCP protocolVersion: ${String(definition.protocolVersion)}`);
  }
}

function boundedStderrChunk(chunk: Buffer | string): Buffer {
  if (Buffer.isBuffer(chunk)) {
    const start = Math.max(0, chunk.byteLength - MAX_CAPTURED_STDERR_BYTES);
    return Buffer.from(chunk.subarray(start));
  }

  // Limit string conversion before encoding; Buffer.from(largeString) would
  // otherwise allocate the entire stderr event before applying the cap.
  const suffix = chunk.length > MAX_CAPTURED_STDERR_BYTES
    ? chunk.slice(-MAX_CAPTURED_STDERR_BYTES)
    : chunk;
  const bytes = Buffer.from(suffix, "utf8");
  return bytes.byteLength > MAX_CAPTURED_STDERR_BYTES
    ? Buffer.from(bytes.subarray(bytes.byteLength - MAX_CAPTURED_STDERR_BYTES))
    : bytes;
}

function appendStderrTail(tail: Buffer, chunk: Buffer | string): Buffer {
  const bytes = boundedStderrChunk(chunk);
  if (bytes.length === 0) return tail;
  if (tail.length === 0) return bytes;
  const combined = Buffer.concat([tail, bytes]);
  return combined.length > MAX_CAPTURED_STDERR_BYTES
    ? Buffer.from(combined.subarray(combined.length - MAX_CAPTURED_STDERR_BYTES))
    : combined;
}

export interface ServerConnection {
  client: Client;
  transport: Transport;
  definition: ServerDefinition;
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
  /** True when prompts were advertised but prompts/list failed. */
  promptDiscoveryFailed?: boolean;
  instructions?: string;
  toolListHints?: { ttlMs?: number; cacheScope?: string } | undefined;
  catalogRevision?: number;
  catalogAcquiredAt?: number;
  publicationPending?: boolean;
  listenSubscription?: Awaited<ReturnType<Client["listen"]>>;
  listenPromise?: Promise<void>;
  listenStopped?: boolean;
  listenCatalogStale?: boolean;
  listenRetryAfter?: number;
  listenState?: "active" | "dropped" | "legacy" | "not-listening" | "re-establishing";

  lastUsedAt: number;
  inFlight: number;
  status: "connected" | "closed" | "needs-auth";
}

type UiStreamListener = (serverName: string, notification: ServerStreamResultPatchNotification["params"]) => void;
type MetadataListChangedListener = (serverName: string, reason: string) => void | Promise<void>;

function connectionServerUrl(definition: ServerDefinition, resolved: boolean): string {
  if (!resolved) return resolveServerUrl(definition)!;
  if (typeof definition.url !== "string") throw new Error("Resolved MCP server URL must be a string");
  try {
    new URL(definition.url);
  } catch (error) {
    throw new Error(`Invalid resolved MCP server URL: ${definition.url}`, { cause: error });
  }
  return definition.url;
}

interface ConnectOptions {
  /** Programmatic Streamable HTTP sources must never silently become legacy SSE. */
  allowLegacySseFallback?: boolean;
  /** Secret-free definition retained after launch for request/runtime policy. */
  retainedDefinition?: ServerDefinition;
  /** Programmatic values are callback-resolved and must not consult process.env. */
  values?: "config" | "resolved";
}

export class McpServerManager {
  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, Promise<ServerConnection>>();
  private reconnectPromises = new Map<string, Promise<ServerConnection>>();
  private uiStreamListeners = new Map<string, UiStreamListener>();
  private samplingConfig: ServerSamplingConfig | undefined;
  private metadataListChangedListener: MetadataListChangedListener | undefined;
  private reconnectFailureListener: ((name: string, error: unknown) => void) | undefined;
  private elicitationConfig: ServerElicitationConfig | undefined;
  private authStorageOptions: AuthStorageOptions = {};
  private oauthRuntime: McpOAuthRuntime | undefined;
  private acceptedUrlElicitations = new Map<string, Set<string>>();
  private defaultRequestTimeoutMs: number | undefined;
  private runtimeSignal: AbortSignal | undefined;
  private closePromises = new Map<string, Promise<void>>();
  private closeGenerations = new Map<string, number>();
  private connectAttempts = new Map<string, AbortController>();
  private traceSettings: McpTraceSettings | undefined;
  private traceWriter: McpTraceWriter | undefined;
  private stopped = false;

  /** Default cwd for stdio servers without an explicit config `cwd`. */
  constructor(private readonly defaultCwd?: string) {}

  setSamplingConfig(config: ServerSamplingConfig | undefined): void {
    this.samplingConfig = config;
  }

  setReconnectFailureListener(listener: (name: string, error: unknown) => void): void {
    this.reconnectFailureListener = listener;
  }

  setMetadataListChangedListener(listener: MetadataListChangedListener | undefined): void {
    this.metadataListChangedListener = listener;
  }

  setElicitationConfig(config: ServerElicitationConfig | undefined): void {
    this.elicitationConfig = config;
  }

  setRuntimeSignal(signal: AbortSignal | undefined): void {
    this.runtimeSignal = signal;
  }

  setDefaultRequestTimeoutMs(timeoutMs: number | undefined): void {
    this.defaultRequestTimeoutMs = normalizeRequestTimeoutMs(timeoutMs);
  }

  setTraceConfig(settings: McpTraceSettings | undefined): void {
    this.traceSettings = settings;
  }

  setAuthStorageOptions(options: AuthStorageOptions): void {
    this.authStorageOptions = options;
  }

  setOAuthRuntime(runtime: McpOAuthRuntime): void {
    this.oauthRuntime = runtime;
  }

  getRequestOptions(name: string, signal?: AbortSignal): RequestOptions | undefined {
    const connection = this.connections.get(name);
    return this.buildRequestOptions(connection?.definition, signal);
  }

  private getResolvedRequestTimeoutMs(definition?: ServerDefinition): number | undefined {
    if (definition?.requestTimeoutMs !== undefined) {
      return normalizeRequestTimeoutMs(definition.requestTimeoutMs);
    }
    return this.defaultRequestTimeoutMs;
  }

  private buildRequestOptions(
    definition?: ServerDefinition,
    signal?: AbortSignal,
  ): RequestOptions | undefined {
    const timeout = this.getResolvedRequestTimeoutMs(definition);
    const ownedSignal = combineAbortSignals(this.runtimeSignal, signal);

    if (!ownedSignal && timeout === undefined) {
      return undefined;
    }

    return {
      ...(ownedSignal ? { signal: ownedSignal } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
    };
  }

  async connect(
    name: string,
    definition: ServerDefinition,
    signal?: AbortSignal,
    options: ConnectOptions = {},
  ): Promise<ServerConnection> {
    if (isServerDisabled(definition)) throw new Error(`MCP server "${name}" is disabled`);
    if (this.stopped) throw new Error("MCP server manager is closed");
    const ownedSignal = combineAbortSignals(this.runtimeSignal, signal);
    throwIfAborted(ownedSignal);
    const closing = this.closePromises.get(name);
    if (closing) await abortable(closing, ownedSignal);
    throwIfAborted(ownedSignal);

    // Dedupe concurrent connection attempts.
    if (this.connectPromises.has(name)) {
      return abortable(this.connectPromises.get(name)!, ownedSignal);
    }

    const existing = this.connections.get(name);
    if (existing?.status === "connected") {
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const generation = this.closeGenerations.get(name) ?? 0;
    const attemptController = new AbortController();
    const attemptSignal = combineAbortSignals(ownedSignal, attemptController.signal);
    const connectionAttempt = this.createConnection(name, definition, attemptSignal, ownedSignal, options);
    const promise = definition.url
      ? connectionAttempt.catch(async error => { throw await this.enrichHttpConnectionError(definition, error, options, attemptSignal); })
      : connectionAttempt;
    this.connectPromises.set(name, promise);
    this.connectAttempts.set(name, attemptController);

    try {
      const connection = await promise;
      if (attemptController.signal.aborted || (this.closeGenerations.get(name) ?? 0) !== generation) {
        await this.disposeConnection(connection);
        throwIfAborted(attemptSignal);
        throw new Error(`MCP connection for ${name} was closed while connecting`);
      }
      this.connections.set(name, connection);
      if (connection.listenSubscription) this.watchListen(name, connection, connection.listenSubscription);
      return connection;
    } finally {
      if (this.connectPromises.get(name) === promise) this.connectPromises.delete(name);
      if (this.connectAttempts.get(name) === attemptController) this.connectAttempts.delete(name);
    }
  }

  /**
   * Reconnect a server whose connection was proven stale (e.g. by a 404
   * "session no longer exists" response). Single-flight per server name —
   * concurrent callers that raced to the same failure share one reconnect —
   * and identity-guarded: `staleConnection` is only torn down if it is
   * still the manager's current connection for `name`. If a concurrent
   * reconnect (or an unrelated connect()) already replaced it with a fresh
   * connection, that fresh connection is returned untouched.
   */
  async reconnect(
    name: string,
    definition: ServerDefinition,
    staleConnection: ServerConnection,
    signal?: AbortSignal,
  ): Promise<ServerConnection> {
    if (isServerDisabled(definition)) throw new Error(`MCP server "${name}" is disabled`);
    if (this.stopped) throw new Error("MCP server manager is closed");
    const ownedSignal = combineAbortSignals(this.runtimeSignal, signal);
    throwIfAborted(ownedSignal);
    const inFlight = this.reconnectPromises.get(name);
    if (inFlight) {
      return abortable(inFlight, ownedSignal);
    }

    const promise = this.doReconnect(name, definition, staleConnection, ownedSignal).finally(() => {
      if (this.reconnectPromises.get(name) === promise) {
        this.reconnectPromises.delete(name);
      }
    });
    this.reconnectPromises.set(name, promise);
    return abortable(promise, ownedSignal);
  }

  private async doReconnect(
    name: string,
    definition: ServerDefinition,
    staleConnection: ServerConnection,
    signal?: AbortSignal,
  ): Promise<ServerConnection> {
    throwIfAborted(signal);
    const current = this.connections.get(name);

    // Never tear down a connection we didn't prove stale: if the map no
    // longer holds the connection we were asked to replace, someone else
    // already reconnected (or connected) first.
    if (current !== staleConnection) {
      return current ?? this.connect(name, definition, signal);
    }

    const staleInFlight = staleConnection.inFlight;
    await this.close(name);
    let fresh: ServerConnection;
    try {
      fresh = await this.connect(name, definition, signal);
    } catch (error) {
      if (!signal?.aborted && !this.stopped) {
        this.invokeDetachedCallback("reconnect failure", this.reconnectFailureListener, [name, error]);
      }
      throw error;
    }
    fresh.inFlight = Math.max(fresh.inFlight, staleInFlight);
    await this.publishMetadata(name, fresh, "session-reconnect");
    return fresh;
  }

  private async createConnection(
    name: string,
    definition: ServerDefinition,
    signal?: AbortSignal,
    requestSignal?: AbortSignal,
    options: ConnectOptions = {},
  ): Promise<ServerConnection> {
    throwIfAborted(signal);

    const tracingEnabled = isMcpTraceEnabled(definition, this.traceSettings);
    const traceWriter = tracingEnabled
      ? (this.traceWriter ??= createMcpTraceWriter(this.defaultCwd, this.traceSettings ?? {}))
      : undefined;
    const traceObserver: McpTraceObserver | undefined = traceWriter
      ? { record: event => traceWriter.write(event) }
      : undefined;

    // Programmatic sources hand the manager fully-resolved launch values; the
    // persisted secret-free definition is what the connection should expose.
    const retainedDefinition = options.retainedDefinition ?? definition;

    let client: Client;
    let transport: Transport;
    let clientConnected = false;
    let transportAlreadyTraced = false;
    let stderrTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const configuredTransports = [definition.command, definition.url, definition.socket]
      .filter(value => typeof value === "string" && value.length > 0);
    if (configuredTransports.length !== 1) {
      throw new Error(`Server ${name} must configure exactly one of command, url, or socket`);
    }

    const requestOptions = this.buildRequestOptions(definition, requestSignal);

    if (definition.command) {
      client = this.createClient(name, definition);
      let command = definition.command;
      let args = definition.args ?? [];

      if (command === "npx" || command === "npm") {
        const resolved = await resolveNpxBinary(command, args, signal);
        if (resolved) {
          command = resolved.isJs ? "node" : resolved.binPath;
          args = resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs;
          logger.debug(`${name} resolved to ${resolved.binPath} (skipping npm parent)`);
        }
      }
      throwIfAborted(signal);

      // Programmatic (resolved) sources supply env/cwd verbatim and must not
      // inherit process.env or run command-secret resolvers; file-config
      // sources go through the full interpolation + command-secret pipeline.
      const env = options.values === "resolved" ? definition.env : resolveEnv(definition.env, name);
      const cwd = options.values === "resolved"
        ? (definition.cwd ?? this.defaultCwd)
        : (resolveConfigPath(definition.cwd) ?? this.defaultCwd);
      const stdioTransport = new StdioClientTransport({
        command,
        args,
        ...(env !== undefined ? { env } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        stderr: definition.debug ? "inherit" : "pipe",
      });
      // Keep non-debug child diagnostics available for connection failures without
      // retaining an unbounded stream or changing the existing debug behavior.
      if (stdioTransport.stderr) {
        stdioTransport.stderr.on("data", (chunk: Buffer | string) => {
          stderrTail = appendStderrTail(stderrTail, chunk);
        });
      }
      transport = stdioTransport;
    } else if (definition.url) {
      const httpConnection = await this.connectHttpClient(
        definition,
        name,
        requestOptions,
        signal,
        traceObserver,
        options,
      );
      client = httpConnection.client;
      transport = httpConnection.transport;
      if (httpConnection.status === "needs-auth") {
        return {
          client,
          transport,
          definition: retainedDefinition,
          tools: [],
          resources: [],
          prompts: [],
          lastUsedAt: Date.now(),
          inFlight: 0,
          status: "needs-auth",
        };
      }
      clientConnected = true;
      transportAlreadyTraced = traceObserver !== undefined;
    } else {
      client = this.createClient(name, definition);
      transport = new UnixSocketClientTransport(resolveConfigPath(definition.socket!)!);
    }

    if (traceObserver && !transportAlreadyTraced) {
      const traceTransportKindValue = traceTransportKind(definition, transport);
      transport = wrapTransportWithMcpTrace(transport, name, traceTransportKindValue, traceObserver);
    }

    try {
      throwIfAborted(signal);
      if (!clientConnected) {
        await this.connectClientWithAbort(client, transport, requestOptions, signal);
      }
      this.attachAdapterNotificationHandlers(name, client);

      const instructions = client.getInstructions?.();
      const connection: ServerConnection = {
        client,
        transport,
        definition: retainedDefinition,
        tools: [],
        resources: [],
        prompts: [],
        ...(instructions !== undefined ? { instructions } : {}),
        lastUsedAt: Date.now(),
        inFlight: 0,
        status: "connected",
      };

      // Reflect the SDK's own close signal in connection status, guarded by
      // identity so a stale connection's late close can never clobber a fresh
      // connection. The SDK client owns the transport callbacks.
      client.onclose = () => {
        if (this.connections.get(name) === connection) {
          connection.status = "closed";
        }
      };

      const subscription = client.autoOpenedSubscription;
      if (subscription) connection.listenSubscription = subscription;
      connection.listenState = client.getProtocolEra?.() === "modern" ? subscription ? "active" : "not-listening" : "legacy";
      const hints: { ttlMs?: number; cacheScope?: string } = {};
      // Discover tools, resources, and prompts. Resource and prompt listing is
      // optional: only servers advertising the capability are queried.
      const [tools, resources, promptResult] = await Promise.all([
        this.fetchAllTools(client, requestOptions, hints),
        this.fetchAllResources(client, requestOptions),
        this.fetchAllPrompts(client, requestOptions),
      ]);
      connection.tools = tools;
      connection.catalogRevision = 0;
      connection.catalogAcquiredAt = Date.now();
      connection.toolListHints = hints;
      connection.resources = resources;
      connection.prompts = promptResult.prompts;
      connection.promptDiscoveryFailed = promptResult.failed;

      return connection;
    } catch (error) {
      // If connectClientWithAbort closed the transport, await that exact close.
      // Otherwise the SDK client owns its transport and performs cleanup once.
      const abortCleanup = abortCleanupPromises.get(transport);
      const abortCleanupFailed = error instanceof AggregateError && error.message === "MCP connection abort cleanup failed";
      const cleanupResults = abortCleanupFailed
        ? []
        : await Promise.allSettled([
            abortCleanup ?? Promise.resolve().then(() => client.close()),
          ]);
      const cleanupFailures = cleanupResults.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      let reportedError: unknown = error;
      if (cleanupFailures.length > 0) {
        reportedError = new AggregateError([error, ...cleanupFailures], "MCP connection setup failed");
      }

      // A cleanup failure remains a setup failure rather than being hidden
      // behind needs-auth.
      if (isUnauthorizedHttpError(error) && supportsOAuth(definition) && cleanupFailures.length === 0) {
        return {
          client,
          transport,
          definition: retainedDefinition,
          tools: [],
          resources: [],
          prompts: [],
          lastUsedAt: Date.now(),
          inFlight: 0,
          status: "needs-auth",
        };
      }

      if (stderrTail.length > 0) {
        const stderrText = stderrTail.toString("utf8").trim();
        const lines = stderrText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (lines.length > 0) {
          const baseMessage = reportedError instanceof Error ? reportedError.message : String(reportedError);
          const detail = lines.slice(-MAX_CAPTURED_STDERR_LINES).join(" — ");
          throw new Error(`${baseMessage} (${detail})`, { cause: reportedError });
        }
      }
      if (definition.command && reportedError instanceof Error && "code" in reportedError && ["ENOENT", "ENOTDIR"].includes(String(reportedError.code))) {
        const cwd = options.values === "resolved" ? definition.cwd ?? this.defaultCwd : resolveConfigPath(definition.cwd) ?? this.defaultCwd;
        if (cwd) {
          const info = await stat(cwd).catch(() => undefined);
          if (!info?.isDirectory()) throw new Error(`MCP server ${name} has a missing or non-directory cwd: ${cwd}`, { cause: reportedError });
        }
      }
      throw reportedError;
    }
  }

  private async enrichHttpConnectionError(definition: ServerDefinition, error: unknown, options: ConnectOptions, signal?: AbortSignal): Promise<Error> {
    if (signal?.aborted) { throwIfAborted(signal); }
    if (isTemporarilyUnavailable(error)) return new Error("MCP server temporarily unavailable (HTTP 503); retry later or explicitly reconnect.", { cause: error });
    const originalMessage = error instanceof Error ? error.message : String(error);
    try {
      const probe = await probeMcpEndpoint(connectionServerUrl(definition, options.values === "resolved"), signal);
      return new Error(`${originalMessage} — probe: ${probe.classification}`, { cause: error });
    } catch {
      return error instanceof Error ? error : new Error(originalMessage);
    }
  }

  private async connectClientWithAbort(
    client: Client,
    transport: Transport,
    requestOptions?: RequestOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    let abortCleanup: Promise<void> | undefined;
    const closeTransport = () => {
      abortCleanup = Promise.resolve().then(() => transport.close());
      abortCleanupPromises.set(transport, abortCleanup);
    };
    signal?.addEventListener("abort", closeTransport, { once: true });
    try {
      await abortable(client.connect(transport, requestOptions), signal);
      await abortCleanup;
    } catch (error) {
      if (abortCleanup) {
        try {
          await abortCleanup;
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "MCP connection abort cleanup failed");
        }
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", closeTransport);
    }
  }

  private buildClientCapabilities() {
    return {
      ...(this.samplingConfig ? { sampling: {} } : {}),
      ...(this.elicitationConfig
        ? {
            elicitation: {
              form: {},
              ...(this.elicitationConfig.allowUrl ? { url: {} } : {}),
            },
          }
        : {}),
    };
  }

  private createClient(serverName: string, definition: ServerDefinition): Client {
    const capabilities = this.buildClientCapabilities();
    const versionNegotiation = resolveVersionNegotiation(definition);
    let client: Client;
    client = new Client(
      { name: `pi-mcp-${serverName}`, version: "1.0.0" },
      {
        // Custom validator: the SDK default Ajv logs a warning for every
        // schemars-style integer-width format (int64, uint64, ...) it meets
        // in a tool outputSchema. The shared validator registers them as
        // real range-checked formats, both silencing the warning and making
        // the annotation true.
        jsonSchemaValidator: createJsonSchemaValidator(),
        ...(versionNegotiation ? { versionNegotiation } : {}),
        ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
        listChanged: {
          tools: {
            onChanged: (error: Error | null, tools: McpTool[] | null) => {
              this.handleToolsListChanged(serverName, client, error, tools);
            },
          },
          resources: {
            onChanged: (error: Error | null, resources: McpResource[] | null) => {
              this.handleResourcesListChanged(serverName, client, error, resources);
            },
          },
          prompts: {
            onChanged: (error: Error | null, prompts: McpPrompt[] | null) => {
              this.handlePromptsListChanged(serverName, client, error, prompts);
            },
          },
        },
      },
    );
    if (this.samplingConfig) {
      registerSamplingHandler(client, { ...this.samplingConfig, serverName });
    }
    if (this.elicitationConfig) {
      registerElicitationHandler(client, {
        ...this.elicitationConfig,
        serverName,
        onUrlAccepted: elicitationId => this.rememberUrlElicitation(serverName, elicitationId),
      });
      if (this.elicitationConfig.allowUrl) {
        client.setNotificationHandler("notifications/elicitation/complete", notification => {
          if (this.runtimeSignal?.aborted) return;
          const accepted = this.acceptedUrlElicitations.get(serverName);
          if (!accepted?.delete(notification.params.elicitationId)) return;
          this.elicitationConfig?.ui.notify(
            `MCP browser interaction for ${serverName} completed. You can retry the tool now.`,
            "info",
          );
        });
      }
    }
    return client;
  }

  private handleToolsListChanged(
    serverName: string,
    client: Client,
    error: Error | null,
    tools: McpTool[] | null,
  ): void {
    if (error) {
      logger.debug(`MCP: tools/list_changed refresh failed for ${serverName}: ${error.message}`);
      return;
    }
    if (!tools) return;
    const connection = this.connections.get(serverName);
    if (!connection || connection.client !== client || connection.status !== "connected") return;
    connection.tools = tools;
    connection.catalogAcquiredAt = Date.now();
    connection.catalogRevision = (connection.catalogRevision ?? 0) + 1;
    connection.toolListHints = undefined;
    void this.publishMetadata(serverName, connection, "tools-list-changed");
  }

  private handlePromptsListChanged(
    serverName: string,
    client: Client,
    error: Error | null,
    prompts: McpPrompt[] | null,
  ): void {
    if (error) {
      logger.debug(`MCP: prompts/list_changed refresh failed for ${serverName}: ${error.message}`);
      return;
    }
    if (!prompts) return;
    const connection = this.connections.get(serverName);
    if (!connection || connection.client !== client || connection.status !== "connected") return;
    connection.prompts = prompts;
    connection.catalogRevision = (connection.catalogRevision ?? 0) + 1;
    connection.toolListHints = undefined;
    connection.promptDiscoveryFailed = false;
    void this.publishMetadata(serverName, connection, "prompts-list-changed");
  }

  private handleResourcesListChanged(
    serverName: string,
    client: Client,
    error: Error | null,
    resources: McpResource[] | null,
  ): void {
    if (error) {
      logger.debug(`MCP: resources/list_changed refresh failed for ${serverName}: ${error.message}`);
      return;
    }
    if (!resources) return;
    const connection = this.connections.get(serverName);
    if (!connection || connection.client !== client || connection.status !== "connected") return;
    connection.resources = resources;
    connection.catalogRevision = (connection.catalogRevision ?? 0) + 1;
    connection.toolListHints = undefined;
    void this.publishMetadata(serverName, connection, "resources-list-changed");
  }

  /** Publish live truth before status/cache observers; a failed observer is retried. */
  async publishMetadata(name: string, connection: ServerConnection, reason: string): Promise<void> {
    if (this.stopped || this.connections.get(name) !== connection || !(["connected", "needs-auth"].includes(connection.status))) return;
    connection.publicationPending = true;
    try {
      await this.metadataListChangedListener?.(name, reason);
      if (this.connections.get(name) === connection) connection.publicationPending = false;
    } catch (error) {
      this.reportDetachedCallbackFailure("metadata publication", error);
    }
  }

  async refreshTools(name: string, expected: ServerConnection, signal?: AbortSignal): Promise<"updated" | "unchanged" | "superseded" | "deferred"> {
    await this.ensureListen(name, expected, signal);
    return this.refreshCatalog(name, expected, signal);
  }

  private async refreshCatalog(name: string, expected: ServerConnection, signal?: AbortSignal): Promise<"updated" | "unchanged" | "superseded" | "deferred"> {
    const owned = combineAbortSignals(this.runtimeSignal, signal);
    throwIfAborted(owned);
    const current = () => !this.stopped && this.connections.get(name) === expected && expected.status === "connected";
    if (!current()) return "superseded";
    const revision = expected.catalogRevision ?? 0;
    // This is a background latency budget, not evidence that a slow server died.
    // Existing explicit request timeouts override the five-second default.
    const timeout = this.getResolvedRequestTimeoutMs(expected.definition) ?? 5000;
    const deadline = AbortSignal.timeout(timeout);
    const requestSignal = combineAbortSignals(owned, deadline)!;
    const options: RequestOptions & { cacheMode: "refresh" } = { signal: requestSignal, timeout, cacheMode: "refresh" };
    const hints: { ttlMs?: number; cacheScope?: string } = {};
    const caps = expected.client.getServerCapabilities?.();
    const requests = [
      caps?.tools ? this.fetchAllTools(expected.client, options, hints) : Promise.resolve(expected.tools),
      this.fetchAllResources(expected.client, options, true),
      this.fetchAllPrompts(expected.client, options, true),
    ] as const;
    const results = await Promise.allSettled(requests.map(request => abortable<unknown>(request, requestSignal)));
    throwIfAborted(owned);
    if (!current() || revision !== (expected.catalogRevision ?? 0)) return "superseded";
    let deferred = false;
    for (const result of results) {
      if (result.status === "fulfilled") continue;
      if (deadline.aborted || isTemporarilyUnavailable(result.reason) || result.reason instanceof SdkError && result.reason.code === SdkErrorCode.RequestTimeout) deferred = true;
      else throw result.reason;
    }
    const tools = results[0]!;
    const resources = results[1]!;
    const prompts = results[2]!;
    let changed = false;
    if (tools.status === "fulfilled") {
      changed ||= !isDeepStrictEqual(expected.tools, tools.value) || !isDeepStrictEqual(expected.toolListHints, hints);
      expected.tools = tools.value as McpTool[]; expected.toolListHints = hints;
      expected.catalogAcquiredAt = Date.now();
    }
    if (resources.status === "fulfilled") {
      changed ||= !isDeepStrictEqual(expected.resources, resources.value);
      expected.resources = resources.value as McpResource[];
    }
    if (prompts.status === "fulfilled") {
      const value = prompts.value as { prompts: McpPrompt[]; failed: boolean };
      changed ||= !isDeepStrictEqual(expected.prompts, value.prompts);
      expected.prompts = value.prompts; expected.promptDiscoveryFailed = false;
    }
    if (changed) expected.catalogRevision = revision + 1;
    if (!deferred) expected.listenCatalogStale = false;
    if (changed || expected.publicationPending) await this.publishMetadata(name, expected, "catalog-refresh");
    return deferred ? "deferred" : changed ? "updated" : "unchanged";
  }

  private watchListen(name: string, connection: ServerConnection, subscription: NonNullable<ServerConnection["listenSubscription"]>): void {
    void subscription.closed.then(cause => {
      if (this.stopped || this.connections.get(name) !== connection || connection.status !== "connected" || connection.listenSubscription !== subscription) return;
      if (cause === "remote") {
        connection.listenState = "dropped"; connection.listenCatalogStale = true; connection.listenRetryAfter = 0;
      } else if (connection.listenState !== "re-establishing") {
        connection.listenStopped = true; connection.listenState = "not-listening";
      }
    }).catch(error => {
      if (!this.stopped && this.connections.get(name) === connection && connection.listenSubscription === subscription) {
        connection.listenState = "dropped"; connection.listenCatalogStale = true;
      }
      this.reportDetachedCallbackFailure("catalog subscription", error);
    });
  }

  /** Repair only negotiated catalog subscriptions; never create resource subscriptions. */
  async ensureListen(name: string, expected: ServerConnection, signal?: AbortSignal): Promise<void> {
    const current = () => !this.stopped && !this.runtimeSignal?.aborted && this.connections.get(name) === expected && expected.status === "connected" && !expected.listenStopped;
    if (!current() || expected.client.getProtocolEra?.() !== "modern") return;
    if (expected.listenPromise) return abortable(expected.listenPromise, signal);
    if ((expected.listenRetryAfter ?? 0) > Date.now()) return;
    if (expected.listenState === "active" && !expected.listenCatalogStale) return;
    const caps = expected.client.getServerCapabilities?.();
    const filter = {
      ...(caps?.tools?.listChanged ? { toolsListChanged: true } : {}),
      ...(caps?.resources?.listChanged ? { resourcesListChanged: true } : {}),
      ...(caps?.prompts?.listChanged ? { promptsListChanged: true } : {}),
    };
    if (!Object.keys(filter).length) return;
    // Caller cancellation stops waiting, never the adopted shared stream.
    const owned = this.runtimeSignal;
    const attempt = (async () => {
      const stale = expected.listenCatalogStale;
      let adopted = false;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new Error("Catalog listen timed out")), 5000);
      timer.unref?.();
      const requestSignal = combineAbortSignals(owned, timeout.signal)!;
      expected.listenState = "re-establishing";
      try {
        if (expected.listenSubscription) await abortable(expected.listenSubscription.close(), requestSignal);
        if (!current()) return;
        const request = expected.client.listen(filter, { signal: requestSignal, timeout: 5000 });
        // A client ignoring cancellation must not leave a late live subscription.
        void request.then(subscription => { if (!current() || requestSignal.aborted) return subscription.close(); }).catch(error => this.reportDetachedCallbackFailure("late catalog listen", error));
        const subscription = await abortable(request, requestSignal);
        // The deadline bounds establishment, not the live event stream.
        clearTimeout(timer);
        if (!current()) { await subscription.close(); return; }
        expected.listenSubscription = subscription; expected.listenState = "active";
        adopted = true;
        this.watchListen(name, expected, subscription);
        if (stale) {
          const result = await this.refreshCatalog(name, expected, owned);
          if (result === "deferred" || result === "superseded") expected.listenRetryAfter = Date.now() + 5000;
        }
      } catch (error) {
        if (!adopted) timeout.abort(error);
        if (current()) { expected.listenState = "dropped"; expected.listenCatalogStale = true; expected.listenRetryAfter = Date.now() + 5000; }
        if (owned?.aborted) throw error;
        logger.debug(`MCP catalog listen repair deferred for ${name}: ${formatTerminalError(error)}`);
      } finally { clearTimeout(timer); }
    })().finally(() => { if (expected.listenPromise === attempt) delete expected.listenPromise; });
    expected.listenPromise = attempt;
    return abortable(attempt, signal);
  }

  async handleUrlElicitationRequired(
    serverName: string,
    error: UrlElicitationRequiredError,
  ): Promise<"accept" | "decline" | "cancel"> {
    if (this.runtimeSignal?.aborted || !this.elicitationConfig?.allowUrl) return "cancel";
    for (const params of error.elicitations) {
      const result = await handleUrlElicitation({
        ...this.elicitationConfig,
        serverName,
        onUrlAccepted: elicitationId => this.rememberUrlElicitation(serverName, elicitationId),
      }, params);
      if (result.action !== "accept") return result.action;
    }
    return "accept";
  }

  private rememberUrlElicitation(serverName: string, elicitationId: string): void {
    if (this.runtimeSignal?.aborted) return;
    let accepted = this.acceptedUrlElicitations.get(serverName);
    if (!accepted) {
      accepted = new Set();
      this.acceptedUrlElicitations.set(serverName, accepted);
    }
    accepted.add(elicitationId);
  }

  private async connectHttpClient(
    definition: ServerDefinition,
    serverName: string,
    requestOptions: RequestOptions | undefined,
    signal?: AbortSignal,
    traceObserver?: McpTraceObserver,
    options: ConnectOptions = {},
  ): Promise<{ client: Client; transport: Transport; status: "connected" | "needs-auth" }> {
    throwIfAborted(signal);
    const serverUrl = connectionServerUrl(definition, options.values === "resolved");
    const url = new URL(serverUrl);

    // Programmatic sources supply fully-resolved header/bearer values; skip
    // command-secret resolution, env interpolation, and the resulting header
    // validation. File-config sources go through the secret-aware pipeline.
    const resolved = options.values === "resolved";
    const hasCommandHeader = resolved
      ? false
      : Object.values(definition.headers ?? {})
        .some(value => value.startsWith("!") && !value.startsWith("!!"));
    const headers = resolved
      ? { ...(definition.headers ?? {}) }
      : (resolveCommandSecretsRecord(
        definition.headers,
        key => `MCP server "${serverName}" HTTP header "${key}"`,
      ) ?? {});

    // Resolve bearer auth before creating requestInit so every attempted
    // transport receives the same headers.
    const rawBearer = definition.bearerToken;
    const commandBearer = !resolved && rawBearer !== undefined
      && rawBearer.startsWith("!") && !rawBearer.startsWith("!!")
      ? rawBearer
      : undefined;
    if (definition.auth === "bearer") {
      const token = resolved
        ? rawBearer
        : commandBearer
          ? resolveCommandSecret(commandBearer, `MCP server "${serverName}" HTTP bearer token`)
          : resolveBearerToken(definition);
      if (token) headers["Authorization"] = `Bearer ${token}`;
    }

    if (!resolved && (hasCommandHeader || commandBearer)) {
      try {
        new Headers(headers);
      } catch {
        throw new Error(`Failed to resolve MCP server "${serverName}" HTTP command secret: command returned an invalid header value`);
      }
    }

    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
    const createAuthProvider = (): McpOAuthProvider => new McpOAuthProvider(
      serverName,
      serverUrl,
      extractOAuthConfig(definition),
      { onRedirect: async () => {} },
      this.authStorageOptions,
      this.oauthRuntime?.signal,
    );

    // Explicit OAuth checks secure storage immediately. Implicit OAuth defers
    // provider construction until the server proves authentication is needed.
    let authState: HttpAuthProviderState = supportsOAuth(definition)
      ? definition.auth === undefined
        ? { status: "implicit-deferred" }
        : { status: "explicit", provider: createAuthProvider() }
      : { status: "disabled" };

    if (authState.status === "implicit-deferred") {
      // Storage failure must not prevent an anonymous-capable server from
      // connecting. A genuine OAuth challenge still exposes its storage error.
      try {
        const stored = inspectAuthForUrl(serverName, serverUrl, this.authStorageOptions);
        if (stored.status === "present" && stored.entry.tokens) authState = { status: "implicit-challenged", provider: createAuthProvider() };
      } catch { /* malformed optional credentials: anonymous discovery remains usable */ }
    }

    const attempt = async (
      kind: "streamable-http" | "sse",
    ): Promise<
      | { status: "connected"; client: Client; transport: Transport }
      | { status: "failed"; client: Client; transport: Transport; error: unknown }
    > => {
      const authProvider = "provider" in authState ? authState.provider : undefined;
      const transportOptions = {
        ...(requestInit !== undefined ? { requestInit } : {}),
        ...(authProvider !== undefined ? { authProvider } : {}),
      };
      const baseTransport: Transport = kind === "streamable-http"
        ? new StreamableHTTPClientTransport(url, transportOptions)
        : new SSEClientTransport(url, transportOptions);
      const transport = traceObserver
        ? wrapTransportWithMcpTrace(baseTransport, serverName, kind, traceObserver)
        : baseTransport;
      const client = this.createClient(serverName, definition);

      try {
        await this.connectClientWithAbort(client, transport, requestOptions, signal);
        return { status: "connected", client, transport };
      } catch (error) {
        const abortCleanupFailed = error instanceof AggregateError
          && error.message === "MCP connection abort cleanup failed";
        if (!abortCleanupFailed) {
          try {
            await (abortCleanupPromises.get(transport) ?? client.close());
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "MCP HTTP connection cleanup failed");
          }
        }
        return { status: "failed", client, transport, error };
      }
    };

    // Connect the real client once. Retry Streamable HTTP only for an implicit
    // OAuth challenge; use SSE only for definitive endpoint incompatibility
    // and only when the caller has not pinned Streamable HTTP as exact
    // (programmatic sources opt out of legacy SSE via allowLegacySseFallback).
    let kind: "streamable-http" | "sse" = "streamable-http";
    for (;;) {
      const result = await attempt(kind);
      if (result.status === "connected") return result;
      if (result.error instanceof AggregateError
        && result.error.message === "MCP connection abort cleanup failed") {
        throw result.error;
      }
      if (signal?.aborted) throwIfAborted(signal);

      if (authState.status === "implicit-deferred" && isUnauthorizedHttpError(result.error)) {
        authState = { status: "implicit-challenged", provider: createAuthProvider() };
        continue;
      }
      if (isUnauthorizedHttpError(result.error)) {
        if (supportsOAuth(definition)) {
          return { client: result.client, transport: result.transport, status: "needs-auth" };
        }
        throw result.error;
      }

      if (kind === "streamable-http"
        && options.allowLegacySseFallback !== false
        && shouldFallbackToSse(result.error, definition)) {
        kind = "sse";
        continue;
      }
      throw result.error;
    }
  }

  private async fetchAllTools(client: Client, requestOptions?: RequestOptions, hints?: { ttlMs?: number; cacheScope?: string }): Promise<McpTool[]> {
    const allTools: McpTool[] = [];
    let cursor: string | undefined;

    do {
      const result = await client.listTools(cursor ? { cursor } : undefined, requestOptions);
      if (hints) {
        if (typeof result.ttlMs === "number" && Number.isSafeInteger(result.ttlMs) && result.ttlMs >= 0) hints.ttlMs = Math.min(hints.ttlMs ?? Infinity, result.ttlMs);
        if (result.cacheScope === "private" || result.cacheScope === "public" && hints.cacheScope === undefined) hints.cacheScope = result.cacheScope;
      }
      allTools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);

    return allTools;
  }

  private async fetchAllPrompts(
    client: Client,
    requestOptions?: RequestOptions,
    strict = false,
  ): Promise<{ prompts: McpPrompt[]; failed: boolean }> {
    const capabilities = client.getServerCapabilities?.();
    if (!capabilities?.prompts) return { prompts: [], failed: false };

    try {
      const prompts: McpPrompt[] = [];
      let cursor: string | undefined;
      do {
        const result = await client.listPrompts(cursor ? { cursor } : undefined, requestOptions);
        prompts.push(...(result.prompts ?? []));
        cursor = result.nextCursor;
      } while (cursor);
      return { prompts, failed: false };
    } catch (error) {
      if (requestOptions?.signal?.aborted) throwIfAborted(requestOptions.signal);
      const message = error instanceof Error ? error.message : String(error);
      if (strict || isUnauthorizedHttpError(error)) throw error;
      logger.debug(`MCP: prompts/list failed: ${message}`);
      return { prompts: [], failed: true };
    }
  }

  private async fetchAllResources(client: Client, requestOptions?: RequestOptions, strict = false): Promise<McpResource[]> {
    const capabilities = client.getServerCapabilities?.();
    if (!capabilities?.resources) return [];

    try {
      const allResources: McpResource[] = [];
      let cursor: string | undefined;

      do {
        const result = await client.listResources(cursor ? { cursor } : undefined, requestOptions);
        allResources.push(...(result.resources ?? []));
        cursor = result.nextCursor;
      } while (cursor);

      return allResources;
    } catch (error) {
      if (strict || isUnauthorizedHttpError(error)) throw error;
      if (requestOptions?.signal?.aborted) {
        throwIfAborted(requestOptions.signal);
      }
      // The server advertises resources but the listing failed
      return [];
    }
  }

  private invokeDetachedCallback(
    name: string,
    callback: ((...args: any[]) => unknown) | undefined,
    args: unknown[],
  ): void {
    invokeContainedCallback(callback, args, error => this.reportDetachedCallbackFailure(name, error));
  }

  private reportDetachedCallbackFailure(name: string, error: unknown): void {
    const message = truncateAtWord(formatTerminalError(error), 1_024);
    logger.error(`MCP ${name} callback failed: ${message || "unknown error"}`);
  }

  private attachAdapterNotificationHandlers(serverName: string, client: Client): void {
    client.setNotificationHandler(
      SERVER_STREAM_RESULT_PATCH_METHOD,
      { params: serverStreamResultPatchNotificationSchema.shape.params },
      params => {
        const listener = this.uiStreamListeners.get(params.streamToken);
        if (!listener) return;
        this.invokeDetachedCallback("UI stream notification", listener, [serverName, params]);
      },
    );
  }

  registerUiStreamListener(streamToken: string, listener: UiStreamListener): void {
    this.uiStreamListeners.set(streamToken, listener);
  }

  removeUiStreamListener(streamToken: string): void {
    this.uiStreamListeners.delete(streamToken);
  }

  async getPrompt(
    name: string,
    promptName: string,
    args?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<GetPromptResult> {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") {
      throw new Error(`Server "${name}" is not connected`);
    }
    try {
      this.touch(name);
      this.incrementInFlight(name);
      return await connection.client.getPrompt(
        { name: promptName, ...(args ? { arguments: args } : {}) },
        this.getRequestOptions(name, signal),
      );
    } finally {
      this.decrementInFlight(name);
      this.touch(name);
    }
  }

  async readResource(name: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
    if (isServerDisabled(this.connections.get(name)?.definition)) {
      throw new Error(`MCP server "${name}" is disabled`);
    }
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") {
      throw new Error(`Server "${name}" is not connected`);
    }

    try {
      this.touch(name);
      this.incrementInFlight(name);
      return await connection.client.readResource({ uri }, this.getRequestOptions(name, signal));
    } finally {
      this.decrementInFlight(name);
      this.touch(name);
    }
  }

  async close(name: string): Promise<void> {
    this.closeGenerations.set(name, (this.closeGenerations.get(name) ?? 0) + 1);
    this.connectAttempts.get(name)?.abort(new Error(`MCP connection ${name} was closed`));

    const connection = this.connections.get(name);
    if (!connection) {
      const pendingClose = this.closePromises.get(name);
      if (pendingClose) {
        await pendingClose;
        return;
      }
      const pendingConnect = this.connectPromises.get(name);
      if (pendingConnect) {
        try {
          await pendingConnect;
        } catch (error) {
          if (this.containsCleanupFailure(error)) throw error;
        }
      }
      return;
    }

    // Delete before awaiting SDK cleanup so a replacement cannot be removed by
    // an old close operation finishing later.
    connection.status = "closed";
    connection.listenStopped = true;
    this.connections.delete(name);
    this.acceptedUrlElicitations.delete(name);
    const closing = this.disposeConnection(connection).finally(() => {
      if (this.closePromises.get(name) === closing) this.closePromises.delete(name);
    });
    this.closePromises.set(name, closing);
    return closing;
  }

  private async disposeConnection(connection: ServerConnection): Promise<void> {
    const results = await Promise.allSettled([
      // Only client.close() is needed; the client owns the transport and will close it internally.
      Promise.resolve().then(() => connection.client.close()),
      this.traceWriter?.flush() ?? Promise.resolve(),
    ]);
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "MCP connection cleanup failed");
  }

  async closeAll(): Promise<void> {
    this.stopped = true;
    const names = new Set([...this.connections.keys(), ...this.connectPromises.keys()]);
    for (const name of names) {
      this.closeGenerations.set(name, (this.closeGenerations.get(name) ?? 0) + 1);
      this.connectAttempts.get(name)?.abort(new Error(`MCP connection ${name} was closed`));
    }

    const pendingConnects = [...this.connectPromises.values()];
    const currentNames = [...this.connections.keys()];
    const pendingResults = await Promise.allSettled(pendingConnects);
    const results = await Promise.allSettled(currentNames.map(name => this.close(name)));

    // A connect that resolved during the first close snapshot is still fenced;
    // close any handle that was already inserted before its attempt settled.
    const lateNames = [...this.connections.keys()];
    const lateResults = await Promise.allSettled(lateNames.map(name => this.close(name)));
    const failures = [...pendingResults, ...results, ...lateResults]
      .flatMap(result => result.status === "rejected" ? [result.reason] : [])
      .filter(error => this.containsCleanupFailure(error));
    this.uiStreamListeners.clear();
    this.acceptedUrlElicitations.clear();
    this.samplingConfig = undefined;
    this.elicitationConfig = undefined;
    await this.traceWriter?.flush();
    if (failures.length > 0) throw new AggregateError(failures, "MCP manager cleanup failed");
  }

  private containsCleanupFailure(error: unknown): boolean {
    const pending: unknown[] = [error];
    const seen = new Set<unknown>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (!(current instanceof Error) || seen.has(current)) continue;
      seen.add(current);
      if (current instanceof AggregateError) {
        if (/cleanup failed|setup failed/.test(current.message)) return true;
        pending.push(...current.errors);
      }
      if (current.cause !== undefined) pending.push(current.cause);
    }
    return false;
  }

  isConnecting(name: string): boolean {
    return this.connectPromises.has(name);
  }

  getConnection(name: string): ServerConnection | undefined {
    return this.connections.get(name);
  }

  getAllConnections(): Map<string, ServerConnection> {
    return new Map(this.connections);
  }

  touch(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.lastUsedAt = Date.now();
    }
  }

  incrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.inFlight = (connection.inFlight ?? 0) + 1;
    }
  }

  decrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection && connection.inFlight) {
      connection.inFlight--;
    }
  }

  isIdle(name: string, timeoutMs: number): boolean {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") return false;
    if (connection.inFlight > 0) return false;
    return (Date.now() - connection.lastUsedAt) > timeoutMs;
  }
}

/**
 * Resolve environment variables with interpolation. Programmatic (resolved)
 * sources bypass this entirely and pass their env verbatim.
 */
function resolveEnv(env: Record<string, string> | undefined, serverName: string): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) resolved[key] = value;
  }
  const overrides = resolveCommandSecretsRecord(
    env,
    key => `MCP server "${serverName}" stdio env "${key}"`,
  );
  return overrides ? { ...resolved, ...overrides } : resolved;
}

function normalizeRequestTimeoutMs(timeoutMs: number | undefined): number | undefined {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : undefined;
}
