import type { UpdateNotice } from "../../domain/update-policy.js";

export type AutomaticUpdateAuthoritySnapshot = Readonly<{
  candidate: "current" | "stale";
  source: "stable" | "changed";
  target: "current" | "stale";
  project: "trusted" | "untrusted";
  configuration: "valid" | "required";
  secrets: "available" | "unavailable";
  capability: "available" | "unavailable";
}>;

export type AutomaticUpdateLifecycleResult =
  | Readonly<{ kind: "changed" | "unchanged" }>
  | Readonly<{ kind: "live-next-start" }>
  | Readonly<{ kind: "degraded" }>
  | Readonly<{ kind: "stale" | "cancelled-before-commit" }>
  | Readonly<{ kind: "rejected"; code: "INCOMPATIBLE" | "UNTRUSTED" | "UNCONFIGURED" | "CAPABILITY_UNAVAILABLE" | "AVAILABLE_REVISION_CHANGED" | "CONFIGURATION_STALE" | "PROJECTION_FAILED" | "PROMOTION_FAILED" | "BUSY" | "ABORTED" }>;

/**
 * Narrow adapter over the existing lifecycle authority. Implementations resolve
 * the exact notice candidate/target and must invoke that authority rather than
 * writing state, projections, journals, or recovery evidence directly.
 */
export interface AutomaticUpdateLifecyclePort {
  inspect(notice: UpdateNotice, signal: AbortSignal): Promise<AutomaticUpdateAuthoritySnapshot>;
  apply(notice: UpdateNotice, signal: AbortSignal): Promise<AutomaticUpdateLifecycleResult>;
  /** Commit the update with activation deferred to the next start/reload. */
  defer(notice: UpdateNotice, signal: AbortSignal): Promise<AutomaticUpdateLifecycleResult>;
}
