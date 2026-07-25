import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";
import { sealedFloor } from "../../src/packs/floor.ts";
import type { PackReplayImpactSummary } from "../../src/packs/validation.ts";
import { evaluatePackReplayImpact } from "../../src/packs/validation.ts";
import type { PathFactsResolvedConfig } from "../../src/parse/native-path-facts.ts";
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
import { buildDataPackCandidatePolicy } from "../../src/replay/proposal-candidate-policy.ts";
import {
  packReplayImpactToReplayDelta,
  replayStructuredProposal,
} from "../../src/replay/proposal-replay-delta.ts";
import type {
  ProposalEvidence,
  StructuredRatchetProposal,
} from "../../src/replay/proposal-schema.ts";
import {
  PROPOSAL_SCHEMA_VERSION,
  ReplayDeltaSchema,
} from "../../src/replay/proposal-schema.ts";
import {
  FIXTURE_CWD,
  fixturePathScopedConstructivePack,
  fixtureProjectScope,
} from "../fixtures/path-scoped-constructive-pack.ts";

const CREATED_AT = "2026-06-27T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Shared low-level fixtures (mirror test/replay/ratchet-compare.test.ts)
// ---------------------------------------------------------------------------

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

const _syntheticParser = vi.fn(
  async (command: string): Promise<ToolShape> => shapeFor(command),
);

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

function compiledPack(id: string, rules: readonly PolicyRule[]): PolicyPack {
  return { version: 1, id, rules };
}

function emptyEvidence(): ProposalEvidence {
  return {
    familyIds: [],
    recordIds: [],
    calls: 0,
    uniqueCommands: 0,
    reviewCalls: 0,
    hardBlockCalls: 0,
    modelReviewCalls: 0,
    capturedDenialCalls: 0,
    replayStatusCounts: [],
    capturedOutcomeCounts: [],
    sampleCommands: [],
  };
}

// ---------------------------------------------------------------------------
// Minimal valid structured proposals per kind (compilable matchers)
// ---------------------------------------------------------------------------

function dataPackProposal(options: {
  readonly match?: unknown;
  readonly packId?: string;
  readonly ruleId?: string;
  readonly effect?: DecisionEffect;
  readonly intendedProvenance?: StructuredRatchetProposal["intendedProvenance"];
  readonly id?: string;
}): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: options.id ?? "prop-data-1",
    kind: "data-pack-policy",
    title: "Allow pnpm test",
    summary: "Structural allow for pnpm test.",
    reason: "reviewed command; safe allow.",
    createdAt: CREATED_AT,
    provenance: { source: "generated" },
    intendedProvenance: options.intendedProvenance ?? "user-global",
    applicationMode: "writable-after-approval",
    target: {
      kind: "user-global-config",
      path: "~/.config/pi-auto-approve/config.json",
    },
    change: {
      kind: "policy-pack",
      packId: options.packId ?? "user-global-pnpm",
      ruleId: options.ruleId ?? "allow-pnpm-test",
      effect: options.effect ?? "allow",
      reason: "read-only pnpm test",
      match: options.match ?? { program: "pnpm" },
      rawPackPatch: [],
    },
    evidence: emptyEvidence(),
    examples: [],
    fixtureSuggestions: [],
    validation: {
      schema: { status: "pass", code: "schema-ok", message: "ok" },
      replay: {
        status: "pending",
        code: "replay-pending",
        message: "replay-delta runs through the proposal bridge",
      },
    },
    trustNotes: [],
    warnings: [],
  };
}

function projectScopeProposal(): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "prop-scope-1",
    kind: "project-scope-config",
    title: "Widen writable directories to ./src",
    summary: "Add ./src to writable directories.",
    reason: "Captured writes target ./src; scope the allow there.",
    createdAt: CREATED_AT,
    provenance: { source: "generated" },
    intendedProvenance: "user-project",
    applicationMode: "writable-after-approval",
    target: {
      kind: "user-project-overlay",
      path: "./.pi/auto-reviewer.json",
      projectKey: "pi-auto-approve",
      projectRoot: "/repo",
    },
    change: {
      kind: "project-scope-config",
      patch: [
        {
          op: "add",
          path: "/projectScope/writableDirectories/-",
          value: "./src",
        },
      ],
    },
    evidence: emptyEvidence(),
    examples: [],
    fixtureSuggestions: [],
    validation: {
      schema: { status: "pass", code: "schema-ok", message: "ok" },
    },
    trustNotes: [],
    warnings: [],
  };
}

