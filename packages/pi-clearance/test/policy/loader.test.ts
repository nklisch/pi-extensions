import { describe, expect, it } from "vitest";

import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import type { BashCommandShape } from "../../src/parse/shape.ts";
import type {
  DecisionEffect,
  DecisionSource,
  PolicyPack,
  PolicyRule,
} from "../../src/policy/core.ts";
import {
  always,
  compilePack,
  decide,
  inspectable,
  type MatcherExpr,
  not,
  program,
} from "../../src/policy/core.ts";
import { loadEffectivePolicy } from "../../src/policy/loader.ts";

async function bash(command: string): Promise<BashCommandShape> {
  const shape = await analyzeBashCommand(command);
  expect(shape.kind).toBe("bash");
  if (shape.kind !== "bash") {
    throw new Error("expected bash shape");
  }
  return shape;
}

function rule(
  id: string,
  effect: DecisionEffect,
  options: {
    readonly match?: MatcherExpr;
    readonly source?: DecisionSource;
    readonly packId?: string;
    readonly reason?: string;
  } = {},
): PolicyRule {
  return {
    id,
    effect,
    match: inspectable(options.match ?? always()),
    reason: options.reason ?? `reason for ${id}`,
    provenance: {
      source: options.source ?? "shipped",
      ruleId: id,
      ...(options.packId === undefined ? {} : { packId: options.packId }),
    },
  };
}

function pack(id: string, rules: readonly PolicyRule[]): PolicyPack {
  return { version: 1, id, rules };
}

/**
 * Compile a single-allow pack from a raw JSON matcher via the DSL compiler so
 * loader coverage exercises JSON -> matcher IR -> overlap together.
 */
function compileAllowPack(id: string, match: unknown): PolicyPack {
  const result = compilePack({
    version: 1,
    id,
    rules: [
      {
        id,
        effect: "allow",
        match,
        reason: id,
        provenance: { source: "shipped" },
      },
    ],
  });
  if (result.pack === null) {
    throw new Error(JSON.stringify(result.errors));
  }
  return result.pack;
}

