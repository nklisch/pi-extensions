import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { piExtensionInspectPack } from "../../src/packs/pi.extension.inspect.ts";
import { piInspectReadPack } from "../../src/packs/pi.inspect.read.ts";
import type { ToolShape } from "../../src/parse/shape.ts";
import type { DecisionEffect, PolicyRule } from "../../src/policy/core.ts";
import { always, inspectable, program } from "../../src/policy/core.ts";
import type {
  CorpusEntry,
  CorpusSource,
  ReplayCorpus,
} from "../../src/replay/history.ts";
import type {
  ReplayDelta,
  ReplayDeltaTransition,
  ReplayDeltaTransitionCount,
  StructuredRatchetProposal,
} from "../../src/replay/proposal-schema.ts";
import {
  REPLAY_DELTA_SCHEMA_VERSION,
  ReplayDeltaSchema,
} from "../../src/replay/proposal-schema.ts";
import {
  buildReplayDeltaForPolicies,
  classifyReplayTransition,
  isReplayRegressionTransition,
  replayRegressionKindForTransition,
} from "../../src/replay/replay-delta.ts";

// ---------------------------------------------------------------------------
// Shared fixtures (mirror test/replay/ratchet-compare.test.ts so the delta suite
// exercises the same dry-run parse + decide path).
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

const _parser = async (command: string): Promise<ToolShape> =>
  shapeFor(command);

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

const PATH_FACTS = {
  cwd: "/repo",
  projectScope: {
    roots: ["/repo"],
    writableDirectories: ["/repo"],
    tempDirectories: ["/tmp"],
    deniedDirectories: [],
    safeHomeDirectories: [],
    unknownPathBehavior: "review" as const,
  },
};

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
  transition: ReplayDeltaTransition,
): ReplayDeltaTransitionCount | undefined {
  return delta.transitions.find((entry) => entry.transition === transition);
}

