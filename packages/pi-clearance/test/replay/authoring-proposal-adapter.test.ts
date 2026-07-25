import { describe, expect, it } from "vitest";

import type { BashStage, ToolShape } from "../../src/parse/shape.ts";
import type { MatcherExpr } from "../../src/policy/core.ts";
import { compileMatch } from "../../src/policy/core.ts";
import {
  AuthoringProposalAdapterError,
  type AuthoringProposalAdapterOptions,
  authoringDesignInputToStructuredProposal,
  packFileWriteDescription,
  proposeStructuredAuthoringInputs,
  ruleProposalDesignInputToStructuredProposal,
} from "../../src/replay/authoring-proposal-adapter.ts";
import type {
  PackFileAuthoringProposalChange,
  StructuredRatchetProposal,
} from "../../src/replay/proposal-schema.ts";
import {
  isWritableProposal,
  proposalJsonRoundTrip,
  validateStructuredProposal,
} from "../../src/replay/proposal-schema.ts";
import type {
  CoreMatcherDesignInput,
  FloorOverlapCheck,
  ProposalApprovalFraming,
  ProposalEvidence,
  RuleProposal,
} from "../../src/replay/proposals.ts";
import { proposeRules } from "../../src/replay/proposals.ts";
import type {
  CapturedOutcomeLabel,
  PerCommandRow,
  RatchetReport,
  ReplayBashParser,
} from "../../src/replay/ratchet.ts";

const CREATED_AT = "2026-06-26T00:00:00.000Z";
const PROJECT_ROOT = "/home/nathan/dev/pi-clearance";
const CORE_MATCHER_PATH = `${PROJECT_ROOT}/.work/design-inputs/core-matcher.json`;
const SHIPPED_PACK_PATH = `${PROJECT_ROOT}/.work/design-inputs/shipped-pack-rule.json`;

const ADAPTER_OPTIONS: AuthoringProposalAdapterOptions = {
  createdAt: CREATED_AT,
  projectRoot: PROJECT_ROOT,
  coreMatcherPath: CORE_MATCHER_PATH,
  shippedPackPath: SHIPPED_PACK_PATH,
};

const GIT_STATUS_MATCH = {
  all: [
    { program: "git" },
    { arg0In: ["status"] },
    { noSubstitution: true },
    { noStdoutRedirect: true },
  ],
};

function mustChange(
  proposal: StructuredRatchetProposal,
): PackFileAuthoringProposalChange {
  const change = proposal.change;
  if (change.kind !== "pack-file-authoring") {
    throw new Error(`expected pack-file-authoring change, got ${change.kind}`);
  }
  return change;
}

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
    routesAsDesignInput: true,
    requiresAcknowledgment: false,
    summary: "authoring design input",
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
  readonly intendedProvenance?: RuleProposal["intendedProvenance"];
  readonly evidence?: ProposalEvidence;
  readonly floorOverlap?: FloorOverlapCheck;
  readonly approvalFraming?: ProposalApprovalFraming;
  readonly warnings?: readonly string[];
  readonly coreMatcher?: CoreMatcherDesignInput;
}

function ruleProposal(overrides: RuleProposalOverrides = {}): RuleProposal {
  return {
    id: overrides.id ?? "prop:generated-allow-git-status",
    kind: overrides.kind ?? "data",
    target: overrides.target ?? "user-global",
    effect: overrides.effect ?? "allow",
    ruleId: overrides.ruleId ?? "generated-allow-git-status",
    ...(overrides.packId === undefined ? {} : { packId: overrides.packId }),
    match: overrides.match ?? GIT_STATUS_MATCH,
    compiledMatch: overrides.compiledMatch ?? compiled(GIT_STATUS_MATCH),
    reason:
      overrides.reason ??
      "Reduce repeated git review friction with a validated structural matcher.",
    scope: "global",
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
    ],
    floorOverlap: overrides.floorOverlap ?? floorEmit(),
    approvalFraming: overrides.approvalFraming ?? defaultFraming(),
    modelDrafted: false,
    warnings: overrides.warnings ?? [],
    ...(overrides.coreMatcher === undefined
      ? {}
      : { coreMatcher: overrides.coreMatcher }),
  };
}

