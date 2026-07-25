import type { ConfigurationWriteId } from "../../domain/configured-values.js";

/** Unpredictable write-id authority; application code does not import randomness. */
export interface ConfigurationWriteIdPort {
  create(signal: AbortSignal): Promise<ConfigurationWriteId>;
}