describe("loadEffectivePolicy", () => {
  it("accepts an empty floor and an allow pack", () => {
    const activeRule = rule("allow-git", "allow", { match: program("git") });
    const result = loadEffectivePolicy({
      floor: pack("floor", []),
      active: [pack("active", [activeRule])],
    });

    expect(result).toEqual({
      ok: true,
      policy: { floor: [], active: [activeRule] },
      warnings: [],
    });
  });

  it("rejects a floor containing a non-deny rule", () => {
    const result = loadEffectivePolicy({
      floor: pack("floor", [rule("review-in-floor", "review")]),
      active: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected load failure");
    }
    expect(result.errors).toEqual([
      {
        packId: "floor",
        ruleId: "review-in-floor",
        path: "floor.rules[0]",
        message: "sealed floor must be deny-only",
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("rejects an allow that overlaps a floor deny", () => {
    const result = loadEffectivePolicy({
      floor: pack("floor", [rule("deny-rm", "deny", { match: program("rm") })]),
      active: [
        pack("active", [rule("allow-rm", "allow", { match: program("rm") })]),
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected load failure");
    }
    expect(result.errors).toEqual([
      {
        packId: "active",
        ruleId: "allow-rm",
        path: "active[0].rules[0]",
        message: "allow rule overlaps sealed-floor deny `deny-rm`",
      },
    ]);
  });

  it("accepts allows provably disjoint from every floor deny", () => {
    const floorRule = rule("deny-rm", "deny", { match: program("rm") });
    const activeRule = rule("allow-git", "allow", { match: program("git") });

    const result = loadEffectivePolicy({
      floor: pack("floor", [floorRule]),
      active: [pack("active", [activeRule])],
    });

    expect(result).toEqual({
      ok: true,
      policy: { floor: [floorRule], active: [activeRule] },
      warnings: [],
    });
  });

  it("rejects undecidable allow-vs-floor overlap fail-closed", () => {
    const result = loadEffectivePolicy({
      floor: pack("floor", [rule("deny-rm", "deny", { match: program("rm") })]),
      active: [
        pack("active", [
          rule("allow-not-rm", "allow", { match: not(program("rm")) }),
        ]),
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected load failure");
    }
    expect(result.errors).toEqual([
      {
        packId: "active",
        ruleId: "allow-not-rm",
        path: "active[0].rules[0]",
        message:
          "allow rule has undecidable overlap with sealed-floor deny `deny-rm`; refine the matcher to be provably disjoint",
      },
    ]);
  });

  it("produces an EffectivePolicy that round-trips through decide", async () => {
    const floorRule = rule("deny-rm", "deny", { match: program("rm") });
    const activeRule = rule("allow-git", "allow", { match: program("git") });
    const result = loadEffectivePolicy({
      floor: pack("floor", [floorRule]),
      active: [pack("active", [activeRule])],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected load success");
    }

    expect(decide(await bash("rm -rf tmp"), result.policy)).toMatchObject({
      effect: "deny",
      reason: "deny-rm: reason for deny-rm",
    });
    expect(decide(await bash("git status"), result.policy)).toMatchObject({
      effect: "allow",
      reason: "allow-git: reason for allow-git",
    });
  });
});

describe("loadEffectivePolicy canonical compound allows", () => {
  const approvedScopes = ["project", "writable-project", "temp"] as const;
  const requiredCompoundMatchers = {
    compoundForm: { compoundForm: "for" },
    bodyStagesAllReadOnly: { bodyStagesAllReadOnly: true },
    noBodySubstitution: { noBodySubstitution: true },
    noBodyShellWrap: { noBodyShellWrap: true },
    noBodyRedirectTo: { noBodyRedirectTo: true },
    iteratorScopesAllIn: {
      iteratorScopesAllIn: { scopes: approvedScopes },
    },
    bodyStagesAllScopeIn: {
      bodyStagesAllScopeIn: { scopes: approvedScopes },
    },
  } as const;

  function canonicalCompoundMatch(
    omit?: keyof typeof requiredCompoundMatchers,
  ): unknown {
    return {
      all: Object.entries(requiredCompoundMatchers)
        .filter(([key]) => key !== omit)
        .map(([, matcher]) => matcher),
    };
  }

  function expectCompoundAllowRejected(match: unknown): void {
    const allow = compileAllowPack("compound-allow", match);
    const result = loadEffectivePolicy({
      floor: pack("floor", []),
      active: [allow],
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected load failure");
    }
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      packId: "compound-allow",
      ruleId: "compound-allow",
      path: "active[0].rules[0]",
    });
    expect(result.errors[0]?.message).toContain(
      "compound allow rule must use approved canonical bundle",
    );
  }

  it("accepts the exact approved compound allow bundle", () => {
    const allow = compileAllowPack("compound-allow", canonicalCompoundMatch());
    const floor = pack("floor", [
      rule("deny-rm", "deny", { match: program("rm") }),
      rule("deny-mv", "deny", { match: program("mv") }),
      rule("deny-sh", "deny", { match: program("sh") }),
      rule("deny-sudo", "deny", { match: program("sudo") }),
    ]);

    const result = loadEffectivePolicy({ floor, active: [allow] });

    expect(result).toEqual({
      ok: true,
      policy: { floor: floor.rules, active: allow.rules },
      warnings: [],
    });
  });

  it.each([
    "compoundForm",
    "bodyStagesAllReadOnly",
    "noBodySubstitution",
    "noBodyShellWrap",
    "noBodyRedirectTo",
    "iteratorScopesAllIn",
    "bodyStagesAllScopeIn",
  ] as const)("rejects a compound allow missing %s", (omitted) => {
    expectCompoundAllowRejected(canonicalCompoundMatch(omitted));
  });

  it.each([
    "brace-group",
    "if",
  ] as const)("rejects unsupported compound form %s", (form) => {
    expectCompoundAllowRejected({
      all: [
        { compoundForm: form },
        requiredCompoundMatchers.bodyStagesAllReadOnly,
        requiredCompoundMatchers.noBodySubstitution,
        requiredCompoundMatchers.noBodyShellWrap,
        requiredCompoundMatchers.noBodyRedirectTo,
        requiredCompoundMatchers.iteratorScopesAllIn,
        requiredCompoundMatchers.bodyStagesAllScopeIn,
      ],
    });
  });

  it.each([
    "home",
    "safe-home",
    "sensitive-home",
    "outside",
    "system",
    "denied",
    "unknown",
  ] as const)("rejects widened iterator scopes containing %s", (scope) => {
    expectCompoundAllowRejected({
      all: [
        requiredCompoundMatchers.compoundForm,
        requiredCompoundMatchers.bodyStagesAllReadOnly,
        requiredCompoundMatchers.noBodySubstitution,
        requiredCompoundMatchers.noBodyShellWrap,
        requiredCompoundMatchers.noBodyRedirectTo,
        { iteratorScopesAllIn: { scopes: [...approvedScopes, scope] } },
        requiredCompoundMatchers.bodyStagesAllScopeIn,
      ],
    });
  });

  it.each([
    "home",
    "safe-home",
    "sensitive-home",
    "outside",
    "system",
    "denied",
    "unknown",
  ] as const)("rejects widened body scopes containing %s", (scope) => {
    expectCompoundAllowRejected({
      all: [
        requiredCompoundMatchers.compoundForm,
        requiredCompoundMatchers.bodyStagesAllReadOnly,
        requiredCompoundMatchers.noBodySubstitution,
        requiredCompoundMatchers.noBodyShellWrap,
        requiredCompoundMatchers.noBodyRedirectTo,
        requiredCompoundMatchers.iteratorScopesAllIn,
        { bodyStagesAllScopeIn: { scopes: [...approvedScopes, scope] } },
      ],
    });
  });

  it("rejects diagnostic-bearing compound allows", () => {
    expectCompoundAllowRejected({
      all: [
        ...Object.values(requiredCompoundMatchers),
        { diagnosticCode: "bash:compound-body-unsupported" },
      ],
    });
  });

  it("rejects compound allows with extra non-canonical matchers", () => {
    expectCompoundAllowRejected({
      all: [...Object.values(requiredCompoundMatchers), { program: "git" }],
    });
  });

  it.each([
    { any: [canonicalCompoundMatch(), { compoundForm: "brace-group" }] },
    { not: canonicalCompoundMatch() },
    { stageEvery: canonicalCompoundMatch() },
    {
      composition: {
        stage: canonicalCompoundMatch(),
        operators: ["seq"],
      },
    },
  ])("rejects compound allows hidden behind non-conjunctive forms", (match) => {
    expectCompoundAllowRejected(match);
  });
});

describe("loadEffectivePolicy path-scoped allows", () => {
  // A small custom floor isolates the overlap-classifier behavior from the
  // shipped sealed floor so the exact loader messages stay stable and readable.
  const denySudo = rule("deny-sudo", "deny", { match: program("sudo") });
  const floor = pack("floor", [denySudo]);

  it("accepts a path-scoped allow disjoint from a floor deny", () => {
    const allow = compileAllowPack("allow-touch-project", {
      all: [
        { program: "touch" },
        { noSubstitution: true },
        { noStdoutRedirect: true },
        {
          pathScopesAllIn: {
            scopes: ["writable-project", "project", "temp"],
            programs: ["touch"],
            requireFacts: "per-command-stage",
          },
        },
      ],
    });

    const result = loadEffectivePolicy({ floor, active: [allow] });

    expect(result).toEqual({
      ok: true,
      policy: { floor: [denySudo], active: allow.rules },
      warnings: [],
    });
  });

  it("rejects a path-only allow overlapping a floor deny", () => {
    const allow = compileAllowPack("allow-path-only", {
      pathScopesAllIn: {
        scopes: ["writable-project", "project", "temp"],
        requireFacts: "one-or-more",
      },
    });

    const result = loadEffectivePolicy({ floor, active: [allow] });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected load failure");
    }
    expect(result.errors).toEqual([
      {
        packId: "allow-path-only",
        ruleId: "allow-path-only",
        path: "active[0].rules[0]",
        message: "allow rule overlaps sealed-floor deny `deny-sudo`",
      },
    ]);
  });

  it("rejects a path-scoped allow inside a non-conjunctive shape as undecidable", () => {
    const allow = compileAllowPack("allow-stage-some-path", {
      stageSome: {
        pathScopesAllIn: {
          scopes: ["writable-project", "project", "temp"],
          programs: ["touch"],
          requireFacts: "per-command-stage",
        },
      },
    });

    const result = loadEffectivePolicy({ floor, active: [allow] });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected load failure");
    }
    expect(result.errors).toEqual([
      {
        packId: "allow-stage-some-path",
        ruleId: "allow-stage-some-path",
        path: "active[0].rules[0]",
        message:
          "allow rule has undecidable overlap with sealed-floor deny `deny-sudo`; refine the matcher to be provably disjoint",
      },
    ]);
  });
});
