import { describe, it, expect } from "vitest";
import { assembleSystemPrompt } from "../src/assemble.js";
import type { ModePlan, PlannedFragment } from "../src/resolver.js";

/**
 * Tests for `src/assemble.ts` — the pure deterministic splice. The splice only
 * reads `plan.fragments[].content`, so these build synthetic `ModePlan` literals
 * directly (no resolver / fragment / cache setup needed).
 */

function frag(
  slot: PlannedFragment["slot"],
  value: string,
  content: string,
): PlannedFragment {
  return { slot, value, path: `/fixture/${slot}/${value}.md`, content };
}

/** A plan with a real base overlay, all three axes, and two modifiers, in order. */
function fullPlan(): ModePlan {
  return {
    mode: {
      base: "chill",
      agency: "autonomous",
      quality: "pragmatic",
      scope: "adjacent",
      modifiers: ["tdd", "terse"],
    },
    signature: "sig",
    fragments: [
      frag("base", "chill", "BASE-chill"),
      frag("agency", "autonomous", "AGENCY-autonomous"),
      frag("quality", "pragmatic", "QUALITY-pragmatic"),
      frag("scope", "adjacent", "SCOPE-adjacent"),
      frag("modifier", "tdd", "MOD-tdd"),
      frag("modifier", "terse", "MOD-terse"),
    ],
  };
}

describe("assembleSystemPrompt — fixed order + blank-line join", () => {
  it("splices identity, then fragments in plan order, then base — blank-line separated", () => {
    const out = assembleSystemPrompt("You are X from Y.", fullPlan(), "PI_BASE");
    expect(out).toBe(
      [
        "You are X from Y.",
        "BASE-chill",
        "AGENCY-autonomous",
        "QUALITY-pragmatic",
        "SCOPE-adjacent",
        "MOD-tdd",
        "MOD-terse",
        "PI_BASE",
      ].join("\n\n"),
    );
  });

  it("preserves fragment array order exactly (no re-sort)", () => {
    // A plan whose fragment order is deliberately NOT alphabetical.
    const plan: ModePlan = {
      mode: undefined,
      signature: "s",
      fragments: [
        frag("modifier", "zeta", "Z"),
        frag("modifier", "alpha", "A"),
        frag("modifier", "mu", "M"),
      ],
    };
    expect(assembleSystemPrompt("ID", plan, "BASE")).toBe("ID\n\nZ\n\nA\n\nM\n\nBASE");
  });
});

describe("assembleSystemPrompt — empty-part handling", () => {
  it("omits an empty identity (no leading blank line)", () => {
    const out = assembleSystemPrompt("", fullPlan(), "PI_BASE");
    expect(out.startsWith("\n")).toBe(false);
    expect(out.split("\n\n")[0]).toBe("BASE-chill");
  });

  it("omits an empty base (no trailing blank line)", () => {
    const out = assembleSystemPrompt("ID", fullPlan(), "");
    expect(out.endsWith("\n")).toBe(false);
    expect(out.split("\n\n").at(-1)).toBe("MOD-terse");
  });

  it("empty plan + non-empty identity → identity + blank line + base", () => {
    const empty: ModePlan = { mode: undefined, signature: "s", fragments: [] };
    expect(assembleSystemPrompt("ID", empty, "BASE")).toBe("ID\n\nBASE");
  });

  it("only a base (empty identity + empty plan) → just the base, no blank lines", () => {
    const empty: ModePlan = { mode: undefined, signature: "s", fragments: [] };
    expect(assembleSystemPrompt("", empty, "BASE")).toBe("BASE");
  });

  it("drops a fragment with empty content (no stray internal blank lines)", () => {
    // A whitespace-only fragment file trims to "" in the loader; the splice must
    // drop it like an empty identity/base, not emit a doubled blank line.
    const plan: ModePlan = {
      mode: undefined,
      signature: "s",
      fragments: [
        frag("agency", "a", "AGENCY"),
        frag("quality", "q", ""), // empty content
        frag("scope", "s", "SCOPE"),
      ],
    };
    expect(assembleSystemPrompt("ID", plan, "BASE")).toBe(
      "ID\n\nAGENCY\n\nSCOPE\n\nBASE",
    );
  });
});

describe("assembleSystemPrompt — purity", () => {
  it("does not mutate the plan, its fragments array, or any fragment (frozen inputs)", () => {
    const plan = fullPlan();
    Object.freeze(plan);
    Object.freeze(plan.fragments);
    for (const f of plan.fragments) Object.freeze(f);
    expect(() => assembleSystemPrompt("ID", plan, "BASE")).not.toThrow();
    // Output is unchanged by the freeze; bytes are exactly as specified.
    expect(assembleSystemPrompt("ID", plan, "BASE").split("\n\n")[0]).toBe("ID");
  });

  it("is deterministic — byte-identical across N calls", () => {
    const plan = fullPlan();
    const first = assembleSystemPrompt("ID", plan, "BASE");
    for (let i = 0; i < 10; i++) {
      expect(assembleSystemPrompt("ID", plan, "BASE")).toBe(first);
    }
  });
});
