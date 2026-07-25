import { describe, expect, it } from "vitest";

import type { BashStage, ToolShape } from "../../src/parse/shape.ts";
import type { MatcherExpr, PolicyRule } from "../../src/policy/core.ts";
import { compileMatch } from "../../src/policy/core.ts";
import {
  CAPTURED_OUTCOME_LABELS,
  type CapturedOutcomeLabel,
} from "../../src/replay/corpus-model.ts";
import {
  PolicyProposalAdapterError,
  type PolicyProposalAdapterOptions,
  policyRuleProposalToStructuredProposal,
  proposeStructuredPolicyChanges,
  rawPackChangeFromRuleProposal,
} from "../../src/replay/policy-proposal-adapter.ts";
import type {
  PolicyPackProposalChange,
  StructuredRatchetProposal,
} from "../../src/replay/proposal-schema.ts";
import {
  isWritableProposal,
  PROPOSAL_SCHEMA_VERSION,
  proposalJsonRoundTrip,
  validateStructuredProposal,
} from "../../src/replay/proposal-schema.ts";
import type {
  FloorOverlapCheck,
  ProposalApprovalFraming,
  ProposalEvidence,
  RuleProposal,
} from "../../src/replay/proposals.ts";
import { proposeRules } from "../../src/replay/proposals.ts";
import type {
  PerCommandRow,
  RatchetReport,
  ReplayBashParser,
} from "../../src/replay/ratchet.ts";

const CREATED_AT = "2026-06-26T00:00:00.000Z";
const GLOBAL_CONFIG_PATH =
  "/home/nathan/.config/pi/pi-auto-approve/global.json";
const PROJECT_OVERLAY_PATH =
  "/home/nathan/.config/pi/pi-auto-approve/projects/pi-auto-approve-abc12345/overlay.json";
const PROJECT_KEY = "pi-auto-approve-abc12345";
const PROJECT_ROOT = "/home/nathan/dev/pi-auto-approve";

const ADAPTER_OPTIONS: PolicyProposalAdapterOptions = {
  createdAt: CREATED_AT,
  globalConfigPath: GLOBAL_CONFIG_PATH,
  projectOverlayPath: PROJECT_OVERLAY_PATH,
  projectKey: PROJECT_KEY,
  projectRoot: PROJECT_ROOT,
};