function reviewerConfigProposal(): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "prop-reviewer-1",
    kind: "reviewer-config",
    title: "Append project prompt",
    summary: "Append a reviewer prompt fragment.",
    reason: "Narrow the reviewer prompt.",
    createdAt: CREATED_AT,
    provenance: { source: "generated" },
    intendedProvenance: "user-project",
    applicationMode: "writable-after-approval",
    target: {
      kind: "user-project-overlay",
      path: "./.pi/auto-reviewer.json",
      projectKey: "pi-auto-approve",
      projectRoot: "/repo",
    },
    change: {
      kind: "reviewer-config",
      pointer: "/reviewer/projectPromptAppends/-",
      op: "append-string",
      before: [],
      after: "Prefer structural allow.",
      rendered: 'reviewer.projectPromptAppends += "Prefer structural allow..."',
    },
    evidence: emptyEvidence(),
    examples: [],
    fixtureSuggestions: [],
    validation: {
      schema: { status: "pass", code: "schema-ok", message: "ok" },
    },
    trustNotes: [],
    warnings: [],
  };
}

function packFileAuthoringProposal(): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "prop-authoring-1",
    kind: "pack-file-authoring",
    title: "Draft core matcher",
    summary: "Design input: core matcher.",
    reason: "Structural matchers cannot express the matcher.",
    createdAt: CREATED_AT,
    provenance: { source: "generated" },
    applicationMode: "design-input-only",
    target: {
      kind: "design-input",
      route: "core-matcher",
      suggestedPath: "./.pi/packs/core-matcher.json",
    },
    change: {
      kind: "pack-file-authoring",
      authoringKind: "core-matcher",
      matcherName: "isX",
      matcherSignature: "(shape: BashCommandShape) => boolean",
      rationale: "Core matcher required.",
      fileWrite: {
        path: "./.pi/packs/core-matcher.json",
        format: "json",
        mode: "create",
        atomic: false,
        backupRequired: false,
        contents: '{"kind":"core-matcher-design-input"}',
      },
    },
    evidence: emptyEvidence(),
    examples: [],
    fixtureSuggestions: [],
    validation: {
      schema: { status: "pass", code: "schema-ok", message: "ok" },
    },
    trustNotes: [],
    warnings: [],
  };
}

