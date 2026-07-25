import { describe, expect, it } from "vitest";
import { sealedFloor } from "../../src/packs/floor.ts";
import type { PolicyRule } from "../../src/policy/core.ts";
import {
  compileMatch,
  inspectable,
  type MatcherExpr,
} from "../../src/policy/core.ts";
import {
  checkFloorOverlap,
  type DraftedMatcher,
  draftStructuralMatcher,
  type FrictionCluster,
} from "../../src/replay/proposals.ts";

function compiled(match: unknown): MatcherExpr {
  const result = compileMatch(match);
  if ("errors" in result) {
    throw new Error(JSON.stringify(result.errors));
  }
  return result.expr;
}

function draft(
  match: unknown,
  effect: "allow" | "review" | "deny" = "allow",
): DraftedMatcher {
  return {
    match,
    compiled: compiled(match),
    effect,
    origin: "structural",
    notes: [],
  };
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

function cluster(
  overrides: Partial<FrictionCluster> & {
    readonly program?: unknown;
    readonly arg0Set?: readonly string[];
    readonly flags?: readonly string[];
    readonly behaviors?: readonly string[];
    readonly hasSubstitution?: boolean;
    readonly hasStdoutRedirect?: boolean;
  },
): FrictionCluster {
  const executable =
    typeof overrides.program === "string" ? overrides.program : "tool";

  return {
    executable,
    rows: [],
    signature: {
      program: (overrides.program ?? executable) as string | undefined,
      arg0Set: overrides.arg0Set ?? [],
      flags: overrides.flags ?? [],
      hasSubstitution: overrides.hasSubstitution ?? false,
      hasStdoutRedirect: overrides.hasStdoutRedirect ?? false,
      parseDiagnostics: [],
    },
    addressableBy: "data",
    frictionScore: 1,
    behaviors: overrides.behaviors ?? [],
    sampleCommands: [],
    evidence: {
      executable,
      calls: 1,
      unique: 1,
      reviewCalls: 1,
      hardBlockCalls: 0,
      modelReviewCalls: 0,
      capturedDenialCalls: 0,
      behaviors: overrides.behaviors ?? [],
      sampleCommands: [],
      capturedOutcomeBreakdown: new Map(),
    },
    notes: [],
    ...overrides,
  };
}

function arg0InFromDraft(value: DraftedMatcher): readonly string[] | undefined {
  const match = value.match as { readonly all?: readonly unknown[] };
  const arg0Clause = match.all?.find(
    (clause): clause is { readonly arg0In: readonly string[] } =>
      typeof clause === "object" &&
      clause !== null &&
      Array.isArray((clause as { readonly arg0In?: unknown }).arg0In),
  );
  return arg0Clause?.arg0In;
}

describe("proposal structural drafting", () => {
  it("drafts shipped-pack vocabulary with guards and load-bearing safety flags", () => {
    const result = draftStructuralMatcher(
      cluster({
        program: "prettier",
        flags: ["--check"],
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.effect).toBe("allow");
    expect(result?.match).toEqual({
      all: [
        { program: "prettier" },
        { noSubstitution: true },
        { noStdoutRedirect: true },
        { flagPresent: "check" },
      ],
    });
    expect(result?.compiled.kind).toBe("all");
  });

  it("uses arg0In for observed subcommand families", () => {
    const result = draftStructuralMatcher(
      cluster({ program: "pnpm", arg0Set: ["test", "build"] }),
    );

    expect(result?.match).toEqual({
      all: [
        { program: "pnpm" },
        { arg0In: ["build", "test"] },
        { noSubstitution: true },
        { noStdoutRedirect: true },
      ],
    });
  });

  it("never drafts an allow for risky or hidden-shell behavior", () => {
    const risky = draftStructuralMatcher(
      cluster({
        program: "git",
        arg0Set: ["push"],
        behaviors: ["force-push"],
      }),
    );
    const substitution = draftStructuralMatcher(
      cluster({ program: "echo", hasSubstitution: true }),
    );
    const stdoutRedirect = draftStructuralMatcher(
      cluster({ program: "echo", hasStdoutRedirect: true }),
    );

    expect(risky?.effect).toBe("review");
    expect(substitution?.effect).toBe("review");
    expect(stdoutRedirect?.effect).toBe("review");
    expect(risky?.match).toEqual({
      all: [
        { program: "git" },
        { arg0In: ["push"] },
        { noSubstitution: true },
        { noStdoutRedirect: true },
      ],
    });
  });

  it("returns null for non-compiling structural drafts", () => {
    const result = draftStructuralMatcher(
      cluster({ program: { invalid: "program" } as never }),
    );

    expect(result).toBeNull();
  });
});

describe("proposal sealed-floor overlap pre-check", () => {
  it("emits an allow that is disjoint from every floor deny", () => {
    const result = checkFloorOverlap(
      draft({
        all: [
          { program: "git" },
          { arg0In: ["status"] },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      }),
      [
        denyRule("floor:rm-root", {
          all: [{ program: "rm" }, { arg0In: ["/"] }],
        }),
      ],
    );

    expect(result).toEqual({ action: "emit" });
  });

  it("narrows an overlapping arg0In allow and re-checks to disjoint", () => {
    const floor = [
      denyRule("floor:tool-danger", {
        all: [{ program: "tool" }, { arg0In: ["danger"] }],
      }),
    ];
    const result = checkFloorOverlap(
      draft({
        all: [
          { program: "tool" },
          { arg0In: ["safe", "danger"] },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      }),
      floor,
    );

    expect(result.action).toBe("narrowed");
    if (result.action !== "narrowed") {
      throw new Error("expected narrowed outcome");
    }
    expect(arg0InFromDraft(result.narrowed)).toEqual(["safe"]);
    expect(checkFloorOverlap(result.narrowed, floor)).toEqual({
      action: "emit",
    });
  });

  it("downgrades an allow that cannot be narrowed without a negation", () => {
    const result = checkFloorOverlap(
      draft({
        all: [
          { program: "rm" },
          { arg0In: ["tmp"] },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      }),
      [denyRule("floor:rm-any", { program: "rm" })],
    );

    expect(result.action).toBe("downgraded-to-review");
    if (result.action !== "downgraded-to-review") {
      throw new Error("expected downgrade outcome");
    }
    expect(result.downgraded.effect).toBe("review");
  });

  it("skips review and deny drafts", () => {
    expect(
      checkFloorOverlap(draft({ program: "rm" }, "review"), sealedFloor.rules),
    ).toMatchObject({ action: "skipped-non-allow" });
    expect(
      checkFloorOverlap(draft({ program: "rm" }, "deny"), sealedFloor.rules),
    ).toMatchObject({ action: "skipped-non-allow" });
  });

  it("never throws on malformed matcher IR", () => {
    const malformed: DraftedMatcher = {
      match: { program: "git" },
      compiled: { kind: "malformed" } as never,
      effect: "allow",
      origin: "structural",
      notes: [],
    };

    expect(() =>
      checkFloorOverlap(malformed, [denyRule("floor:git", { program: "git" })]),
    ).not.toThrow();
    expect(
      checkFloorOverlap(malformed, [denyRule("floor:git", { program: "git" })])
        .action,
    ).toBe("downgraded-to-review");
  });

  it("handles the real sealed floor by emitting, narrowing, or downgrading", () => {
    expect(
      checkFloorOverlap(
        draft({
          all: [
            { program: "git" },
            { arg0In: ["status"] },
            { noSubstitution: true },
            { noStdoutRedirect: true },
          ],
        }),
        sealedFloor.rules,
      ),
    ).toEqual({ action: "emit" });

    const rmResult = checkFloorOverlap(
      draft({
        all: [
          { program: "rm" },
          { arg0In: ["/", "tmp"] },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      }),
      sealedFloor.rules,
    );
    expect(rmResult.action).toBe("narrowed");
    if (rmResult.action !== "narrowed") {
      throw new Error("expected rm floor to narrow");
    }
    expect(arg0InFromDraft(rmResult.narrowed)).toEqual(["tmp"]);

    const privilegeResult = checkFloorOverlap(
      draft({
        all: [
          { program: "sudo" },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      }),
      sealedFloor.rules,
    );
    expect(privilegeResult.action).toBe("downgraded-to-review");

    const shutdownResult = checkFloorOverlap(
      draft({
        all: [
          { program: "systemctl" },
          { arg0In: ["status", "reboot"] },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      }),
      sealedFloor.rules,
    );
    expect(shutdownResult.action).toBe("downgraded-to-review");
  });
});
