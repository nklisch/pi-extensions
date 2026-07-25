import { describe, expect, it } from "vitest";

import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import type { BashCommandShape, ToolShape } from "../../src/parse/shape.ts";
import type {
  DecisionEffect,
  DecisionSource,
  PolicyRule,
} from "../../src/policy/core.ts";
import {
  always,
  type ChooseWinning,
  compilePack,
  decide,
  defaultChooseWinning,
  diagnosticCode,
  inspectable,
  type MatcherExpr,
  program,
} from "../../src/policy/core.ts";

async function bash(command: string): Promise<BashCommandShape> {
  const shape = await analyzeBashCommand(command);
  expect(shape.kind).toBe("bash");
  if (shape.kind !== "bash") {
    throw new Error("expected bash shape");
  }
  return shape;
}

function withDiagnostic(shape: BashCommandShape): BashCommandShape {
  return {
    ...shape,
    diagnostics: [
      ...shape.diagnostics,
      {
        code: "test:diagnostic",
        message: "synthetic parse diagnostic",
        severity: "error",
      },
    ],
  };
}

function unknownShape(): ToolShape {
  return {
    kind: "unknown",
    toolName: "mystery",
    rawInput: { command: "???" },
    diagnostics: [],
  };
}

function rule(
  id: string,
  effect: DecisionEffect,
  options: {
    readonly match?: MatcherExpr;
    readonly reason?: string;
    readonly source?: DecisionSource;
  } = {},
): PolicyRule {
  return {
    id,
    effect,
    match: inspectable(options.match ?? always()),
    reason: options.reason ?? `reason for ${id}`,
    provenance: { source: options.source ?? "generated", ruleId: id },
  };
}

