import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { AgentWidget, type UICtx, assembleWidgetState, formatStatusBar } from "#src/ui/agent-widget";
import type { Theme } from "#src/ui/display";
import { createTestSubagent } from "#test/helpers/make-subagent";

describe("widget projections", () => {
  it("counts running and queued records", () => {
    expect(assembleWidgetState([
      { id: "a", status: "running" }, { id: "b", status: "queued" }, { id: "c", status: "completed", completedAt: 1 },
    ], () => true)).toEqual({ runningCount: 1, queuedCount: 1, hasFinished: true, hasActive: true });
  });

  it("formats per-agent active model and runtime details", () => {
    expect(formatStatusBar({ runningCount: 1, queuedCount: 1, hasFinished: false, hasActive: true }, [
      { status: "running", modelLabel: "p/m", effectiveThinkingLevel: "high", startedAt: 1_000 },
      { status: "queued", modelLabel: "z/q", effectiveThinkingLevel: "off", startedAt: 5_000 },
    ], 6_000)).toContain("p/m · thinking: high 5.0s");
  });
});

describe("AgentWidget lifecycle read model", () => {
  let widget: AgentWidget;
  beforeEach(() => { vi.useFakeTimers(); widget = new AgentWidget(new AgentTypeRegistry(() => new Map())); });
  afterEach(() => { widget.dispose(); vi.useRealTimers(); });

  function attachUI(target = widget) {
    let factory: Parameters<UICtx["setWidget"]>[1] | undefined;
    const setWidget = vi.fn((key: string, content: Parameters<UICtx["setWidget"]>[1]) => { if (key === "agents" && content) factory = content; });
    const ui: UICtx = { setStatus: vi.fn(), setWidget };
    target.setUICtx(ui);
    const requestRender = vi.fn();
    const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
    const component = () => factory?.({ terminal: { columns: 120 }, requestRender } as any, theme);
    return { ui, setWidget, requestRender, component };
  }

  it("does not start a headless timer, then starts a UI timer for active detached work", () => {
    widget.onSubagentStarted(createTestSubagent({ status: "running", mode: "detached" }));
    expect(vi.getTimerCount()).toBe(0);
    attachUI();
    expect(vi.getTimerCount()).toBe(1);
    widget.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes an active widget at the status interval", async () => {
    const { requestRender, component } = attachUI();
    widget.onSubagentStarted(createTestSubagent({ status: "running", mode: "detached" }));
    component();
    await vi.advanceTimersByTimeAsync(499);
    expect(requestRender).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("keeps terminal detached records visible for one turn and then clears them", () => {
    const { setWidget, component } = attachUI();
    const record = createTestSubagent({ id: "finished", description: "finished", mode: "detached" });
    widget.onSubagentCompleted(record);
    expect(component()?.render().join("\n")).toContain("finished");
    widget.onTurnStart();
    expect(setWidget).toHaveBeenLastCalledWith("agents", undefined);
  });

  it("does not track joined records", () => {
    const { setWidget } = attachUI();
    widget.onSubagentStarted(createTestSubagent({ mode: "joined", status: "running" }));
    expect(setWidget).not.toHaveBeenCalled();
  });

  it("removes a cleared record and contains UI failures", () => {
    const { ui, setWidget } = attachUI();
    const record = createTestSubagent({ status: "running", mode: "detached" });
    widget.onSubagentStarted(record);
    widget.onSubagentCleared(record);
    expect(setWidget).toHaveBeenLastCalledWith("agents", undefined);
    vi.mocked(ui.setStatus).mockImplementation(() => { throw new Error("stale UI"); });
    expect(() => widget.onSubagentStarted(record)).not.toThrow();
  });
});