/** Narrow a structured proposal's change to the policy-pack variant the adapter emits. */
function mustGet<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected item at index ${index}`);
  }
  return item;
}

function policyChange(
  proposal: StructuredRatchetProposal,
): PolicyPackProposalChange {
  const change = proposal.change;
  if (change.kind !== "policy-pack") {
    throw new Error(`expected policy-pack change, got ${change.kind}`);
  }
  return change;
}

const GIT_STATUS_MATCH = {
  all: [
    { program: "git" },
    { arg0In: ["status"] },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

function compiled(match: unknown): MatcherExpr {
  const result = compileMatch(match);
  if ("errors" in result) {
    throw new Error(JSON.stringify(result.errors));
  }
  return result.expr;
}

function floorEmit(): FloorOverlapCheck {
  return {
    status: "disjoint",
    action: "emit",
    checkedFloorRuleIds: [],
    overlappingFloorRuleIds: [],
    note: "allow draft is disjoint from checked floor denies",
  };
}

function floorDowngraded(): FloorOverlapCheck {
  return {
    status: "unknown",
    action: "downgraded-to-review",
    checkedFloorRuleIds: ["floor:git"],
    overlappingFloorRuleIds: ["floor:git"],
    note: "allow draft was downgraded to review because floor safety was not provable",
  };
}

function floorSkippedNonAllow(): FloorOverlapCheck {
  return {
    status: "disjoint",
    action: "skipped-non-allow",
    checkedFloorRuleIds: ["floor:git"],
    overlappingFloorRuleIds: [],
    note: "floor overlap check applies only to allow proposals",
  };
}

function evidence(overrides: Partial<ProposalEvidence> = {}): ProposalEvidence {
  return {
    executable: "git",
    calls: 2,
    unique: 1,
    reviewCalls: 2,
    hardBlockCalls: 0,
    modelReviewCalls: 2,
    capturedDenialCalls: 0,
    behaviors: [],
    sampleCommands: ["git status --short"],
    capturedOutcomeBreakdown: new Map<CapturedOutcomeLabel, number>([
      ["model-review", 2],
    ]),
    ...overrides,
  };
}

function defaultFraming(
  overrides: Partial<ProposalApprovalFraming> = {},
): ProposalApprovalFraming {
  return {
    writesExecutableCode: false,
    touchesDsl: false,
    routesAsDesignInput: false,
    requiresAcknowledgment: false,
    summary: "data-only user-global overlay proposal",
    ...overrides,
  };
}

interface RuleProposalOverrides {
  readonly id?: string;
  readonly kind?: RuleProposal["kind"];
  readonly target?: RuleProposal["target"];
  readonly effect?: RuleProposal["effect"];
  readonly ruleId?: string;
  readonly packId?: string;
  readonly match?: unknown;
  readonly compiledMatch?: MatcherExpr;
  readonly reason?: string;
  readonly scope?: RuleProposal["scope"];
  readonly intendedProvenance?: RuleProposal["intendedProvenance"];
  readonly evidence?: ProposalEvidence;
  readonly floorOverlap?: FloorOverlapCheck;
  readonly approvalFraming?: ProposalApprovalFraming;
  readonly modelDrafted?: boolean;
  readonly warnings?: readonly string[];
}

function ruleProposal(overrides: RuleProposalOverrides = {}): RuleProposal {
  const effect = overrides.effect ?? "allow";
  return {
    id: overrides.id ?? "prop:generated-allow-git-status",
    kind: overrides.kind ?? "data",
    target: overrides.target ?? "user-global",
    effect,
    ruleId: overrides.ruleId ?? "generated-allow-git-status",
    ...(overrides.packId === undefined ? {} : { packId: overrides.packId }),
    match: overrides.match ?? GIT_STATUS_MATCH,
    compiledMatch: overrides.compiledMatch ?? compiled(GIT_STATUS_MATCH),
    reason:
      overrides.reason ??
      "Reduce repeated git review friction with a validated structural matcher.",
    scope: overrides.scope ?? "global",
    provenance: { source: "generated" },
    intendedProvenance: overrides.intendedProvenance ?? "user-global",
    evidence: overrides.evidence ?? evidence(),
    examples: [
      {
        command: "git status --short",
        matches: true,
        capturedOutcome: "model-review",
        note: "corpus command verified against proposed matcher",
      },
      {
        command: "git push --force origin main",
        matches: false,
        note: "adversarial near-miss verified not to match",
      },
    ],
    fixtureSuggestions: [
      {
        command: "git status --short",
        expected: "fast_path",
        reason: "Positive example for prop:generated-allow-git-status",
        provenance: "prop:generated-allow-git-status",
      },
      {
        command: "git push --force origin main",
        expected: "hard_block",
        reason: "Adversarial near-miss for prop:generated-allow-git-status",
        provenance: "prop:generated-allow-git-status",
      },
    ],
    floorOverlap: overrides.floorOverlap ?? floorEmit(),
    approvalFraming: overrides.approvalFraming ?? defaultFraming(),
    modelDrafted: overrides.modelDrafted ?? false,
    warnings: overrides.warnings ?? [
      "structural draft uses program/arg0 guards",
    ],
  };
}

// ---------------------------------------------------------------------------
// End-to-end report/parser builders (mirror proposals-orchestrator.test.ts)
// ---------------------------------------------------------------------------

function commandShape(options: {
  readonly command: string;
  readonly program: string;
  readonly args?: readonly string[];
  readonly flags?: readonly string[];
}): ToolShape {
  const stage: BashStage = {
    kind: "command",
    program: {
      program: options.program,
      resolvable: true,
      arguments: options.args ?? [],
      flags: (options.flags ?? []).map((flag, index) => ({
        raw: flag,
        name: flag.replace(/^-+/, ""),
        short: !flag.startsWith("--"),
        span: { start: index, end: index + flag.length },
      })),
      environment: [],
      span: { start: 0, end: options.program.length },
    },
    substitutions: [],
    redirects: [],
    span: { start: 0, end: options.command.length },
  };

  return {
    kind: "bash",
    rawCommand: options.command,
    blocks: [
      {
        pipeline: {
          stages: [stage],
          pipeTargets: [],
          span: { start: 0, end: options.command.length },
        },
        span: { start: 0, end: options.command.length },
      },
    ],
    stages: [stage],
    diagnostics: [],
  };
}

function simpleParser(): ReplayBashParser {
  return async (command) => {
    const [program = "", ...rest] = command.trim().split(/\s+/);
    const args = rest.filter((part) => !part.startsWith("-"));
    const flags = rest.filter((part) => part.startsWith("-"));
    return commandShape({ command, program, args, flags });
  };
}

function row(overrides: Partial<PerCommandRow> = {}): PerCommandRow {
  return {
    command: "git status --short",
    count: 2,
    toolName: "bash",
    executable: "git",
    status: "review",
    reason: "test friction",
    capturedOutcomes: new Map<CapturedOutcomeLabel, number>([
      ["model-review", 2],
    ]),
    fidelity: "high",
    sources: ["session"],
    ...overrides,
  };
}

function report(rows: readonly PerCommandRow[]): RatchetReport {
  return {
    generatedAt: "2026-06-25T12:00:00.000Z",
    corpus: {
      totalCalls: rows.reduce((sum, item) => sum + item.count, 0),
      totalUnique: rows.length,
      sources: new Map([
        ["session", rows.length],
        ["audit", 0],
        ["corpus", 0],
      ]),
      unmatchedAuditEntries: 0,
      warnings: [],
    },
    summary: {
      totalCalls: rows.reduce((sum, item) => sum + item.count, 0),
      totalUnique: rows.length,
      fastPathCalls: 0,
      fastPathUnique: 0,
      reviewCalls: rows.length,
      reviewUnique: rows.length,
      hardBlockCalls: 0,
      hardBlockUnique: 0,
      byCapturedOutcome: new Map(),
      modelReviewLoad: { calls: 0, unique: 0 },
      redactedCalls: 0,
    },
    topReviewedExecutables: [],
    topFastPathExecutables: [],
    topReviewedCommands: [],
    topHardBlockedCommands: [],
    topContentiousFamilies: [],
    topUnknownTools: [],
    perCommand: rows,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("policy-proposal-adapter — single-proposal conversion", () => {
  it("converts a user-global allow into a writable data-pack-policy proposal", () => {
    const proposal = ruleProposal();
    const structured = policyRuleProposalToStructuredProposal(
      proposal,
      ADAPTER_OPTIONS,
    );

    expect(structured.version).toBe(PROPOSAL_SCHEMA_VERSION);
    expect(structured.kind).toBe("data-pack-policy");
    expect(structured.id).toBe(proposal.id);
    expect(structured.applicationMode).toBe("writable-after-approval");
    expect(isWritableProposal(structured)).toBe(true);
    expect(structured.target).toEqual({
      kind: "user-global-config",
      path: GLOBAL_CONFIG_PATH,
    });
    expect(structured.intendedProvenance).toBe("user-global");
    const change = policyChange(structured);
    expect(change.kind).toBe("policy-pack");
    expect(change).toMatchObject({
      packId: "user-global-git",
      ruleId: "generated-allow-git-status",
      effect: "allow",
      match: GIT_STATUS_MATCH,
    });
    // Raw pack patch adds a user-owned pack with the rule to the config packs array.
    expect(change.rawPackPatch).toEqual([
      {
        op: "add",
        path: "/packs/-",
        value: {
          version: 1,
          id: "user-global-git",
          rules: [
            {
              id: "generated-allow-git-status",
              effect: "allow",
              match: GIT_STATUS_MATCH,
              reason: proposal.reason,
              provenance: { source: "user-global" },
            },
          ],
        },
      },
    ]);
    // Writable user-global proposal carries a file-write description.
    expect(change.fileWrite).toMatchObject({
      path: GLOBAL_CONFIG_PATH,
      format: "json",
      mode: "patch",
      atomic: true,
      backupRequired: true,
    });
    expect(change.fileWrite?.patch).toBe(change.rawPackPatch);
    // No compiled matcher / Map / function leaks into the structured object.
    expect(JSON.stringify(structured).includes("compiledMatch")).toBe(false);
  });

  it("routes a user-project proposal to a user-project-overlay target with project fields", () => {
    const proposal = ruleProposal({
      target: "user-project",
      scope: "project",
      intendedProvenance: "user-project",
    });
    const structured = policyRuleProposalToStructuredProposal(
      proposal,
      ADAPTER_OPTIONS,
    );

    expect(structured.target).toEqual({
      kind: "user-project-overlay",
      path: PROJECT_OVERLAY_PATH,
      projectKey: PROJECT_KEY,
      projectRoot: PROJECT_ROOT,
    });
    expect(structured.intendedProvenance).toBe("user-project");
    expect(policyChange(structured).packId).toBe("user-project-git");
    expect(structured.applicationMode).toBe("writable-after-approval");
    expect(policyChange(structured).fileWrite?.path).toBe(PROJECT_OVERLAY_PATH);
  });

  it("represents shipped-pack recommendations as design input, not writable config", () => {
    const proposal = ruleProposal({
      target: "shipped-pack",
      packId: "bash.dev.verify",
      intendedProvenance: "shipped",
      approvalFraming: defaultFraming({
        routesAsDesignInput: true,
        summary:
          "shipped-pack design input; apply skill routes without writing shipped code",
      }),
    });
    const structured = policyRuleProposalToStructuredProposal(
      proposal,
      ADAPTER_OPTIONS,
    );

    expect(structured.applicationMode).toBe("design-input-only");
    expect(isWritableProposal(structured)).toBe(false);
    expect(structured.target).toEqual({
      kind: "design-input",
      route: "shipped-pack",
    });
    // The change names the shipped pack + suggested rule, but claims no write.
    const change = policyChange(structured);
    expect(change.packId).toBe("bash.dev.verify");
    expect(change.effect).toBe("allow");
    expect(change.match).toBe(GIT_STATUS_MATCH);
    expect(change.rawPackPatch).toEqual([]);
    expect(change.fileWrite).toBeUndefined();
    expect(structured.warnings).toEqual(
      expect.arrayContaining([
        "shipped-pack recommendation is design input; the ratchet cannot write shipped source",
      ]),
    );
  });

  it("keeps a floor-overlap-downgraded review proposal writable and records the failed floor check", () => {
    // The existing generator downgraded an unsafe allow to a review rule. The
    // structured proposal is writable as a review rule, but floorOverlap is fail.
    const proposal = ruleProposal({
      effect: "review",
      floorOverlap: floorDowngraded(),
    });
    const structured = policyRuleProposalToStructuredProposal(
      proposal,
      ADAPTER_OPTIONS,
    );

    expect(structured.applicationMode).toBe("writable-after-approval");
    expect(policyChange(structured).effect).toBe("review");
    expect(structured.validation.floorOverlap).toMatchObject({
      status: "fail",
      code: "floor-overlap-downgraded",
    });
    expect(structured.validation.floorOverlap?.details).toMatchObject({
      checkedFloorRuleIds: ["floor:git"],
      overlappingFloorRuleIds: ["floor:git"],
    });
  });

  it("keeps deny proposals writable as posture-tightening config writes", () => {
    const structured = policyRuleProposalToStructuredProposal(
      ruleProposal({ effect: "deny", floorOverlap: floorSkippedNonAllow() }),
      ADAPTER_OPTIONS,
    );

    expect(structured.applicationMode).toBe("writable-after-approval");
    expect(isWritableProposal(structured)).toBe(true);
    const change = policyChange(structured);
    expect(change.effect).toBe("deny");
    expect(change.rawPackPatch).toHaveLength(1);
    expect(change.fileWrite?.patch).toBe(change.rawPackPatch);
    expect(structured.validation.floorOverlap?.status).toBe("skipped");
  });

  it("marks an undecidable allow non-writable (design-input-only) and drops the patch", () => {
    // Defensive: if an unsafe allow somehow reached the adapter unchanged, the
    // adapter marks it non-writable rather than emitting a writable allow.
    const proposal = ruleProposal({
      effect: "allow",
      floorOverlap: floorDowngraded(),
    });
    const structured = policyRuleProposalToStructuredProposal(
      proposal,
      ADAPTER_OPTIONS,
    );

    expect(structured.applicationMode).toBe("design-input-only");
    expect(isWritableProposal(structured)).toBe(false);
    const change = policyChange(structured);
    expect(change.fileWrite).toBeUndefined();
    expect(change.rawPackPatch).toEqual([]);
    expect(structured.validation.floorOverlap?.status).toBe("fail");
    expect(structured.warnings).toEqual(
      expect.arrayContaining([
        "allow proposal is not floor-safe; marked non-writable (design-input-only)",
      ]),
    );
    expect(
      structured.trustNotes.some((note) => note.kind === "non-writable-allow"),
    ).toBe(true);
  });

  it("preserves model-drafted provenance as a trust note", () => {
    const proposal = ruleProposal({
      modelDrafted: true,
      reason: "model drafted the git status convenience rule",
    });
    const structured = policyRuleProposalToStructuredProposal(
      proposal,
      ADAPTER_OPTIONS,
    );

    expect(structured.reason).toBe(
      "model drafted the git status convenience rule",
    );
    expect(
      structured.trustNotes.some((note) => note.kind === "model-origin"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rawPackChangeFromRuleProposal
// ---------------------------------------------------------------------------

describe("policy-proposal-adapter — rawPackChangeFromRuleProposal", () => {
  it("returns a policy-pack change without fileWrite for a writable user-global proposal", () => {
    const change = rawPackChangeFromRuleProposal(ruleProposal());
    expect(change.kind).toBe("policy-pack");
    expect(change.packId).toBe("user-global-git");
    expect(change.ruleId).toBe("generated-allow-git-status");
    expect(change.effect).toBe("allow");
    expect(change.match).toBe(GIT_STATUS_MATCH);
    expect(change.rawPackPatch).toHaveLength(1);
    expect(change.fileWrite).toBeUndefined();
  });

  it("returns an empty rawPackPatch for a shipped-pack design input", () => {
    const change = rawPackChangeFromRuleProposal(
      ruleProposal({
        target: "shipped-pack",
        packId: "bash.dev.verify",
        intendedProvenance: "shipped",
      }),
    );
    expect(change.packId).toBe("bash.dev.verify");
    expect(change.rawPackPatch).toEqual([]);
  });

  it("throws for non-data proposal kinds", () => {
    expect(() =>
      rawPackChangeFromRuleProposal(
        ruleProposal({ kind: "core-matcher", target: "core-matcher" }),
      ),
    ).toThrow(PolicyProposalAdapterError);
  });
});

// ---------------------------------------------------------------------------
// Validation status taxonomy
// ---------------------------------------------------------------------------

describe("policy-proposal-adapter — validation status", () => {
  it("reflects matcher compile, floor overlap, adversarial near-miss, and pending downstream checks", () => {
    const structured = policyRuleProposalToStructuredProposal(
      ruleProposal(),
      ADAPTER_OPTIONS,
    );

    expect(structured.validation.schema.status).toBe("pass");
    expect(structured.validation.matcherCompile?.status).toBe("pass");
    expect(structured.validation.floorOverlap?.status).toBe("pass");
    // The fixture has one adversarial near-miss example.
    expect(structured.validation.adversarial?.status).toBe("pass");
    expect(structured.validation.adversarial?.code).toBe(
      "adversarial-near-miss-verified",
    );
    // Downstream checks are pending, never pass.
    expect(structured.validation.replay?.status).toBe("pending");
    expect(structured.validation.configSchema?.status).toBe("pending");
    // Structural matcher with no executable code: trust passes.
    expect(structured.validation.trust?.status).toBe("pass");
  });

  it("skips adversarial when the proposal carries no near-miss examples", () => {
    const proposal = ruleProposal();
    // Strip the negative example to exercise the skipped branch.
    const onlyPositive: RuleProposal = {
      ...proposal,
      examples: [mustGet(proposal.examples, 0)],
    };
    const structured = policyRuleProposalToStructuredProposal(
      onlyPositive,
      ADAPTER_OPTIONS,
    );
    expect(structured.validation.adversarial?.status).toBe("skipped");
    expect(structured.validation.adversarial?.code).toBe(
      "adversarial-no-near-miss",
    );
  });

  it("omits configSchema for design-input-only proposals", () => {
    const structured = policyRuleProposalToStructuredProposal(
      ruleProposal({
        target: "shipped-pack",
        packId: "bash.dev.verify",
        intendedProvenance: "shipped",
        approvalFraming: defaultFraming({ routesAsDesignInput: true }),
      }),
      ADAPTER_OPTIONS,
    );
    expect(structured.validation.configSchema).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Evidence mapping (Map → sorted arrays; no markdown; corpus references)
// ---------------------------------------------------------------------------

describe("policy-proposal-adapter — evidence and examples", () => {
  it("converts the capturedOutcomeBreakdown Map into canonical-order CountByLabel arrays", () => {
    const proposal = ruleProposal({
      evidence: evidence({
        capturedOutcomeBreakdown: new Map<CapturedOutcomeLabel, number>([
          ["human-deny", 3],
          ["model-review", 4],
          ["deterministic-allow", 0], // zero entries are dropped
        ]),
      }),
    });
    const structured = policyRuleProposalToStructuredProposal(
      proposal,
      ADAPTER_OPTIONS,
    );

    // Canonical order: model-review precedes human-deny; zero dropped.
    expect(structured.evidence.capturedOutcomeCounts).toEqual([
      { label: "model-review", calls: 4 },
      { label: "human-deny", calls: 3 },
    ]);
    // Every label is a valid canonical captured-outcome label.
    for (const entry of structured.evidence.capturedOutcomeCounts) {
      expect(CAPTURED_OUTCOME_LABELS).toContain(entry.label);
    }
  });

  it("derives replayStatusCounts from the legacy review/hard-block scalars", () => {
    const proposal = ruleProposal({
      evidence: evidence({
        reviewCalls: 5,
        hardBlockCalls: 2,
      }),
    });
    const structured = policyRuleProposalToStructuredProposal(
      proposal,
      ADAPTER_OPTIONS,
    );
    expect(structured.evidence.replayStatusCounts).toEqual([
      { label: "review", calls: 5 },
      { label: "hard_block", calls: 2 },
    ]);
  });

  it("leaves familyIds/recordIds empty with a corpus-link-pending trust note", () => {
    const structured = policyRuleProposalToStructuredProposal(
      ruleProposal(),
      ADAPTER_OPTIONS,
    );
    expect(structured.evidence.familyIds).toEqual([]);
    expect(structured.evidence.recordIds).toEqual([]);
    expect(structured.evidence.corpusSummary).toBeUndefined();
    expect(
      structured.trustNotes.some((note) => note.kind === "corpus-link-pending"),
    ).toBe(true);
  });

  it("preserves examples and fixture suggestions verbatim", () => {
    const proposal = ruleProposal();
    const structured = policyRuleProposalToStructuredProposal(
      proposal,
      ADAPTER_OPTIONS,
    );
    expect(structured.examples).toEqual(proposal.examples);
    expect(structured.fixtureSuggestions).toEqual(proposal.fixtureSuggestions);
  });
});

// ---------------------------------------------------------------------------
// JSON round-trip + schema validation
// ---------------------------------------------------------------------------

describe("policy-proposal-adapter — JSON contract", () => {
  const cases: ReadonlyArray<readonly [string, RuleProposal]> = [
    ["user-global allow", ruleProposal()],
    [
      "user-project review",
      ruleProposal({
        target: "user-project",
        effect: "review",
        scope: "project",
        intendedProvenance: "user-project",
      }),
    ],
    [
      "shipped-pack design input",
      ruleProposal({
        target: "shipped-pack",
        packId: "bash.dev.verify",
        intendedProvenance: "shipped",
        approvalFraming: defaultFraming({ routesAsDesignInput: true }),
      }),
    ],
    [
      "floor-overlap-downgraded review",
      ruleProposal({ effect: "review", floorOverlap: floorDowngraded() }),
    ],
    ["model-drafted", ruleProposal({ modelDrafted: true })],
    [
      "unsafe allow non-writable",
      ruleProposal({ effect: "allow", floorOverlap: floorDowngraded() }),
    ],
  ];

  it.each(
    cases,
  )("produces a schema-valid %s that JSON.stringify can serialize without a custom replacer", (_label, proposal) => {
    const structured = policyRuleProposalToStructuredProposal(
      proposal,
      ADAPTER_OPTIONS,
    );
    expect(validateStructuredProposal(structured).ok).toBe(true);
    const json = JSON.stringify(structured);
    expect(() => JSON.parse(json)).not.toThrow();
    // Round-trip preserves equality and re-validates.
    expect(proposalJsonRoundTrip(structured)).toEqual(structured);
  });
});

// ---------------------------------------------------------------------------
// Batch conversion (proposeStructuredPolicyChanges)
// ---------------------------------------------------------------------------

describe("policy-proposal-adapter — proposeStructuredPolicyChanges", () => {
  it("converts legacy data proposals and skips core-matcher design inputs", async () => {
    const input = {
      report: report([
        row({ command: "git status --short", count: 2 }),
        row({
          command: "git -C /home/nathan/dev/pi-auto-approve status",
          count: 1,
        }),
      ]),
      currentPolicy: { floor: [] } as unknown as {
        readonly floor: readonly PolicyRule[];
      },
    };

    const legacy = await proposeRules(input, { bashParser: simpleParser() });
    const structured = await proposeStructuredPolicyChanges(input, {
      bashParser: simpleParser(),
      createdAt: CREATED_AT,
      globalConfigPath: GLOBAL_CONFIG_PATH,
      projectOverlayPath: PROJECT_OVERLAY_PATH,
      projectKey: PROJECT_KEY,
      projectRoot: PROJECT_ROOT,
    });

    // Legacy produced a core-matcher design input (git -C path subcommand gap)
    // plus a data allow proposal (git status).
    expect(legacy.some((p) => p.kind === "core-matcher")).toBe(true);
    expect(legacy.some((p) => p.kind === "data")).toBe(true);

    // Structured output keeps only the data-pack-policy proposal.
    expect(structured.every((p) => p.kind === "data-pack-policy")).toBe(true);
    expect(structured.length).toBe(
      legacy.filter((p) => p.kind === "data").length,
    );
    expect(structured.length).toBe(1);

    const gitStatus = mustGet(structured, 0);
    expect(policyChange(gitStatus).effect).toBe("allow");
    expect(gitStatus.target.kind).toBe("user-global-config");
    expect(isWritableProposal(gitStatus)).toBe(true);
    expect(validateStructuredProposal(gitStatus).ok).toBe(true);
    expect(() => JSON.parse(JSON.stringify(gitStatus))).not.toThrow();
  });

  it("stamps createdAt from new Date() when not provided", async () => {
    const input = {
      report: report([row()]),
      currentPolicy: { floor: [] } as unknown as {
        readonly floor: readonly PolicyRule[];
      },
    };
    const structured = await proposeStructuredPolicyChanges(input, {
      bashParser: simpleParser(),
    });
    expect(structured.length).toBe(1);
    const firstStructured = mustGet(structured, 0);
    expect(firstStructured.createdAt.length).toBeGreaterThan(0);
    // ISO timestamp shape.
    expect(firstStructured.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it("returns an empty array when no data proposals are generated", async () => {
    const input = {
      report: report([]),
      currentPolicy: { floor: [] } as unknown as {
        readonly floor: readonly PolicyRule[];
      },
    };
    const structured = await proposeStructuredPolicyChanges(input, {
      bashParser: simpleParser(),
      createdAt: CREATED_AT,
    });
    expect(structured).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Non-data kinds throw
// ---------------------------------------------------------------------------

describe("policy-proposal-adapter — domain boundary", () => {
  it("throws PolicyProposalAdapterError for core-matcher proposals", () => {
    expect(() =>
      policyRuleProposalToStructuredProposal(
        ruleProposal({ kind: "core-matcher", target: "core-matcher" }),
        ADAPTER_OPTIONS,
      ),
    ).toThrow(PolicyProposalAdapterError);
  });
});
