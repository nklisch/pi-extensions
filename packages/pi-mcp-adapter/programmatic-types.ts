import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;

export type McpBridgeTransport = "stdio" | "streamable-http";

export interface McpSourceIdentity {
  readonly schemaVersion: 1;
  readonly scope: Readonly<Record<string, JsonValue>>;
  readonly plugin: string;
  readonly revision: string;
  readonly projectionDigest: string;
}

export interface McpSourceServer {
  readonly componentId: string;
  readonly nativeKey: string;
  readonly transport: McpBridgeTransport;
  readonly options: Readonly<Record<string, JsonValue>>;
  readonly projection: Readonly<Record<string, JsonValue>>;
  readonly launchTemplate: Readonly<Record<string, JsonValue>>;
  readonly toolAliases: readonly Readonly<Record<string, JsonValue>>[];
  readonly provenance: readonly Readonly<Record<string, JsonValue>>[];
}

export interface McpConfigSource {
  readonly schemaVersion: 1;
  readonly identity: McpSourceIdentity;
  /** Server keys are source-local and remain qualified by `identity` internally. */
  readonly servers: Readonly<Record<string, McpSourceServer>>;
}

export interface McpSourceRegistration {
  readonly schemaVersion: 1;
  readonly source: McpConfigSource;
  /** SHA-256 of the canonical source registration bytes. */
  readonly digest: string;
}

export type McpSourcePrecondition =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "exact"; identity: McpSourceIdentity }>;

export interface McpRuntimeServerBinding {
  readonly schemaVersion: 1;
  readonly source: McpSourceIdentity;
  readonly serverKey: string;
  readonly componentId: string;
  readonly transport: McpBridgeTransport;
}

export type McpLaunchValueRequest = McpRuntimeServerBinding;

/**
 * Plaintext launch values exist only for one immediate launch/connect attempt.
 * The runtime never places them in source records, status, cache metadata, or
 * diagnostics and always calls the provider's `dispose` hook.
 */
export type McpLaunchValues =
  | Readonly<{
      transport: "stdio";
      command: string;
      args: readonly string[];
      cwd?: string;
      env?: Readonly<Record<string, string>>;
    }>
  | Readonly<{
      transport: "streamable-http";
      url: string;
      headers?: Readonly<Record<string, string>>;
      bearerToken?: string;
    }>;

export interface McpLaunchValueProvider {
  resolve(request: McpLaunchValueRequest, signal: AbortSignal): Promise<McpLaunchValues>;
  dispose(values: McpLaunchValues): void | Promise<void>;
}

/** Opaque caller-owned authority retained only for one active execution. */
export type McpRuntimeLease = Readonly<Record<PropertyKey, unknown>>;

export interface McpRuntimeLeaseProvider {
  acquire(binding: McpRuntimeServerBinding, signal: AbortSignal): Promise<McpRuntimeLease>;
  release(lease: McpRuntimeLease, signal: AbortSignal): Promise<void>;
  drain(signal: AbortSignal): Promise<void>;
}

export type McpSourceReplaceRequest = Readonly<{
  registration: McpSourceRegistration;
  expected: McpSourcePrecondition;
  launchValues: McpLaunchValueProvider;
  runtimeLeases: McpRuntimeLeaseProvider;
}>;

export interface McpDiagnostic {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly operation: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export type McpSourceValidationResult =
  | Readonly<{
      ok: true;
      value: McpSourceRegistration;
      diagnostics: readonly McpDiagnostic[];
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly McpDiagnostic[];
    }>;

export interface McpSourceServerStatus {
  readonly key: string;
  readonly componentId: string;
  readonly nativeKey: string;
  readonly provenance: readonly Readonly<Record<string, JsonValue>>[];
  readonly state: "registered" | "idle" | "connecting" | "connected" | "needs-auth" | "failed";
  readonly toolCount?: number;
  readonly errorCode?: string;
}

export interface McpSourceStatus {
  readonly identity: McpSourceIdentity;
  readonly registrationDigest: string;
  readonly state: "registered" | "replacing" | "removing" | "failed";
  readonly servers: readonly McpSourceServerStatus[];
}

export type McpSourceReplaceResult =
  | Readonly<{
      kind: "applied";
      status: McpSourceStatus;
      previousIdentity?: McpSourceIdentity;
    }>
  | Readonly<{
      kind: "stale";
      currentIdentity: McpSourceIdentity;
    }>
  | Readonly<{
      kind: "rejected";
      diagnostics: readonly McpDiagnostic[];
    }>;

export type McpSourceRemoveResult =
  | Readonly<{ kind: "removed" }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{
      kind: "ownership-mismatch";
      requestedIdentity: McpSourceIdentity;
      currentIdentity: McpSourceIdentity;
    }>;

export interface McpRuntimeCapabilities {
  readonly schemaVersion: 1;
  readonly provider?: Readonly<{
    kind: "published-package";
    packageName: string;
    version: string;
    integrity: string;
    nodeEngine: string;
    piPeerRange: string;
    contractVersion: 1;
  }>;
  readonly sourceLifecycle: Readonly<{
    initialSourcesBeforeToolRegistration: boolean;
    isolatedFileDiscovery: boolean;
    localValidation: boolean;
    atomicReplace: boolean;
    exactRemove: boolean;
    inspect: boolean;
    cancellable: boolean;
    lateLaunchValues: boolean;
    runtimeLeases: boolean;
  }>;
  readonly transports: Readonly<{
    stdio: boolean;
    streamableHttp: boolean;
    legacySse: boolean;
    websocket: boolean;
  }>;
  readonly oauth: Readonly<{
    authorizationCode: boolean;
    clientCredentials: boolean;
  }>;
  readonly features: Readonly<{
    sampling: boolean;
    elicitationForm: boolean;
    elicitationUrl: boolean;
    toolApproval: boolean;
    resources: boolean;
    pluginToolAliases: boolean;
  }>;
}

/** Documented package boundary. Transport and manager internals stay private. */
export interface McpProgrammaticRuntime {
  capabilities(signal: AbortSignal): Promise<McpRuntimeCapabilities>;
  validateSource(
    registration: McpSourceRegistration,
    signal: AbortSignal,
  ): Promise<McpSourceValidationResult>;
  replaceSource(
    request: McpSourceReplaceRequest,
    signal: AbortSignal,
  ): Promise<McpSourceReplaceResult>;
  removeSource(
    identity: McpSourceIdentity,
    signal: AbortSignal,
  ): Promise<McpSourceRemoveResult>;
  inspectSource(
    identity: McpSourceIdentity,
    signal: AbortSignal,
  ): Promise<McpSourceStatus | undefined>;
  inspectSources(signal: AbortSignal): Promise<readonly McpSourceStatus[]>;
}

export type McpInitialSource = Readonly<{
  registration: McpSourceRegistration;
  launchValues: McpLaunchValueProvider;
  runtimeLeases: McpRuntimeLeaseProvider;
}>;

export interface McpAdapterOptions {
  /** Installed synchronously before the returned extension can register tools. */
  readonly initialSources?: readonly McpInitialSource[];
  /** Existing standalone behavior remains the default. */
  readonly fileDiscovery?: "enabled" | "disabled";
}

export interface McpAdapterInstance {
  readonly extension: (pi: ExtensionAPI) => void;
  readonly runtime: McpProgrammaticRuntime;
}
