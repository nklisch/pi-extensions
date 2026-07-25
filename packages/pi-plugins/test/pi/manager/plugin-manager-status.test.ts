import { describe, expect, it } from "vitest";
import { NativeControlStatusTone, pluginManagerStatusTone } from "../../../src/pi/manager/plugin-manager-status.js";

describe("plugin manager exact status presentation", () => {
  it.each([
    ["unavailable", "error"],
    ["not-available", "error"],
    ["inactive", "muted"],
    ["unsupported", "error"],
    ["not-a-registered-status", "muted"],
  ] as const)("maps exact status %s without positive-substring inference", (status, tone) => {
    expect(pluginManagerStatusTone(status)).toBe(tone);
  });

  it("maps every typed facade status without substring inference", () => {
    expect(NativeControlStatusTone).toEqual({
      ok: "success",
      "no-change": "success",
      "input-required": "warning",
      "not-found": "warning",
      stale: "warning",
      conflict: "warning",
      unavailable: "error",
      rejected: "error",
      partial: "warning",
      "recovery-required": "error",
      cancelled: "warning",
      failed: "error",
      "presentation-required": "warning",
    });
  });
});
