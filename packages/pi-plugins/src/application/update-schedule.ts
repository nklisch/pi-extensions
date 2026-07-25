import { canonicalJson } from "../domain/canonical-json.js";
import {
  UpdateCadenceRegistry,
  UpdateCadenceSchema,
  UpdateScheduleMemorySchema,
  backoffDelayMs,
  type UpdateCadence,
  type UpdateScheduleMemory,
} from "../domain/update-policy.js";
import type { Sha256 } from "../domain/source.js";

export type UpdateScheduleRequest = Readonly<{
  registrationId: string;
  outcome: "success" | "failure";
  failureCount: number;
  anchorAt: number;
  cadence: UpdateCadence;
}>;

function hashUnit(evidence: unknown, sha256: Sha256): number {
  const digest = sha256(new TextEncoder().encode(`update-schedule-jitter-v1\0${canonicalJson(evidence)}`));
  if (!(digest instanceof Uint8Array) || digest.byteLength !== 32) throw new Error("SHA-256 must return exactly 32 bytes");
  let value = 0n;
  for (const byte of digest.slice(0, 8)) value = (value << 8n) | BigInt(byte);
  return Number(value % 2_000_001n) / 1_000_000 - 1;
}

/** Persist the complete deterministic tuple; restart never recomputes an existing due time. */
export function deriveUpdateSchedule(request: UpdateScheduleRequest, sha256: Sha256): UpdateScheduleMemory | undefined {
  const cadence = UpdateCadenceSchema.parse(request.cadence);
  const definition = UpdateCadenceRegistry[cadence];
  if (cadence === "paused") return undefined;
  if (!Number.isSafeInteger(request.anchorAt) || request.anchorAt < 0) throw new TypeError("schedule anchor must be epoch milliseconds");
  if (!Number.isSafeInteger(request.failureCount) || request.failureCount < 0) throw new TypeError("failure count must be nonnegative");
  const baseDelayMs = request.outcome === "success"
    ? definition.successIntervalMs
    : backoffDelayMs(Math.max(1, request.failureCount), definition.failureBaseMs, definition.failureMaxMs);
  const jitterBound = Math.min(definition.jitterMs, Math.max(0, baseDelayMs - 1));
  const jitterMs = Math.trunc(hashUnit({
    registrationId: request.registrationId,
    outcome: request.outcome,
    failureCount: request.failureCount,
    anchorAt: request.anchorAt,
    cadence,
  }, sha256) * jitterBound);
  return UpdateScheduleMemorySchema.parse({
    anchorAt: request.anchorAt,
    baseDelayMs,
    jitterMs,
    dueAt: request.anchorAt + baseDelayMs + jitterMs,
    reason: request.outcome,
  });
}

export function scheduleClockState(schedule: UpdateScheduleMemory | undefined, now: number): "current" | "regressed" {
  return schedule !== undefined && now < schedule.anchorAt ? "regressed" : "current";
}
