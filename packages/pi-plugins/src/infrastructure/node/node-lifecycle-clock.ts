import { performance } from "node:perf_hooks";
import { EpochMillisecondsSchema } from "../../domain/time.js";
import type { LifecycleClock } from "../../application/ports/lifecycle-clock.js";

/** Process-wide clock identity; it owns no timer and schedules no work. */
export const nodeLifecycleClock: LifecycleClock = Object.freeze({
  nowEpochMilliseconds() {
    return EpochMillisecondsSchema.parse(Date.now());
  },
  monotonicMilliseconds() {
    return performance.now();
  },
});

export function createNodeLifecycleClock(): LifecycleClock {
  return nodeLifecycleClock;
}
