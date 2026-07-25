import type { RuntimeCapabilitySnapshot } from "../../domain/compatibility-policy.js";

/**
 * Supplies one complete runtime-fact snapshot to compatibility inspection.
 * Runtime integrations implement this port at the composition boundary.
 */
export interface RuntimeCapabilityProbe {
  snapshot(signal: AbortSignal): Promise<RuntimeCapabilitySnapshot>;
}
