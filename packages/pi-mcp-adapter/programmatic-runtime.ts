import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { McpServerManager } from "./server-manager.ts";
import { loadProgrammaticCache, saveProgrammaticCache, type ProgrammaticCachedTool } from "./programmatic-cache.ts";
import type { ServerDefinition } from "./types.ts";
import type {
  JsonValue,
  McpAdapterOptions,
  McpConfigSource,
  McpDiagnostic,
  McpInitialSource,
  McpLaunchValues,
  McpProgrammaticRuntime,
  McpRuntimeCapabilities,
  McpRuntimeLease,
  McpRuntimeServerBinding,
  McpSourceIdentity,
  McpSourceRegistration,
  McpSourceRemoveResult,
  McpSourceReplaceRequest,
  McpSourceReplaceResult,
  McpSourceServer,
  McpSourceServerStatus,
  McpSourceStatus,
  McpSourceValidationResult,
} from "./programmatic-types.ts";

const INVALID_SOURCE = "SOURCE_INVALID";
const INVALID_SEARCH = "SEARCH_INVALID";
const SEARCH_MAX_QUERY_LENGTH = 256;
const SEARCH_DEFAULT_LIMIT = 25;
const ADAPTER_FAILED = "ADAPTER_FAILED";
const CANCELLED = "MCP_LAUNCH_CANCELLED";
const CLEANUP_FAILED = "MCP_LAUNCH_CLEANUP_FAILED";
const REGISTRATION_PREFIX = "mcp-source-registration-v1\0";

interface ProgrammaticConnection {
  client: {
    callTool(
      params: { name: string; arguments?: Record<string, unknown> },
      resultSchema?: unknown,
      options?: RequestOptions,
    ): Promise<CallToolResult>;
    readResource(params: { uri: string }, options?: RequestOptions): Promise<ReadResourceResult>;
  };
  tools: readonly { name: string; description?: string; inputSchema?: unknown }[];
  resources: readonly { uri: string; name: string; description?: string }[];
  status: "connected" | "closed" | "needs-auth";
}

type ServerRuntimeStatus = {
  state: McpSourceServerStatus["state"];
  toolCount?: number;
  errorCode?: string;
};

type ExecutionState = {
  controller: AbortController;
  lease: McpRuntimeLease;
  closed: boolean;
  done: Promise<void>;
  finish(): void;
};

type SourceRecord = {
  registration: McpSourceRegistration;
  launchValues: McpSourceReplaceRequest["launchValues"];
  runtimeLeases: McpSourceReplaceRequest["runtimeLeases"];
  serverStatus: Map<string, ServerRuntimeStatus>;
  executions: Set<ExecutionState>;
};

export interface ProgrammaticExecution {
  readonly connection: ProgrammaticConnection;
  readonly signal: AbortSignal;
  close(signal?: AbortSignal): Promise<void>;
}

class ProgrammaticMcpError extends Error {
  constructor(readonly code: string) {
    super("MCP programmatic runtime operation failed");
    this.name = "ProgrammaticMcpError";
  }
}

