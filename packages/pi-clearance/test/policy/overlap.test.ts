import { describe, expect, it } from "vitest";

import type { MatcherExpr } from "../../src/policy/core.ts";
import {
  all,
  always,
  any,
  arg0In,
  argAt,
  argMatches,
  bodyStagesAllReadOnly,
  bodyStagesAllScopeIn,
  classifyOverlap,
  composition,
  compoundForm,
  iteratorScopesAllIn,
  mutationShape,
  mutationTool,
  mutationTrustBoundary,
  noBodyRedirectTo,
  noBodyShellWrap,
  noBodySubstitution,
  noSubstitution,
  not,
  pathScopesAllIn,
  program,
  stageEvery,
  stageSome,
  tool,
  validateCompoundAllowCanonicality,
} from "../../src/policy/core.ts";

describe("classifyOverlap", () => {
  it("classifies equal and disjoint programs", () => {
    expect(classifyOverlap(program("git"), program("git"))).toBe("overlap");
    expect(classifyOverlap(program("git"), program("rm"))).toBe("disjoint");
  });

  it("treats always as overlapping any satisfiable matcher", () => {
    expect(classifyOverlap(always(), program("rm"))).toBe("overlap");
  });

  it("classifies arg0In intersections", () => {
    expect(classifyOverlap(arg0In(["status"]), arg0In(["push"]))).toBe(
      "disjoint",
    );
    expect(
      classifyOverlap(arg0In(["status"]), arg0In(["status", "push"])),
    ).toBe("overlap");
  });

  it("treats argMatches as a non-atomic refinement", () => {
    expect(
      classifyOverlap(argMatches({ index: 0, pattern: "x" }), program("rm")),
    ).toBe("overlap");
    expect(
      classifyOverlap(
        all([program("pnpm"), argMatches({ index: 0, pattern: "x" })]),
        program("rm"),
      ),
    ).toBe("disjoint");
  });

  it("classifies argAt same-index conflicts and different-index compatibility", () => {
    expect(classifyOverlap(argAt(0, "status"), argAt(0, "push"))).toBe(
      "disjoint",
    );
    expect(classifyOverlap(argAt(0, "status"), argAt(1, "x"))).toBe("overlap");
  });

  it("distributes any at the classify level", () => {
    const gitOrRm = any([program("git"), program("rm")]);

    expect(classifyOverlap(gitOrRm, program("rm"))).toBe("overlap");
    expect(classifyOverlap(gitOrRm, program("ls"))).toBe("disjoint");
  });

  it("treats non-conjunctive matchers as unknown", () => {
    expect(classifyOverlap(not(program("rm")), program("rm"))).toBe("unknown");
    expect(classifyOverlap(stageSome(program("git")), program("git"))).toBe(
      "unknown",
    );
    expect(
      classifyOverlap(
        composition({ stage: program("git"), operators: ["and"] }),
        program("git"),
      ),
    ).toBe("overlap");
  });

  it("reduces a floor-side stageSome to existential necessary constraints", () => {
    const floor = stageSome(
      all([program("rm"), arg0In(["/", "/etc"]), argAt(1, "-rf")]),
    );

    expect(
      classifyOverlap(all([program("git"), arg0In(["build"])]), floor),
    ).toBe("disjoint");
    expect(
      classifyOverlap(all([program("rm"), arg0In(["build"])]), floor),
    ).toBe("disjoint");
    expect(classifyOverlap(all([program("rm"), arg0In(["/"])]), floor)).toBe(
      "overlap",
    );
  });

  it("keeps allow-side stageSome and anchorless floor inners unknown", () => {
    expect(
      classifyOverlap(stageSome(program("git")), stageSome(program("rm"))),
    ).toBe("unknown");
    expect(
      classifyOverlap(
        program("git"),
        stageSome(argMatches({ index: 0, pattern: "rm" })),
      ),
    ).toBe("unknown");
  });

  it("recognizes unsatisfiable floor-side stageSome inners as disjoint", () => {
    expect(
      classifyOverlap(
        program("git"),
        stageSome(all([program("rm"), program("sudo")])),
      ),
    ).toBe("disjoint");
  });

  it("classifies compatible conjunctions as overlap", () => {
    expect(
      classifyOverlap(
        all([program("git"), arg0In(["status"])]),
        all([program("git"), noSubstitution()]),
      ),
    ).toBe("overlap");
  });

  it("reduces stageEvery through its inner matcher", () => {
    expect(classifyOverlap(stageEvery(program("git")), program("git"))).toBe(
      "overlap",
    );
  });

  it("is total and returns unknown for malformed input", () => {
    expect(
      classifyOverlap(null as unknown as MatcherExpr, program("git")),
    ).toBe("unknown");
  });
});

