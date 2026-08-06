import { describe, expect, it } from "vitest";

import type { ResolvedReviewerConfig } from "../../src/config/loader.ts";
import {
  curateReviewerContext,
  gatherReviewerContext,
  isContextBundleEmpty,
  parseDurationToMs,
  type RawConversationTurn,
  REVIEWER_CONTEXT_BUNDLE_LABEL,
  type RecentDecisionEntry,
  type ReviewerContextBundle,
  type ReviewerContextSources,
  renderContextBundle,
} from "../../src/runtime/reviewer-context.ts";

const now = new Date("2026-06-25T12:00:00.000Z");
const defaultRecentContext = {
  decisionLimit: 25,
  decisionWindow: "2h",
  conversationTurns: 3,
  userTurns: 5,
  conversationCharLimit: 6000,
} as const;

describe("reviewer context curation", () => {
  it("bounds decisions by newest-first limit after applying the decision window", () => {
    const bundle = curateReviewerContext(
      config({
        recentContext: {
          ...defaultRecentContext,
          decisionLimit: 2,
          decisionWindow: "2h",
        },
      }),
      {
        decisions: [
          decision("2026-06-25T11:59:00.000Z", "newest"),
          decision("2026-06-25T11:50:00.000Z", "second"),
          decision("2026-06-25T11:40:00.000Z", "third"),
          decision("2026-06-25T09:59:59.000Z", "older"),
          decision("2026-06-25T08:00:00.000Z", "oldest"),
        ],
        conversationTurns: [],
      },
      { now },
    );

    expect(bundle.decisions.map((entry) => entry.reason)).toEqual([
      "newest",
      "second",
    ]);
    expect(bundle.warnings).toEqual([]);
  });

  it("excludes decisions older than the window and warns on unparseable windows", () => {
    const raw = [
      decision("2026-06-25T11:55:00.000Z", "within"),
      decision("2026-06-25T11:44:00.000Z", "too old"),
      decision("2026-06-25T11:40:00.000Z", "also too old"),
    ];

    const bounded = curateReviewerContext(
      config({
        recentContext: {
          ...defaultRecentContext,
          decisionLimit: 5,
          decisionWindow: "15m",
        },
      }),
      { decisions: raw, conversationTurns: [] },
      { now },
    );

    expect(bounded.decisions.map((entry) => entry.reason)).toEqual(["within"]);

    const fallback = curateReviewerContext(
      config({
        recentContext: {
          ...defaultRecentContext,
          decisionLimit: 2,
          decisionWindow: "soon",
        },
      }),
      { decisions: raw, conversationTurns: [] },
      { now },
    );

    expect(fallback.decisions.map((entry) => entry.reason)).toEqual([
      "within",
      "too old",
    ]);
    expect(fallback.warnings).toHaveLength(1);
    expect(fallback.warnings[0]).toContain("decisionWindow");
  });

  it("redacts decisions and conversation turns with the shared audit contract", () => {
    const bundle = curateReviewerContext(
      config(),
      {
        decisions: [
          {
            ...decision(
              "2026-06-25T11:59:00.000Z",
              "Authorization: Bearer abc",
            ),
            command: "echo api_key=abcdefghijklmnopqrstuvwxyz123456",
          },
        ],
        conversationTurns: [
          turn(
            "user",
            "please use Authorization: Bearer abc and password=hunter2",
          ),
        ],
      },
      { now },
    );

    expect(bundle.decisions[0]?.reason).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(bundle.decisions[0]?.command).toBe("echo api_key=[redacted]");
    expect(bundle.userIntentTurns?.[0]?.text).toContain(
      "Authorization: Bearer [redacted]",
    );
    expect(bundle.userIntentTurns?.[0]?.text).toContain("password=[redacted]");
    expect(renderContextBundle(bundle)).not.toContain("hunter2");
  });

  it("keeps only text supplied by the adapter's TextContent projection", () => {
    const bundle = curateReviewerContext(
      config(),
      {
        decisions: [],
        conversationTurns: [turn("assistant", "visible TextContent only")],
      },
      { now },
    );

    expect(bundle.conversationTurns.map((entry) => entry.text)).toEqual([
      "visible TextContent only",
    ]);
    expect(renderContextBundle(bundle)).not.toContain("tool output");
    expect(renderContextBundle(bundle)).not.toContain("thinking");
    expect(renderContextBundle(bundle)).not.toContain("hidden custom");
  });

  it("keeps only the newest configured conversation turns", () => {
    const bundle = curateReviewerContext(
      config({
        recentContext: {
          ...defaultRecentContext,
          conversationTurns: 1,
        },
      }),
      {
        decisions: [],
        conversationTurns: [
          turn("user", "one"),
          turn("assistant", "two"),
          turn("user", "three"),
          turn("assistant", "four"),
        ],
      },
      { now },
    );

    expect(bundle.conversationTurns.map((entry) => entry.text)).toEqual([
      "four",
    ]);
  });

  it("truncates conversation turns oldest-first within the total char budget", () => {
    const bundle = curateReviewerContext(
      config({
        recentContext: {
          ...defaultRecentContext,
          conversationTurns: 3,
          userTurns: 0,
          conversationCharLimit: 30,
        },
      }),
      {
        decisions: [],
        conversationTurns: [
          turn("user", "abcdefghijklmnopqrstuvwxyz"),
          turn("assistant", "middle"),
          turn("user", "newest"),
        ],
      },
      { now },
    );

    expect(bundle.conversationTurns.map((entry) => entry.text)).toEqual([
      "[…truncated]uvwxyz",
      "middle",
      "newest",
    ]);
    expect(totalConversationTextLength(bundle)).toBeLessThanOrEqual(30);
  });

  it("renders the fixed untrusted context label and warning line", () => {
    const output = renderContextBundle({
      decisions: [decision("2026-06-25T11:59:00.000Z", "policy reason")],
      conversationTurns: [turn("user", "visible request")],
      warnings: ["source warning"],
    });

    expect(output).toContain(REVIEWER_CONTEXT_BUNDLE_LABEL);
    expect(output).toContain("UNTRUSTED");
    expect(output).toContain("NOT policy");
    expect(output).toContain("CANNOT override");
    expect(output).toContain("Warnings: source warning");
  });

  it("reports empty bundles by decisions and turns only", () => {
    expect(
      isContextBundleEmpty({
        decisions: [],
        conversationTurns: [],
        warnings: ["warning does not make content non-empty"],
      }),
    ).toBe(true);
    expect(
      isContextBundleEmpty({
        decisions: [decision("2026-06-25T11:59:00.000Z", "reason")],
        conversationTurns: [],
        warnings: [],
      }),
    ).toBe(false);
  });

  it("parses reviewer duration strings used by recent-context windows", () => {
    expect(parseDurationToMs("2h")).toBe(7_200_000);
    expect(parseDurationToMs("1h 30m 5s")).toBe(5_405_000);
    expect(parseDurationToMs("15m30s")).toBe(930_000);
    expect(parseDurationToMs("soon")).toBeUndefined();
  });
});