const textEncoder = new TextEncoder();

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) throw new TypeError("invalid string");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("invalid number");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("not JSON");
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort(compareUtf8).map((key) => {
    if (hasLoneSurrogate(key)) throw new TypeError("invalid key");
    return `${JSON.stringify(key)}:${canonicalJson(object[key])}`;
  }).join(",")}}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !hasLoneSurrogate(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function identityIsValid(identity: unknown): identity is McpSourceIdentity {
  if (!isRecord(identity) || !hasOnlyKeys(identity, [
    "schemaVersion", "scope", "plugin", "revision", "projectionDigest",
  ]) || identity.schemaVersion !== 1 || !isRecord(identity.scope) ||
      !isNonEmptyString(identity.plugin) || !isDigest(identity.revision) ||
      !isDigest(identity.projectionDigest)) return false;
  return isJsonValue(identity.scope);
}

function serverIsValid(server: unknown): server is McpSourceServer {
  if (!isRecord(server) || !hasOnlyKeys(server, [
    "componentId", "nativeKey", "transport", "options", "projection",
    "launchTemplate", "toolAliases", "provenance",
  ]) || !isNonEmptyString(server.componentId) || !isNonEmptyString(server.nativeKey) ||
      (server.transport !== "stdio" && server.transport !== "streamable-http") ||
      !isRecord(server.options) || !isRecord(server.projection) || !isRecord(server.launchTemplate) ||
      !Array.isArray(server.toolAliases) || !Array.isArray(server.provenance) || server.provenance.length === 0 ||
      server.launchTemplate.transport !== server.transport) return false;
  return isJsonValue(server.options) && isJsonValue(server.projection) &&
    isJsonValue(server.launchTemplate) && isJsonValue(server.toolAliases) && isJsonValue(server.provenance);
}

function sourceIsValid(source: unknown): source is McpConfigSource {
  if (!isRecord(source) || !hasOnlyKeys(source, ["schemaVersion", "identity", "servers"]) ||
      source.schemaVersion !== 1 || !identityIsValid(source.identity) ||
      !isRecord(source.servers) || Object.keys(source.servers).length === 0) return false;
  const components = new Set<string>();
  for (const [key, server] of Object.entries(source.servers)) {
    if (!isNonEmptyString(key) || !serverIsValid(server) || components.has(server.componentId)) return false;
    components.add(server.componentId);
  }
  return true;
}

function registrationDigest(source: McpConfigSource): string {
  const bytes = `${REGISTRATION_PREFIX}${canonicalJson(source)}`;
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function registrationIsValid(value: unknown): value is McpSourceRegistration {
  return isRecord(value) && hasOnlyKeys(value, ["schemaVersion", "source", "digest"]) &&
    value.schemaVersion === 1 && sourceIsValid(value.source) &&
    isDigest(value.digest) && value.digest === registrationDigest(value.source);
}

function launchValuesAreValid(values: unknown, transport: McpSourceServer["transport"]): values is McpLaunchValues {
  if (!isRecord(values) || values.transport !== transport) return false;
  if (transport === "stdio") {
    return hasOnlyKeys(values, ["transport", "command", "args", "cwd", "env"]) &&
      isNonEmptyString(values.command) && Array.isArray(values.args) &&
      values.args.every((value) => typeof value === "string" && !hasLoneSurrogate(value)) &&
      (values.cwd === undefined || typeof values.cwd === "string") &&
      (values.env === undefined || isRecord(values.env) &&
        Object.entries(values.env).every(([key, value]) =>
          isNonEmptyString(key) && typeof value === "string" && !hasLoneSurrogate(value)));
  }
  if (!hasOnlyKeys(values, ["transport", "url", "headers", "bearerToken"]) ||
      !isNonEmptyString(values.url) ||
      (values.headers !== undefined && (!isRecord(values.headers) ||
        Object.entries(values.headers).some(([key, value]) =>
          !isNonEmptyString(key) || typeof value !== "string" || /[\r\n\0]/.test(value)))) ||
      (values.bearerToken !== undefined && typeof values.bearerToken !== "string")) return false;
  try {
    const url = new URL(values.url);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.username.length === 0 && url.password.length === 0;
  } catch {
    return false;
  }
}

function providerShapeIsValid(request: McpSourceReplaceRequest | McpInitialSource): boolean {
  return isRecord(request.launchValues) && typeof request.launchValues.resolve === "function" &&
    typeof request.launchValues.dispose === "function" && isRecord(request.runtimeLeases) &&
    typeof request.runtimeLeases.acquire === "function" &&
    typeof request.runtimeLeases.release === "function" &&
    typeof request.runtimeLeases.drain === "function";
}

function invalidDiagnostic(operation: string, code = INVALID_SOURCE): McpDiagnostic {
  return {
    code,
    severity: "error",
    operation,
    message: "MCP source operation was rejected",
    details: { sourceOperation: operation },
  };
}

function ownerKey(identity: McpSourceIdentity): string {
  return canonicalJson({ scope: identity.scope, plugin: identity.plugin });
}

function exactIdentityKey(identity: McpSourceIdentity): string {
  return canonicalJson(identity);
}

function qualifiedServerKey(identity: McpSourceIdentity, serverKey: string): string {
  return `programmatic:${createHash("sha256")
    .update(`${exactIdentityKey(identity)}\0${serverKey}`)
    .digest("hex")}`;
}

/**
 * Source-local keys registered by pi-plugins carry this prefix. A caller
 * token with the prefix is therefore treated as a key attempt, never a
 * display name: it resolves only as an exact key, so a stale key matches
 * nothing instead of being captured by another server's nativeKey.
 */
function isKeyShapedToken(token: string): boolean {
  return token.startsWith("mcp-server-v1:");
}

function copyIdentity(identity: McpSourceIdentity): McpSourceIdentity {
  return cloneJson(identity);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function statusFor(record: SourceRecord): McpSourceStatus {

  return {
    identity: copyIdentity(record.registration.source.identity),
    registrationDigest: record.registration.digest,
    state: "registered",
    servers: Object.entries(record.registration.source.servers)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, server]) => {
        const runtime = record.serverStatus.get(key) ?? { state: "registered" as const };
        return {
          key,
          componentId: server.componentId,
          nativeKey: server.nativeKey,
          provenance: cloneJson(server.provenance),
          state: runtime.state,
          ...(runtime.toolCount === undefined ? {} : { toolCount: runtime.toolCount }),
          ...(runtime.errorCode === undefined ? {} : { errorCode: runtime.errorCode }),
        };
      }),
  };
}

