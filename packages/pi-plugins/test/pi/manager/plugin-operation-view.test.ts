import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createNativeControlEnvelope } from "../../../src/application/native-control-contract.js";
import { PluginOperationView } from "../../../src/pi/manager/plugin-operation-view.js";
import { trustedInstallFlowFixture } from "../../fixtures/trusted-install/plugin-install-flow.js";

const executionId = "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never;
const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text } as any;
const keybindings = { matches: (data: string, id: string) =>
  id === "tui.select.confirm" ? data === "\r" :
  (id.includes("cancel") || id === "app.interrupt") && data === "\u001b" } as any;

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
    expect(lines.join("\n")).toContain("✓ ok · done");
    expect(lines.join("\n")).not.toContain("status:");
    expect(lines[0]).toContain("earlier lines omitted");
    // Arrow keys are inert: the view always shows the live tail.
    view.handleInput("\u001b[A");
    view.handleInput("\u001b[B");
    expect(view.render(38)).toEqual(lines);
    view.handleInput("\u001b");
    expect(close).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("routes Enter to an inline child instead of closing a finished result", async () => {
    const cancel = vi.fn();
    const close = vi.fn();
    const tui = { requestRender: vi.fn() } as any;
    const view = new PluginOperationView({ theme, keybindings, height: () => 12, cancel, close, tui });
    view.finish(createNativeControlEnvelope({ executionId, command: "status", status: "ok" }));
    const childHandle = vi.fn();
    let release: ((value?: unknown) => void) | undefined;
    const pending = view.presentInline((_tui, _theme, _kb, done) => {
      release = done;
      return { handleInput: childHandle, render: () => ["child"], invalidate() {} };
    });
    view.handleInput("\r");
    expect(childHandle).toHaveBeenCalledWith("\r");
    expect(close).not.toHaveBeenCalled();
    release?.();
    await pending;
    view.handleInput("\r");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a finished result on Enter exactly like Escape, but never mid-run", () => {
    const cancel = vi.fn();
    const close = vi.fn();
    const view = new PluginOperationView({ theme, keybindings, height: () => 12, cancel, close });
    view.push({ schemaVersion: 1, type: "progress", executionId, sequence: 1, phase: "prepare", state: "started", safe: [] });
    // Still running: Enter must not cancel or close.
    view.handleInput("\r");
    expect(close).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    view.finish(createNativeControlEnvelope({ executionId, command: "status", status: "failed" }));
    expect(view.render(60).join("\n")).toContain("enter/esc close");
    view.handleInput("\r");
    expect(close).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("renders exact signed activation evidence instead of raw JSON", () => {
    const view = new PluginOperationView({ theme, keybindings, height: () => 20, cancel: vi.fn() });
    view.finish(createNativeControlEnvelope({ executionId, command: "install.run", status: "ok", data: trustedInstallFlowFixture.activationResult as never }));
    const output = view.render(80).join("\n");
    expect(output).toContain("Activation result");
    expect(output).toContain("is ready to use — 1 skill");
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
