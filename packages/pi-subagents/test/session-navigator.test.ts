import type { MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import { getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import type { SessionMessage } from "#src/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptOverlay } from "#src/ui/session-navigator";
import type { TranscriptSource, TranscriptSourceAvailability } from "#src/ui/session-navigation";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function staticSource(): TranscriptSource {
  return {
    getMessages: () => [],
    subscribe: () => undefined,
    streaming: () => ({ activeTools: new Map(), responseText: "" }),
    getToolDefinition: () => undefined,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TranscriptOverlay search", () => {
  it("searches complete message fields while keeping the visual match list bounded", () => {
    initTheme(undefined, false);
    const needle = "overlay phrase beyond the former search prefix";
    const messages = [{
      role: "assistant",
      content: [{ type: "text", text: `${"x".repeat(9_000)}${needle}${"y".repeat(9_000)}` }],
      timestamp: 1,
      stopReason: "stop",
    } as unknown as SessionMessage];
    const overlay = new TranscriptOverlay({
      tui: { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as unknown as TUI,
      theme,
      source: { getMessages: () => messages, subscribe: () => undefined, streaming: () => undefined, getToolDefinition: () => undefined },
      run: { modelLabel: "model", thinkingLevel: "medium", startedAt: 1_000, completedAt: () => 2_000 },
      done: vi.fn(),
      cwd: "/repo",
      markdownTheme: getMarkdownTheme(),
    });

    overlay.handleInput("/");
    overlay.handleInput(needle);
    expect(overlay.render(100).join("\\n")).toContain("1 matches");
    overlay.handleInput("\r");
    expect(overlay.render(100).join("\\n")).toContain("MATCH 1/1");
    overlay.dispose();
  });

  it("preserves a selected match and reports newly arriving matches", () => {
    initTheme(undefined, false);
    let messages: readonly SessionMessage[] = [{ role: "user", content: "needle", timestamp: 1 } as SessionMessage];
    let notify!: () => void;
    const overlay = new TranscriptOverlay({
      tui: { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as unknown as TUI,
      theme,
      source: {
        getMessages: () => messages,
        subscribe: (onChange) => { notify = onChange; return () => {}; },
        streaming: () => undefined,
        getToolDefinition: () => undefined,
      },
      run: { modelLabel: "model", thinkingLevel: "medium", startedAt: 1_000, completedAt: () => 2_000 },
      done: vi.fn(),
      cwd: "/repo",
      markdownTheme: getMarkdownTheme(),
    });
    overlay.handleInput("/");
    overlay.handleInput("needle");
    overlay.handleInput("\r");
    expect(overlay.render(100).join("\\n")).toContain("MATCH 1/1");
    messages = [...messages, { role: "assistant", content: [{ type: "text", text: "needle again" }], timestamp: 2, stopReason: "stop" } as unknown as SessionMessage];
    notify();
    expect(overlay.render(100).join("\\n")).toContain("2 matches [1/2] (+1 new)");
    overlay.dispose();
  });

  it("supports N and Shift+Enter previous navigation, then closes in two stages", () => {
    initTheme(undefined, false);
    const messages = [
      { role: "user", content: "needle one", timestamp: 1 } as SessionMessage,
      { role: "assistant", content: [{ type: "text", text: "needle two" }], timestamp: 2, stopReason: "stop" } as SessionMessage,
      { role: "user", content: "needle three", timestamp: 3 } as SessionMessage,
    ];
    const done = vi.fn();
    const overlay = new TranscriptOverlay({
      tui: { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as unknown as TUI,
      theme,
      source: { getMessages: () => messages, subscribe: () => undefined, streaming: () => undefined, getToolDefinition: () => undefined },
      run: { modelLabel: "model", thinkingLevel: "medium", startedAt: 1_000, completedAt: () => 2_000 },
      done,
      cwd: "/repo",
      markdownTheme: getMarkdownTheme(),
    });

    overlay.handleInput("/");
    overlay.handleInput("needle");
    overlay.handleInput("\r");
    expect(overlay.render(100).join("\\n")).toContain("▶ MATCH 1/3");
    overlay.handleInput("N");
    expect(overlay.render(100).join("\\n")).toContain("▶ MATCH 3/3");
    overlay.handleInput("\x1b[13;2u");
    expect(overlay.render(100).join("\\n")).toContain("▶ MATCH 2/3");

    overlay.handleInput("\x1b");
    expect(done).not.toHaveBeenCalled();
    overlay.handleInput("\x1b");
    overlay.dispose();
    expect(done).toHaveBeenCalledOnce();

    const qDone = vi.fn();
    const qOverlay = new TranscriptOverlay({
      tui: { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as unknown as TUI,
      theme,
      source: { getMessages: () => messages, subscribe: () => undefined, streaming: () => undefined, getToolDefinition: () => undefined },
      run: { modelLabel: "model", thinkingLevel: "medium", startedAt: 1_000, completedAt: () => 2_000 },
      done: qDone,
      cwd: "/repo",
      markdownTheme: getMarkdownTheme(),
    });
    qOverlay.handleInput("q");
    qOverlay.handleInput("q");
    qOverlay.dispose();
    expect(qDone).toHaveBeenCalledOnce();
  });

  it("reports match overflow instead of treating the capped list as complete", () => {
    initTheme(undefined, false);
    const messages = Array.from({ length: 51 }, (_, index) => ({
      role: "user",
      content: `needle ${index}`,
      timestamp: index,
    } as SessionMessage));
    const overlay = new TranscriptOverlay({
      tui: { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as unknown as TUI,
      theme,
      source: { getMessages: () => messages, subscribe: () => undefined, streaming: () => undefined, getToolDefinition: () => undefined },
      run: { modelLabel: "model", thinkingLevel: "medium", startedAt: 1_000, completedAt: () => 2_000 },
      done: vi.fn(),
      cwd: "/repo",
      markdownTheme: getMarkdownTheme(),
    });

    overlay.handleInput("/");
    overlay.handleInput("needle");
    expect(overlay.render(100).join("\\n")).toContain("50+ matches");
    overlay.handleInput("\r");
    expect(overlay.render(100).join("\\n")).toContain("MATCH 1/51");
    overlay.dispose();
  });

  it("enters literal search, marks matches, navigates, filters, and clears", () => {
    initTheme(undefined, false);
    const messages = [
      { role: "user", content: "needle in a haystack", timestamp: 1 } as SessionMessage,
      { role: "assistant", content: [{ type: "text", text: "needle found" }], timestamp: 2, stopReason: "stop" } as SessionMessage,
    ];
    const requestRender = vi.fn();
    const overlay = new TranscriptOverlay({
      tui: { terminal: { columns: 120, rows: 40 }, requestRender } as unknown as TUI,
      theme,
      source: { getMessages: () => messages, subscribe: () => undefined, streaming: () => undefined, getToolDefinition: () => undefined },
      run: { modelLabel: "model", thinkingLevel: "medium", startedAt: 1_000, completedAt: () => 2_000 },
      done: vi.fn(),
      cwd: "/repo",
      markdownTheme: getMarkdownTheme(),
    });

    overlay.handleInput("/");
    overlay.handleInput("needle");
    expect(overlay.render(100).join("\\n")).toContain("2 matches");
    overlay.handleInput("\r");
    expect(overlay.render(100).join("\\n")).toContain("MATCH 1/2");
    overlay.handleInput("\t");
    expect(overlay.render(100).join("\\n")).toContain("[tools]");
    expect(overlay.render(100).join("\\n")).toContain("0 matches");
    overlay.handleInput("\x1b");
    expect(overlay.render(100).join("\\n")).not.toContain("MATCH");
    overlay.dispose();
  });

  it("keeps the released and transcript-unavailable state visible in the footer", () => {
    initTheme(undefined, false);
    let availability: TranscriptSourceAvailability = { kind: "file", path: "/tmp/released.jsonl" };
    const overlay = new TranscriptOverlay({
      tui: { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as unknown as TUI,
      theme,
      source: {
        getMessages: () => [],
        subscribe: () => undefined,
        streaming: () => undefined,
        getToolDefinition: () => undefined,
        availability: () => availability,
      },
      run: { modelLabel: "model", thinkingLevel: "medium", startedAt: 1_000, completedAt: () => 2_000 },
      done: vi.fn(),
      cwd: "/repo",
      markdownTheme: getMarkdownTheme(),
    });

    expect(overlay.render(100).join("\\n")).toContain("released (snapshot)");
    availability = { kind: "unavailable", path: "/tmp/released.jsonl", error: "gone" };
    expect(overlay.render(100).join("\\n")).toContain("released / transcript unavailable");
    overlay.handleInput("/");
    expect(overlay.render(100).join("\\n")).toContain("released / transcript unavailable");
    overlay.dispose();
  });

  it("pins ordinary scroll and keeps the inspected position when search is cleared", () => {
    initTheme(undefined, false);
    const messages = Array.from({ length: 80 }, (_, index) => ({
      role: "user",
      content: `transcript line ${index}`,
      timestamp: index,
    } as SessionMessage));
    const overlay = new TranscriptOverlay({
      tui: { terminal: { columns: 120, rows: 40 }, requestRender: vi.fn() } as unknown as TUI,
      theme,
      source: { getMessages: () => messages, subscribe: () => undefined, streaming: () => undefined, getToolDefinition: () => undefined },
      run: { modelLabel: "model", thinkingLevel: "medium", startedAt: 1_000, completedAt: () => 2_000 },
      done: vi.fn(),
      cwd: "/repo",
      markdownTheme: getMarkdownTheme(),
    });

    const tail = overlay.render(100).join("\\n");
    overlay.handleInput("\x1b[H");
    const top = overlay.render(100).join("\\n");
    expect(top).not.toBe(tail);

    overlay.handleInput("/");
    overlay.handleInput("absent");
    overlay.handleInput("\x1b");
    expect(overlay.render(100).join("\\n")).toBe(top);
    overlay.dispose();
  });
});

describe("TranscriptOverlay runtime metadata", () => {
  it("shows the effective model and elapsed runtime, then stops repainting after disposal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(6_000);
    const requestRender = vi.fn();
    const tui = {
      terminal: { columns: 120, rows: 40 },
      requestRender,
    } as unknown as TUI;

    const overlay = new TranscriptOverlay({
      tui,
      theme,
      source: staticSource(),
      run: {
        modelLabel: "openai-codex/gpt-5.6-sol",
        thinkingLevel: "high",
        startedAt: 1_000,
        completedAt: () => undefined,
      },
      done: vi.fn(),
      cwd: "/repo",
      markdownTheme: {} as MarkdownTheme,
    });

    expect(overlay.render(100)[1]).toContain(
      "Subagent session · openai-codex/gpt-5.6-sol · thinking: high · 5.0s (running)",
    );

    vi.advanceTimersByTime(200);
    expect(requestRender).toHaveBeenCalledTimes(2);

    overlay.dispose();
    vi.advanceTimersByTime(200);
    expect(requestRender).toHaveBeenCalledTimes(2);
  });

  it("contains live subscription, timer, input, and disposal failures", () => {
    vi.useFakeTimers();
    const requestRender = vi.fn(() => { throw new Error("stale TUI"); });
    let notify!: () => void;
    const unsubscribe = vi.fn(() => { throw new Error("unsubscribe failed"); });
    const source: TranscriptSource = {
      getMessages: () => [],
      subscribe: (onChange) => {
        notify = onChange;
        return unsubscribe;
      },
      streaming: () => ({ activeTools: new Map(), responseText: "" }),
      getToolDefinition: () => undefined,
    };
    const done = vi.fn(() => { throw new Error("overlay closed"); });
    const tui = {
      terminal: { columns: 120, rows: 40 },
      requestRender,
    } as unknown as TUI;
    const overlay = new TranscriptOverlay({
      tui,
      theme,
      source,
      run: {
        modelLabel: "model",
        thinkingLevel: "medium",
        startedAt: 1_000,
        completedAt: () => undefined,
      },
      done,
      cwd: "/repo",
      markdownTheme: {} as MarkdownTheme,
    });

    expect(() => notify()).not.toThrow();
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(() => overlay.handleInput("q")).not.toThrow();
    expect(() => overlay.dispose()).not.toThrow();
    expect(() => overlay.dispose()).not.toThrow();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