function packagePackEnablementProposal(): StructuredRatchetProposal {
  return {
    version: PROPOSAL_SCHEMA_VERSION,
    id: "prop-pack-1",
    kind: "package-pack-enablement",
    title: "Enable test-safety pack",
    summary: "Enable package-contributed pack 'test-safety'.",
    reason: "Pack matches captured friction.",
    createdAt: CREATED_AT,
    provenance: { source: "generated" },
    intendedProvenance: "user-global",
    applicationMode: "writable-after-approval",
    target: {
      kind: "package-pack-config",
      path: "~/.config/pi-auto-approve/config.json",
      packId: "test-safety",
    },
    change: {
      kind: "package-pack-enablement",
      packId: "test-safety",
      enable: true,
      metadataWarnings: [],
      plan: {
        id: "pack-enable:test-safety",
        request: {
          action: "enable",
          scope: "global",
          subject: "package",
          packId: "test-safety",
        },
        targetPath: "~/.config/pi-auto-approve/config.json",
        patch: [
          {
            op: "replace",
            path: "/packEnablement/enabledPackagePacks",
            before: [],
            value: ["test-safety"],
          },
        ],
        before: {
          scope: "global",
          packEnablement: {
            enabledPackagePacks: [],
            disabledPackagePacks: [],
            disabledConfigPacks: [],
          },
          packs: [],
        },
        after: {
          scope: "global",
          packEnablement: {
            enabledPackagePacks: ["test-safety"],
            disabledPackagePacks: [],
            disabledConfigPacks: [],
          },
          packs: [],
        },
        warnings: [],
        requiredAcknowledgementCodes: [],
      },
    },
    evidence: emptyEvidence(),
    examples: [],
    fixtureSuggestions: [],
    validation: {
      schema: { status: "pass", code: "schema-ok", message: "ok" },
    },
    trustNotes: [],
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers for asserting no Map / function leakage into a serialized delta
// ---------------------------------------------------------------------------

function containsMapOrFunction(value: unknown): boolean {
  if (typeof value === "function") {
    return true;
  }
  if (value instanceof Map) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(containsMapOrFunction);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(containsMapOrFunction);
  }
  return false;
}

function transitionCalls(
  delta: {
    readonly transitions: readonly {
      readonly transition: string;
      readonly calls: number;
    }[];
  },
  transition: string,
): number | undefined {
  return delta.transitions.find((entry) => entry.transition === transition)
    ?.calls;
}

// ---------------------------------------------------------------------------
// data-pack-policy
// ---------------------------------------------------------------------------

describe("replayStructuredProposal: data-pack-policy", () => {
  it("replays a candidate allow into a typed delta without applying or writing config", async () => {
    const proposal = dataPackProposal({ match: { program: "pnpm" } });
    const baselinePolicy: EffectivePolicy = { active: [] };
    const originalActive = baselinePolicy.active;

    const result = await replayStructuredProposal({
      proposal,
      corpus: corpus([entry({ command: "pnpm test" })]),
      baselinePolicy,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.delta.status).toBe("passed");
    expect(result.delta.changedCalls).toBe(1);
    expect(transitionCalls(result.delta, "review->fast_path")).toBe(1);
    expect(result.delta.regressions).toEqual([]);
    // No config application or write: the baseline active lane is untouched.
    expect(baselinePolicy.active).toBe(originalActive);
    expect(baselinePolicy.active).toHaveLength(0);
  });

  it("shares data-pack candidate construction with adversarial validation", () => {
    const proposal = dataPackProposal({ match: { program: "pnpm" } });
    const baselinePolicy: EffectivePolicy = {
      floor: sealedFloor.rules,
      active: [],
    };
    const result = buildDataPackCandidatePolicy({ proposal, baselinePolicy });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.candidatePolicy.floor).toBe(sealedFloor.rules);
    expect(result.candidatePolicy.active).toHaveLength(1);
    expect(baselinePolicy.active).toEqual([]);
    expect(result.candidatePack.rules[0]?.provenance.source).toBe(
      "user-global",
    );
    expect(result.candidatePack.rules[0]?.id).toBe("allow-pnpm-test");
  });

  it("replays a caller-supplied already-compiled candidate pack", async () => {
    const proposal = dataPackProposal({ match: { program: "git" } });
    const candidatePack = compiledPack("user-global-git", [
      rule("allow-git", "allow", program("git")),
    ]);

    const result = await replayStructuredProposal({
      proposal,
      corpus: corpus([entry({ command: "git status" })]),
      baselinePolicy: { active: [] },
      candidatePack,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(transitionCalls(result.delta, "review->fast_path")).toBe(1);
  });

  it("returns not-run when the proposed matcher fails to compile", async () => {
    const proposal = dataPackProposal({ match: { bogusCombinator: true } });

    const result = await replayStructuredProposal({
      proposal,
      corpus: corpus([entry({ command: "pnpm test" })]),
      baselinePolicy: { active: [] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.delta.status).toBe("not-run");
    expect(result.reason).toContain("failed to compile");
    expect(result.delta.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("failed to compile")]),
    );
  });

  it("forwards path-fact contexts so path-scoped candidate allows fire", async () => {
    // Candidate allow requires a project/temp path fact; supplying the candidate
    // context enriches the candidate build so the allow fast-paths the touch.
    const candidatePack = compiledPack("fixture.path-scoped", [
      ...fixturePathScopedConstructivePack.rules,
    ]);
    const proposal = dataPackProposal({
      match: { program: "touch" },
      packId: "fixture.path-scoped",
      ruleId: "fixture:allow-touch-project-temp",
    });
    const pathFacts: PathFactsResolvedConfig = {
      cwd: FIXTURE_CWD,
      projectScope: fixtureProjectScope(),
    };

    const result = await replayStructuredProposal({
      proposal,
      corpus: corpus([entry({ command: "touch README.md" })]),
      baselinePolicy: { floor: sealedFloor.rules, active: [] },
      candidatePack,
      pathFacts: { baseline: pathFacts, candidate: pathFacts },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(transitionCalls(result.delta, "review->fast_path")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// project-scope-config
// ---------------------------------------------------------------------------

describe("replayStructuredProposal: project-scope-config", () => {
  it("replays distinct baseline/candidate path-fact contexts", async () => {
    const proposal = projectScopeProposal();
    // Baseline scope has no writable/project roots: touch fails closed (review).
    // Candidate scope adds /repo as a writable root: touch fast-paths.
    const baselineScope: PathFactsResolvedConfig = {
      cwd: FIXTURE_CWD,
      projectScope: fixtureProjectScope({ writableDirectories: [], roots: [] }),
    };
    const candidateScope: PathFactsResolvedConfig = {
      cwd: FIXTURE_CWD,
      projectScope: fixtureProjectScope(),
    };
    const policy: EffectivePolicy = {
      floor: sealedFloor.rules,
      active: fixturePathScopedConstructivePack.rules,
    };

    const result = await replayStructuredProposal({
      proposal,
      corpus: corpus([entry({ command: "touch README.md" })]),
      baselinePolicy: policy,
      pathFacts: { baseline: baselineScope, candidate: candidateScope },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.delta.status).toBe("passed");
    expect(transitionCalls(result.delta, "review->fast_path")).toBe(1);
  });

  it("returns not-run when no candidate path-fact context is supplied", async () => {
    const proposal = projectScopeProposal();

    const result = await replayStructuredProposal({
      proposal,
      corpus: corpus([entry({ command: "touch README.md" })]),
      baselinePolicy: { active: [] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.delta.status).toBe("not-run");
    expect(result.reason).toContain("candidate path-fact context");
  });
});

// ---------------------------------------------------------------------------
// reviewer-config + pack-file-authoring (unsupported deterministic replay)
// ---------------------------------------------------------------------------

describe("replayStructuredProposal: unsupported kinds report not-run", () => {
  it("reviewer-config reports deterministic replay as not-run and never simulates a model", async () => {
    const result = await replayStructuredProposal({
      proposal: reviewerConfigProposal(),
      corpus: corpus([]),
      baselinePolicy: { active: [] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.delta.status).toBe("not-run");
    expect(result.reason).toContain("deterministically replayed");
    expect(result.reason).toContain("model evaluation");
    // The not-run delta carries the reason as a warning for self-explanation.
    expect(result.delta.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("deterministically replayed"),
      ]),
    );
  });

  it("pack-file-authoring reports design-input-only not-run", async () => {
    const result = await replayStructuredProposal({
      proposal: packFileAuthoringProposal(),
      corpus: corpus([]),
      baselinePolicy: { active: [] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.delta.status).toBe("not-run");
    expect(result.reason).toContain("design-input-only");
  });
});

// ---------------------------------------------------------------------------
// package-pack-enablement
// ---------------------------------------------------------------------------

describe("replayStructuredProposal: package-pack-enablement", () => {
  it("serializes a supplied PackReplayImpactSummary into a typed delta", async () => {
    const impact = await evaluatePackReplayImpact({
      corpus: corpus([entry({ command: "pnpm test" })]),
      currentPolicy: { active: [] },
      pack: compiledPack("pack:allow-pnpm", [
        rule("allow-pnpm", "allow", program("pnpm")),
      ]),
    });

    const result = await replayStructuredProposal({
      proposal: packagePackEnablementProposal(),
      corpus: corpus([entry({ command: "pnpm test" })]),
      baselinePolicy: { active: [] },
      packReplayImpact: impact,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.delta.status).toBe("passed");
    expect(transitionCalls(result.delta, "review->fast_path")).toBe(1);
    // The serialized delta is schema-valid and JSON-clean (no Map leakage).
    expect(Value.Check(ReplayDeltaSchema, result.delta)).toBe(true);
    expect(containsMapOrFunction(result.delta)).toBe(false);
    expect(JSON.parse(JSON.stringify(result.delta))).toEqual(result.delta);
  });

  it("replays a caller-supplied compiled candidate pack through the core engine", async () => {
    const candidatePack = compiledPack("pack:allow-pnpm", [
      rule("allow-pnpm", "allow", program("pnpm")),
    ]);

    const result = await replayStructuredProposal({
      proposal: packagePackEnablementProposal(),
      corpus: corpus([entry({ command: "pnpm test" })]),
      baselinePolicy: { active: [] },
      candidatePack,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(transitionCalls(result.delta, "review->fast_path")).toBe(1);
  });

  it("reports not-run when a supplied impact is itself not-run", async () => {
    const impact: PackReplayImpactSummary = {
      status: "not-run",
      changedUnique: 0,
      changedCalls: 0,
      reviewToAllow: 0,
      denyToAllow: 0,
      allowToReviewOrDeny: 0,
      changedStatuses: new Map(),
      issues: [],
    };

    const result = await replayStructuredProposal({
      proposal: packagePackEnablementProposal(),
      corpus: corpus([]),
      baselinePolicy: { active: [] },
      packReplayImpact: impact,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.delta.status).toBe("not-run");
    expect(result.reason).toContain("replay impact was not run");
    expect(result.delta.notRun).toMatchObject({
      code: "replay-impact-not-run",
    });
  });

  it("reports not-run when neither impact nor candidate pack is supplied", async () => {
    const result = await replayStructuredProposal({
      proposal: packagePackEnablementProposal(),
      corpus: corpus([entry({ command: "pnpm test" })]),
      baselinePolicy: { active: [] },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.delta.status).toBe("not-run");
    expect(result.reason).toContain("PackReplayImpactSummary");
    expect(result.reason).toContain("compiled candidate pack");
  });
});

// ---------------------------------------------------------------------------
// packReplayImpactToReplayDelta — bridge serializer
// ---------------------------------------------------------------------------

describe("packReplayImpactToReplayDelta", () => {
  it("serializes a real pack replay impact into a schema-valid, JSON-clean delta", async () => {
    const impact = await evaluatePackReplayImpact({
      corpus: corpus([entry({ command: "pnpm test" })]),
      currentPolicy: { active: [] },
      pack: compiledPack("pack:allow-pnpm", [
        rule("allow-pnpm", "allow", program("pnpm")),
      ]),
    });

    const delta = packReplayImpactToReplayDelta(impact);

    expect(Value.Check(ReplayDeltaSchema, delta)).toBe(true);
    expect(delta.status).toBe("passed");
    expect(delta.changedCalls).toBe(1);
    expect(transitionCalls(delta, "review->fast_path")).toBe(1);
    // No Map/ReplayCompare/compiled matcher functions cross into transport.
    expect(containsMapOrFunction(delta)).toBe(false);
    expect(JSON.parse(JSON.stringify(delta))).toEqual(delta);
    // changedFamilies/changedRecords are intentionally empty for the legacy
    // summary (it groups by command, not per-family/per-record).
    expect(delta.changedFamilies).toEqual([]);
    expect(delta.changedRecords).toEqual([]);
  });

  it("preserves pack-validation regression issue wording for regression transitions", async () => {
    const impact = await evaluatePackReplayImpact({
      corpus: corpus([entry({ command: "git status" })]),
      currentPolicy: { active: [rule("allow-git", "allow", program("git"))] },
      pack: compiledPack("pack:review-git", [
        rule("review-git", "review", program("git")),
      ]),
    });

    const delta = packReplayImpactToReplayDelta(impact);

    expect(delta.status).toBe("regression");
    expect(delta.regressions).toHaveLength(1);
    const regression = delta.regressions[0];
    expect(regression?.transition).toBe("fast_path->review");
    expect(regression?.kind).toBe("allow-to-review");
    // The regression message reuses the pack-validation issue wording
    // (transition key + effect-direction prose).
    expect(regression?.message).toContain("fast_path->review");
    expect(regression?.message).toContain("allow→review");
  });

  it("uses core review-reduction semantics and does not fabricate block attribution", async () => {
    const impact = await evaluatePackReplayImpact({
      corpus: corpus([
        entry({ command: "pnpm test" }),
        entry({ command: "rm -rf tmp" }),
      ]),
      currentPolicy: { active: [] },
      pack: compiledPack("pack:mixed", [
        rule("allow-pnpm", "allow", program("pnpm")),
        rule("deny-rm", "deny", program("rm")),
      ]),
    });

    const delta = packReplayImpactToReplayDelta(impact);

    expect(delta.transitions).toEqual(
      expect.arrayContaining([
        { transition: "review->fast_path", calls: 1, uniqueCommands: 1 },
        { transition: "review->hard_block", calls: 1, uniqueCommands: 0 },
      ]),
    );
    // Net review load drops from two review calls to zero, so the bridge must
    // match the core engine's review-reduction semantics rather than only
    // counting review->allow expansions.
    expect(delta.improvement.reviewReductionPercent).toBe(100);
    expect(delta.improvement.remainingReviewCalls).toBe(0);
    // PackReplayImpactSummary cannot distinguish sealed-floor blocks from active
    // denies, so the typed bridge reports no attribution instead of fabricating
    // every hard block as active-deny.
    expect(delta.blocked.sealedFloorBlockCalls).toBe(0);
    expect(delta.blocked.activeDenyBlockCalls).toBe(0);
    expect(delta.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("does not expose sealed-floor vs active-deny"),
      ]),
    );
  });

  it("emits a not-run delta for a not-run impact summary", () => {
    const impact: PackReplayImpactSummary = {
      status: "not-run",
      changedUnique: 0,
      changedCalls: 0,
      reviewToAllow: 0,
      denyToAllow: 0,
      allowToReviewOrDeny: 0,
      changedStatuses: new Map(),
      issues: [],
    };

    const delta = packReplayImpactToReplayDelta(impact);

    expect(Value.Check(ReplayDeltaSchema, delta)).toBe(true);
    expect(delta.status).toBe("not-run");
    expect(delta.warnings).toEqual(
      expect.arrayContaining(["replay impact was not run"]),
    );
  });
});

// ---------------------------------------------------------------------------
// Compatibility: the existing pack-enablement proposal path still emits a
// typed replay delta (no Map leakage) through the shared bridge.
// ---------------------------------------------------------------------------

describe("pack-enablement proposal compatibility", () => {
  it("packEnablementPlanToStructuredProposal emits a typed replayDelta via the shared bridge", async () => {
    const { packEnablementPlanToStructuredProposal } = await import(
      "../../src/replay/pack-enablement-proposal.ts"
    );
    const impact = await evaluatePackReplayImpact({
      corpus: corpus([entry({ command: "pnpm test" })]),
      currentPolicy: { active: [] },
      pack: compiledPack("pack:allow-pnpm", [
        rule("allow-pnpm", "allow", program("pnpm")),
      ]),
    });

    const plan = {
      id: "pack-enable:test-safety",
      request: {
        action: "enable" as const,
        scope: "global" as const,
        subject: "package" as const,
        packId: "test-safety",
      },
      targetPath: "~/.config/pi-auto-approve/config.json",
      patch: [
        {
          op: "replace" as const,
          path: "/packEnablement/enabledPackagePacks",
          before: [],
          value: ["test-safety"],
        },
      ],
      before: {
        scope: "global" as const,
        packEnablement: {
          enabledPackagePacks: [],
          disabledPackagePacks: [],
          disabledConfigPacks: [],
        },
        packs: [],
      },
      after: {
        scope: "global" as const,
        packEnablement: {
          enabledPackagePacks: ["test-safety"],
          disabledPackagePacks: [],
          disabledConfigPacks: [],
        },
        packs: [],
      },
      warnings: [],
      requiredAcknowledgementCodes: [],
    };

    const proposal = packEnablementPlanToStructuredProposal({
      plan,
      createdAt: CREATED_AT,
      evidence: emptyEvidence(),
      replayImpact: impact,
    });

    const delta = proposal.evidence.replayDelta;
    expect(delta).toBeDefined();
    if (delta === undefined) {
      throw new Error(
        "expected typed replayDelta on the pack-enablement proposal",
      );
    }
    expect(Value.Check(ReplayDeltaSchema, delta)).toBe(true);
    expect(containsMapOrFunction(delta)).toBe(false);
    expect(transitionCalls(delta, "review->fast_path")).toBe(1);
    // JSON round-trip proves no Map/function/compiled-matcher crossed transport.
    expect(JSON.parse(JSON.stringify(delta))).toEqual(delta);
  });
});
