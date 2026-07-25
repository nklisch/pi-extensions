import { describe, expect, it, vi } from "vitest";
import { dispatchNativeControlPolicy } from "../../src/application/native-control-update-policy.js";
import { createNativeControlParser } from "../../src/application/native-control-parser.js";

const parser = createNativeControlParser();
function command(argv: string[]) { const value = parser.parseArgv(argv); if (value.kind !== "parsed" || value.command.command !== "updates.policy.set") throw new Error(JSON.stringify(value)); return value.command; }

describe("native control update policy", () => {
  it("always previews set and performs zero apply on rejected policy", async () => {
    const previewPolicy = vi.fn(async () => ({ kind: "rejected" as const, code: "INVALID_CHANGE" as const }));
    const applyPolicy = vi.fn();
    const result = await dispatchNativeControlPolicy(command(["updates", "policy", "set", "--kind", "application", "--target", "global", "--mode", "manual"]), { updates: { previewPolicy, applyPolicy } as never, selection: {} as never }, new AbortController().signal);
    expect(result).toMatchObject({ status: "rejected", data: { kind: "rejected", code: "INVALID_CHANGE" } });
    expect(previewPolicy).toHaveBeenCalledOnce();
    expect(applyPolicy).not.toHaveBeenCalled();
  });
});