function serverDefinition(server: McpSourceServer, values: McpLaunchValues): ServerDefinition {
  const options = server.options as Record<string, unknown>;
  const auth = isRecord(options.auth) ? options.auth : undefined;
  const common: ServerDefinition = {
    requestTimeoutMs: typeof options.toolTimeoutMs === "number" ? options.toolTimeoutMs : undefined,
    exposeResources: options.resources === false ? false : true,
    excludeTools: [
      ...(Array.isArray(options.deniedTools) ? options.deniedTools.filter((value): value is string => typeof value === "string") : []),
    ],
    auth: auth?.kind === "oauth" ? "oauth" : auth?.kind === "bearer-environment" ? "bearer" : false,
    oauth: auth?.kind === "oauth" ? {
      grantType: auth.flow === "client-credentials" ? "client_credentials" : "authorization_code",
    } : false,
  };
  if (values.transport === "stdio") {
    return {
      ...common,
      command: values.command,
      args: [...values.args],
      ...(values.cwd === undefined ? {} : { cwd: values.cwd }),
      ...(values.env === undefined ? {} : { env: { ...values.env } }),
    };
  }
  return {
    ...common,
    url: values.url,
    ...(values.headers === undefined ? {} : { headers: { ...values.headers } }),
    ...(values.bearerToken === undefined ? {} : { bearerToken: values.bearerToken }),
  };
}

function retainedDefinition(server: McpSourceServer): ServerDefinition {
  const options = server.options as Record<string, unknown>;
  return {
    requestTimeoutMs: typeof options.toolTimeoutMs === "number" ? options.toolTimeoutMs : undefined,
    exposeResources: options.resources === false ? false : true,
    excludeTools: Array.isArray(options.deniedTools)
      ? options.deniedTools.filter((value): value is string => typeof value === "string")
      : [],
  };
}

/**
 * Shared allowed/denied visibility filter for a server's tools. An absent or
 * empty allowedTools means everything is visible; deniedTools always wins.
 */
function toolVisibilityFilter(options: Record<string, unknown>): (name: string) => boolean {
  const allowed = new Set(Array.isArray(options.allowedTools)
    ? options.allowedTools.filter((value): value is string => typeof value === "string")
    : []);
  const denied = new Set(Array.isArray(options.deniedTools)
    ? options.deniedTools.filter((value): value is string => typeof value === "string")
    : []);
  return (name) => (allowed.size === 0 || allowed.has(name)) && !denied.has(name);
}

/**
 * Source authority used by the public factory and its Pi extension. The class
 * itself is package-internal; callers receive the narrow lifecycle interface.
 */
export class ProgrammaticMcpRuntime implements McpProgrammaticRuntime {
  private readonly records = new Map<string, SourceRecord>();
  private manager: McpServerManager | undefined;
  private context: ExtensionContext | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  /**
   * Discovery inventory: visible tool names/descriptions per qualified server
   * key, persisted across sessions so the gateway can render the system-prompt
   * discovery block without launching servers. Schemas stay in
   * `schemaMemory` (session-scoped) — they are fetched fresh via
   * `getToolSchemas` and only reused to enrich same-session tool errors.
   */
  private inventory = new Map<string, { tools: ProgrammaticCachedTool[]; cachedAt: number }>();
  private schemaMemory = new Map<string, Map<string, unknown>>();
  private inventoryLoaded = false;

  constructor(readonly options: Required<Pick<McpAdapterOptions, "fileDiscovery">>) {
    // Initial registration is deliberately synchronous. The returned extension
    // cannot register a tool until every source has been validated and stored.
  }

  installInitialSources(initialSources: readonly McpInitialSource[]): void {
    for (const initial of initialSources) {
      if (!registrationIsValid(initial.registration) || !providerShapeIsValid(initial)) {
        throw new ProgrammaticMcpError(INVALID_SOURCE);
      }
      const registration = cloneJson(initial.registration);
      const key = ownerKey(registration.source.identity);
      if (this.records.has(key)) throw new ProgrammaticMcpError(INVALID_SOURCE);
      this.records.set(key, this.createRecord(registration, initial.launchValues, initial.runtimeLeases));
    }
  }

  private createRecord(
    registration: McpSourceRegistration,
    launchValues: McpSourceReplaceRequest["launchValues"],
    runtimeLeases: McpSourceReplaceRequest["runtimeLeases"],
  ): SourceRecord {
    return {
      registration,
      launchValues,
      runtimeLeases,
      serverStatus: new Map(Object.keys(registration.source.servers)
        .map((key) => [key, { state: "registered" as const }])),
      executions: new Set(),
    };
  }

