import { createHash } from "node:crypto";
import {
  McpLaunchValueRequestSchema,
  McpRuntimeCapabilitiesSchemaV1,
  McpRuntimeServerBindingSchemaV1,
  McpSourceIdentitySchemaV1,
  McpSourceRemoveResultSchema,
  McpSourceReplaceResultSchema,
  McpSourceStatusSchema,
  McpSourceValidationResultSchema,
  type McpLaunchValues,
  type McpRuntimeCapabilities,
  type McpRuntimeLease,
  type McpRuntimePort,
  type McpSourceIdentity,
  type McpSourceRegistration,
  type McpSourceReplaceRequest,
  type McpSourceStatus,
} from "../../../src/application/ports/mcp-runtime.js";
import { verifyMcpSourceRegistration } from "../../../src/application/mcp-source-registration.js";
import {
  DiagnosticSchema,
  ErrorCodeRegistry,
  ErrorCodeSchema,
  type ErrorCode,
} from "../../../src/domain/errors.js";
import {
  classifyMcpLaunchFailure,
  McpLaunchErrorCodes,
} from "../../../src/runtime/mcp/launch-error.js";

export type FakeMcpRuntimeOptions = Readonly<{
  capabilities?: McpRuntimeCapabilities;
}>;

type StoredServerRuntimeStatus = {
  state: "registered" | "idle" | "connecting" | "connected" | "needs-auth" | "failed";
  errorCode?: ErrorCode;
  toolCount?: number;
};

type StoredSource = {
  registration: McpSourceRegistration;
  launchValues: McpSourceReplaceRequest["launchValues"];
  runtimeLeases: McpSourceReplaceRequest["runtimeLeases"];
  serverStatus: Map<string, StoredServerRuntimeStatus>;
  executions: Set<ExecutionState>;
  inspectionServerKeys?: ReadonlySet<string>;
};

type ExecutionState = {
  record: StoredSource;
  lease: McpRuntimeLease;
  closed: boolean;
};

export interface FakeMcpExecution {
  close(signal?: AbortSignal): Promise<void>;
}

const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");

export class FakeMcpRuntimeLeaseProvider {
  readonly acquired: object[] = [];
  readonly released: object[] = [];
  private readonly active = new WeakSet<object>();
  private failAcquireOnce = false;
  private failReleaseOnce = false;

  failNextAcquire(): void { this.failAcquireOnce = true; }
  failNextRelease(): void { this.failReleaseOnce = true; }
  get activeCount(): number { return this.acquired.length - this.released.length; }

  async acquire(
    _binding: ReturnType<typeof McpRuntimeServerBindingSchemaV1.parse>,
    signal: AbortSignal,
  ): Promise<McpRuntimeLease> {
    signal.throwIfAborted();
    if (this.failAcquireOnce) {
      this.failAcquireOnce = false;
      throw new Error("runtime lease acquisition failed");
    }
    const token = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperties(token, {
      toString: { value: () => "[REDACTED]" },
      toJSON: { value: () => "[REDACTED]" },
      [inspectSymbol]: { value: () => "[REDACTED]" },
    });
    Object.freeze(token);
    this.active.add(token);
    this.acquired.push(token);
    return token as McpRuntimeLease;
  }

  async release(lease: McpRuntimeLease, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.failReleaseOnce) {
      this.failReleaseOnce = false;
      throw new Error("runtime lease release failed");
    }
    const token = lease as object;
    if (!this.active.has(token)) throw new Error("runtime lease ownership mismatch");
    this.active.delete(token);
    this.released.push(token);
  }

  async drain(signal: AbortSignal): Promise<void> {
    for (const token of this.acquired) {
      if (this.active.has(token)) await this.release(token as McpRuntimeLease, signal);
    }
  }
}

class FakeMcpRuntimeFailure extends Error {
  constructor(readonly code: ErrorCode) {
    super("MCP runtime operation failed");
    this.name = "FakeMcpRuntimeFailure";
  }
}

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ownerKey(identity: McpSourceIdentity): string {
  return JSON.stringify({ scope: identity.scope, plugin: identity.plugin });
}

