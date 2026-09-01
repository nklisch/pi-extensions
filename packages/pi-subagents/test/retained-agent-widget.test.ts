import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { AgentWidget, type UICtx, formatStatusBar } from "#src/ui/agent-widget";
import type { Theme } from "#src/ui/display";
import { createTestSubagent } from "#test/helpers/make-subagent";

function makeUI(widget: AgentWidget) {
  let factory: Parameters<UICtx["setWidget"]>[1] | undefined;
  const setWidget = vi.fn((key: string, content: Parameters<UICtx["setWidget"]>[1]) => {
    if (key === "agents" && content) factory = content;
  });
  const setStatus = vi.fn();
  const requestRender = vi.fn();
  widget.setUICtx({ setWidget, setStatus });
  const theme: Theme = { fg: (_color, text) => text, bold: (text) => text };
  const render = () => factory?.({ terminal: { columns: 120 }, requestRender } as any, theme)?.render().join("\n") ?? "";
  return { setWidget, setStatus, requestRender, render };
}

describe("retained AgentWidget lifecycle behavior", () => {
  let widget: AgentWidget;
  beforeEach(() => { vi.useFakeTimers(); widget = new AgentWidget(new AgentTypeRegistry(() => new Map())); });
  afterEach(() => { widget.dispose(); vi.useRealTimers(); });

  it("keeps queued models visible in the aggregate status bar", () => {
    const status = formatStatusBar({ runningCount: 0, queuedCount: 1, hasFinished: false, hasActive: true }, [
      { status: "queued", modelLabel: "provider/queued", effectiveThinkingLevel: "off", startedAt: 1000 },
    ], 2000);
    expect(status).toContain("1 queued agent");
    expect(status).toContain("provider/queued · thinking: off queued");
  });

  it("stops animation while keeping a finished widget renderable", () => {
    const ui = makeUI(widget);
    const active = createTestSubagent({ id: "same", status: "running", result: undefined, completedAt: undefined, mode: "detached" });
    widget.onSubagentStarted(active);
    expect(vi.getTimerCount()).toBe(1);
    const finished = createTestSubagent({ id: "same", mode: "detached" });
    widget.onSubagentCompleted(finished);
    expect(vi.getTimerCount()).toBe(0);
    expect(ui.render()).toContain("Test task");
  });

  it("keeps an error visible for two turns before clearing it", () => {
    const ui = makeUI(widget);
    const record = createTestSubagent({ id: "failed", mode: "detached", status: "error", error: "bad", terminalReason: "provider_failure" });
    widget.onSubagentCompleted(record);
    expect(ui.render()).toContain("error: bad");
    widget.onTurnStart();
    expect(ui.render()).toContain("error: bad");
    widget.onTurnStart();
    expect(ui.setWidget).toHaveBeenLastCalledWith("agents", undefined);
  });

  it("renders only lifecycle records instead of scanning unseen retained history", () => {
    const ui = makeUI(widget);
    const live = createTestSubagent({ id: "live", description: "live work", mode: "detached", status: "running", result: undefined, completedAt: undefined });
    widget.onSubagentStarted(live);
    widget.onSubagentCleared(createTestSubagent({ id: "unseen", description: "unseen history", mode: "detached" }));
    expect(ui.render()).toContain("live work");
    expect(ui.render()).not.toContain("unseen history");
  });

  it("stops a failing UI refresh timer instead of leaking it", () => {
    const ui = makeUI(widget);
    ui.setStatus.mockImplementation(() => { throw new Error("stale UI"); });
    widget.onSubagentStarted(createTestSubagent({ status: "running", result: undefined, completedAt: undefined, mode: "detached" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("contains independent widget and status disposal failures", () => {
    const ui = makeUI(widget);
    ui.setWidget.mockImplementation(() => { throw new Error("widget gone"); });
    ui.setStatus.mockImplementation(() => { throw new Error("status gone"); });
    expect(() => widget.dispose()).not.toThrow();
  });
});