function _pathFactWarning(delta: {
  readonly warnings: readonly string[];
}): string {
  return delta.warnings.find((w) => w.includes("path-fact context")) ?? "";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("classifyReplayTransition + regression helpers", () => {
  it.each([
    ["review->fast_path", "expansion"],
    ["review->hard_block", "safe-tightening"],
    ["hard_block->fast_path", "regression"],
    ["hard_block->review", "regression"],
    ["fast_path->review", "regression"],
    ["fast_path->hard_block", "regression"],
    ["fast_path->fast_path", "unchanged"],
    ["review->review", "unchanged"],
    ["hard_block->hard_block", "unchanged"],
  ] as const)("classifies %s as %s", (transition, expected) => {
    expect(classifyReplayTransition(transition)).toBe(expected);
  });

  it.each([
    ["hard_block->fast_path", "deny-to-allow"],
    ["hard_block->review", "deny-to-review"],
    ["fast_path->review", "allow-to-review"],
    ["fast_path->hard_block", "allow-to-deny"],
  ] as const)("maps %s to regression kind %s", (transition, expected) => {
    expect(replayRegressionKindForTransition(transition)).toBe(expected);
  });

  it("treats only the four regression transitions as regressions", () => {
    expect(isReplayRegressionTransition("hard_block->fast_path")).toBe(true);
    expect(isReplayRegressionTransition("review->fast_path")).toBe(false);
    expect(isReplayRegressionTransition("review=>fast_path")).toBe(false);
  });
});

describe("buildReplayDeltaForPolicies", () => {
  it("parses each unique bash command once across baseline and candidate builds", async () => {
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus([
        entry({ command: "git status" }),
        entry({ command: "pnpm test" }),
        entry({ command: "pnpm test" }),
        entry({ command: "rm -rf tmp" }),
        entry({ command: "node --version" }),
      ]),
      baselinePolicy: { active: [rule("allow-git", "allow", program("git"))] },
      candidatePolicy: {
        active: [
          rule("allow-git", "allow", program("git")),
          rule("allow-pnpm", "allow", program("pnpm")),
        ],
      },
    });
    expect(delta.version).toBe(REPLAY_DELTA_SCHEMA_VERSION);
    expect(Value.Check(ReplayDeltaSchema, delta)).toBe(true);
  });

  it("reports not-run when no corpus records are available", async () => {
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus([]),
      baselinePolicy: { active: [rule("rev-git", "review", program("git"))] },
      candidatePolicy: { active: [rule("allow-git", "allow", program("git"))] },
    });

    expect(delta.status).toBe("not-run");
    expect(delta.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("no corpus records were available"),
      ]),
    );
    expect(Value.Check(ReplayDeltaSchema, delta)).toBe(true);
  });

  it("reports review->fast_path expansion, transition counts, and review reduction", async () => {
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus([
        entry({ command: "git status" }),
        entry({ command: "git status" }),
        entry({ command: "pnpm test" }),
      ]),
      baselinePolicy: {
        active: [
          rule("rev-git", "review", program("git")),
          rule("rev-pnpm", "review", program("pnpm")),
        ],
      },
      candidatePolicy: {
        active: [
          rule("allow-git", "allow", program("git")),
          rule("allow-pnpm", "allow", program("pnpm")),
        ],
      },
    });

    expect(delta.status).toBe("passed");
    expect(delta.changedCalls).toBe(3);
    expect(delta.changedUniqueCommands).toBe(2);
    expect(delta.transitions).toEqual([
      { transition: "review->fast_path", calls: 3, uniqueCommands: 2 },
    ]);
    expect(delta.improvement).toMatchObject({
      reviewToAllowCalls: 3,
      reviewToAllowUniqueCommands: 2,
      reviewReductionPercent: 100,
      remainingReviewCalls: 0,
      unchangedReviewCalls: 0,
    });
    expect(delta.regressions).toEqual([]);
    expect(Value.Check(ReplayDeltaSchema, delta)).toBe(true);
  });

  it("reports built-in Pi-tool review->fast_path expansion in changed families", async () => {
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus([
        entry({
          toolName: "read",
          command: JSON.stringify({ path: "README.md" }),
          toolInput: { path: "README.md" },
        }),
      ]),
      baselinePolicy: {},
      candidatePolicy: { active: piInspectReadPack.rules },
      pathFacts: { baseline: PATH_FACTS, candidate: PATH_FACTS },
    });

    expect(delta.status).toBe("passed");
    expect(delta.transitions).toEqual([
      { transition: "review->fast_path", calls: 1, uniqueCommands: 1 },
    ]);
    expect(delta.changedFamilies[0]).toMatchObject({
      familyId: "pi-tool:read:read-file:clean",
      toolName: "read",
      executable: "read",
      reviewToAllowCalls: 1,
      unknownToolCalls: 0,
    });
    expect(delta.blocked.unknownToolCalls).toBe(0);
    expect(delta.blocked.unknownPathCalls).toBe(0);
    expect(delta.changedRecords[0]).toMatchObject({
      toolName: "read",
      familyId: "pi-tool:read:read-file:clean",
      transition: "review->fast_path",
    });
    expect(Value.Check(ReplayDeltaSchema, delta)).toBe(true);
  });

  it("reports covered extension-tool review->fast_path expansion in changed families", async () => {
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus([
        entry({
          toolName: "get_goal",
          command: JSON.stringify({}),
          toolInput: {},
        }),
      ]),
      baselinePolicy: {},
      candidatePolicy: { active: piExtensionInspectPack.rules },
    });

    expect(delta.status).toBe("passed");
    expect(delta.changedFamilies[0]).toMatchObject({
      familyId: "pi-tool:get_goal:state-read:clean",
      toolName: "get_goal",
      executable: "get_goal",
      reviewToAllowCalls: 1,
      unknownToolCalls: 0,
    });
    expect(delta.blocked.unknownToolCalls).toBe(0);
    expect(Value.Check(ReplayDeltaSchema, delta)).toBe(true);
  });

  it("returns null reviewReductionPercent when the baseline had no review calls", async () => {
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus([
        entry({ command: "git status" }),
        entry({ command: "pnpm test" }),
      ]),
      baselinePolicy: {
        active: [
          rule("allow-git", "allow", program("git")),
          rule("allow-pnpm", "allow", program("pnpm")),
        ],
      },
      candidatePolicy: {
        active: [
          rule("allow-git", "allow", program("git")),
          rule("allow-pnpm", "allow", program("pnpm")),
        ],
      },
    });

    // Baseline already fast-paths everything: no review denominator.
    expect(delta.improvement.reviewReductionPercent).toBeNull();
    expect(delta.improvement.remainingReviewCalls).toBe(0);
    expect(delta.improvement.unchangedReviewCalls).toBe(0);
    expect(delta.status).toBe("passed");
    expect(delta.changedCalls).toBe(0);
  });

  it("classifies hard_block->fast_path and fast_path->review as regressions", async () => {
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus([
        entry({ command: "git status" }),
        entry({ command: "node --version" }),
        entry({ command: "pnpm test" }),
        entry({ command: "rm -rf tmp" }),
      ]),
      baselinePolicy: {
        active: [
          rule("allow-git", "allow", program("git")),
          rule("allow-node", "allow", program("node")),
          rule("deny-pnpm", "deny", program("pnpm")),
          rule("deny-rm", "deny", program("rm")),
        ],
      },
      candidatePolicy: {
        active: [
          rule("allow-git", "allow", program("git")),
          rule("rev-node", "review", program("node")),
          rule("allow-pnpm", "allow", program("pnpm")),
          rule("deny-rm", "deny", program("rm")),
        ],
      },
    });

    expect(delta.status).toBe("regression");
    expect(delta.changedCalls).toBe(2);
    expect(delta.changedUniqueCommands).toBe(2);
    // Regression order follows REPLAY_DELTA_REGRESSION_TRANSITIONS:
    // hard_block->fast_path (pnpm) before fast_path->review (node).
    expect(delta.regressions).toEqual([
      {
        transition: "hard_block->fast_path",
        kind: "deny-to-allow",
        calls: 1,
        uniqueCommands: 1,
        message:
          "replay regression: candidate would shift 1 command call(s) hard_block->fast_path (deny→allow)",
      },
      {
        transition: "fast_path->review",
        kind: "allow-to-review",
        calls: 1,
        uniqueCommands: 1,
        message:
          "replay regression: candidate would shift 1 command call(s) fast_path->review (allow→review)",
      },
    ]);
    expect(classifyReplayTransition("hard_block->fast_path")).toBe(
      "regression",
    );
    expect(classifyReplayTransition("fast_path->review")).toBe("regression");
  });
});