function coreProposal(): RuleProposal {
  return ruleProposal({
    id: "prop:core-matcher-git-c",
    kind: "core-matcher",
    target: "core-matcher",
    effect: "review",
    ruleId: "design-core-matcher-git-c",
    intendedProvenance: "shipped",
    approvalFraming: defaultFraming({
      touchesDsl: true,
      requiresAcknowledgment: true,
      summary:
        "core matcher DSL design input; requires explicit acknowledgment",
    }),
    coreMatcher: {
      name: "gitWithWorkingTree",
      signature: "gitWithWorkingTree(subcommands: string[]): MatcherExpr",
      gap: "Current data DSL cannot express git -C path subcommand guards.",
      rationale: "Repeated git -C usage needs a reusable core matcher.",
      examples: [
        {
          command: "git -C repo status --short",
          matches: true,
          capturedOutcome: "model-review",
        },
      ],
    },
  });
}

function shippedPackProposal(): RuleProposal {
  return ruleProposal({
    id: "prop:shipped-pack-prettier-check",
    kind: "data",
    target: "shipped-pack",
    effect: "allow",
    ruleId: "allow-prettier-check",
    packId: "bash.dev.verify",
    intendedProvenance: "shipped",
    approvalFraming: defaultFraming({
      summary:
        "shipped-pack design input; apply skill routes without writing shipped code",
    }),
    match: {
      all: [
        { program: "prettier" },
        { arg0In: ["--check"] },
        { noSubstitution: true },
        { noStdoutRedirect: true },
      ],
    },
    compiledMatch: compiled({
      all: [
        { program: "prettier" },
        { arg0In: ["--check"] },
        { noSubstitution: true },
        { noStdoutRedirect: true },
      ],
    }),
    reason:
      "Repeated prettier --check calls are good shipped verify-pack candidates.",
  });
}

describe("authoring-proposal-adapter — single proposal conversion", () => {
  it("converts core-matcher proposals with matcher name, signature, DSL gap, and examples", () => {
    const structured = authoringDesignInputToStructuredProposal(
      coreProposal() as Parameters<
        typeof authoringDesignInputToStructuredProposal
      >[0],
      ADAPTER_OPTIONS,
    );

    expect(structured.target).toEqual({
      kind: "design-input",
      route: "core-matcher",
      suggestedPath: CORE_MATCHER_PATH,
    });
    expect(structured.intendedProvenance).toBe("shipped");
    const change = mustChange(structured);
    expect(change).toMatchObject({
      authoringKind: "core-matcher",
      matcherName: "gitWithWorkingTree",
      matcherSignature:
        "gitWithWorkingTree(subcommands: string[]): MatcherExpr",
    });
    expect(change.rationale).toContain("DSL gap:");
    const contents = JSON.parse(change.fileWrite?.contents ?? "{}");
    expect(contents).toMatchObject({
      kind: "core-matcher-design-input",
      name: "gitWithWorkingTree",
      gap: "Current data DSL cannot express git -C path subcommand guards.",
    });
    expect(structured.validation.matcherCompile).toMatchObject({
      status: "skipped",
      code: "matcher-compile-design-input",
    });
    expect(structured.trustNotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "core-source-change" }),
      ]),
    );
  });

  it("converts shipped-pack source suggestions as non-writable exact raw rule JSON", () => {
    const structured = authoringDesignInputToStructuredProposal(
      shippedPackProposal() as Parameters<
        typeof authoringDesignInputToStructuredProposal
      >[0],
      ADAPTER_OPTIONS,
    );

    expect(structured).toMatchObject({
      kind: "pack-file-authoring",
      applicationMode: "design-input-only",
      target: {
        kind: "design-input",
        route: "shipped-pack",
        suggestedPath: SHIPPED_PACK_PATH,
      },
      intendedProvenance: "shipped",
    });
    const change = mustChange(structured);
    expect(change).toMatchObject({
      authoringKind: "shipped-pack-source",
      packId: "bash.dev.verify",
      ruleId: "allow-prettier-check",
      rawRule: {
        id: "allow-prettier-check",
        effect: "allow",
        reason:
          "Repeated prettier --check calls are good shipped verify-pack candidates.",
        provenance: { source: "shipped" },
      },
    });
    expect(change.rawRule).toMatchObject({
      match: shippedPackProposal().match,
    });
    expect(change.fileWrite).toMatchObject({
      path: SHIPPED_PACK_PATH,
      format: "json",
      mode: "patch",
      atomic: true,
      backupRequired: true,
      patch: [
        {
          op: "add",
          path: "/rules/-",
          value: change.rawRule,
        },
      ],
    });
    expect(structured.warnings).toEqual(
      expect.arrayContaining([
        "shipped-pack source suggestion is non-writable design input",
      ]),
    );
  });

  it("returns undefined for ordinary data proposals at the authoring boundary", () => {
    expect(
      ruleProposalDesignInputToStructuredProposal(
        ruleProposal(),
        ADAPTER_OPTIONS,
      ),
    ).toBeUndefined();
  });
});