  async attachSession(context: ExtensionContext): Promise<void> {
    if (this.manager !== undefined) await this.detachSession();
    this.context = context;
    this.schemaMemory.clear();
    const manager = new McpServerManager(context.cwd);
    manager.setSamplingConfig(context.hasUI ? {
      autoApprove: false,
      ui: context.ui,
      modelRegistry: context.modelRegistry,
      getCurrentModel: () => context.model,
      getSignal: () => context.signal,
    } : undefined);
    manager.setElicitationConfig(context.hasUI ? {
      ui: context.ui,
      allowUrl: context.mode === "tui",
    } : undefined);
    this.manager = manager;
    for (const record of this.records.values()) {
      for (const key of Object.keys(record.registration.source.servers)) {
        record.serverStatus.set(key, { state: "registered" });
      }
    }
  }

  async detachSession(): Promise<void> {
    const manager = this.manager;
    this.manager = undefined;
    this.context = undefined;
    for (const record of this.records.values()) {
      for (const execution of [...record.executions]) execution.controller.abort(new ProgrammaticMcpError(CANCELLED));
      await this.closeExecutions(record);
      for (const key of Object.keys(record.registration.source.servers)) {
        record.serverStatus.set(key, { state: "registered" });
      }
    }
    if (manager !== undefined) await manager.closeAll();
  }

  async capabilities(signal: AbortSignal): Promise<McpRuntimeCapabilities> {
    throwIfAborted(signal);
    const context = this.context;
    return {
      schemaVersion: 1,
      sourceLifecycle: {
        initialSourcesBeforeToolRegistration: true,
        isolatedFileDiscovery: true,
        localValidation: true,
        atomicReplace: true,
        exactRemove: true,
        inspect: true,
        cancellable: true,
        lateLaunchValues: true,
        runtimeLeases: true,
      },
      transports: {
        stdio: true,
        streamableHttp: true,
        legacySse: false,
        websocket: false,
      },
      oauth: {
        authorizationCode: false,
        clientCredentials: false,
      },
      features: {
        sampling: context?.hasUI === true,
        elicitationForm: context?.hasUI === true,
        elicitationUrl: context?.hasUI === true && context.mode === "tui",
        toolApproval: false,
        resources: true,
        pluginToolAliases: false,
      },
    };
  }

  async validateSource(
    registration: McpSourceRegistration,
    signal: AbortSignal,
  ): Promise<McpSourceValidationResult> {
    throwIfAborted(signal);
    if (!registrationIsValid(registration)) {
      return { ok: false, diagnostics: [invalidDiagnostic("validateMcpSource")] };
    }
    const copy = cloneJson(registration);
    throwIfAborted(signal);
    return { ok: true, value: copy, diagnostics: [] };
  }

  private async exclusive<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    throwIfAborted(signal);
    const previous = this.operationTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.operationTail = previous.catch(() => undefined).then(() => gate);
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        previous.then(
          () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
          (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
      throwIfAborted(signal);
      return await operation();
    } finally {
      // An operation cancelled while queued must still release its queue slot.
      release();
    }
  }

  async replaceSource(
    request: McpSourceReplaceRequest,
    signal: AbortSignal,
  ): Promise<McpSourceReplaceResult> {
    return this.exclusive(signal, async () => {
      const validation = await this.validateSource(request.registration, signal);
      if (!validation.ok) return { kind: "rejected", diagnostics: validation.diagnostics };
      if (!providerShapeIsValid(request) || !isRecord(request.expected) ||
          (request.expected.kind !== "absent" && request.expected.kind !== "exact")) {
        return { kind: "rejected", diagnostics: [invalidDiagnostic("replaceMcpSource")] };
      }

      const registration = validation.value;
      const key = ownerKey(registration.source.identity);
      const previous = this.records.get(key);
      const expectedMatches = request.expected.kind === "absent"
        ? previous === undefined
        : previous !== undefined && identityIsValid(request.expected.identity) &&
          exactIdentityKey(previous.registration.source.identity) === exactIdentityKey(request.expected.identity);
      if (!expectedMatches) {
        if (previous !== undefined) {
          return { kind: "stale", currentIdentity: copyIdentity(previous.registration.source.identity) };
        }
        return { kind: "rejected", diagnostics: [invalidDiagnostic("replaceMcpSource")] };
      }

      const replacement = this.createRecord(
        cloneJson(registration),
        request.launchValues,
        request.runtimeLeases,
      );
      if (previous !== undefined) {
        try {
          await this.closeRecord(previous, signal);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          return { kind: "rejected", diagnostics: [invalidDiagnostic("replaceMcpSource", CLEANUP_FAILED)] };
        }
      }
      // Cleanup is the commit threshold. Once the old runtime authority has
      // drained, publish the complete replacement even if cancellation arrives
      // concurrently; this avoids exposing a half-reconciled source.
      this.records.set(key, replacement);
      return {
        kind: "applied",
        status: statusFor(replacement),
        ...(previous === undefined ? {} : {
          previousIdentity: copyIdentity(previous.registration.source.identity),
        }),
      };
    });
  }

