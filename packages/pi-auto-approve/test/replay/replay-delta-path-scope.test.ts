import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { sealedFloor } from "../../src/packs/floor.ts";
import type { PathFactsResolvedConfig } from "../../src/parse/native-path-facts.ts";
import type { DecisionEffect, PolicyRule } from "../../src/policy/core.ts";
import { always, inspectable, program } from "../../src/policy/core.ts";
import type {
  CorpusEntry,
  CorpusSource,
  ReplayCorpus,
} from "../../src/replay/history.ts";
import type { ReplayDeltaTransitionCount } from "../../src/replay/proposal-schema.ts";
import { ReplayDeltaSchema } from "../../src/replay/proposal-schema.ts";
import { buildReplayDeltaForPolicies } from "../../src/replay/replay-delta.ts";
import type { FixtureScopeOptions } from "../fixtures/path-scoped-constructive-pack.ts";
import {
  FIXTURE_CWD,
  fixturePathScopedConstructivePack,
  fixtureProjectScope,
} from "../fixtures/path-scoped-constructive-pack.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
//
// These tests exercise path-fact-enriched replay against the fixture
// path-scoped constructive pack (touch / mkdir / mktemp allows that require
// `pathScopesAllIn` with `requireFacts: "per-command-stage"`). They use the
// REAL `analyzeBashCommand` parser (the `buildReplayDeltaForPolicies` default)
// so enrichment has genuine bash shapes to classify — the same shapes the
// runtime handler produces via `enrichToolShapeWithPathFacts`.
// ---------------------------------------------------------------------------

const PATH_FACT_WARNING =
  "replay delta: path-fact context not supplied; unknownPathCalls is null (path-unknown evidence not computed)";

/** Constructive policy: sealed floor + fixture path-scoped constructive allows. */
const constructivePolicy = {
  floor: sealedFloor.rules,
  active: fixturePathScopedConstructivePack.rules,
};

/**
 * Build a `PathFactsResolvedConfig` from fixture scope options. `homeDirectory`
 * is intentionally not plumbed — `PathFactsResolvedConfig` mirrors the runtime
 * seam (`enrichToolShapeWithPathFacts`), which does not carry home, so `~/...`
 * operands stay fail-closed `unknown` exactly as at runtime.
 */
function ctx(overrides: FixtureScopeOptions = {}): PathFactsResolvedConfig {
  return {
    cwd: overrides.cwd ?? FIXTURE_CWD,
    projectScope: fixtureProjectScope(overrides),
  };
}

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
    command: "touch README.md",
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