function exactIdentityKey(identity: McpSourceIdentity): string {
  return JSON.stringify({
    schemaVersion: identity.schemaVersion,
    scope: identity.scope,
    plugin: identity.plugin,
    revision: identity.revision,
    projectionDigest: identity.projectionDigest,
  });
}

function defaultCapabilities(): McpRuntimeCapabilities {
  return McpRuntimeCapabilitiesSchemaV1.parse({
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
      authorizationCode: true,
      clientCredentials: true,
    },
    features: {
      sampling: true,
      elicitationForm: true,
      elicitationUrl: true,
      toolApproval: true,
      resources: true,
      pluginToolAliases: true,
    },
  });
}

function safeCode(value: string | undefined): ErrorCode {
  const parsed = ErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : ErrorCodeRegistry.adapterFailed;
}

function rejection(code: string | undefined, operation: string) {
  return DiagnosticSchema.parse({
    code: safeCode(code),
    severity: "error",
    operation,
    message: "MCP source operation was rejected",
    details: { sourceOperation: operation },
  });
}

function copyIdentity(identity: McpSourceIdentity): McpSourceIdentity {
  return McpSourceIdentitySchemaV1.parse(clone(identity));
}

function statusFor(
  record: StoredSource,
  state: "registered" | "replacing" | "removing" | "failed" = "registered",
): McpSourceStatus {
  const servers = Object.entries(record.registration.source.servers)
    .filter(([key]) => record.inspectionServerKeys?.has(key) ?? true)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, server]) => {
      const runtime = record.serverStatus.get(key) ?? { state: "registered" as const };
      return {
        key,
        componentId: server.componentId,
        nativeKey: server.nativeKey,
        provenance: clone(server.provenance),
        state: runtime.state,
        ...(runtime.toolCount === undefined ? {} : { toolCount: runtime.toolCount }),
        ...(runtime.errorCode === undefined ? {} : { errorCode: runtime.errorCode }),
      };
    });
  return McpSourceStatusSchema.parse({
    identity: clone(record.registration.source.identity),
    registrationDigest: record.registration.digest,
    state,
    servers,
  });
}

function copyStatus(status: McpSourceStatus): McpSourceStatus {
  return McpSourceStatusSchema.parse(clone(status));
}

function providerShapeIsValid(request: McpSourceReplaceRequest): boolean {
  return request.launchValues !== null && typeof request.launchValues === "object" &&
    typeof request.launchValues.resolve === "function" &&
    typeof request.launchValues.dispose === "function" &&
    request.runtimeLeases !== null && typeof request.runtimeLeases === "object" &&
    typeof request.runtimeLeases.acquire === "function" &&
    typeof request.runtimeLeases.release === "function" &&
    typeof request.runtimeLeases.drain === "function";
}

/**
 * Test-only source authority with deterministic failure seams. Registration is
 * local and offline; launch health and execution cleanup are separate.
 */
export class FakeMcpRuntime implements McpRuntimePort {
  private readonly records = new Map<string, StoredSource>();
  private readonly cleanupResidue = new Map<string, Readonly<{
    identity: McpSourceIdentity;
    executions: Set<ExecutionState>;
    runtimeLeases: McpSourceReplaceRequest["runtimeLeases"];
  }>>();
  private readonly runtimeCapabilities: McpRuntimeCapabilities;
  private nextReplacementFailure: ErrorCode | undefined;
  private nextReplacementEffect: "partial" | "lost-response" | undefined;
  private nextRemovalFailure: "before-effect" | "after-unregister" | undefined;

  constructor(options: FakeMcpRuntimeOptions = {}) {
    this.runtimeCapabilities = McpRuntimeCapabilitiesSchemaV1.parse(
      clone(options.capabilities ?? defaultCapabilities()),
    );
  }

  capabilities(signal: AbortSignal): Promise<McpRuntimeCapabilities> {
    signal.throwIfAborted();
    return Promise.resolve(clone(this.runtimeCapabilities));
  }

