import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { NativePluginControlService } from "../application/native-control-service.js";
import type { McpRuntimePort } from "../application/ports/mcp-runtime.js";
import type { UpdateNotificationPublisherPort } from "../application/ports/update-notification-publisher.js";
import type { HostStartupResult } from "../application/host-observation-contract.js";
import type { NetworkEgressPolicyOptions } from "../infrastructure/network/network-egress-policy.js";
export type { HostCapabilityStatus, HostStartupResult } from "../application/host-observation-contract.js";

export const PackagedPluginHostErrorCode = {
  invalidOptions: "HOST_INVALID_OPTIONS",
  duplicateComposition: "HOST_DUPLICATE_COMPOSITION",
  duplicateSession: "HOST_DUPLICATE_SESSION",
  sessionMismatch: "HOST_SESSION_MISMATCH",
  terminal: "HOST_TERMINAL",
  reloadContextUnavailable: "PI_RELOAD_CONTEXT_UNAVAILABLE",
  startupFailed: "HOST_STARTUP_FAILED",
} as const;
export type PackagedPluginHostErrorCode =
  (typeof PackagedPluginHostErrorCode)[keyof typeof PackagedPluginHostErrorCode];

/** A redacted host-boundary failure. Native causes never enter JSON output. */
export class PackagedPluginHostError extends Error {
  readonly code: PackagedPluginHostErrorCode;

  constructor(code: PackagedPluginHostErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PackagedPluginHostError";
    this.code = code;
  }

  toJSON(): Readonly<{ code: PackagedPluginHostErrorCode; message: string }> {
    return Object.freeze({ code: this.code, message: this.message });
  }
}

export type PackagedPluginHostRuntimeParticipants = Readonly<{
  mcp?: McpRuntimePort;
}>;

export type PackagedPluginHostSourceOptions = Readonly<{
  fetch?: typeof globalThis.fetch;
  networkPolicy?: NetworkEgressPolicyOptions;
}>;

export type PackagedPluginHostOptions = Readonly<{
  pi: ExtensionAPI;
  agentDir?: string;
  source?: PackagedPluginHostSourceOptions;
  runtime?: PackagedPluginHostRuntimeParticipants;
  update?: Readonly<{ publisher?: UpdateNotificationPublisherPort }>;
}>;

export type PiSessionBinding = Readonly<{
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  mode: ExtensionContext["mode"];
  projectTrusted: boolean;
}>;

export interface PiSessionBindingPort {
  current(): PiSessionBinding;
  assertContext(context: ExtensionContext): void;
  isProjectTrusted(): boolean;
}

/** The packaged command boundary exposes one management facade only. */
export type PackagedPluginHostApplication = Readonly<{
  control: NativePluginControlService;
}>;

export type StartedPackagedPluginHost = Readonly<{
  application: PackagedPluginHostApplication;
  startup: HostStartupResult;
  close(): Promise<void>;
}>;

export interface PackagedPluginHost {
  start(event: SessionStartEvent, context: ExtensionContext): Promise<StartedPackagedPluginHost>;
  current(): StartedPackagedPluginHost | undefined;
  runWithPiOperationContext<T>(
    context: ExtensionCommandContext,
    signal: AbortSignal,
    use: (application: PackagedPluginHostApplication) => Promise<T>,
  ): Promise<T>;
  dispose(reason: SessionShutdownEvent["reason"]): Promise<void>;
}
