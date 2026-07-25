import type { ContentDigest } from "../../domain/content-manifest.js";
import type { PluginKey } from "../../domain/identity.js";
import type { ScopeReference } from "../../domain/state/scope.js";
import type { ProjectSyncConflictResolution } from "../project-sync-contract.js";
import type { SensitiveValue } from "../sensitive-value.js";
import type {
  TrustedInstallConfigurationField,
  TrustedInstallConsentDisclosure,
  TrustedInstallConsentId,
} from "../trusted-install-contract.js";
import type { NativeControlExecutionId } from "../native-control-contract.js";
import type { NativeControlInputChannel } from "../native-control-registry.js";

export type NativeControlInputPurpose =
  | "trusted-install"
  | "trusted-install-recovery"
  | "update"
  | "uninstall"
  | "project-sync-resolution"
  | "policy-consent";

export type NativeControlInputRequest = Readonly<{
  executionId: NativeControlExecutionId;
  purpose: NativeControlInputPurpose;
  channel: NativeControlInputChannel;
  fields: readonly TrustedInstallConfigurationField[];
  consent?: TrustedInstallConsentDisclosure;
  expectedVersion?: number;
  expected: Readonly<{
    plugin?: PluginKey;
    scope?: ScopeReference;
    immutableRevision?: ContentDigest;
    executableSurfaceDigest?: ContentDigest;
    consentId?: TrustedInstallConsentId | string;
  }>;
}>;

export type NativeControlExactDecision =
  | Readonly<{ kind: "grant"; consentId: string }>
  | Readonly<{ kind: "deny"; consentId?: string }>
  | Readonly<{ kind: "confirm" }>
  | Readonly<{ kind: "uninstall"; persistentData: "keep" | "delete-confirmed" }>
  | Readonly<{ kind: "project-sync"; resolutions: readonly ProjectSyncConflictResolution[] }>;

export type NativeControlInputIssue = Readonly<{
  code:
    | "INPUT_UNKNOWN_KEY"
    | "INPUT_DUPLICATE_KEY"
    | "INPUT_REQUIRED"
    | "INPUT_SENSITIVITY_MISMATCH"
    | "INPUT_EXPECTATION_STALE"
    | "INPUT_DECISION_REQUIRED"
    | "INPUT_DOCUMENT_INVALID"
    | "INPUT_TOO_LARGE";
  key?: string;
}>;

export type NativeControlInputResult =
  | Readonly<{
      kind: "supplied";
      nonSensitive: readonly Readonly<{ key: string; value: unknown }>[];
      sensitive: readonly Readonly<{ key: string; value: SensitiveValue }>[];
      decision: NativeControlExactDecision;
    }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{
      kind: "unavailable";
      code: "NO_INPUT_CHANNEL" | "NO_TTY" | "SECRET_PROMPT_UNAVAILABLE" | "CHANNEL_UNSUPPORTED";
    }>
  | Readonly<{ kind: "invalid"; issues: readonly NativeControlInputIssue[] }>;

export interface NativeControlInputPort {
  collect(request: NativeControlInputRequest, signal: AbortSignal): Promise<NativeControlInputResult>;
}