describe("classifyOverlap composition reduction", () => {
  it("proves a program-anchored family union disjoint from a stageSome floor", () => {
    expect(
      classifyOverlap(
        composition({
          stage: any([
            all([program("git"), noSubstitution()]),
            all([program("head"), noSubstitution()]),
          ]),
          operators: ["and", "seq"],
          minStages: 2,
        }),
        stageSome(all([program("rm"), arg0In(["/"])])),
      ),
    ).toBe("disjoint");
  });

  it("proves a program-anchored family union disjoint from floor programs", () => {
    expect(
      classifyOverlap(
        composition({
          stage: any([
            all([program("git"), noSubstitution()]),
            all([program("cat"), noSubstitution()]),
          ]),
          operators: ["and", "seq"],
          minStages: 2,
        }),
        program("rm"),
      ),
    ).toBe("disjoint");
  });

  it("keeps unanchored family alternatives unknown", () => {
    expect(
      classifyOverlap(
        composition({
          stage: any([all([program("git")]), all([noSubstitution()])]),
          operators: ["and", "seq"],
        }),
        program("rm"),
      ),
    ).toBe("unknown");
  });

  it("rejects a composition family that includes a floor program", () => {
    expect(
      classifyOverlap(
        composition({
          stage: any([program("git"), program("rm")]),
          operators: ["and", "seq"],
        }),
        program("rm"),
      ),
    ).toBe("overlap");
  });

  it("includes the exempt final fallback in the necessary condition", () => {
    expect(
      classifyOverlap(
        composition({
          stage: program("git"),
          operators: ["and", "seq"],
          orFallback: ["true"],
        }),
        program("true"),
      ),
    ).toBe("overlap");
  });
});

describe("classifyOverlap mutation constraints", () => {
  it("lowers mutationTool to concrete edit/write tool constraints", () => {
    expect(classifyOverlap(mutationTool({ tools: [] }), tool("edit"))).toBe(
      "overlap",
    );
    expect(
      classifyOverlap(mutationTool({ tools: ["edit"] }), tool("write")),
    ).toBe("disjoint");
    expect(classifyOverlap(mutationTool({ tools: [] }), program("sudo"))).toBe(
      "disjoint",
    );
  });

  it("treats mutation refiners as concrete-compatible under a mutation tool anchor", () => {
    const shippedStyle = all([
      mutationTool({ tools: ["edit", "write"] }),
      mutationShape({ shape: "well-formed" }),
      mutationTrustBoundary({ in: ["none"] }),
    ]);

    expect(classifyOverlap(shippedStyle, program("sudo"))).toBe("disjoint");
    expect(classifyOverlap(shippedStyle, tool("edit"))).toBe("overlap");
  });

  it("keeps mutation refiners without concrete mutation tools unknown", () => {
    expect(
      classifyOverlap(mutationShape({ shape: "well-formed" }), program("sudo")),
    ).toBe("unknown");
    expect(
      classifyOverlap(
        all([
          mutationShape({ shape: "well-formed" }),
          mutationTrustBoundary({ in: ["none"] }),
        ]),
        program("sudo"),
      ),
    ).toBe("unknown");
    expect(
      classifyOverlap(
        all([tool("bash"), mutationTrustBoundary({ in: ["none"] })]),
        program("sudo"),
      ),
    ).toBe("unknown");
  });
});

