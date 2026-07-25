import type { Model } from "@earendil-works/pi-ai";
import { providerDisplayName } from "./provider-names.js";

/**
 * Derive the identity line from a pi model object.
 *
 * Pure: reads `model.name` and `model.provider` only — no mutation, no I/O,
 * no pi runtime coupling beyond the `import type`. Same model in => same
 * string out, every call (byte-deterministic; the line-level foundation of
 * SPEC Invariant 2).
 *
 * Format: `You are {model.name} from {providerDisplayName(model.provider)}.`
 */
export function deriveIdentityLine(model: Model<any>): string {
  return `You are ${model.name} from ${providerDisplayName(model.provider)}.`;
}
