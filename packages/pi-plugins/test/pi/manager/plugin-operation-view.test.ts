import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createNativeControlEnvelope } from "../../../src/application/native-control-contract.js";
import { PluginOperationView } from "../../../src/pi/manager/plugin-operation-view.js";
import { trustedInstallFlowFixture } from "../../fixtures/trusted-install/plugin-install-flow.js";

const executionId = "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never;
const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text } as any;
const keybindings = { matches: (data: string, id: string) => (id.includes("cancel") || id === "app.interrupt") && data === "\u001b" } as any;

describe("plugin operation view", () => {
  it("renders long exact progress/result output bounded to the live tail without scroll keys", () => {
    const cancel = vi.fn();
    const close = vi.fn();
    const view = new PluginOperationView({ theme, keybindings, height: () => 12, cancel, close });
    for (let sequence = 1; sequence <= 60; sequence += 1) {
      view.push({ schemaVersion: 1, type: "progress", executionId, sequence, phase: `phase-${sequence}`, state: "started", safe: [] });
    }
    view.finish(createNativeControlEnvelope({ executionId, command: "status", status: "ok", human: [{ text: "界".repeat(100), escaped: false, truncated: false }] }));
    const lines = view.render(38);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.every((line) => visibleWidth(line) <= 38)).toBe(true);
    expect(lines.join("\n")).toContain("status ok");
    expect(lines[0]).toContain("earlier lines omitted");
    // Arrow keys are inert: the view always shows the live tail.
    view.handleInput("\u001b[A");
    view.handleInput("\u001b[B");
    expect(view.render(38)).toEqual(lines);
    view.handleInput("\u001b");
    expect(close).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("renders exact signed activation evidence instead of raw JSON", () => {
    const view = new PluginOperationView({ theme, keybindings, height: () => 20, cancel: vi.fn() });
    view.finish(createNativeControlEnvelope({ executionId, command: "install.run", status: "ok", data: trustedInstallFlowFixture.activationResult as never }));
    const output = view.render(80).join("\n");
    expect(output).toContain("Activation result");
    expect(output).toContain("1 skills discoverable");
    expect(output).toContain("activation-observation completed");
    expect(output).not.toContain("{\"");
  });

  it("disposes idempotently", () => {
    const view = new PluginOperationView({ theme, keybindings, height: () => 5, cancel: vi.fn() });
    view.dispose();
    view.dispose();
    expect(view.render(20)).toEqual([]);
  });
});
