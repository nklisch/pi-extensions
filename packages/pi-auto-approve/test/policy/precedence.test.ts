import { describe, expect, it } from "vitest";

import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import type { BashCommandShape } from "../../src/parse/shape.ts";
import type { DecisionSource, PolicyRule } from "../../src/policy/core.ts";
import {
  all,
  always,
  arg0In,
  argMatches,
  compareSameEffect,
  decide,
  inspectable,
  matcherSpecificity,
  noStdoutRedirect,
  noSubstitution,
  pathScopesAllIn,
  program,
  sourcePriority,
  specificityChooseWinning,
  stageEvery,
} from "../../src/policy/core.ts";

async function bash(command: string): Promise<BashCommandShape> {
  const shape = await analyzeBashCommand(command);
  expect(shape.kind).toBe("bash");
  if (shape.kind !== "bash") {
    throw new Error("expected bash shape");
  }
  return shape;
}

function allowRule(
  id: string,
  options: {
    readonly match?: ReturnType<typeof always>;
    readonly source?: DecisionSource;
  } = {},
): PolicyRule {
  return {
    id,
    effect: "allow",
    match: inspectable(options.match ?? always()),
    reason: `reason for ${id}`,
    provenance: { source: options.source ?? "generated", ruleId: id },
  };
}

describe("matcherSpecificity", () => {
  it("is monotonic across always, structural leaves, and conjunctions", () => {
    expect(matcherSpecificity(program("git"))).toBeGreaterThan(
      matcherSpecificity(always()),
    );
    expect(
      matcherSpecificity(all([program("git"), arg0In(["status"])])),
    ).toBeGreaterThan(matcherSpecificity(program("git")));
  });

  it("scores argMatches in the arg0In/argAt specificity class", () => {
    expect(matcherSpecificity(argMatches({ index: 0, pattern: "x" }))).toBe(2);
  });

  it("scores narrower arg0In matchers higher than wider ones", () => {
    expect(matcherSpecificity(arg0In(["status"]))).toBeGreaterThan(
      matcherSpecificity(arg0In(["status", "log", "diff"])),
    );
  });

  it("scores explicit stageEvery as narrower and any as its most-specific branch", () => {
    expect(matcherSpecificity(stageEvery(program("git")))).toBeGreaterThan(
      matcherSpecificity(program("git")),
    );
    expect(
      matcherSpecificity({
        kind: "any",
        of: [always(), all([program("git"), arg0In(["status"])])],
      }),
    ).toBe(matcherSpecificity(all([program("git"), arg0In(["status"])])));
  });

  it("scores path-scope predicates above broad safety sentinels with coverage bonuses", () => {
    const broad = all([program("touch"), noSubstitution(), noStdoutRedirect()]);
    const scoped = all([
      program("touch"),
      noSubstitution(),
      noStdoutRedirect(),
      pathScopesAllIn({
        scopes: ["writable-project", "project", "temp"],
        programs: ["touch"],
        requireFacts: "per-command-stage",
      }),
    ]);

    // Same-effect specificity prefers the path-scoped constructive rule.
    expect(matcherSpecificity(scoped)).toBeGreaterThan(
      matcherSpecificity(broad),
    );

    // Base path-scope score outranks broad safety sentinels (noSubstitution = 2).
    const base = pathScopesAllIn({ scopes: ["project"] });
    expect(matcherSpecificity(base)).toBeGreaterThan(
      matcherSpecificity(noSubstitution()),
    );

    // Per-command-stage coverage adds a small bonus; `programs` only adds its
    // bonus when that per-stage guard makes the program list load-bearing.
    const withPrograms = pathScopesAllIn({
      scopes: ["project"],
      programs: ["touch"],
    });
    const withPerStage = pathScopesAllIn({
      scopes: ["project"],
      requireFacts: "per-command-stage",
    });
    expect(matcherSpecificity(withPrograms)).toBe(matcherSpecificity(base));
    expect(matcherSpecificity(withPerStage)).toBeGreaterThan(
      matcherSpecificity(base),
    );
    expect(
      matcherSpecificity(
        pathScopesAllIn({
          scopes: ["project"],
          programs: ["touch"],
          requireFacts: "per-command-stage",
        }),
      ),
    ).toBe(matcherSpecificity(base) + 2);
  });
});

describe("sourcePriority", () => {
  it("ranks every DecisionSource in documented order", () => {
    expect(sourcePriority("generated")).toBeLessThan(sourcePriority("shipped"));
    expect(sourcePriority("shipped")).toBeLessThan(
      sourcePriority("trusted-repo"),
    );
    expect(sourcePriority("trusted-repo")).toBeLessThan(
      sourcePriority("user-global"),
    );
    expect(sourcePriority("user-global")).toBeLessThan(
      sourcePriority("user-project"),
    );
    expect(sourcePriority("default")).toBe(sourcePriority("generated"));
  });
});

describe("compareSameEffect and specificityChooseWinning", () => {
  it("orders by specificity first, then source priority, then declaration order", () => {
    const broad = allowRule("broad", { match: program("git") });
    const narrow = allowRule("narrow", {
      match: all([program("git"), arg0In(["status"])]),
    });
    const userProject = allowRule("user-project", {
      match: program("git"),
      source: "user-project",
    });
    const shipped = allowRule("shipped", {
      match: program("git"),
      source: "shipped",
    });

    expect(compareSameEffect(narrow, broad)).toBeGreaterThan(0);
    expect(compareSameEffect(userProject, shipped)).toBeGreaterThan(0);
    expect(compareSameEffect(broad, broad)).toBe(0);
  });

  it("chooses the more-specific rule, then source priority, then first declaration", () => {
    const first = allowRule("first", { match: program("git") });
    const mostSpecific = allowRule("middle-most-specific", {
      match: all([program("git"), arg0In(["status"])]),
    });
    const last = allowRule("last", {
      match: program("git"),
      source: "user-project",
    });

    expect(
      specificityChooseWinning([first, mostSpecific, last], {} as never),
    ).toBe(mostSpecific);
    expect(specificityChooseWinning([first, last], {} as never)).toBe(last);
    expect(
      specificityChooseWinning([first, allowRule("second")], {} as never),
    ).toBe(first);
  });

  it("is the default decide tie-breaker while preserving equal-tie declaration order", async () => {
    const shape = await bash("git status");
    const broad = allowRule("broad", { match: program("git") });
    const narrow = allowRule("narrow", {
      match: all([program("git"), arg0In(["status"])]),
    });
    const firstEqual = allowRule("first-equal");
    const secondEqual = allowRule("second-equal");

    expect(decide(shape, { active: [broad, narrow] })).toMatchObject({
      effect: "allow",
      reason: "narrow: reason for narrow",
    });
    expect(decide(shape, { active: [firstEqual, secondEqual] })).toMatchObject({
      effect: "allow",
      reason: "first-equal: reason for first-equal",
    });
  });
});
