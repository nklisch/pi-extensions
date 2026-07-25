import { describe, expect, it, vi } from "vitest";
import {
  evaluatePackReplayImpact,
  policyWithCandidatePack,
  summarizeReplayCompare,
} from "../../src/packs/validation.ts";
import type { ToolShape } from "../../src/parse/shape.ts";
import type {
  DecisionEffect,
  EffectivePolicy,
  PolicyPack,
  PolicyRule,
} from "../../src/policy/core.ts";
import { always, inspectable, program } from "../../src/policy/core.ts";
import type {
  CorpusEntry,
  CorpusSource,
  ReplayCorpus,
} from "../../src/replay/history.ts";
import type { ReplayCompare, ReplaySummary } from "../../src/replay/ratchet.ts";

// ---------------------------------------------------------------------------
// Fixtures (mirror test/replay/ratchet-compare.test.ts so pack replay shares
// the same compact parser/clock/corpus shape)
// ---------------------------------------------------------------------------

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

function pack(id: string, rules: readonly PolicyRule[]): PolicyPack {
  return { version: 1, id, rules };
}

function shapeFor(command: string): ToolShape {
  const executable = command.trim().split(/\s+/, 1)[0] ?? "";
  const stage =
    executable.length === 0
      ? undefined
      : {
          kind: "command" as const,
          program: {
            program: executable,
            resolvable: true,
            arguments: [],
            flags: [],
            environment: [],
            span: { start: 0, end: executable.length },
          },
          substitutions: [],
          redirects: [],
          span: { start: 0, end: command.length },
        };
  const stages = stage === undefined ? [] : [stage];

  return {
    kind: "bash",
    rawCommand: command,
    blocks:
      stage === undefined
        ? []
        : [
            {
              pipeline: {
                stages,
                pipeTargets: [],
                span: { start: 0, end: command.length },
              },
              span: { start: 0, end: command.length },
            },
          ],
    stages,
    diagnostics: [],
  };
}

const _parser = vi.fn(
  async (command: string): Promise<ToolShape> => shapeFor(command),
);
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

/** Minimal valid ReplaySummary with zero tallies, for synthetic compares. */
function emptySummary(): ReplaySummary {
  return {
    totalCalls: 0,
    totalUnique: 0,
    fastPathCalls: 0,
    fastPathUnique: 0,
    reviewCalls: 0,
    reviewUnique: 0,
    hardBlockCalls: 0,
    hardBlockUnique: 0,
    byCapturedOutcome: new Map(),
    modelReviewLoad: { calls: 0, unique: 0 },
    redactedCalls: 0,
  };
}

/** Build a synthetic ReplayCompare carrying only transition counts. */
function syntheticCompare(
  transitions: ReadonlyMap<string, number>,
  options: {
    readonly changedUnique?: number;
    readonly changedCalls?: number;
  } = {},
): ReplayCompare {
  return {
    changedUnique: options.changedUnique ?? 0,
    changedCalls: options.changedCalls ?? 0,
    transitions,
    expansions: { calls: 0, unique: 0 },
    beforeSummary: emptySummary(),
    afterSummary: emptySummary(),
    changedCommands: [],
  };
}

function transitions(
  entries: ReadonlyArray<readonly [string, number]>,
): Map<string, number> {
  return new Map(entries);
}

function regressionIssues(summary: {
  readonly issues: readonly {
    readonly code: string;
    readonly message: string;
  }[];
}): readonly { readonly code: string; readonly message: string }[] {
  return summary.issues.filter(
    (issue) => issue.code === "replay-impact-regression",
  );
}

// ---------------------------------------------------------------------------
// policyWithCandidatePack
// ---------------------------------------------------------------------------

