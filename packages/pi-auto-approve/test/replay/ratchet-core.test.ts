import { describe, expect, it } from "vitest";

import type { DecisionEffect, PolicyRule } from "../../src/policy/core.ts";
import { always, inspectable, program } from "../../src/policy/core.ts";
import type {
  CorpusEntry,
  CorpusSource,
  ReplayCorpus,
} from "../../src/replay/history.ts";
import {
  classifyCapturedOutcome,
  effectToStatus,
  replayHistory,
} from "../../src/replay/ratchet.ts";

function rule(
  id: string,
  effect: DecisionEffect,
  match = always(),
): PolicyRule {
  return {
    id,
    effect,
    match: inspectable(match),
    reason: `reason for ${id}`,
    provenance: { source: "generated", packId: "test-pack", ruleId: id },
  };
}

function entry(overrides: Partial<CorpusEntry> = {}): CorpusEntry {
  const source = overrides.source ?? "session";
  return {
    command: "git status",
    toolName: "bash",
    source,
    sources: overrides.sources ?? [source],
    provenance: "test",
    fidelity: overrides.fidelity ?? "high",
    ...overrides,
  };
}

function corpus(
  entries: readonly CorpusEntry[],
  options: { readonly warnings?: readonly string[] } = {},
): ReplayCorpus {
  return {
    entries,
    sourceSummary: sourceSummary(entries),
    unmatchedAuditEntries: 0,
    warnings: options.warnings ?? [],
  };
}

function sourceSummary(
  entries: readonly CorpusEntry[],
): ReadonlyMap<CorpusSource, number> {
  const summary = new Map<CorpusSource, number>([
    ["session", 0],
    ["audit", 0],
    ["corpus", 0],
  ]);
  for (const item of entries) {
    summary.set(item.source, (summary.get(item.source) ?? 0) + 1);
  }
  return summary;
}

const fixedClock = () => new Date("2026-06-25T12:00:00.000Z");