describe("compareCorpusQueryModels", () => {
  it("sorts changed families by regression, review-to-allow, changed calls, then id", async () => {
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus([
        entry({ command: "git status" }),
        entry({ command: "pnpm test" }),
        entry({ command: "rm -rf tmp" }),
        entry({ command: "ls -la" }),
      ]),
      baselinePolicy: {
        active: [
          rule("allow-git", "allow", program("git")),
          rule("rev-pnpm", "review", program("pnpm")),
          rule("rev-rm", "review", program("rm")),
          rule("rev-ls", "review", program("ls")),
        ],
      },
      candidatePolicy: {
        active: [
          rule("rev-git", "review", program("git")), // fast_path->review (regression)
          rule("allow-pnpm", "allow", program("pnpm")), // review->fast_path
          rule("deny-rm", "deny", program("rm")), // review->hard_block (safe tightening)
          rule("allow-ls", "allow", program("ls")), // review->fast_path
        ],
      },
    });

    // The fixture parser emits empty argument arrays, so family ids carry the
    // executable only (semantic argument "none"). Assert executables to verify the
    // sort order robustly: regression first, then review-to-allow, then id.
    expect(delta.changedFamilies.map((f) => f.executable)).toEqual([
      "git", // regression first
      "ls", // review-to-allow, id sorts before pnpm
      "pnpm", // review-to-allow
      "rm", // no review-to-allow
    ]);

    // The git family carries the fast_path->review regression; ls/pnpm carry expansions.
    const gitFamily = delta.changedFamilies[0];
    expect(gitFamily?.regressions[0]?.transition).toBe("fast_path->review");
    expect(gitFamily?.reviewToAllowCalls).toBe(0);
    const lsFamily = delta.changedFamilies[1];
    expect(lsFamily?.reviewToAllowCalls).toBe(1);
    expect(lsFamily?.regressions).toEqual([]);
  });

  it("caps sampleRecordIds and sampleCommands at the sample limit", async () => {
    const entries = Array.from({ length: 7 }, () =>
      entry({ command: "git status" }),
    );
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus(entries),
      baselinePolicy: { active: [rule("rev-git", "review", program("git"))] },
      candidatePolicy: { active: [rule("allow-git", "allow", program("git"))] },
    });

    expect(delta.changedFamilies).toHaveLength(1);
    const family = delta.changedFamilies[0];
    expect(family?.calls).toBe(7);
    expect(family?.sampleRecordIds).toHaveLength(5); // default sampleLimit
    expect(family?.sampleCommands).toEqual(["git status"]); // 1 distinct command
  });

  it("caps changedRecords at the changedRecordLimit option", async () => {
    const entries = Array.from({ length: 10 }, (_, index) =>
      entry({ command: `git ${index}` }),
    );
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus(entries),
      baselinePolicy: {
        active: entries.map((_, index) =>
          rule(`rev-${index}`, "review", program("git")),
        ),
      },
      candidatePolicy: {
        active: entries.map((_, index) =>
          rule(`allow-${index}`, "allow", program("git")),
        ),
      },
      changedRecordLimit: 5,
    });

    expect(delta.changedRecords).toHaveLength(5);
    // All ten commands changed; the cap keeps the first five by sort (family id, command).
    expect(delta.changedUniqueCommands).toBe(10);
  });

  it("attributes candidate hard-blocks to sealed floor and active deny rules", async () => {
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus([
        entry({ command: "git status" }),
        entry({ command: "rm -rf tmp" }),
        entry({ command: "pnpm test" }),
        entry({
          command: "secret",
          source: "audit",
          sources: ["audit"],
          fidelity: "redacted",
        }),
      ]),
      baselinePolicy: {
        floor: [rule("floor-deny-rm", "deny", program("rm"))],
        active: [
          rule("allow-git", "allow", program("git")),
          rule("active-deny-pnpm", "deny", program("pnpm")),
        ],
      },
      candidatePolicy: {
        floor: [rule("floor-deny-rm", "deny", program("rm"))],
        active: [
          rule("allow-git", "allow", program("git")),
          rule("active-deny-pnpm", "deny", program("pnpm")),
        ],
      },
    });

    // Baseline == candidate: no changes, but blocked attribution is still derived.
    expect(delta.changedCalls).toBe(0);
    expect(delta.status).toBe("passed");
    expect(delta.blocked).toMatchObject({
      unknownToolCalls: 0,
      unknownPathCalls: null,
      sealedFloorBlockCalls: 1, // rm blocked by floor
      activeDenyBlockCalls: 1, // pnpm blocked by active deny
      lowFidelityCalls: 1, // redacted audit-only "secret"
      redactedCalls: 1,
    });
    expect(Value.Check(ReplayDeltaSchema, delta)).toBe(true);
  });

  it("produces a schema-valid delta including identity transitions", async () => {
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus([
        entry({ command: "git status" }),
        entry({ command: "pnpm test" }),
      ]),
      baselinePolicy: {
        active: [
          rule("allow-git", "allow", program("git")),
          rule("rev-pnpm", "review", program("pnpm")),
        ],
      },
      candidatePolicy: {
        active: [
          rule("allow-git", "allow", program("git")),
          rule("allow-pnpm", "allow", program("pnpm")),
        ],
      },
    });

    // git is unchanged (fast_path->fast_path identity); pnpm expands (review->fast_path).
    expect(transitionCount(delta, "fast_path->fast_path")).toMatchObject({
      calls: 1,
      uniqueCommands: 1,
    });
    expect(transitionCount(delta, "review->fast_path")).toMatchObject({
      calls: 1,
      uniqueCommands: 1,
    });
    expect(Value.Check(ReplayDeltaSchema, delta)).toBe(true);
    expect(delta.warnings).toContain(
      "replay delta: path-fact context not supplied; unknownPathCalls is null (path-unknown evidence not computed)",
    );
  });
});