describe("policyWithCandidatePack", () => {
  it("appends candidate rules to the active lane and preserves the floor", () => {
    const floorRule = rule("deny-rm", "deny", program("rm"));
    const allowGit = rule("allow-git", "allow", program("git"));
    const candidate = rule("allow-pnpm", "allow", program("pnpm"));
    const currentPolicy: EffectivePolicy = {
      floor: [floorRule],
      active: [allowGit],
    };

    const proposed = policyWithCandidatePack(
      currentPolicy,
      pack("pack:candidate", [candidate]),
    );

    expect(proposed.active).toEqual([allowGit, candidate]);
    // The floor lane is preserved by reference (shared, never mutated).
    expect(proposed.floor).toBe(currentPolicy.floor);
    // A new active array is allocated rather than mutating the input.
    expect(proposed.active).not.toBe(currentPolicy.active);
  });

  it("does not mutate the input policy or pack", () => {
    const allowGit = rule("allow-git", "allow", program("git"));
    const candidate = rule("allow-pnpm", "allow", program("pnpm"));
    const candidatePack = pack("pack:candidate", [candidate]);
    const currentPolicy: EffectivePolicy = { active: [allowGit] };

    policyWithCandidatePack(currentPolicy, candidatePack);

    expect(currentPolicy.active).toEqual([allowGit]);
    expect(candidatePack.rules).toEqual([candidate]);
  });

  it("treats an undefined active lane as empty", () => {
    const floorRule = rule("deny-rm", "deny", program("rm"));
    const candidate = rule("allow-pnpm", "allow", program("pnpm"));
    const currentPolicy: EffectivePolicy = { floor: [floorRule] };

    const proposed = policyWithCandidatePack(
      currentPolicy,
      pack("pack:candidate", [candidate]),
    );

    expect(proposed.active).toEqual([candidate]);
    expect(proposed.floor).toEqual([floorRule]);
  });

  it("preserves legacy rules fallback semantics for compatibility", () => {
    // decide() prefers `active ?? rules`, so a rules-only legacy policy must seed
    // the proposed active lane with those rules before appending candidate rules.
    const legacy = rule("legacy", "review", program("legacy"));
    const candidate = rule("allow-pnpm", "allow", program("pnpm"));
    const currentPolicy: EffectivePolicy = { rules: [legacy] };

    const proposed = policyWithCandidatePack(
      currentPolicy,
      pack("pack:candidate", [candidate]),
    );

    expect(proposed.rules).toBe(currentPolicy.rules);
    expect(proposed.active).toEqual([legacy, candidate]);
  });
});

// ---------------------------------------------------------------------------
// summarizeReplayCompare
// ---------------------------------------------------------------------------