  async validateSource(registration: McpSourceRegistration, signal: AbortSignal) {
    signal.throwIfAborted();
    let verified: McpSourceRegistration;
    try {
      verified = verifyMcpSourceRegistration(registration, sha256);
    } catch {
      return McpSourceValidationResultSchema.parse({
        ok: false,
        diagnostics: [rejection(ErrorCodeRegistry.sourceInvalid, "validateMcpSource")],
      });
    }
    signal.throwIfAborted();
    return McpSourceValidationResultSchema.parse({
      ok: true,
      value: clone(verified),
      diagnostics: [],
    });
  }

  failNextReplacement(code?: string): void {
    this.nextReplacementFailure = safeCode(code);
  }

  partiallyApplyNextReplacement(): void {
    this.nextReplacementEffect = "partial";
  }

  loseNextReplacementResponse(): void {
    this.nextReplacementEffect = "lost-response";
  }

  failNextRemoval(afterUnregister = false): void {
    this.nextRemovalFailure = afterUnregister ? "after-unregister" : "before-effect";
  }

  setServerHealth(
    identity: McpSourceIdentity,
    serverKey: string,
    health: StoredServerRuntimeStatus,
  ): void {
    const record = this.records.get(ownerKey(identity));
    if (record === undefined || exactIdentityKey(record.registration.source.identity) !== exactIdentityKey(identity) ||
        record.registration.source.servers[serverKey] === undefined) {
      throw new Error("MCP source server is not registered");
    }
    record.serverStatus.set(serverKey, { ...health });
  }

  executionCount(identity?: McpSourceIdentity): number {
    if (identity === undefined) {
      return [...this.records.values()].reduce((count, record) => count + record.executions.size, 0) +
        [...this.cleanupResidue.values()].reduce((count, residue) => count + residue.executions.size, 0);
    }
    const exact = exactIdentityKey(identity);
    const record = this.records.get(ownerKey(identity));
    const active = record !== undefined && exactIdentityKey(record.registration.source.identity) === exact
      ? record.executions.size
      : 0;
    return active + (this.cleanupResidue.get(exact)?.executions.size ?? 0);
  }

  private async closeExecution(state: ExecutionState, signal: AbortSignal): Promise<void> {
    if (state.closed) return;
    await state.record.runtimeLeases.release(state.lease, signal);
    state.closed = true;
    state.record.executions.delete(state);
    this.cleanupResidue.get(exactIdentityKey(state.record.registration.source.identity))?.executions.delete(state);
  }

  private async closeAll(record: StoredSource): Promise<void> {
    const cleanupSignal = new AbortController().signal;
    for (const execution of [...record.executions]) {
      await this.closeExecution(execution, cleanupSignal);
    }
    await record.runtimeLeases.drain(cleanupSignal);
  }

  private expectedMatches(
    current: StoredSource | undefined,
    request: McpSourceReplaceRequest,
  ): boolean {
    if (request.expected.kind === "absent") return current === undefined;
    return current !== undefined &&
      exactIdentityKey(current.registration.source.identity) === exactIdentityKey(request.expected.identity);
  }