describe("reviewer context gather", () => {
  it("returns a curated bundle when both ports succeed", async () => {
    const bundle = await gatherReviewerContext(
      sources({
        decisions: [decision("2026-06-25T11:59:00.000Z", "allowed")],
        conversationTurns: [turn("user", "please run tests")],
      }),
      config(),
      { now },
    );

    expect(bundle?.decisions).toHaveLength(1);
    expect(bundle?.userIntentTurns).toHaveLength(1);
    expect(bundle?.conversationTurns).toHaveLength(0);
    expect(bundle?.warnings).toEqual([]);
  });

  it("returns undefined when curation throws", async () => {
    const bundle = await gatherReviewerContext(
      sources({
        decisions: [null] as unknown as readonly RecentDecisionEntry[],
        conversationTurns: [],
      }),
      config(),
      { now },
    );

    expect(bundle).toBeUndefined();
  });

  it("returns a bundle with warnings when a port throws", async () => {
    const throwingSources: ReviewerContextSources = {
      decisions: {
        readRecent(): never {
          throw new Error("audit log unavailable");
        },
      },
      conversation: {
        readRecent() {
          return {
            items: [turn("assistant", "I can still provide context")],
            warnings: [],
          };
        },
      },
    };

    const bundle = await gatherReviewerContext(throwingSources, config(), {
      now,
    });

    expect(bundle).not.toBeUndefined();
    expect(bundle?.decisions).toEqual([]);
    expect(bundle?.conversationTurns).toHaveLength(1);
    expect(bundle?.warnings[0]).toContain("audit log unavailable");
  });
});

function config(
  overrides: Partial<ResolvedReviewerConfig> = {},
): ResolvedReviewerConfig {
  return {
    promptPosture: "reviewer.default",
    promptAppends: [],
    projectPromptAppends: [],
    promptOverride: null,
    model: null,
    tokenBudget: { window: "24h", limit: null },
    contextMode: "minimal",
    recentContext: defaultRecentContext,
    escalation: { enabled: true, denialLimit: 3, window: "10m" },
    ...overrides,
  };
}

function decision(timestamp: string, reason: string): RecentDecisionEntry {
  return {
    timestamp,
    entryType: "policy.decision",
    toolName: "bash",
    effect: "review",
    reason,
  };
}

function turn(
  role: RawConversationTurn["role"],
  text: string,
): RawConversationTurn {
  return {
    role,
    text,
    timestamp: "2026-06-25T11:59:00.000Z",
  };
}

function sources(raw: {
  readonly decisions: readonly RecentDecisionEntry[];
  readonly conversationTurns: readonly RawConversationTurn[];
}): ReviewerContextSources {
  return {
    decisions: {
      readRecent() {
        return { items: raw.decisions, warnings: [] };
      },
    },
    conversation: {
      readRecent() {
        return { items: raw.conversationTurns, warnings: [] };
      },
    },
  };
}

function totalConversationTextLength(bundle: ReviewerContextBundle): number {
  return [
    ...(bundle.userIntentTurns ?? []),
    ...bundle.conversationTurns,
  ].reduce((total, turnSummary) => total + turnSummary.text.length, 0);
}