describe("ratchet replay core", () => {
  it("classifies captured outcomes in priority order", () => {
    expect(
      classifyCapturedOutcome(
        entry({ expectedLabel: "fast_path", deterministicOutcome: "deny" }),
      ),
    ).toEqual({ label: "fixture-fast-path", fixtureExpected: "fast_path" });
    expect(
      classifyCapturedOutcome(entry({ expectedLabel: "review" })).label,
    ).toBe("fixture-review");
    expect(
      classifyCapturedOutcome(entry({ expectedLabel: "hard_block" })).label,
    ).toBe("fixture-hard-block");

    expect(
      classifyCapturedOutcome(
        entry({ reviewerOutcome: { mode: "model", finalEffect: "allow" } }),
      ).label,
    ).toBe("model-allow");
    expect(
      classifyCapturedOutcome(
        entry({ reviewerOutcome: { mode: "model", finalEffect: "deny" } }),
      ).label,
    ).toBe("model-deny");
    expect(
      classifyCapturedOutcome(
        entry({ reviewerOutcome: { mode: "model", finalEffect: "review" } }),
      ).label,
    ).toBe("model-review");
    expect(
      classifyCapturedOutcome(
        entry({ reviewerOutcome: { mode: "human", finalEffect: "allow" } }),
      ).label,
    ).toBe("human-allow");
    expect(
      classifyCapturedOutcome(
        entry({ reviewerOutcome: { mode: "human", finalEffect: "deny" } }),
      ).label,
    ).toBe("human-deny");
    expect(
      classifyCapturedOutcome(
        entry({ reviewerOutcome: { mode: "human", finalEffect: "review" } }),
      ).label,
    ).toBe("human-deny");
    expect(
      classifyCapturedOutcome(
        entry({
          reviewerOutcome: { mode: "block-and-log", finalEffect: "review" },
        }),
      ).label,
    ).toBe("block-and-log");

    expect(
      classifyCapturedOutcome(entry({ deterministicOutcome: "allow" })).label,
    ).toBe("deterministic-allow");
    expect(
      classifyCapturedOutcome(entry({ deterministicOutcome: "deny" })).label,
    ).toBe("deterministic-deny");
    expect(
      classifyCapturedOutcome(entry({ deterministicOutcome: "review" })).label,
    ).toBe("deterministic-review");
    expect(classifyCapturedOutcome(entry()).label).toBe("no-captured-outcome");
  });

  it("maps decision effects to replay statuses", () => {
    expect(effectToStatus("allow")).toBe("fast_path");
    expect(effectToStatus("review")).toBe("review");
    expect(effectToStatus("deny")).toBe("hard_block");
  });

  it("groups repeated commands and tallies mixed captured outcomes", async () => {
    const report = await replayHistory(
      corpus([
        entry({
          command: "git status",
          reviewerOutcome: { mode: "model", finalEffect: "allow" },
        }),
        entry({ command: "git status", deterministicOutcome: "allow" }),
      ]),
      { active: [rule("allow-git", "allow", program("git"))] },
    );
    expect(report.perCommand).toHaveLength(1);
    expect(report.perCommand[0]).toMatchObject({
      command: "git status",
      count: 2,
      executable: "git",
      status: "fast_path",
      reason: "allow-git: reason for allow-git",
    });
    expect([
      ...(report.perCommand[0]?.capturedOutcomes.entries() ?? []),
    ]).toEqual([
      ["deterministic-allow", 1],
      ["model-allow", 1],
    ]);
    expect(report.summary.byCapturedOutcome.get("model-allow")).toEqual({
      calls: 1,
      unique: 1,
    });
    expect(report.summary.modelReviewLoad).toEqual({ calls: 1, unique: 1 });
  });

  it("summarizes captured outcomes, model-review load, and redacted calls", async () => {
    const report = await replayHistory(
      corpus([
        entry({ command: "git status", deterministicOutcome: "allow" }),
        entry({
          command: "pnpm test",
          reviewerOutcome: { mode: "model", finalEffect: "deny" },
          fidelity: "redacted",
          source: "audit",
          sources: ["audit"],
        }),
        entry({
          command: "rm -rf tmp",
          reviewerOutcome: { mode: "human", finalEffect: "deny" },
        }),
      ]),
      {
        active: [
          rule("allow-git", "allow", program("git")),
          rule("deny-rm", "deny", program("rm")),
        ],
      },
    );

    expect(report.summary).toMatchObject({
      totalCalls: 3,
      totalUnique: 3,
      fastPathCalls: 1,
      reviewCalls: 1,
      hardBlockCalls: 1,
      redactedCalls: 1,
      modelReviewLoad: { calls: 1, unique: 1 },
    });
    expect(report.summary.byCapturedOutcome.get("model-deny")).toEqual({
      calls: 1,
      unique: 1,
    });
    expect(report.summary.byCapturedOutcome.get("human-deny")).toEqual({
      calls: 1,
      unique: 1,
    });
  });

  it("maps non-bash rows to unknownToolPosture and parses empty bash commands", async () => {
    const report = await replayHistory(
      corpus([
        entry({
          command: "https://example.test",
          toolName: "web_fetch",
          reviewerOutcome: { mode: "model", finalEffect: "review" },
        }),
        entry({ command: "" }),
      ]),
      { active: [rule("allow-git", "allow", program("git"))] },
      { clock: fixedClock, unknownToolPosture: "deny" },
    );

    expect(report.perCommand[0]).toMatchObject({
      command: "https://example.test",
      toolName: "web_fetch",
      status: "hard_block",
      reason: "unknown tool: web_fetch",
    });
    expect(report.perCommand[1]).toMatchObject({
      command: "",
      toolName: "bash",
      status: "review",
      reason: "no matching rule",
    });
    expect(report.topUnknownTools).toHaveLength(1);
    const unknownTool = report.topUnknownTools[0];
    expect(unknownTool).toMatchObject({
      toolName: "web_fetch",
      calls: 1,
      reviewCalls: 0,
      hardBlockCalls: 1,
      fastPathCalls: 0,
      modelReviewCalls: 1,
      capturedDenialCalls: 0,
    });
    expect([...(unknownTool?.capturedOutcomes.entries() ?? [])]).toEqual([
      ["model-review", 1],
    ]);
  });

  it("tallies multiple unknown tools separately from raw entries and excludes bash", async () => {
    const report = await replayHistory(
      corpus([
        entry({
          command: "",
          toolName: "web_fetch",
          reviewerOutcome: { mode: "model", finalEffect: "review" },
        }),
        entry({
          command: "",
          toolName: "custom_read",
          reviewerOutcome: { mode: "human", finalEffect: "deny" },
        }),
        entry({
          command: "git status",
          toolName: "bash",
          reviewerOutcome: { mode: "model", finalEffect: "deny" },
        }),
      ]),
      { active: [rule("allow-git", "allow", program("git"))] },
    );

    expect(report.topUnknownTools).toEqual([
      expect.objectContaining({
        toolName: "custom_read",
        calls: 1,
        reviewCalls: 1,
        hardBlockCalls: 0,
        fastPathCalls: 0,
        modelReviewCalls: 0,
        capturedDenialCalls: 1,
        capturedOutcomes: new Map([["human-deny", 1]]),
      }),
      expect.objectContaining({
        toolName: "web_fetch",
        calls: 1,
        reviewCalls: 1,
        hardBlockCalls: 0,
        fastPathCalls: 0,
        modelReviewCalls: 1,
        capturedDenialCalls: 0,
        capturedOutcomes: new Map([["model-review", 1]]),
      }),
    ]);
  });

  it("sorts and caps top lists consistently with per-command rows", async () => {
    const entries = Array.from({ length: 22 }, (_, index) =>
      entry({ command: `pnpm task-${index}`, deterministicOutcome: "review" }),
    );
    const report = await replayHistory(
      corpus(entries),
      {},
      {
        clock: fixedClock,
      },
    );

    expect(report.topReviewedCommands).toHaveLength(20);
    expect(
      report.topReviewedCommands.every((row) => row.status === "review"),
    ).toBe(true);
    expect(report.topReviewedExecutables).toEqual([
      expect.objectContaining({
        executable: "pnpm",
        calls: 22,
        unique: 22,
        reviewCalls: 22,
      }),
    ]);
    expect(report.topContentiousFamilies).toEqual([
      expect.objectContaining({
        executable: "pnpm",
        calls: 22,
        unique: 22,
        reviewCalls: 22,
        sampleCommands: entries.slice(0, 5).map((item) => item.command),
      }),
    ]);
  });

  it("never throws on empty or malformed corpus input and surfaces warnings", async () => {
    const empty = await replayHistory(corpus([]), {});
    expect(empty.summary.totalCalls).toBe(0);
    expect(empty.corpus.totalCalls).toBe(0);

    const malformed = await replayHistory(
      { entries: [null], warnings: "bad" } as never,
      null as never,
    );
    expect(malformed.summary.totalCalls).toBe(0);
    expect(malformed.corpus.warnings).toEqual([
      "replay corpus warnings were malformed; skipped",
      "replay corpus entry at index 0 was malformed; skipped",
    ]);
  });
});
