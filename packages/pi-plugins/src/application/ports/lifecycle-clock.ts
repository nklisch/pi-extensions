/** State imports the clock contract from the inward domain layer. */
export { EpochMillisecondsSchema } from "../../domain/time.js";
export type { EpochMilliseconds } from "../../domain/time.js";
import type { EpochMilliseconds } from "../../domain/time.js";

export interface LifecycleClock {
  nowEpochMilliseconds(): EpochMilliseconds;
  monotonicMilliseconds(): number;
}
