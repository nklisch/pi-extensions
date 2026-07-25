import type { UpdateNotice } from "../../domain/update-policy.js";

export type AutomaticUpdateAuthoritySnapshot = Readonly<{
  candidate: "current" | "stale";
  source: "stable" | "changed";
  target: "current" | "stale";
  project: "trusted" | "untrusted";
  recovery: "clear" | "required";
  configuration: "valid" | "required";
  secrets: "available" | "unavailable";
  capability: "available" | "unavailable";
}>;

export type AutomaticUpdateLifecycleResult =
  | Readonly<{ kind: "changed" | "unchanged" }>
  | Readonly<{ kind: "stale" | "rolled-back" | "cancelled-before-commit" }>
  | Readonly<{ kind: "recovery-required" }>
  | Readonly<{ kind: "rejected"; code: "INCOMPATIBLE" | "UNTRUSTED" | "UNCONFIGURED" | "CAPABILITY_UNAVAILABLE" | "AVAILABLE_REVISION_CHANGED" | "CONFIGURATION_STALE" | "PROJECTION_FAILED" | "PROMOTION_FAILED" | "ABORTED" }>;

/**
 * Narrow adapter over the existing lifecycle authority. Implementations resolve
 * the exact notice candidate/target and must invoke that authority rather than
 * writing state, projections, journals, or recovery evidence directly.
 */
export interface AutomaticUpdateLifecyclePort {
  inspect(notice: UpdateNotice, signal: AbortSignal): Promise<AutomaticUpdateAuthoritySnapshot>;
  apply(notice: UpdateNotice, signal: AbortSignal): Promise<AutomaticUpdateLifecycleResult>;
}
