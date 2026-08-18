import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { CompositeSubagentObserver } from "#src/observation/composite-subagent-observer";
import { AgentWidget, type UICtx, formatStatusBar } from "#src/ui/agent-widget";
import type { Theme } from "#src/ui/display";
import { createTestSubagent } from "#test/helpers/make-subagent";
import { createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

describe("formatStatusBar", () => {
  it("shows each active model with elapsed runtime or queued state", () => {
    const text = formatStatusBar(
      { runningCount: 1, queuedCount: 1, hasFinished: false, hasActive: true },
      [
        { status: "running", modelLabel: "openai-codex/gpt-5.6-sol", effectiveThinkingLevel: "high", startedAt: 1_000 },
        { status: "queued", modelLabel: "zai/glm-5.2", effectiveThinkingLevel: "off", startedAt: 5_000 },
      ],
      6_000,
    );

    expect(text).toBe(
      "1 running, 1 queued agents · openai-codex/gpt-5.6-sol · thinking: high 5.0s, zai/glm-5.2 · thinking: off queued",
    );
  });

  it("clears when no agent is active", () => {
    expect(formatStatusBar(
      { runningCount: 0, queuedCount: 0, hasFinished: true, hasActive: false },
      [],
    )).toBeUndefined();
  });
});

describe("AgentWidget lifecycle read model", () => {
  let widget: AgentWidget;

  beforeEach(() => {
    vi.useFakeTimers();
    widget = new AgentWidget(new AgentTypeRegistry(() => new Map()));
  });

  afterEach(() => {
    widget.dispose();
    vi.useRealTimers();
  });

  function attachUI(target = widget) {
    let factory: Parameters<UICtx["setWidget"]>[1] | undefined;
    const setWidget = vi.fn((key: string, content: Parameters<UICtx["setWidget"]>[1]): void => {
      if (key === "agents" && content) factory = content;
    });
    const ui: UICtx = { setStatus: vi.fn(), setWidget };
    target.setUICtx(ui);
    const requestRender = vi.fn();
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as Theme;
    const component = () => factory?.(
      { terminal: { columns: 120 }, requestRender } as any,
      theme,
    );
    return { ui, setWidget, requestRender, component };
  }

  it("does not start a headless interval and disposes the UI timer", () => {
    const record = createTestSubagent({
      status: "running",
      invocation: { runInBackground: true },
    });

    widget.onSubagentStarted(record);
    expect(vi.getTimerCount()).toBe(0);

    attachUI();
    expect(vi.getTimerCount()).toBe(1);
    widget.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes active status at 500 ms rather than animation speed", async () => {
    const { requestRender, component } = attachUI();
    const running = createTestSubagent({
      status: "running",
      invocation: { runInBackground: true },
    });

    widget.onSubagentStarted(running);
    component();

    await vi.advanceTimersByTimeAsync(499);
    expect(requestRender).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("stops animating after completion while the finished widget remains renderable", async () => {
    const { setWidget, requestRender, component } = attachUI();
    const completed = createTestSubagent({
      id: "finished",
      description: "finished",
      status: "running",
      invocation: { runInBackground: true },
    });

    widget.onSubagentStarted(completed);
    const rendered = component();
    completed.markCompleted("done", 2_000);
    widget.onSubagentCompleted(completed);

    expect(vi.getTimerCount()).toBe(0);
    expect(setWidget).not.toHaveBeenCalledWith("agents", undefined);
    expect(rendered?.render().join("\\n")).toContain("finished");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it("refreshes from lifecycle state without scanning a large retained manager history", async () => {
    const observer = new CompositeSubagentObserver([]);
    const manager = new SubagentManager({
      createSubagentSession: async () => toSubagentSession(createSubagentSessionStub()),
      limiter: new ConcurrencyLimiter(() => 2_001),
      baseCwd: "/repo",
      observer,
    });
    try {
      const historicalIds: string[] = [];
      for (let i = 0; i < 2_000; i++) {
        historicalIds.push(manager.spawn(STUB_SNAPSHOT, "general-purpose", `old-${i}`, {
          description: `old-${i}`,
          isBackground: true,
          bypassQueue: true,
          invocation: { runInBackground: true },
        }));
      }
      await Promise.all(historicalIds.map(id => manager.getRecord(id)!.promise));

      const listAgents = vi.spyOn(manager, "listAgents");
      const timersBeforeWidget = vi.getTimerCount();
      const historicalWidget = new AgentWidget(new AgentTypeRegistry(() => new Map()));
      observer.add(historicalWidget);
      const { requestRender, component } = attachUI(historicalWidget);

      const activeId = manager.spawn(STUB_SNAPSHOT, "general-purpose", "visible work", {
        description: "visible work",
        isBackground: true,
        bypassQueue: true,
        invocation: { runInBackground: true },
      });
      await manager.getRecord(activeId)!.promise;
      expect(component()?.render().join("\\n") ?? "").toContain("visible work");

      // The stub session has already settled, so this is a static linger:
      // lifecycle-fed rendering must not leave an animation timer behind.
      await vi.advanceTimersByTimeAsync(500);
      expect(vi.getTimerCount()).toBe(timersBeforeWidget);
      expect(requestRender).not.toHaveBeenCalled();
      expect(listAgents).not.toHaveBeenCalled();

      historicalWidget.dispose();
    } finally {
      manager.dispose();
    }
  });

  it("ignores foreground lifecycle records", () => {
    const { setWidget } = attachUI();
    const foreground = createTestSubagent({
      id: "foreground",
      status: "running",
      invocation: { runInBackground: false },
    });

    widget.onSubagentStarted(foreground);
    expect(setWidget).not.toHaveBeenCalled();
  });

  it("clears finished linger entries on turn aging and disposes its timer", async () => {
    const { setWidget, requestRender, component } = attachUI();
    const completed = createTestSubagent({
      id: "completed",
      status: "running",
      invocation: { runInBackground: true },
    });

    widget.onSubagentStarted(completed);
    component();
    completed.markCompleted("done", 2_000);
    widget.onSubagentCompleted(completed);
    widget.onTurnStart();

    expect(requestRender).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(setWidget).toHaveBeenLastCalledWith("agents", undefined);
  });

  it("preserves error linger for one extra turn before clearing", () => {
    const { setWidget } = attachUI();
    const failed = createTestSubagent({
      id: "failed",
      status: "running",
      invocation: { runInBackground: true },
    });

    widget.onSubagentStarted(failed);
    failed.markError("boom", 2_000);
    widget.onSubagentCompleted(failed);
    widget.onTurnStart();
    expect(setWidget).not.toHaveBeenLastCalledWith("agents", undefined);

    widget.onTurnStart();
    expect(setWidget).toHaveBeenLastCalledWith("agents", undefined);
  });

  it("removes active entries when the manager clears the parent session", () => {
    const { setWidget } = attachUI();
    const active = createTestSubagent({
      id: "active",
      status: "running",
      invocation: { runInBackground: true },
    });

    widget.onSubagentStarted(active);
    widget.onSubagentCleared(active);

    expect(setWidget).toHaveBeenLastCalledWith("agents", undefined);
  });
});
