import { describe, expect, it } from "vitest";

import type { DecisionEffect, PolicyRule } from "../../src/policy/core.ts";
import { always, inspectable, program } from "../../src/policy/core.ts";
import type {
  CorpusEntry,
  CorpusSource,
  ReplayCorpus,
} from "../../src/replay/history.ts";
import { replayHistory } from "../../src/replay/ratchet.ts";

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

const fixedClock = () => new Date("2026-06-25T12:00:00.000Z");

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

function corpus(entries: readonly CorpusEntry[]): ReplayCorpus {
  return {
    entries,
    sourceSummary: sourceSummary(entries),
    unmatchedAuditEntries: 0,
    warnings: [],
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

describe("ratchet replay compare mode", () => {
  it("leaves compare absent without a proposed policy", async () => {
    const report = await replayHistory(
      corpus([entry({ command: "git status" })]),
      { active: [rule("allow-git", "allow", program("git"))] },
      { clock: fixedClock },
    );

    expect(report.compare).toBeUndefined();
  });

  it("populates before/after summaries, transitions, expansions, and changed rows", async () => {
    const report = await replayHistory(
      corpus([
        entry({ command: "git status" }),
        entry({ command: "pnpm test" }),
        entry({ command: "pnpm test" }),
        entry({ command: "rm -rf tmp" }),
        entry({ command: "node --version" }),
      ]),
      { active: [rule("allow-git", "allow", program("git"))] },
      {
        clock: fixedClock,
        proposedPolicy: {
          floor: [rule("deny-rm", "deny", program("rm"))],
          active: [
            rule("review-git", "review", program("git")),
            rule("allow-pnpm", "allow", program("pnpm")),
          ],
        },
      },
    );
    expect(report.summary).toMatchObject({
      totalCalls: 5,
      totalUnique: 4,
      fastPathCalls: 1,
      fastPathUnique: 1,
      reviewCalls: 4,
      reviewUnique: 3,
      hardBlockCalls: 0,
      hardBlockUnique: 0,
    });

    expect(report.compare).toBeDefined();
    expect(report.compare?.beforeSummary).toEqual(report.summary);
    expect(report.compare?.afterSummary).toMatchObject({
      totalCalls: 5,
      totalUnique: 4,
      fastPathCalls: 2,
      fastPathUnique: 1,
      reviewCalls: 2,
      reviewUnique: 2,
      hardBlockCalls: 1,
      hardBlockUnique: 1,
    });
    expect(report.compare?.changedUnique).toBe(3);
    expect(report.compare?.changedCalls).toBe(4);
    expect([...(report.compare?.transitions.entries() ?? [])]).toEqual([
      ["review->fast_path", 2],
      ["fast_path->review", 1],
      ["review->hard_block", 1],
    ]);
    expect(report.compare?.expansions).toEqual({ calls: 2, unique: 1 });
    expect(
      report.compare?.changedCommands.map((row) => [
        row.command,
        row.count,
        row.status,
      ]),
    ).toEqual([
      ["pnpm test", 2, "fast_path"],
      ["git status", 1, "review"],
      ["rm -rf tmp", 1, "hard_block"],
    ]);
  });

  it("excludes unchanged commands from transition counts and changed rows", async () => {
    const report = await replayHistory(
      corpus([
        entry({ command: "git status" }),
        entry({ command: "node --version" }),
      ]),
      { active: [rule("allow-git", "allow", program("git"))] },
      {
        clock: fixedClock,
        proposedPolicy: {
          active: [rule("allow-git", "allow", program("git"))],
        },
      },
    );

    expect(report.compare).toMatchObject({
      changedUnique: 0,
      changedCalls: 0,
      expansions: { calls: 0, unique: 0 },
      changedCommands: [],
    });
    expect([...(report.compare?.transitions.entries() ?? [])]).toEqual([]);
  });
});