function transitionCount(
  delta: { readonly transitions: readonly ReplayDeltaTransitionCount[] },
  transition: string,
): ReplayDeltaTransitionCount | undefined {
  return delta.transitions.find((entry) => entry.transition === transition);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("replay delta path-scope support", () => {
  it("fast-paths safe constructive commands that parser-only replay would review", async () => {
    // Baseline has NO path-fact context: the constructive allow fails closed on
    // parser-only shapes (no `pathFacts`) and `touch README.md` falls through to
    // review. Candidate supplies a path-fact context so the same allow matches
    // and the command fast-paths — the parity gap path-fact enrichment closes.
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus([entry({ command: "touch README.md" })]),
      baselinePolicy: constructivePolicy,
      candidatePolicy: constructivePolicy,
      pathFacts: { candidate: ctx() },
    });

    expect(delta.status).toBe("passed");
    expect(delta.changedCalls).toBe(1);
    expect(transitionCount(delta, "review->fast_path")).toMatchObject({
      calls: 1,
      uniqueCommands: 1,
    });
    expect(delta.improvement.reviewToAllowCalls).toBe(1);
    // The candidate fast-pathed via the path-scoped constructive allow.
    expect(delta.changedRecords[0]?.candidateRuleId).toBe(
      "fixture:allow-touch-project-temp",
    );
    // Candidate was enriched: unknown-path is a counted number (0), not null,
    // and the no-context warning is absent.
    expect(delta.blocked.unknownPathCalls).toBe(0);
    expect(delta.blocked.unknownToolCalls).toBe(0);
    expect(delta.warnings).not.toContain(PATH_FACT_WARNING);
    // The changed touch family carries a numeric unknownPathCalls (not null).
    const family = delta.changedFamilies.find((f) => f.executable === "touch");
    expect(family?.unknownPathCalls).toBe(0);
    expect(Value.Check(ReplayDeltaSchema, delta)).toBe(true);
  });

  it("produces a visible delta when baseline and candidate path scopes differ", async () => {
    // Baseline scope is `/repo`-only; candidate adds `/new` as a root+writable.
    // `touch /new/file` is outside under the baseline (review) but project under
    // the candidate (fast_path) — a project-scope proposal that widens scope.
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus([entry({ command: "touch /new/file" })]),
      baselinePolicy: constructivePolicy,
      candidatePolicy: constructivePolicy,
      pathFacts: {
        baseline: ctx(),
        candidate: ctx({
          roots: ["/repo", "/new"],
          writableDirectories: ["/repo", "/new"],
        }),
      },
    });

    expect(delta.changedCalls).toBe(1);
    expect(transitionCount(delta, "review->fast_path")).toMatchObject({
      calls: 1,
      uniqueCommands: 1,
    });
    expect(delta.improvement.reviewToAllowCalls).toBe(1);
    expect(delta.changedRecords[0]?.candidateRuleId).toBe(
      "fixture:allow-touch-project-temp",
    );
    // Both contexts supplied: no warning, unknown-path counted at 0.
    expect(delta.blocked.unknownPathCalls).toBe(0);
    expect(delta.warnings).not.toContain(PATH_FACT_WARNING);
    expect(Value.Check(ReplayDeltaSchema, delta)).toBe(true);
  });

  it("reports unknownPathCalls as null with a warning when no path-fact context is supplied", async () => {
    // No pathFacts supplied. A broad (non-path-scoped) touch allow makes the
    // candidate fast-path so there IS a changed family to inspect; the point is
    // that unknownPathCalls stays null (not zero) and the warning is present.
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus([entry({ command: "touch README.md" })]),
      baselinePolicy: { active: [] },
      candidatePolicy: {
        active: [rule("allow-touch", "allow", program("touch"))],
      },
    });

    expect(delta.blocked.unknownPathCalls).toBeNull();
    const family = delta.changedFamilies.find((f) => f.executable === "touch");
    expect(family?.unknownPathCalls).toBeNull();
    expect(delta.warnings).toContain(PATH_FACT_WARNING);
  });

  it("keeps unknown/outside/system/denied path facts review-visible and fail-closed", async () => {
    // Baseline is parser-only (review for every constructive command). Candidate
    // is enriched under the fixture scope. Only the safe in-project target
    // fast-paths; unknown/system/outside/denied paths all stay review under the
    // candidate — missing or unsafe facts never produce a project-scoped allow.
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus([
        entry({ command: "touch README.md" }),
        entry({ command: "touch $VAR" }),
        entry({ command: "touch /etc/passwd" }),
        entry({ command: "touch /outside/random" }),
        entry({ command: "touch /repo/denied/file" }),
      ]),
      baselinePolicy: constructivePolicy,
      candidatePolicy: constructivePolicy,
      pathFacts: {
        candidate: ctx({ deniedDirectories: ["/repo/denied"] }),
      },
    });

    // Only the safe target fast-paths; the four unsafe ones stay review->review.
    expect(transitionCount(delta, "review->fast_path")?.calls).toBe(1);
    expect(transitionCount(delta, "review->review")?.calls).toBe(4);
    expect(delta.changedCalls).toBe(1);
    expect(delta.changedRecords).toHaveLength(1);
    expect(delta.changedRecords[0]?.command).toBe("touch README.md");
    // Only the dynamic-expansion operand is `scope: "unknown"`; system/outside/
    // denied scopes are distinct and not counted here (they remain review-visible
    // via the review->review transition and candidate review load).
    expect(delta.blocked.unknownPathCalls).toBe(1);
    expect(delta.status).toBe("passed"); // expansion only, no regression
    expect(delta.warnings).not.toContain(PATH_FACT_WARNING);
    expect(Value.Check(ReplayDeltaSchema, delta)).toBe(true);
  });

  it("surfaces unknown-path records in a changed family when tightening to a path-scoped policy", async () => {
    // Baseline broad `program("touch")` allow fast-paths `touch re*` (no path
    // guard). Candidate path-scoped constructive pack enriches and finds the
    // glob operand is `scope: "unknown"` → allow fails → review. The resulting
    // fast_path->review regression carries family-level unknownPathCalls=1.
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus([entry({ command: "touch re*" })]),
      baselinePolicy: {
        active: [rule("allow-touch", "allow", program("touch"))],
      },
      candidatePolicy: constructivePolicy,
      pathFacts: { candidate: ctx() },
    });

    expect(delta.status).toBe("regression");
    expect(transitionCount(delta, "fast_path->review")?.calls).toBe(1);
    expect(delta.regressions[0]?.transition).toBe("fast_path->review");
    const family = delta.changedFamilies.find((f) => f.executable === "touch");
    expect(family?.unknownPathCalls).toBe(1);
    expect(delta.blocked.unknownPathCalls).toBe(1);
    expect(Value.Check(ReplayDeltaSchema, delta)).toBe(true);
  });

  it("keeps redacted low-fidelity unknown-path records visible in blocked counts", async () => {
    // A redacted audit-only `touch $VAR` record is enriched (bash is still
    // parsed + enriched regardless of fidelity): it stays review and shows up in
    // redactedCalls, lowFidelityCalls, AND unknownPathCalls simultaneously.
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus([
        entry({
          command: "touch $VAR",
          source: "audit",
          sources: ["audit"],
          fidelity: "redacted",
        }),
      ]),
      baselinePolicy: constructivePolicy,
      candidatePolicy: constructivePolicy,
      pathFacts: { baseline: ctx(), candidate: ctx() },
    });

    expect(delta.blocked.redactedCalls).toBe(1);
    expect(delta.blocked.lowFidelityCalls).toBe(1);
    expect(delta.blocked.unknownPathCalls).toBe(1);
    expect(delta.warnings).not.toContain(PATH_FACT_WARNING);
  });
});
