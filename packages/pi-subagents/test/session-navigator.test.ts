import type { MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptOverlay } from "#src/ui/session-navigator";
import type { TranscriptSource } from "#src/ui/session-navigation";

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
