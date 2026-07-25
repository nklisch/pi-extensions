import { describe, expect, it } from "vitest";
import { NativeControlStatusClause, NativeControlStatusTone, pluginManagerStatusTone, styledNativeControlStatusLine } from "../../../src/pi/manager/plugin-manager-status.js";

const theme = { fg: (_token: string, text: string) => text } as any;

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

  it("renders one shared tone-styled result line per facade status", () => {
    expect(Object.keys(NativeControlStatusClause).sort()).toEqual(Object.keys(NativeControlStatusTone).sort());
    expect(styledNativeControlStatusLine(theme, "ok")).toBe("✓ ok · done");
    expect(styledNativeControlStatusLine(theme, "unavailable")).toBe("! unavailable · couldn't finish — something it needed wasn't available");
  });
});