describe("classifyOverlap canonical compound allows", () => {
  const canonicalCompoundAllow = all([
    compoundForm("for"),
    bodyStagesAllReadOnly(),
    noBodySubstitution(),
    noBodyShellWrap(),
    noBodyRedirectTo(),
    iteratorScopesAllIn({ scopes: ["project", "writable-project", "temp"] }),
    bodyStagesAllScopeIn({ scopes: ["project", "writable-project", "temp"] }),
  ]);

  it("proves the canonical read-only body bundle disjoint from non-read-only floor programs", () => {
    expect(classifyOverlap(canonicalCompoundAllow, program("rm"))).toBe(
      "disjoint",
    );
    expect(classifyOverlap(canonicalCompoundAllow, program("mv"))).toBe(
      "disjoint",
    );
    expect(classifyOverlap(canonicalCompoundAllow, program("sh"))).toBe(
      "disjoint",
    );
    expect(classifyOverlap(canonicalCompoundAllow, program("sudo"))).toBe(
      "disjoint",
    );
  });

  it("keeps the proof scoped to read-only body semantics", () => {
    expect(classifyOverlap(canonicalCompoundAllow, program("cat"))).toBe(
      "overlap",
    );
    expect(classifyOverlap(canonicalCompoundAllow, always())).toBe("overlap");
  });

  it("does not let partial compound bundles borrow the symbolic proof", () => {
    expect(
      classifyOverlap(
        all([
          compoundForm("for"),
          bodyStagesAllReadOnly(),
          noBodySubstitution(),
        ]),
        program("rm"),
      ),
    ).toBe("unknown");
  });

  it("rejects empty scope arrays in direct canonicality recognition", () => {
    expect(
      validateCompoundAllowCanonicality(
        all([
          compoundForm("for"),
          bodyStagesAllReadOnly(),
          noBodySubstitution(),
          noBodyShellWrap(),
          noBodyRedirectTo(),
          iteratorScopesAllIn({ scopes: [] }),
          bodyStagesAllScopeIn({ scopes: ["project"] }),
        ]),
      ),
    ).toMatchObject({ applies: true, ok: false });

    expect(
      validateCompoundAllowCanonicality(
        all([
          compoundForm("for"),
          bodyStagesAllReadOnly(),
          noBodySubstitution(),
          noBodyShellWrap(),
          noBodyRedirectTo(),
          iteratorScopesAllIn({ scopes: ["project"] }),
          bodyStagesAllScopeIn({ scopes: [] }),
        ]),
      ),
    ).toMatchObject({ applies: true, ok: false });
  });
});

describe("classifyOverlap path-scope constraints", () => {
  // Conservative path-scope overlap semantics: pathScope is a concrete
  // constraint (so it does not degrade a conjunctive allow to `unknown`) but it
  // never proves disjointness on its own (so a path-only allow stays
  // overlapping the floor). Structural constraints keep providing disjointness.
  const scoped = pathScopesAllIn({
    scopes: ["writable-project", "project", "temp"],
    programs: ["touch"],
    requireFacts: "per-command-stage",
  });

  it("is disjoint when a structural program constraint conflicts", () => {
    expect(
      classifyOverlap(all([program("touch"), scoped]), program("sudo")),
    ).toBe("disjoint");
  });

  it("does not prove disjointness from a program constraint by scope alone", () => {
    expect(classifyOverlap(scoped, program("sudo"))).toBe("overlap");
  });

  it("treats pathScope vs pathScope as compatible (no scope-based disjointness)", () => {
    const home = pathScopesAllIn({
      scopes: ["home"],
      requireFacts: "one-or-more",
    });
    // Even contradictory scope sets stay overlap: false disjointness would be unsafe.
    expect(classifyOverlap(scoped, home)).toBe("overlap");
  });

  it("keeps a path-only allow overlapping a broad deny", () => {
    expect(classifyOverlap(scoped, always())).toBe("overlap");
  });

  it("does not break compatible structural conjunctions", () => {
    expect(
      classifyOverlap(
        all([program("touch"), scoped]),
        all([program("touch"), noSubstitution()]),
      ),
    ).toBe("overlap");
  });

  it("proves typed non-bash tool allows disjoint from bash-only floor programs", () => {
    expect(classifyOverlap(all([tool("read"), scoped]), program("sudo"))).toBe(
      "disjoint",
    );
    expect(classifyOverlap(all([tool("bash"), scoped]), program("sudo"))).toBe(
      "overlap",
    );
  });

  it("keeps pathScope inside non-conjunctive shapes unknown and fail-closed", () => {
    expect(classifyOverlap(stageSome(scoped), program("sudo"))).toBe("unknown");
    expect(classifyOverlap(not(scoped), program("sudo"))).toBe("unknown");
    expect(
      classifyOverlap(
        composition({ stage: scoped, operators: ["and"] }),
        program("sudo"),
      ),
    ).toBe("unknown");
  });
});