  async replaceSource(request: McpSourceReplaceRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    const validation = await this.validateSource(request.registration, signal);
    if (!validation.ok) {
      return McpSourceReplaceResultSchema.parse({
        kind: "rejected",
        diagnostics: clone(validation.diagnostics),
      });
    }
    if (!providerShapeIsValid(request)) {
      return McpSourceReplaceResultSchema.parse({
        kind: "rejected",
        diagnostics: [rejection(ErrorCodeRegistry.sourceInvalid, "replaceMcpSource")],
      });
    }

    const registration = validation.value;
    const key = ownerKey(registration.source.identity);
    const previous = this.records.get(key);
    if (!this.expectedMatches(previous, request)) {
      if (previous !== undefined) {
        return McpSourceReplaceResultSchema.parse({
          kind: "stale",
          currentIdentity: copyIdentity(previous.registration.source.identity),
        });
      }
      return McpSourceReplaceResultSchema.parse({
        kind: "rejected",
        diagnostics: [rejection(ErrorCodeRegistry.sourceInvalid, "replaceMcpSource")],
      });
    }
    if (this.nextReplacementFailure !== undefined) {
      const code = this.nextReplacementFailure;
      this.nextReplacementFailure = undefined;
      return McpSourceReplaceResultSchema.parse({
        kind: "rejected",
        diagnostics: [rejection(code, "replaceMcpSource")],
      });
    }

    // Cleanup is part of the runtime's atomic source publication contract,
    // including residue left by an unregister-before-cleanup failure.
    try {
      if (previous !== undefined) await this.closeAll(previous);
      for (const [residueKey, residue] of [...this.cleanupResidue]) {
        if (ownerKey(residue.identity) !== key) continue;
        const cleanupSignal = new AbortController().signal;
        for (const execution of [...residue.executions]) {
          await this.closeExecution(execution, cleanupSignal);
        }
        await residue.runtimeLeases.drain(cleanupSignal);
        this.cleanupResidue.delete(residueKey);
      }
    } catch {
      return McpSourceReplaceResultSchema.parse({
        kind: "rejected",
        diagnostics: [rejection(ErrorCodeRegistry.mcpLaunchCleanupFailed, "replaceMcpSource")],
      });
    }
    signal.throwIfAborted();
    const replacement: StoredSource = {
      registration: clone(registration),
      launchValues: request.launchValues,
      runtimeLeases: request.runtimeLeases,
      serverStatus: new Map(Object.keys(registration.source.servers).map((serverKey) => [serverKey, { state: "registered" as const }])),
      executions: new Set(),
    };
    const effect = this.nextReplacementEffect;
    this.nextReplacementEffect = undefined;
    if (effect === "partial") {
      replacement.inspectionServerKeys = new Set(Object.keys(registration.source.servers).slice(1));
    }
    this.records.set(key, replacement);
    if (effect === "lost-response") throw new FakeMcpRuntimeFailure(ErrorCodeRegistry.adapterFailed);
    const status = statusFor(replacement);
    return McpSourceReplaceResultSchema.parse({
      kind: "applied",
      status: copyStatus(status),
      ...(previous === undefined ? {} : {
        previousIdentity: copyIdentity(previous.registration.source.identity),
      }),
    });
  }

  async removeSource(identity: McpSourceIdentity, signal: AbortSignal) {
    signal.throwIfAborted();
    const requested = McpSourceIdentitySchemaV1.parse(clone(identity));
    const key = ownerKey(requested);
    const current = this.records.get(key);
    if (current !== undefined && exactIdentityKey(current.registration.source.identity) !== exactIdentityKey(requested)) {
      return McpSourceRemoveResultSchema.parse({
        kind: "ownership-mismatch",
        requestedIdentity: requested,
        currentIdentity: copyIdentity(current.registration.source.identity),
      });
    }
    if (this.nextRemovalFailure === "before-effect") {
      this.nextRemovalFailure = undefined;
      throw new FakeMcpRuntimeFailure(ErrorCodeRegistry.adapterFailed);
    }

    const exact = exactIdentityKey(requested);
    const residue = this.cleanupResidue.get(exact);
    if (current === undefined && residue === undefined) {
      return McpSourceRemoveResultSchema.parse({ kind: "absent" });
    }
    const executions = current?.executions ?? residue!.executions;
    if (current !== undefined && this.nextRemovalFailure === "after-unregister") {
      this.nextRemovalFailure = undefined;
      this.records.delete(key);
      this.cleanupResidue.set(exact, {
        identity: requested,
        executions,
        runtimeLeases: current.runtimeLeases,
      });
      throw new FakeMcpRuntimeFailure(ErrorCodeRegistry.mcpLaunchCleanupFailed);
    }
    try {
      const cleanupSignal = new AbortController().signal;
      for (const execution of [...executions]) await this.closeExecution(execution, cleanupSignal);
      await (current?.runtimeLeases ?? residue!.runtimeLeases).drain(cleanupSignal);
    } catch {
      // The registered record still owns its executions. Residue is used only
      // after an intentionally partial unregister-before-cleanup effect.
      throw new FakeMcpRuntimeFailure(ErrorCodeRegistry.mcpLaunchCleanupFailed);
    }
    this.cleanupResidue.delete(exact);
    this.records.delete(key);
    return McpSourceRemoveResultSchema.parse({ kind: current === undefined ? "absent" : "removed" });
  }

