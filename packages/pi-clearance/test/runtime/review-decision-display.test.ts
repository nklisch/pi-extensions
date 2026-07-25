import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import type { ResolvedReviewNotePreference } from "../../src/config/loader.ts";
import {
  createReviewDecisionDisplay,
  detectReviewDecisionDisplayCapability,
} from "../../src/runtime/review-decision-display.ts";
import type { ReviewDecisionNote } from "../../src/runtime/review-visibility.ts";

describe("review decision display", () => {
  it("detects and applies tool-call accents only for gold allow notes", () => {
    const ctx = context({ capability: "tool-call-accent" });
    const display = createReviewDecisionDisplay(ctx, preference());

    expect(display.capability).toBe("tool-call-accent");

    display.present(allowNote(), "tool-call-1");
    display.present({ text: "model denied", accent: false }, "tool-call-2");

    expect(ctx.__accentCalls).toEqual([["tool-call-1", "clearance-gold"]]);
  });

  it("uses a stable widget key for stream-widget fallback notes", () => {
    const ctx = context({ capability: "stream-widget" });
    const display = createReviewDecisionDisplay(ctx, preference());

    expect(display.capability).toBe("stream-widget");

    display.present(allowNote(), "tool-call-1");
    display.present(
      {
        text: "model allowed another command",
        detail: "glm/test",
        accent: false,
      },
      "tool-call-2",
    );

    expect(ctx.__widgetCalls).toEqual([
      ["auto-reviewer:review-note", "model allowed\nopenai-codex/gpt-test"],
      ["auto-reviewer:review-note", "model allowed another command\nglm/test"],
    ]);
  });

  it("uses notify when no stronger text surface is available", () => {
    const ctx = context({ capability: "status-notify" });
    const display = createReviewDecisionDisplay(ctx, preference());

    expect(display.capability).toBe("status-notify");

    display.present(allowNote(), "tool-call-1");
    display.present({ text: "second", accent: false }, "tool-call-2");

    expect(ctx.__notifyCalls).toEqual([
      ["model allowed\nopenai-codex/gpt-test", "info"],
      ["second", "info"],
    ]);
  });

  it("no-ops when UI is unavailable", () => {
    const ctx = context({ capability: "stream-widget", hasUI: false });
    const display = createReviewDecisionDisplay(ctx, preference());

    expect(display.capability).toBe("none");
    expect(() => display.present(allowNote(), "tool-call-1")).not.toThrow();
    expect(ctx.__widgetCalls).toEqual([]);
    expect(ctx.__notifyCalls).toEqual([]);
    expect(ctx.__accentCalls).toEqual([]);
  });

  it.each([
    "tool-call-accent",
    "stream-widget",
    "status-notify",
  ] as const)("swallows throwing %s UI methods", (capability) => {
    const ctx = context({ capability, throwUi: true });
    const display = createReviewDecisionDisplay(ctx, preference());

    expect(() => display.present(allowNote(), "tool-call-1")).not.toThrow();
  });

  it("skips text surfaces for notes without text or detail", () => {
    const ctx = context({ capability: "stream-widget" });
    const display = createReviewDecisionDisplay(ctx, preference());

    display.present({ accent: false }, "tool-call-2");

    expect(ctx.__widgetCalls).toEqual([]);
    expect(ctx.__notifyCalls).toEqual([]);
  });

  it("falls back to a minimal marker when accent-only cannot render", () => {
    // On hosts without the accent API, an accent-only allow must still
    // surface once rather than vanish.
    const ctx = context({ capability: "stream-widget" });
    const display = createReviewDecisionDisplay(ctx, preference());

    display.present({ accent: "clearance-gold" }, "tool-call-1");

    expect(ctx.__widgetCalls).toHaveLength(1);
    expect(ctx.__widgetCalls[0]?.[1]).toBe("Clearance: allowed");
  });

  it("caches capability per context", () => {
    const ctx = context({ capability: "stream-widget" });

    expect(detectReviewDecisionDisplayCapability(ctx)).toBe("stream-widget");
    ctx.__installAccentHook();

    expect(detectReviewDecisionDisplayCapability(ctx)).toBe("stream-widget");
  });
});

type FakeCapability = "tool-call-accent" | "stream-widget" | "status-notify";

type FakeContext = ExtensionContext & {
  readonly __accentCalls: readonly (readonly [string, string | undefined])[];
  readonly __widgetCalls: readonly (readonly [string, string | undefined])[];
  readonly __notifyCalls: readonly (readonly [string, string | undefined])[];
  readonly __installAccentHook: () => void;
};

function context(options: {
  readonly capability: FakeCapability;
  readonly hasUI?: boolean;
  readonly throwUi?: boolean;
}): FakeContext {
  const accentCalls: (readonly [string, string | undefined])[] = [];
  const widgetCalls: (readonly [string, string | undefined])[] = [];
  const notifyCalls: (readonly [string, string | undefined])[] = [];

  const ui: Record<string, unknown> = {};
  const installAccentHook = () => {
    ui.setToolCallAccent = (toolCallId: string, accent: string | undefined) => {
      if (options.throwUi === true) throw new Error("accent failed");
      accentCalls.push([toolCallId, accent]);
    };
  };

  if (options.capability === "tool-call-accent") {
    installAccentHook();
  }
  if (options.capability === "stream-widget") {
    ui.setWidget = (key: string, content: string | undefined) => {
      if (options.throwUi === true) throw new Error("widget failed");
      widgetCalls.push([key, content]);
    };
  }
  if (options.capability === "status-notify") {
    ui.notify = (message: string, level?: string) => {
      if (options.throwUi === true) throw new Error("notify failed");
      notifyCalls.push([message, level]);
    };
  }

  return {
    hasUI: options.hasUI ?? true,
    cwd: "/repo",
    model: { id: "fake-model", provider: "fake-provider" },
    signal: undefined,
    ui,
    sessionManager: { getSessionId: () => "review-decision-display-session" },
    isProjectTrusted: () => false,
    __accentCalls: accentCalls,
    __widgetCalls: widgetCalls,
    __notifyCalls: notifyCalls,
    __installAccentHook: installAccentHook,
  } as unknown as FakeContext;
}

function allowNote(): ReviewDecisionNote {
  return {
    text: "model allowed",
    detail: "openai-codex/gpt-test",
    accent: "clearance-gold",
  };
}

function preference(
  overrides: Partial<ResolvedReviewNotePreference> = {},
): ResolvedReviewNotePreference {
  return {
    mode: "reason+accent",
    showModelLabel: false,
    accent: true,
    ...overrides,
  };
}
