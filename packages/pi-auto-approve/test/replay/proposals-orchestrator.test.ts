import { describe, expect, it } from "vitest";
import type { BashStage, ToolShape } from "../../src/parse/shape.ts";
import type { PolicyRule } from "../../src/policy/core.ts";
import {
  compileMatch,
  evalMatcher,
  inspectable,
  type MatcherExpr,
} from "../../src/policy/core.ts";
import { proposeRules } from "../../src/replay/proposals.ts";
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

function compiled(match: unknown): MatcherExpr {
  const result = compileMatch(match);
  if ("errors" in result) {
    throw new Error(JSON.stringify(result.errors));
  }
  return result.expr;
}

function policyRule(
  id: string,
  effect: "allow" | "deny" | "review",
  match: unknown,
): PolicyRule {
  return {
    id,
    effect,
    match: inspectable(compiled(match)),
    reason: "test policy rule",
    provenance: { source: "user-project", ruleId: id },
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

describe("proposal orchestrator", () => {
  it("emits one annotated proposal per cluster and verifies examples", async () => {
    const proposals = await proposeRules(
      {
        report: report([
          row({ command: "git status --short", count: 2 }),
          row({ command: "git push origin main", count: 1 }),
        ]),
        currentPolicy: { floor: [] },
      },
      { bashParser: parser() },
    );

    expect(proposals).toHaveLength(2);
    const status = proposals.find((proposal) =>
      proposal.ruleId.includes("status"),
    );
    expect(status).toBeDefined();
    expect(status).toMatchObject({
      effect: "allow",
      provenance: { source: "generated" },
      floorOverlap: { action: "emit" },
      modelDrafted: false,
    });
    expect(status?.reason).not.toBe("");
    expect(status?.examples.some((example) => example.matches)).toBe(true);
    expect(status?.examples.some((example) => !example.matches)).toBe(true);
    expect(
      status?.fixtureSuggestions.every(
        (fixture) => fixture.provenance === status.id,
      ),
    ).toBe(true);

    const compiledMatch = status?.compiledMatch;
    expect(compiledMatch).toBeDefined();
    if (compiledMatch !== undefined) {
      for (const example of status?.examples ?? []) {
        expect(
          evalMatcher(
            inspectable(compiledMatch),
            await parser()(example.command),
          ),
        ).toBe(example.matches);
      }
    }
  });

  it("drops proposals already present in active policy", async () => {
    const proposals = await proposeRules(
      {
        report: report([row()]),
        currentPolicy: {
          floor: [],
          active: [
            policyRule("already-allow-git-status", "allow", {
              all: [
                { program: "git" },
                { arg0In: ["status"] },
                { noSubstitution: true },
                { noStdoutRedirect: true },
              ],
            }),
          ],
        },
      },
      { bashParser: parser() },
    );

    expect(proposals).toEqual([]);
  });

  it("downgrades floor-overlapping allows rather than emitting unsafe allows", async () => {
    const proposals = await proposeRules(
      {
        report: report([row()]),
        currentPolicy: {
          floor: [policyRule("floor:git", "deny", { program: "git" })],
        },
      },
      { bashParser: parser() },
    );

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      effect: "review",
      floorOverlap: { action: "downgraded-to-review" },
    });
  });

  it("sets routing metadata and acknowledgment framing for design-input proposals", async () => {
    const proposals = await proposeRules(
      {
        report: report([
          row({
            command: "tool check src/file.ts",
            executable: "tool",
            reason: "needs argument inside project root",
          }),
        ]),
        currentPolicy: { floor: [] },
      },
      { bashParser: parser() },
    );

    const core = proposals.find((proposal) => proposal.kind === "core-matcher");
    expect(core).toMatchObject({
      target: "core-matcher",
      scope: "global",
      intendedProvenance: "shipped",
      approvalFraming: {
        routesAsDesignInput: true,
        touchesDsl: true,
        requiresAcknowledgment: true,
      },
    });
    expect(core?.coreMatcher).toBeDefined();
  });

  it("sorts by friction score, then calls, and caps the output", async () => {
    const proposals = await proposeRules(
      {
        report: report([
          row({ command: "git status", executable: "git", count: 2 }),
          row({
            command: "pnpm check",
            executable: "pnpm",
            count: 1,
            capturedOutcomes: outcomes([["model-review", 5]]),
          }),
        ]),
        currentPolicy: { floor: [] },
      },
      { bashParser: parser(), maxProposals: 1 },
    );

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.ruleId).toContain("pnpm-check");
  });

  it("is total for malformed input", async () => {
    await expect(
      proposeRules({} as never, { bashParser: parser() }),
    ).resolves.toEqual([]);
  });
});