  async inspectSource(
    identity: McpSourceIdentity,
    signal: AbortSignal,
  ): Promise<McpSourceStatus | undefined> {
    signal.throwIfAborted();
    const requested = McpSourceIdentitySchemaV1.parse(clone(identity));
    const record = this.records.get(ownerKey(requested));
    if (record === undefined || exactIdentityKey(record.registration.source.identity) !== exactIdentityKey(requested)) {
      return undefined;
    }
    return copyStatus(statusFor(record));
  }

  async inspectSources(signal: AbortSignal): Promise<readonly McpSourceStatus[]> {
    signal.throwIfAborted();
    return [...this.records.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, record]) => copyStatus(statusFor(record)));
  }

  async openExecution(
    identity: McpSourceIdentity,
    serverKey: string,
    signal: AbortSignal,
    consume: (values: McpLaunchValues) => void | Promise<void> = () => undefined,
  ): Promise<FakeMcpExecution> {
    signal.throwIfAborted();
    const requested = McpSourceIdentitySchemaV1.parse(clone(identity));
    const record = this.records.get(ownerKey(requested));
    if (record === undefined || exactIdentityKey(record.registration.source.identity) !== exactIdentityKey(requested)) {
      throw new Error("MCP source is not registered for launch");
    }
    const server = record.registration.source.servers[serverKey];
    if (server === undefined) throw new Error("MCP server is not registered for launch");
    const binding = McpRuntimeServerBindingSchemaV1.parse({
      schemaVersion: 1,
      source: requested,
      serverKey,
      componentId: server.componentId,
      transport: server.transport,
    });

    let lease: McpRuntimeLease | undefined;
    let values: McpLaunchValues | undefined;
    let failure: unknown;
    record.serverStatus.set(serverKey, { state: "connecting" });
    try {
      lease = await record.runtimeLeases.acquire(binding, signal);
      const request = McpLaunchValueRequestSchema.parse(binding);
      values = await record.launchValues.resolve(request, signal);
      signal.throwIfAborted();
      if (values.transport !== server.transport) {
        throw new FakeMcpRuntimeFailure(McpLaunchErrorCodes.valueInvalid);
      }
      await consume(values);
      signal.throwIfAborted();
    } catch (error) {
      const code = classifyMcpLaunchFailure(error, signal);
      record.serverStatus.set(serverKey, { state: "failed", errorCode: code });
      failure = signal.aborted ? signal.reason : new FakeMcpRuntimeFailure(code);
    } finally {
      if (values !== undefined) {
        try {
          await record.launchValues.dispose(values);
        } catch {
          // Caller cancellation/timeout is the launch outcome even when
          // cleanup also fails; disposal still completes before rejection.
          if (!signal.aborted) {
            record.serverStatus.set(serverKey, {
              state: "failed",
              errorCode: McpLaunchErrorCodes.cleanupFailed,
            });
            failure = new FakeMcpRuntimeFailure(McpLaunchErrorCodes.cleanupFailed);
          }
        }
      }
      if (failure !== undefined && lease !== undefined) {
        try {
          await record.runtimeLeases.release(lease, new AbortController().signal);
        } catch {
          if (!signal.aborted) {
            record.serverStatus.set(serverKey, {
              state: "failed",
              errorCode: McpLaunchErrorCodes.cleanupFailed,
            });
            failure = new FakeMcpRuntimeFailure(McpLaunchErrorCodes.cleanupFailed);
          }
        }
      }
    }
    if (failure !== undefined) throw failure;
    if (lease === undefined) throw new FakeMcpRuntimeFailure(McpLaunchErrorCodes.cleanupFailed);

    const state: ExecutionState = { record, lease, closed: false };
    record.executions.add(state);
    record.serverStatus.set(serverKey, { state: "connected" });
    return Object.freeze({
      close: async (closeSignal = new AbortController().signal) => {
        await this.closeExecution(state, closeSignal);
      },
    });
  }

  /** Test-only one-shot execution; no production adapter uses this method. */
  async launch(
    identity: McpSourceIdentity,
    serverKey: string,
    signal: AbortSignal,
    consume: (values: McpLaunchValues) => void | Promise<void> = () => undefined,
  ): Promise<void> {
    const execution = await this.openExecution(identity, serverKey, signal, consume);
    await execution.close(new AbortController().signal);
  }
}