describe("summarizeReplayCompare", () => {
  it("returns a not-run summary for an undefined compare", () => {
    const summary = summarizeReplayCompare(undefined);

    expect(summary.status).toBe("not-run");
    expect(summary.changedUnique).toBe(0);
    expect(summary.changedCalls).toBe(0);
    expect(summary.reviewToAllow).toBe(0);
    expect(summary.denyToAllow).toBe(0);
    expect(summary.allowToReviewOrDeny).toBe(0);
    expect(summary.changedStatuses.size).toBe(0);
    expect(summary.issues).toEqual([]);
    expect(summary.compare).toBeUndefined();
  });

  it("returns a passed summary with no changes and attaches the compare", () => {
    const compare = syntheticCompare(new Map(), {
      changedUnique: 0,
      changedCalls: 0,
    });

    const summary = summarizeReplayCompare(compare);

    expect(summary.status).toBe("passed");
    expect(summary.issues).toEqual([]);
    expect(summary.compare).toBe(compare);
  });

  it("classifies review->fast_path as expansion (passed, no issue)", () => {
    const summary = summarizeReplayCompare(
      syntheticCompare(transitions([["review->fast_path", 3]]), {
        changedUnique: 1,
        changedCalls: 3,
      }),
    );

    expect(summary.status).toBe("passed");
    expect(summary.reviewToAllow).toBe(3);
    expect(summary.denyToAllow).toBe(0);
    expect(summary.allowToReviewOrDeny).toBe(0);
    expect(summary.changedUnique).toBe(1);
    expect(summary.changedCalls).toBe(3);
    expect(regressionIssues(summary)).toEqual([]);
  });

  it("classifies fast_path->review as a regression", () => {
    const summary = summarizeReplayCompare(
      syntheticCompare(transitions([["fast_path->review", 2]])),
    );

    expect(summary.status).toBe("regression");
    expect(summary.allowToReviewOrDeny).toBe(2);
    expect(summary.reviewToAllow).toBe(0);
    const issues = regressionIssues(summary);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("fast_path->review");
    expect(issues[0]?.message).toContain("replay regression");
  });

  it("classifies fast_path->hard_block as a regression", () => {
    const summary = summarizeReplayCompare(
      syntheticCompare(transitions([["fast_path->hard_block", 1]])),
    );

    expect(summary.status).toBe("regression");
    expect(summary.allowToReviewOrDeny).toBe(1);
    expect(regressionIssues(summary)[0]?.message).toContain(
      "fast_path->hard_block",
    );
  });

  it("classifies hard_block->fast_path (deny-to-allow) as a regression", () => {
    const summary = summarizeReplayCompare(
      syntheticCompare(transitions([["hard_block->fast_path", 4]])),
    );

    expect(summary.status).toBe("regression");
    expect(summary.denyToAllow).toBe(4);
    expect(summary.allowToReviewOrDeny).toBe(0);
    expect(regressionIssues(summary)[0]?.message).toContain(
      "hard_block->fast_path",
    );
    expect(regressionIssues(summary)[0]?.message).toContain("deny→allow");
  });

  it("classifies hard_block->review as a regression", () => {
    const summary = summarizeReplayCompare(
      syntheticCompare(transitions([["hard_block->review", 2]])),
    );

    expect(summary.status).toBe("regression");
    // hard_block->review is a regression but is not captured by the named
    // reviewToAllow / denyToAllow / allowToReviewOrDeny fields; it surfaces
    // only through changedStatuses and the regression issue.
    expect(summary.denyToAllow).toBe(0);
    expect(summary.allowToReviewOrDeny).toBe(0);
    expect(summary.changedStatuses.get("hard_block->review")).toBe(2);
    expect(regressionIssues(summary)[0]?.message).toContain(
      "hard_block->review",
    );
  });

  it("does not flag review->hard_block (safe tightening)", () => {
    const summary = summarizeReplayCompare(
      syntheticCompare(transitions([["review->hard_block", 5]])),
    );

    expect(summary.status).toBe("passed");
    expect(regressionIssues(summary)).toEqual([]);
    expect(summary.changedStatuses.get("review->hard_block")).toBe(5);
  });

  it("mixed expansion and regression yields regression status with one issue", () => {
    const summary = summarizeReplayCompare(
      syntheticCompare(
        transitions([
          ["review->fast_path", 3],
          ["fast_path->review", 1],
        ]),
      ),
    );

    expect(summary.status).toBe("regression");
    expect(summary.reviewToAllow).toBe(3);
    expect(summary.allowToReviewOrDeny).toBe(1);
    expect(regressionIssues(summary)).toHaveLength(1);
    expect(regressionIssues(summary)[0]?.message).toContain(
      "fast_path->review",
    );
  });

  it("preserves changedStatuses as a Map keyed by status-transition literals", () => {
    const summary = summarizeReplayCompare(
      syntheticCompare(
        transitions([
          ["review->fast_path", 1],
          ["fast_path->review", 2],
        ]),
      ),
    );

    expect(summary.changedStatuses).toBeInstanceOf(Map);
    expect([...summary.changedStatuses.entries()]).toEqual([
      ["review->fast_path", 1],
      ["fast_path->review", 2],
    ]);
  });

  it("emits one issue per distinct regression transition, ordered by the regression set", () => {
    const summary = summarizeReplayCompare(
      syntheticCompare(
        transitions([
          ["hard_block->review", 1],
          ["fast_path->review", 2],
          ["hard_block->fast_path", 3],
          ["fast_path->hard_block", 4],
        ]),
      ),
    );

    const keys = regressionIssues(summary).map(
      (issue) =>
        issue.message.match(
          /(hard_block|fast_path)->(fast_path|review|hard_block)/,
        )?.[0],
    );
    // REGRESSION_TRANSITIONS order: hard_block->fast_path, hard_block->review,
    // fast_path->review, fast_path->hard_block.
    expect(keys).toEqual([
      "hard_block->fast_path",
      "hard_block->review",
      "fast_path->review",
      "fast_path->hard_block",
    ]);
  });
});

// ---------------------------------------------------------------------------
// evaluatePackReplayImpact (end-to-end, no command execution)
// ---------------------------------------------------------------------------