describe("authoring-proposal-adapter — helper and transport behavior", () => {
  it("builds exact file-write descriptions and rejects ambiguous contents", () => {
    expect(
      packFileWriteDescription({
        path: "/tmp/design.json",
        format: "json",
        contents: "{}",
      }),
    ).toEqual({
      path: "/tmp/design.json",
      format: "json",
      mode: "create",
      atomic: true,
      backupRequired: true,
      contents: "{}",
    });

    expect(() =>
      packFileWriteDescription({
        path: "/tmp/design.json",
        format: "json",
      }),
    ).toThrow(AuthoringProposalAdapterError);
    expect(() =>
      packFileWriteDescription({
        path: "/tmp/design.json",
        format: "json",
        contents: "{}",
        patch: [{ op: "add", path: "/rules/-", value: {} }],
      }),
    ).toThrow(AuthoringProposalAdapterError);
  });

  it("emits schema-valid JSON-round-trippable proposals without Map or markdown-derived data", () => {
    for (const legacy of [coreProposal(), shippedPackProposal()]) {
      const structured = authoringDesignInputToStructuredProposal(
        legacy as Parameters<
          typeof authoringDesignInputToStructuredProposal
        >[0],
        ADAPTER_OPTIONS,
      );
      expect(validateStructuredProposal(structured)).toMatchObject({
        ok: true,
      });
      expect(proposalJsonRoundTrip(structured)).toEqual(structured);
      expect(JSON.stringify(structured)).not.toContain("```markdown");
      expect(structured.evidence.capturedOutcomeCounts).toEqual([
        { label: "model-review", calls: 2 },
      ]);
      expect(structured.evidence.familyIds).toEqual([]);
      expect(structured.evidence.recordIds).toEqual([]);
    }
  });
});

describe("authoring-proposal-adapter — generator integration", () => {
  it("converts legacy authoring design inputs and skips ordinary data-pack proposals", async () => {
    const input = {
      report: report([
        row({
          command: "tool check src/file.ts",
          executable: "tool",
          reason: "needs argument inside project root",
        }),
        row({ command: "git status --short", executable: "git" }),
      ]),
      currentPolicy: { floor: [] },
    };

    const legacy = await proposeRules(input, { bashParser: parser() });
    expect(legacy.some((proposal) => proposal.kind === "core-matcher")).toBe(
      true,
    );
    expect(legacy.some((proposal) => proposal.kind === "data")).toBe(true);

    const structured = await proposeStructuredAuthoringInputs(input, {
      bashParser: parser(),
      createdAt: CREATED_AT,
      projectRoot: PROJECT_ROOT,
    });

    expect(structured.map((proposal) => proposal.kind)).toEqual([
      "pack-file-authoring",
    ]);
    expect(
      structured.map((proposal) => mustChange(proposal).authoringKind),
    ).toEqual(["core-matcher"]);
    expect(structured.every((proposal) => !isWritableProposal(proposal))).toBe(
      true,
    );
  });
});

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

function parser(): ReplayBashParser {
  return async (command) => {
    const [program = "", ...rest] = command.trim().split(/\s+/);
    const args = rest.filter((part) => !part.startsWith("-"));
    const flags = rest.filter((part) => part.startsWith("-"));
    return commandShape({ command, program, args, flags });
  };
}

function outcomes(
  entries: readonly [CapturedOutcomeLabel, number][] = [["model-review", 1]],
): ReadonlyMap<CapturedOutcomeLabel, number> {
  return new Map(entries);
}

function row(overrides: Partial<PerCommandRow> = {}): PerCommandRow {
  return {
    command: "git status --short",
    count: 1,
    toolName: "bash",
    executable: "git",
    status: "review",
    reason: "test friction",
    capturedOutcomes: outcomes(),
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