  async removeSource(
    identity: McpSourceIdentity,
    signal: AbortSignal,
  ): Promise<McpSourceRemoveResult> {
    return this.exclusive(signal, async () => {
      if (!identityIsValid(identity)) throw new ProgrammaticMcpError(INVALID_SOURCE);
      const requested = cloneJson(identity);
      const key = ownerKey(requested);
      const current = this.records.get(key);
      if (current === undefined) return { kind: "absent" };
      if (exactIdentityKey(current.registration.source.identity) !== exactIdentityKey(requested)) {
        return {
          kind: "ownership-mismatch",
          requestedIdentity: requested,
          currentIdentity: copyIdentity(current.registration.source.identity),
        };
      }
      await this.closeRecord(current, signal);
      // As with replacement, exact removal commits after cleanup has drained.
      this.records.delete(key);
      return { kind: "removed" };
    });
  }

  async inspectSource(
    identity: McpSourceIdentity,
    signal: AbortSignal,
  ): Promise<McpSourceStatus | undefined> {
    throwIfAborted(signal);
    if (!identityIsValid(identity)) throw new ProgrammaticMcpError(INVALID_SOURCE);
    const record = this.records.get(ownerKey(identity));
    if (record === undefined || exactIdentityKey(record.registration.source.identity) !== exactIdentityKey(identity)) {
      return undefined;
    }
    return cloneJson(statusFor(record));
  }