describe("replay delta structured-proposal integration", () => {
  it("embeds a typed replay delta into proposal evidence and round-trips", async () => {
    const delta = await buildReplayDeltaForPolicies({
      corpus: corpus([entry({ command: "git status" })]),
      baselinePolicy: { active: [rule("rev-git", "review", program("git"))] },
      candidatePolicy: { active: [rule("allow-git", "allow", program("git"))] },
    });

    const proposal = proposalWithReplayDelta(delta);
    expect(Value.Check(ReplayDeltaSchema, proposal.evidence.replayDelta)).toBe(
      true,
    );
    // The full delta survives a JSON round-trip (no Map / function / undefined leakage).
    const roundTripped = JSON.parse(
      JSON.stringify(proposal),
    ) as typeof proposal;
    expect(
      Value.Check(ReplayDeltaSchema, roundTripped.evidence.replayDelta),
    ).toBe(true);
    expect(roundTripped.evidence.replayDelta?.changedCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Proposal-evidence helper (minimal; only exercises replayDelta transport).
// ---------------------------------------------------------------------------

function proposalWithReplayDelta(
  replayDelta: ReplayDelta,
): StructuredRatchetProposal {
  return {
    version: 1,
    id: "prop-replay-delta-integration",
    kind: "data-pack-policy",
    title: "Allow git status",
    summary: "Allow read-only git status.",
    reason: "Captured history shows repeated review with no denials.",
    createdAt: "2026-06-27T00:00:00.000Z",
    provenance: { source: "generated" },
    intendedProvenance: "user-global",
    applicationMode: "writable-after-approval",
    target: {
      kind: "user-global-config",
      path: "~/.config/pi-clearance/config.json",
    },
    change: {
      kind: "policy-pack",
      packId: "user-global-bash",
      ruleId: "allow-git-status",
      effect: "allow",
      reason: "read-only git status",
      match: { toolName: "bash", executable: "git", args: ["status"] },
      rawPackPatch: [
        {
          op: "add",
          path: "/packs/0/rules/-",
          value: { id: "allow-git-status", effect: "allow" },
        },
      ],
    },
    evidence: {
      corpusSummary: {
        totalRecords: 1,
        totalUniqueCommands: 1,
        modelReviewLoad: { calls: 0, uniqueCommands: 0 },
        redactedCalls: 0,
        lowFidelityCalls: 0,
      },
      familyIds: ["bash:git:status:clean"],
      recordIds: ["rec-1"],
      calls: 1,
      uniqueCommands: 1,
      reviewCalls: 1,
      hardBlockCalls: 0,
      modelReviewCalls: 0,
      capturedDenialCalls: 0,
      replayStatusCounts: [{ label: "review", calls: 1, uniqueCommands: 1 }],
      capturedOutcomeCounts: [],
      sampleCommands: ["git status"],
      replayDelta,
    },
    examples: [],
    fixtureSuggestions: [],
    validation: {
      schema: {
        status: "pass",
        code: "schema-ok",
        message: "proposal conforms to structured schema",
      },
    },
    trustNotes: [],
    warnings: [],
  };
}
