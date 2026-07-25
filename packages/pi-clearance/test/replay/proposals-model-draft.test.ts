import { describe, expect, it, vi } from "vitest";

import type { BashStage, ToolShape } from "../../src/parse/shape.ts";
import type { PolicyRule } from "../../src/policy/core.ts";
import {
  compileMatch,
  inspectable,
  type MatcherExpr,
} from "../../src/policy/core.ts";
import {
  type FrictionCluster,
  type ModelDrafter,
  type ModelDraftResult,
  proposeRules,
  validateModelDraft,
} from "../../src/replay/proposals.ts";
import type {
  CapturedOutcomeLabel,
  PerCommandRow,
  RatchetReport,
  ReplayBashParser,
} from "../../src/replay/ratchet.ts";

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
  entries: readonly [CapturedOutcomeLabel, number][] = [],
): ReadonlyMap<CapturedOutcomeLabel, number> {
  return new Map(entries);
}

function row(overrides: Partial<PerCommandRow> = {}): PerCommandRow {
  return {
    command: "git status --short",
    count: 2,
    toolName: "bash",
    executable: "git",
    status: "review",
    reason: "test friction",
    capturedOutcomes: outcomes([["model-review", 2]]),
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

function compiled(match: unknown): MatcherExpr {
  const result = compileMatch(match);
  if ("errors" in result) {
    throw new Error(JSON.stringify(result.errors));
  }
  return result.expr;
}

function denyRule(id: string, match: unknown): PolicyRule {
  return {
    id,
    effect: "deny",
    match: inspectable(compiled(match)),
    reason: "test floor rule",
    provenance: { source: "shipped" },
  };
}

function cluster(): FrictionCluster {
  return {
    executable: "git",
    rows: [],
    signature: {
      program: "git",
      arg0Set: ["status"],
      flags: ["--short"],
      hasSubstitution: false,
      hasStdoutRedirect: false,
      parseDiagnostics: [],
    },
    addressableBy: "data",
    frictionScore: 2,
    behaviors: [],
    sampleCommands: ["git status --short"],
    evidence: {
      executable: "git",
      calls: 2,
      unique: 1,
      reviewCalls: 2,
      hardBlockCalls: 0,
      modelReviewCalls: 2,
      capturedDenialCalls: 0,
      behaviors: [],
      sampleCommands: ["git status --short"],
      capturedOutcomeBreakdown: new Map([["model-review", 2]]),
    },
    notes: [],
  };
}

const validGitStatusDraft: ModelDraftResult = {
  match: {
    all: [
      { program: "git" },
      { arg0In: ["status"] },
      { noSubstitution: true },
      { noStdoutRedirect: true },
    ],
  },
  effect: "allow",
  reason: "git status is read-only friction",
};

describe("proposal model-drafting validation", () => {
  it("accepts a model draft that compiles, passes floor checks, and verifies samples", async () => {
    const result = await validateModelDraft(
      validGitStatusDraft,
      cluster(),
      [],
      {
        bashParser: parser(),
      },
    );

    expect(result).toMatchObject({
      effect: "allow",
      origin: "model",
      match: validGitStatusDraft.match,
    });
  });

  it.each([
    ["non-compiling", { match: { unknown: true }, effect: "allow" }],
    [
      "under-matching",
      {
        match: {
          all: [
            { program: "git" },
            { arg0In: ["log"] },
            { noSubstitution: true },
            { noStdoutRedirect: true },
          ],
        },
        effect: "allow",
      },
    ],
    ["over-matching", { match: { program: "git" }, effect: "allow" }],
  ] as const)("rejects a %s model draft", async (_label, partial) => {
    const result = await validateModelDraft(
      { ...partial, reason: "bad draft" },
      cluster(),
      [],
      { bashParser: parser() },
    );

    expect(result).toBeNull();
  });

  it("rejects an allow draft whose floor overlap cannot be proved safe", async () => {
    const result = await validateModelDraft(
      validGitStatusDraft,
      cluster(),
      [denyRule("floor:git", { program: "git" })],
      { bashParser: parser() },
    );

    expect(result).toBeNull();
  });
});

describe("proposal model-drafting seam", () => {
  it("is deterministic by default and identical to a drafter returning undefined", async () => {
    const input = { report: report([row()]), currentPolicy: { floor: [] } };
    const noModel = await proposeRules(input, { bashParser: parser() });
    const undefinedModel = await proposeRules(input, {
      bashParser: parser(),
      modelDrafter: async () => undefined,
    });

    expect(undefinedModel).toEqual(noModel);
    expect(noModel).toHaveLength(1);
    expect(noModel[0]?.modelDrafted).toBe(false);
  });

  it("adopts a valid model draft with transparent model provenance", async () => {
    const modelDrafter = vi.fn<ModelDrafter>(async () => validGitStatusDraft);
    const proposals = await proposeRules(
      { report: report([row()]), currentPolicy: { floor: [] } },
      { bashParser: parser(), modelDrafter },
    );

    expect(modelDrafter).toHaveBeenCalledTimes(1);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      modelDrafted: true,
      effect: "allow",
      match: validGitStatusDraft.match,
      reason: validGitStatusDraft.reason,
    });
  });

  it.each([
    ["non-compiling", { match: { unknown: true }, effect: "allow" }],
    [
      "under-matching",
      {
        match: {
          all: [
            { program: "git" },
            { arg0In: ["log"] },
            { noSubstitution: true },
            { noStdoutRedirect: true },
          ],
        },
        effect: "allow",
      },
    ],
    ["over-matching", { match: { program: "git" }, effect: "allow" }],
    ["floor-failing", validGitStatusDraft],
  ] as const)("falls back to structural drafting for a %s model draft", async (_label, partial) => {
    const floor =
      _label === "floor-failing"
        ? [denyRule("floor:git", { program: "git" })]
        : [];
    const proposals = await proposeRules(
      { report: report([row()]), currentPolicy: { floor } },
      {
        bashParser: parser(),
        modelDrafter: async () => ({ ...partial, reason: "bad draft" }),
      },
    );

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.modelDrafted).toBe(false);
    expect(proposals[0]?.match).toEqual({
      all: [
        { program: "git" },
        { arg0In: ["status"] },
        { noSubstitution: true },
        { noStdoutRedirect: true },
      ],
    });
  });
});