  async inspectSources(signal: AbortSignal): Promise<readonly McpSourceStatus[]> {
    throwIfAborted(signal);
    return [...this.records.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, record]) => cloneJson(statusFor(record)));
  }

  private recordFor(identity: McpSourceIdentity): SourceRecord {
    if (!identityIsValid(identity)) throw new ProgrammaticMcpError(INVALID_SOURCE);
    const record = this.records.get(ownerKey(identity));
    if (record === undefined || exactIdentityKey(record.registration.source.identity) !== exactIdentityKey(identity)) {
      throw new ProgrammaticMcpError(INVALID_SOURCE);
    }
    return record;
  }

  /**
   * Resolve a record by one of its source-local server keys. Server keys
   * are derived from the exact source identity, so a key match is as exact
   * as passing the identity JSON — a stale key simply matches nothing.
   *
   * Agents read the human-readable native key from status output
   * (`nativeKey · key`) and naturally call with it, but native keys are not
   * source-local keys — pi-plugins derives opaque `mcp-server-v1:<digest>`
   * keys. Resolution is therefore phased: an exact own-property key match
   * wins globally; a key-shaped token (`mcp-server-v1:` prefix) never falls
   * back to names, so a stale key cannot be captured by another server's
   * nativeKey; otherwise a unique exact nativeKey match selects the record.
   * Native keys are plugin-local names and may repeat across sources — any
   * ambiguity rejects.
   */
  private recordForServerKey(serverKey: string): SourceRecord {
    if (typeof serverKey !== "string" || serverKey.length === 0) throw new ProgrammaticMcpError(INVALID_SOURCE);
    const records = [...this.records.values()];
    const byKey = records.filter((record) => Object.hasOwn(record.registration.source.servers, serverKey));
    if (byKey.length === 1) return byKey[0]!;
    if (byKey.length > 1 || isKeyShapedToken(serverKey)) throw new ProgrammaticMcpError(INVALID_SOURCE);
    const byName = records.filter((record) =>
      Object.values(record.registration.source.servers).some((server) => server.nativeKey === serverKey));
    if (byName.length !== 1) throw new ProgrammaticMcpError(INVALID_SOURCE);
    return byName[0]!;
  }

  /**
   * Map a caller-supplied server token to the record's source-local key,
   * under the same phased rules as recordForServerKey: exact own-property
   * keys win, key-shaped tokens never resolve via names, and a nativeKey
   * match must be unique within the record.
   */
  private resolveServerKey(record: SourceRecord, serverKey: string): string {
    const servers = record.registration.source.servers;
    if (Object.hasOwn(servers, serverKey)) return serverKey;
    if (isKeyShapedToken(serverKey)) throw new ProgrammaticMcpError(INVALID_SOURCE);
    const matches = Object.keys(servers).filter((key) => servers[key]!.nativeKey === serverKey);
    if (matches.length !== 1) throw new ProgrammaticMcpError(INVALID_SOURCE);
    return matches[0]!;
  }

  private recordForCall(
    identity: McpSourceIdentity | undefined,
    serverKey: string,
  ): { record: SourceRecord; serverKey: string } {
    const record = identity === undefined ? this.recordForServerKey(serverKey) : this.recordFor(identity);
    return { record, serverKey: this.resolveServerKey(record, serverKey) };
  }

  private bindingFor(record: SourceRecord, serverKey: string): McpRuntimeServerBinding {
    const server = record.registration.source.servers[serverKey];
    if (server === undefined) throw new ProgrammaticMcpError(INVALID_SOURCE);
    return {
      schemaVersion: 1,
      source: copyIdentity(record.registration.source.identity),
      serverKey,
      componentId: server.componentId,
      transport: server.transport,
    };
  }

  async openExecution(
    identity: McpSourceIdentity,
    serverKey: string,
    signal: AbortSignal,
  ): Promise<ProgrammaticExecution> {
    throwIfAborted(signal);
    const record = this.recordFor(identity);
    const resolvedKey = this.resolveServerKey(record, serverKey);
    const server = record.registration.source.servers[resolvedKey]!;
    const binding = this.bindingFor(record, resolvedKey);
    let lease: McpRuntimeLease | undefined;
    let values: McpLaunchValues | undefined;
    let connection: ProgrammaticConnection | undefined;
    let primaryFailure: unknown;
    record.serverStatus.set(resolvedKey, { state: "connecting" });

    try {
      lease = await record.runtimeLeases.acquire(binding, signal);
      throwIfAborted(signal);
      const manager = this.manager;
      if (manager === undefined) throw new ProgrammaticMcpError(ADAPTER_FAILED);
      const internalKey = qualifiedServerKey(identity, resolvedKey);
      const existing = manager.getConnection(internalKey) as ProgrammaticConnection | undefined;
      if (existing?.status === "connected") {
        connection = existing;
      } else {
        values = await record.launchValues.resolve(binding, signal);
        throwIfAborted(signal);
        if (!launchValuesAreValid(values, server.transport)) {
          throw new ProgrammaticMcpError(INVALID_SOURCE);
        }
        connection = await manager.connect(
          internalKey,
          serverDefinition(server, values),
          signal,
          {
            allowLegacySseFallback: false,
            retainedDefinition: retainedDefinition(server),
            values: "resolved",
          },
        ) as ProgrammaticConnection;
        // Warm the discovery inventory on every fresh connect so any
        // successful operation (list, call, schema) makes the server's tools
        // visible in the system prompt from the next turn — and from the next
        // session via the persisted cache. Discovery data is best-effort and
        // must never fail the operation that produced it.
        try {
          const visible = connection.tools
            .filter((tool) => toolVisibilityFilter(server.options as Record<string, unknown>)(tool.name));
          this.warmInventory(internalKey, visible);
        } catch {
          // best-effort
        }
      }
      throwIfAborted(signal);
    } catch (error) {
      primaryFailure = signal.aborted ? signal.reason : error;
    } finally {
      if (values !== undefined) {
        try {
          await record.launchValues.dispose(values);
        } catch {
          if (!signal.aborted) primaryFailure = new ProgrammaticMcpError(CLEANUP_FAILED);
        }
      }
      if (primaryFailure !== undefined && lease !== undefined) {
        try {
          await record.runtimeLeases.release(lease, new AbortController().signal);
        } catch {
          if (!signal.aborted) primaryFailure = new ProgrammaticMcpError(CLEANUP_FAILED);
        }
      }
    }

    if (primaryFailure !== undefined) {
      if (connection !== undefined && this.manager !== undefined) {
        await this.manager.close(qualifiedServerKey(identity, resolvedKey));
      }
      record.serverStatus.set(resolvedKey, {
        state: "failed",
        errorCode: signal.aborted ? CANCELLED : primaryFailure instanceof ProgrammaticMcpError
          ? primaryFailure.code
          : ADAPTER_FAILED,
      });
      throw primaryFailure instanceof ProgrammaticMcpError || signal.aborted
        ? primaryFailure
        : new ProgrammaticMcpError(ADAPTER_FAILED);
    }
    if (lease === undefined || connection === undefined) throw new ProgrammaticMcpError(CLEANUP_FAILED);
    if (connection.status === "needs-auth") {
      await record.runtimeLeases.release(lease, new AbortController().signal);
      record.serverStatus.set(resolvedKey, { state: "needs-auth" });
      throw new ProgrammaticMcpError(ADAPTER_FAILED);
    }

    const executionController = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const execution: ExecutionState = {
      controller: executionController,
      lease,
      closed: false,
      done,
      finish,
    };
    record.executions.add(execution);
    record.serverStatus.set(resolvedKey, {
      state: "connected",
      toolCount: connection.tools.length,
    });

    return {
      connection,
      signal: AbortSignal.any([signal, executionController.signal]),
      close: async (closeSignal = new AbortController().signal) => {
        if (execution.closed) return;
        await record.runtimeLeases.release(execution.lease, closeSignal);
        execution.closed = true;
        record.executions.delete(execution);
        execution.finish();
      },
    };
  }

  async callTool(
    identity: McpSourceIdentity | undefined,
    serverKey: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const { record, serverKey: resolvedKey } = this.recordForCall(identity, serverKey);
    const server = record.registration.source.servers[resolvedKey]!;
    const options = server.options as Record<string, unknown>;
    const allowed = Array.isArray(options.allowedTools)
      ? new Set(options.allowedTools.filter((value): value is string => typeof value === "string"))
      : undefined;
    const denied = Array.isArray(options.deniedTools)
      ? new Set(options.deniedTools.filter((value): value is string => typeof value === "string"))
      : undefined;
    if ((allowed !== undefined && !allowed.has(tool)) || denied?.has(tool)) {
      throw new ProgrammaticMcpError(INVALID_SOURCE);
    }
    const execution = await this.openExecution(record.registration.source.identity, resolvedKey, signal);
    try {
      return await execution.connection.client.callTool(
        { name: tool, arguments: args },
        undefined,
        { signal: execution.signal },
      );
    } finally {
      await execution.close(new AbortController().signal);
    }
  }

  async listTools(
    identity: McpSourceIdentity | undefined,
    serverKey: string,
    signal: AbortSignal,
  ): Promise<readonly { identity: string; name: string; description?: string; inputSchema?: unknown }[]> {
    const { record, serverKey: resolvedKey } = this.recordForCall(identity, serverKey);
    const server = record.registration.source.servers[resolvedKey]!;
    const execution = await this.openExecution(record.registration.source.identity, resolvedKey, signal);
    try {
      const qualifier = qualifiedServerKey(record.registration.source.identity, resolvedKey);
      const isVisible = toolVisibilityFilter(server.options as Record<string, unknown>);
      return execution.connection.tools
        .filter((tool) => isVisible(tool.name))
        .map((tool) => ({
          identity: `${qualifier}:${tool.name}`,
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        }));
    } finally {
      await execution.close(new AbortController().signal);
    }
  }

  /**
   * Fan out listTools across every server in one source and filter by
   * name/description. A server that will not start is reported as
   * unsearchable rather than sinking the whole query — best-effort like
   * every other hook/inspection boundary in the host.
   */
  async searchTools(
    identity: McpSourceIdentity | undefined,
    query: string,
    options: Readonly<{ regex?: boolean; limit?: number }>,
    signal: AbortSignal,
  ): Promise<Readonly<{
    matches: readonly Readonly<{ server: string; nativeKey: string; name: string; description?: string }>[];
    unavailableServers: readonly string[];
  }>> {
    throwIfAborted(signal);
    if (typeof query !== "string" || query.length === 0 || query.length > SEARCH_MAX_QUERY_LENGTH) {
      throw new ProgrammaticMcpError(INVALID_SEARCH);
    }
    const records = identity === undefined ? [...this.records.values()] : [this.recordFor(identity)];
    let matcher: (text: string) => boolean;
    if (options.regex === true) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(query, "iu");
      } catch {
        throw new ProgrammaticMcpError(INVALID_SEARCH);
      }
      matcher = (text) => pattern.test(text);
    } else {
      const needle = query.toLocaleLowerCase("en-US");
      matcher = (text) => text.toLocaleLowerCase("en-US").includes(needle);
    }
    const limit = options.limit ?? SEARCH_DEFAULT_LIMIT;
    const matches: { server: string; nativeKey: string; name: string; description?: string }[] = [];
    const unavailableServers: string[] = [];
    for (const record of records) {
      for (const key of Object.keys(record.registration.source.servers).sort(compareText)) {
        let tools: readonly { name: string; description?: string }[];
        try {
          tools = await this.listTools(undefined, key, signal);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          unavailableServers.push(key);
          continue;
        }
        for (const tool of tools) {
          if (!matcher(tool.name) && !(tool.description !== undefined && matcher(tool.description))) continue;
          matches.push({
            server: key,
            nativeKey: record.registration.source.servers[key]!.nativeKey,
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
          });
          if (matches.length >= limit) return Object.freeze({ matches: Object.freeze(matches), unavailableServers: Object.freeze(unavailableServers) });
        }
      }
    }
    return Object.freeze({ matches: Object.freeze(matches), unavailableServers: Object.freeze(unavailableServers) });
  }

  private ensureInventoryLoaded(): void {
    if (this.inventoryLoaded) return;
    this.inventoryLoaded = true;
    const cache = loadProgrammaticCache();
    if (cache === null) return;
    for (const [key, entry] of Object.entries(cache.servers)) {
      this.inventory.set(key, { tools: entry.tools, cachedAt: entry.cachedAt });
    }
  }

  private warmInventory(
    qualifiedKey: string,
    tools: readonly { name: string; description?: string; inputSchema?: unknown }[],
  ): void {
    this.ensureInventoryLoaded();
    this.inventory.set(qualifiedKey, {
      tools: tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
      })),
      cachedAt: Date.now(),
    });
    const schemas = new Map<string, unknown>();
    for (const tool of tools) {
      if (tool.inputSchema !== undefined) schemas.set(tool.name, tool.inputSchema);
    }
    this.schemaMemory.set(qualifiedKey, schemas);
    // Prune entries whose source is no longer registered, then persist. The
    // save is a full replace so pruned keys actually disappear.
    const live = new Set<string>();
    for (const record of this.records.values()) {
      for (const key of Object.keys(record.registration.source.servers)) {
        live.add(qualifiedServerKey(record.registration.source.identity, key));
      }
    }
    for (const key of [...this.inventory.keys()]) {
      if (!live.has(key)) this.inventory.delete(key);
    }
    try {
      saveProgrammaticCache({
        version: 1,
        servers: Object.fromEntries(this.inventory.entries()),
      });
    } catch {
      // best-effort: a cache write failure must never fail an MCP operation
    }
  }

  /**
   * Cached visible tools for one server, or undefined when the server has
   * never been reached (in this or a previous session). Class-internal
   * gateway support — deliberately not on the McpProgrammaticRuntime
   * package boundary.
   */
  cachedServerTools(
    identity: McpSourceIdentity,
    serverKey: string,
  ): readonly ProgrammaticCachedTool[] | undefined {
    this.ensureInventoryLoaded();
    try {
      const record = this.recordFor(identity);
      const resolved = this.resolveServerKey(record, serverKey);
      return this.inventory.get(qualifiedServerKey(record.registration.source.identity, resolved))?.tools;
    } catch {
      return undefined;
    }
  }

  /**
   * Same-session schema lookup used to enrich tool errors — warm after any
   * successful connect, so a failed call can append the exact input schema
   * without another round-trip. Never launches a server.
   */
  cachedToolSchema(
    identity: McpSourceIdentity | undefined,
    serverKey: string,
    tool: string,
  ): unknown | undefined {
    try {
      const { record, serverKey: resolved } = this.recordForCall(identity, serverKey);
      return this.schemaMemory.get(qualifiedServerKey(record.registration.source.identity, resolved))?.get(tool);
    } catch {
      return undefined;
    }
  }

  /**
   * Batched schema fetch for the gateway's schema action: one server launch
   * (via listTools, which also warms the inventory) serves any number of
   * requested tools. Unknown names are reported, not thrown.
   */
  async getToolSchemas(
    identity: McpSourceIdentity | undefined,
    serverKey: string,
    toolNames: readonly string[],
    signal: AbortSignal,
  ): Promise<{
    schemas: readonly { name: string; description?: string; inputSchema?: unknown }[];
    missing: readonly string[];
  }> {
    const tools = await this.listTools(identity, serverKey, signal);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const schemas: { name: string; description?: string; inputSchema?: unknown }[] = [];
    const missing: string[] = [];
    for (const name of toolNames) {
      const found = byName.get(name);
      if (found === undefined) missing.push(name);
      else schemas.push(found);
    }
    return { schemas, missing };
  }

  private async closeExecutions(record: SourceRecord): Promise<void> {
    for (const execution of [...record.executions]) execution.controller.abort(new ProgrammaticMcpError(CANCELLED));
    for (const execution of [...record.executions]) {
      if (!execution.closed) {
        try {
          await record.runtimeLeases.release(execution.lease, new AbortController().signal);
          execution.closed = true;
          record.executions.delete(execution);
          execution.finish();
        } catch {
          throw new ProgrammaticMcpError(CLEANUP_FAILED);
        }
      }
    }
    await record.runtimeLeases.drain(new AbortController().signal);
  }

  private async closeRecord(record: SourceRecord, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await this.closeExecutions(record);
    throwIfAborted(signal);
    const manager = this.manager;
    if (manager !== undefined) {
      await Promise.all(Object.keys(record.registration.source.servers).map((serverKey) =>
        manager.close(qualifiedServerKey(record.registration.source.identity, serverKey))));
    }
  }
}
