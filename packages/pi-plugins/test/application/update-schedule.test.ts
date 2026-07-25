import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveUpdateSchedule, scheduleClockState } from "../../src/application/update-schedule.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());

describe("deterministic update schedules", () => {
  it("derives byte-identical bounded jitter across processes", () => {
    const request = { registrationId: `marketplace-registration-v1:sha256:${"a".repeat(64)}`, outcome: "success" as const, failureCount: 0, anchorAt: 1_000, cadence: "balanced" as const };
    const left = deriveUpdateSchedule(request, sha256);
    const right = deriveUpdateSchedule({ ...request }, sha256);
    expect(left).toEqual(right);
    expect(Math.abs(left!.jitterMs)).toBeLessThanOrEqual(30 * 60_000);
    expect(left!.dueAt).toBe(left!.anchorAt + left!.baseDelayMs + left!.jitterMs);
  });

  it("bounds failure backoff and pauses without inventing due state", () => {
    const one = deriveUpdateSchedule({ registrationId: "r", outcome: "failure", failureCount: 1, anchorAt: 10, cadence: "balanced" }, sha256)!;
    const many = deriveUpdateSchedule({ registrationId: "r", outcome: "failure", failureCount: 99, anchorAt: 10, cadence: "balanced" }, sha256)!;
    expect(one.baseDelayMs).toBe(5 * 60_000);
    expect(many.baseDelayMs).toBe(6 * 60 * 60_000);
    expect(deriveUpdateSchedule({ registrationId: "r", outcome: "success", failureCount: 0, anchorAt: 10, cadence: "paused" }, sha256)).toBeUndefined();
  });

  it("detects backward wall-clock movement without changing persisted timing", () => {
    const schedule = deriveUpdateSchedule({ registrationId: "r", outcome: "success", failureCount: 0, anchorAt: 1_000, cadence: "frequent" }, sha256)!;
    expect(scheduleClockState(schedule, 999)).toBe("regressed");
    expect(scheduleClockState(schedule, 1_000)).toBe("current");
  });
});
