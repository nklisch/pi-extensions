import type { ForeignStateFileObservation } from "../adoption-contract.js";

/** Fixed, read-only observations are the only filesystem effect adoption sees. */
export interface ForeignStateFilesPort {
  readAll(signal: AbortSignal): Promise<readonly ForeignStateFileObservation[]>;
}