describe("decide", () => {
  it("lets matching floor denies win even when parse diagnostics are present", async () => {
    const shape = withDiagnostic(await bash("git status"));
    const floorDeny = rule("floor-deny", "deny", {
      reason: "sealed floor deny",
      source: "shipped",
    });
    const diagnosticReview = rule("diagnostic-review", "review", {
      match: diagnosticCode("test:diagnostic"),
    });

    const decision = decide(shape, {
      floor: [floorDeny],
      active: [diagnosticReview],
    });

    expect(decision).toEqual({
      effect: "deny",
      reason: "floor-deny: sealed floor deny",
      provenance: { source: "shipped", ruleId: "floor-deny" },
    });
  });

  it("ignores non-deny floor matches and active allows for diagnostic shapes", async () => {
    const shape = withDiagnostic(await bash("git status"));

    const decision = decide(shape, {
      floor: [rule("floor-review", "review")],
      active: [
        rule("active-allow", "allow"),
        rule("diagnostic-allow", "allow", {
          match: diagnosticCode("test:diagnostic"),
        }),
      ],
    });

    expect(decision).toEqual({
      effect: "review",
      reason: "parse diagnostics present",
      provenance: { source: "default" },
    });
  });

  it("uses matching active review provenance for diagnostic shapes", async () => {
    const shape = withDiagnostic(await bash("git status"));
    const diagnosticReview = rule("diagnostic-review", "review", {
      match: diagnosticCode("test:diagnostic"),
      reason: "known diagnostic requires review",
      source: "shipped",
    });

    const decision = decide(shape, { active: [diagnosticReview] });

    expect(decision).toEqual({
      effect: "review",
      reason: "diagnostic-review: known diagnostic requires review",
      provenance: { source: "shipped", ruleId: "diagnostic-review" },
    });
  });

  it("lets matching active denies win for diagnostic shapes", async () => {
    const shape = withDiagnostic(await bash("git status"));
    const diagnosticDeny = rule("diagnostic-deny", "deny", {
      match: diagnosticCode("test:diagnostic"),
      reason: "known diagnostic is blocked",
      source: "user-project",
    });
    const diagnosticReview = rule("diagnostic-review", "review", {
      match: diagnosticCode("test:diagnostic"),
    });

    const decision = decide(shape, {
      active: [diagnosticReview, diagnosticDeny],
    });

    expect(decision).toEqual({
      effect: "deny",
      reason: "diagnostic-deny: known diagnostic is blocked",
      provenance: { source: "user-project", ruleId: "diagnostic-deny" },
    });
  });

  it("falls back to generic diagnostic review without a matching deny or review", async () => {
    const shape = withDiagnostic(await bash("git status"));

    const decision = decide(shape, {
      active: [
        rule("allow-diagnostic", "allow", {
          match: diagnosticCode("test:diagnostic"),
        }),
        rule("review-other-diagnostic", "review", {
          match: diagnosticCode("test:other"),
        }),
      ],
    });

    expect(decision).toEqual({
      effect: "review",
      reason: "parse diagnostics present",
      provenance: { source: "default" },
    });
  });

  it("preserves diagnostic-free active allow behavior", async () => {
    const shape = await bash("git status");

    expect(decide(shape, { active: [rule("allow-any", "allow")] })).toEqual({
      effect: "allow",
      reason: "allow-any: reason for allow-any",
      provenance: { source: "generated", ruleId: "allow-any" },
    });
  });

  it("orders active effects as deny over review over allow", async () => {
    const shape = await bash("git status");

    expect(
      decide(shape, { active: [rule("allow", "allow"), rule("deny", "deny")] }),
    ).toMatchObject({ effect: "deny", reason: "deny: reason for deny" });

    expect(
      decide(shape, {
        active: [rule("allow", "allow"), rule("review", "review")],
      }),
    ).toMatchObject({ effect: "review", reason: "review: reason for review" });

    expect(
      decide(shape, {
        active: [
          rule("allow", "allow"),
          rule("review", "review"),
          rule("deny", "deny"),
        ],
      }),
    ).toMatchObject({ effect: "deny", reason: "deny: reason for deny" });
  });

  it("defaults tie-breaks to the first matching rule in the winning effect class", async () => {
    const shape = await bash("git status");
    const first = rule("first", "allow");
    const second = rule("second", "allow");

    expect(defaultChooseWinning([first, second], shape)).toBe(first);
    expect(decide(shape, { active: [first, second] })).toMatchObject({
      effect: "allow",
      reason: "first: reason for first",
    });
  });

  it("returns default review when no active rule matches", async () => {
    const decision = decide(await bash("git status"), {
      active: [rule("rm-only", "deny", { match: program("rm") })],
    });

    expect(decision).toEqual({
      effect: "review",
      reason: "no matching rule",
      provenance: { source: "default" },
    });
  });

  it("stays total for unknown shapes and empty or legacy policies", async () => {
    const emptyPolicyDecision = decide(await bash("git status"), {});
    const legacyPolicyDecision = decide(await bash("git status"), {
      rules: [],
    });
    const unknownDecision = decide(unknownShape(), { floor: [], active: [] });

    for (const decision of [
      emptyPolicyDecision,
      legacyPolicyDecision,
      unknownDecision,
    ]) {
      expect(decision).toEqual({
        effect: "review",
        reason: "no matching rule",
        provenance: { source: "default" },
      });
    }
  });

  it("fails safe to review on unexpected interpreter errors", async () => {
    const shape = await bash("git status");

    // A malformed policy makes native handle creation fail; the interpreter
    // must stay total with a default review rather than throw.
    const decision = decide(shape, { floor: "not-an-array" } as never);

    expect(decision).toEqual({
      effect: "review",
      reason: "interpreter error",
      provenance: { source: "default" },
    });
  });

  it("decides over JSON-compiled active and floor packs", async () => {
    const active = compilePack({
      version: 1,
      id: "pack:git-read",
      rules: [
        {
          id: "allow-read-only-git",
          effect: "allow",
          match: {
            all: [
              { tool: "bash" },
              { stageEvery: { program: "git" } },
              { noSubstitution: true },
              { noStdoutRedirect: true },
            ],
          },
          reason: "read-only Git inspection",
          provenance: { source: "shipped" },
        },
      ],
    });
    const floor = compilePack({
      version: 1,
      id: "floor.deny",
      rules: [
        {
          id: "deny-all-floor-for-test",
          effect: "deny",
          match: { always: true },
          reason: "floor blocks this command",
          provenance: { source: "shipped" },
        },
      ],
    });
    expect(active.errors).toEqual([]);
    expect(floor.errors).toEqual([]);

    const shape = await bash("git status --short");
    expect(decide(shape, { active: active.pack?.rules ?? [] })).toMatchObject({
      effect: "allow",
      reason: "allow-read-only-git: read-only Git inspection",
      provenance: {
        source: "shipped",
        packId: "pack:git-read",
        ruleId: "allow-read-only-git",
      },
    });
    expect(
      decide(shape, {
        floor: floor.pack?.rules ?? [],
        active: active.pack?.rules ?? [],
      }),
    ).toMatchObject({
      effect: "deny",
      reason: "deny-all-floor-for-test: floor blocks this command",
      provenance: {
        source: "shipped",
        packId: "floor.deny",
        ruleId: "deny-all-floor-for-test",
      },
    });
  });
});
