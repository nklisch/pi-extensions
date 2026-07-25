import { z } from "zod";

/** Wall-clock values are the only time evidence that may cross processes. */
export const EpochMillisecondsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export type EpochMilliseconds = z.infer<typeof EpochMillisecondsSchema>;