describe("evaluatePackReplayImpact", () => {
  it("reports review->fast_path expansion as passed with no command execution", async () => {
    const result = await evaluatePackReplayImpact({
      corpus: corpus([entry({ command: "pnpm test" })]),
      currentPolicy: { active: [] },
      pack: pack("pack:allow-pnpm", [
        rule("allow-pnpm", "allow", program("pnpm")),
      ]),
      clock: fixedClock,
    });

    expect(result.status).toBe("passed");
    expect(result.reviewToAllow).toBe(1);
    expect(result.denyToAllow).toBe(0);
    expect(result.allowToReviewOrDeny).toBe(0);
    expect(result.changedUnique).toBe(1);
    expect(result.changedCalls).toBe(1);
    expect(regressionIssues(result)).toEqual([]);
    expect(result.compare?.transitions.get("review->fast_path")).toBe(1);
  });

  it("surfaces fast_path->review as a regression issue", async () => {
    const result = await evaluatePackReplayImpact({
      corpus: corpus([entry({ command: "git status" })]),
      currentPolicy: { active: [rule("allow-git", "allow", program("git"))] },
      pack: pack("pack:review-git", [
        rule("review-git", "review", program("git")),
      ]),
      clock: fixedClock,
    });

    expect(result.status).toBe("regression");
    expect(result.allowToReviewOrDeny).toBe(1);
    const issues = regressionIssues(result);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("fast_path->review");
  });

  it("preserves rules-only legacy policies when building replay deltas", async () => {
    const result = await evaluatePackReplayImpact({
      corpus: corpus([
        entry({ command: "git status" }),
        entry({ command: "pnpm test" }),
      ]),
      currentPolicy: { rules: [rule("allow-git", "allow", program("git"))] },
      pack: pack("pack:allow-pnpm", [
        rule("allow-pnpm", "allow", program("pnpm")),
      ]),
      clock: fixedClock,
    });

    expect(result.status).toBe("passed");
    expect(result.reviewToAllow).toBe(1);
    expect([...result.changedStatuses.entries()]).toEqual([
      ["review->fast_path", 1],
    ]);
  });

  it("surfaces fast_path->hard_block as a regression issue", async () => {
    const result = await evaluatePackReplayImpact({
      corpus: corpus([entry({ command: "git status" })]),
      currentPolicy: { active: [rule("allow-git", "allow", program("git"))] },
      pack: pack("pack:deny-git", [rule("deny-git", "deny", program("git"))]),
      clock: fixedClock,
    });

    expect(result.status).toBe("regression");
    expect(result.allowToReviewOrDeny).toBe(1);
    expect(regressionIssues(result)[0]?.message).toContain(
      "fast_path->hard_block",
    );
  });

  it("passes with no changes when the candidate does not match", async () => {
    const result = await evaluatePackReplayImpact({
      corpus: corpus([entry({ command: "git status" })]),
      currentPolicy: { active: [rule("allow-git", "allow", program("git"))] },
      pack: pack("pack:allow-other", [
        rule("allow-other", "allow", program("other")),
      ]),
      clock: fixedClock,
    });

    expect(result.status).toBe("passed");
    expect(result.changedUnique).toBe(0);
    expect(result.changedCalls).toBe(0);
    expect([...result.changedStatuses.entries()]).toEqual([]);
    expect(regressionIssues(result)).toEqual([]);
    expect(result.compare).toBeDefined();
  });

  it("is deterministic under an injected clock and parser", async () => {
    const input = {
      corpus: corpus([
        entry({ command: "pnpm test" }),
        entry({ command: "git status" }),
      ]),
      currentPolicy: { active: [rule("allow-git", "allow", program("git"))] },
      pack: pack("pack:allow-pnpm", [
        rule("allow-pnpm", "allow", program("pnpm")),
      ]),
      clock: fixedClock,
    } as const;

    const first = await evaluatePackReplayImpact(input);
    const second = await evaluatePackReplayImpact(input);

    // Compare scalars and the transition entries (Map contents) rather than
    // whole-object identity so a fresh Map allocation per run does not fail.
    expect(second.status).toBe(first.status);
    expect(second.reviewToAllow).toBe(first.reviewToAllow);
    expect(second.changedUnique).toBe(first.changedUnique);
    expect(second.changedCalls).toBe(first.changedCalls);
    expect([...second.changedStatuses.entries()]).toEqual([
      ...first.changedStatuses.entries(),
    ]);
    expect([...second.changedStatuses.entries()]).toEqual([
      ["review->fast_path", 1],
    ]);
  });

  it("forwards unknownToolPosture to replay for non-bash corpus calls", async () => {
    // Non-bash records take their replayed status entirely from
    // unknownToolPosture (they bypass bash parsing and policy), so a candidate
    // pack that adds no rules never produces a transition. Forwarding is
    // observable through the attached compare's absolute afterSummary tallies.
    const input = {
      corpus: corpus([entry({ command: "do-thing", toolName: "custom-tool" })]),
      currentPolicy: { active: [] },
      pack: pack("pack:empty", []),
      clock: fixedClock,
    } as const;

    const denied = await evaluatePackReplayImpact({
      ...input,
      unknownToolPosture: "deny",
    });
    const reviewed = await evaluatePackReplayImpact({
      ...input,
      unknownToolPosture: "review",
    });

    expect(denied.compare?.afterSummary.hardBlockCalls).toBe(1);
    expect(denied.compare?.afterSummary.reviewCalls).toBe(0);
    expect(reviewed.compare?.afterSummary.reviewCalls).toBe(1);
    expect(reviewed.compare?.afterSummary.hardBlockCalls).toBe(0);
    // No status change either way (candidate adds nothing), so status is passed.
    expect(denied.status).toBe("passed");
    expect(reviewed.status).toBe("passed");
  });
});
