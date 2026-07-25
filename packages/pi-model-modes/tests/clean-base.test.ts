import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleBeforeAgentStart } from "../src/handler.js";
import { deriveIdentityLine } from "../src/identity.js";
import { resetCacheForTesting } from "../src/cache.js";
import {
  setActiveMode,
  resetResolverForTesting,
} from "../src/resolver.js";
import {
  setFragmentRootForTesting,
  resetFragmentsForTesting,
} from "../src/fragments.js";
import { resetPresetsForTesting } from "../src/presets.js";
import type { ResolvedMode } from "../src/presets.js";
import { resetStyleForTesting } from "../src/style.js";
import { makeContext, makeEvent, makeModel } from "./harness.js";

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) throw new Error("countOccurrences: empty needle");
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

describe("handleBeforeAgentStart — Invariant 1 (no mutation + no cached-output leak, identity-prepended)", () => {
  const model = makeModel({ name: "GLM-4.6", provider: "zai" });
  const identity = deriveIdentityLine(model);
  const assemble = (base: string) => `${identity}\n${base}`;

  beforeEach(() => {
    resetCacheForTesting();
    resetStyleForTesting();
  });

  it("does not mutate the input event (Object.freeze catches any mutation as a thrown TypeError)", () => {
    const e = makeEvent("line1\nline2\n<project_context>...</project_context>");
    Object.freeze(e);
    expect(() => handleBeforeAgentStart(e, makeContext({ model }))).not.toThrow();
    // Identity-prepended (no longer byte-identical to input); freeze proves no mutation.
    expect(handleBeforeAgentStart(e, makeContext({ model })).systemPrompt).toBe(
      assemble(e.systemPrompt),
    );
  });

  it("does not leak a previous output across calls (A→B→C→A sequence)", () => {
    const a1 = handleBeforeAgentStart(makeEvent("PROMPT_A"), makeContext({ model }));
    const b  = handleBeforeAgentStart(makeEvent("PROMPT_B"), makeContext({ model }));
    const c  = handleBeforeAgentStart(makeEvent("PROMPT_C"), makeContext({ model }));
    const a2 = handleBeforeAgentStart(makeEvent("PROMPT_A"), makeContext({ model }));

    // Each return reflects THAT call's input (identity + base), not a leaked
    // prior output. a2 is a MISS (lastKey was C), so it re-assembles from A.
    expect(a1.systemPrompt).toBe(assemble("PROMPT_A"));
    expect(b.systemPrompt).toBe(assemble("PROMPT_B"));
    expect(c.systemPrompt).toBe(assemble("PROMPT_C"));
    expect(a2.systemPrompt).toBe(assemble("PROMPT_A")); // NOT leaked from a1 or c
  });
});

/**
 * SPEC Invariant 1 — FULL FORM (mode set). With a real mode active, the
 * assembled prompt must contain EXACTLY ONE identity line and EXACTLY ONE copy
 * of each selected fragment across N consecutive turns. Turn 1 is a MISS that
 * assembles; turns 2..N are HITs replaying the cached bytes — neither path may
 * stack the identity or double a fragment. The A→B→C→A base rotation proves no
 * cached-output leak: each return reflects ITS OWN base while still carrying
 * exactly one copy of each fragment.
 *
 * Fixture-driven: a temp prompts tree with UNIQUE sentinel content per fragment
 * (so an occurrence count is unambiguous) + `setActiveMode` over an explicit
 * `ResolvedMode`. Full module reset in `beforeEach` so nothing leaks into the
 * identity-only group above (or the other isolated test files).
 */

let tmp: string | undefined;

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** Unique sentinel content per fragment — counting these is unambiguous. */
const SENTINELS = {
  base: "FRAG-base-chill",
  agency: "FRAG-agency-autonomous",
  quality: "FRAG-quality-pragmatic",
  scope: "FRAG-scope-adjacent",
  mod1: "FRAG-mod-tdd",
  mod2: "FRAG-mod-terse",
} as const;

/** All fragment sentinels selected by FIXTURE_MODE, for one-copy assertions. */
const SELECTED_SENTINELS = [
  SENTINELS.base,
  SENTINELS.agency,
  SENTINELS.quality,
  SENTINELS.scope,
  SENTINELS.mod1,
  SENTINELS.mod2,
];

function buildFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "clean-base-mode-"));
  tmp = root;
  write(root, "base/chill.md", SENTINELS.base);
  write(root, "base.json", JSON.stringify({ overlays: ["base/chill.md"] }));
  write(root, "axis/agency/autonomous.md", SENTINELS.agency);
  write(root, "axis/quality/pragmatic.md", SENTINELS.quality);
  write(root, "axis/scope/adjacent.md", SENTINELS.scope);
  write(root, "modifiers/tdd.md", SENTINELS.mod1);
  write(root, "modifiers/terse.md", SENTINELS.mod2);
  setFragmentRootForTesting(root);
  return root;
}

const FIXTURE_MODE: ResolvedMode = {
  base: "chill",
  agency: "autonomous",
  quality: "pragmatic",
  scope: "adjacent",
  modifiers: ["tdd", "terse"],
};

describe("Invariant 1 — full form (mode set: exactly one identity + one copy of each fragment across N turns)", () => {
  const model = makeModel({ id: "glm-4.6", name: "GLM-4.6", provider: "zai" });
  const identity = deriveIdentityLine(model);

  beforeEach(() => {
    resetCacheForTesting();
    resetResolverForTesting();
    resetFragmentsForTesting();
    resetPresetsForTesting();
    resetStyleForTesting();
    buildFixture();
    setActiveMode(FIXTURE_MODE);
  });

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
    resetFragmentsForTesting();
    resetResolverForTesting();
  });

  it("ONE-COPY across N=5 identical turns: exactly one identity line + one copy of each fragment", () => {
    const N = 5;
    const base = "pi base prompt";
    const outputs: string[] = [];
    for (let i = 0; i < N; i++) {
      outputs.push(
        handleBeforeAgentStart(makeEvent(base), makeContext({ model }))
          .systemPrompt,
      );
    }

    // Turn 1 MISS assembles; turns 2..N HIT and replay — none may stack.
    for (const got of outputs) {
      expect(countOccurrences(got, identity)).toBe(1);
      for (const sentinel of SELECTED_SENTINELS) {
        expect(countOccurrences(got, sentinel)).toBe(1);
      }
      // And the base appears once (it is the trailing part).
      expect(countOccurrences(got, base)).toBe(1);
    }
    // All N turns produced the identical assembled bytes.
    expect(new Set(outputs).size).toBe(1);
  });

  it("NO-LEAK A→B→C→A (base rotation): each return reflects its own base + one copy of each fragment", () => {
    const bases = ["BASE_A", "BASE_B", "BASE_C", "BASE_A"];
    const outputs = bases.map(
      (b) =>
        handleBeforeAgentStart(makeEvent(b), makeContext({ model }))
          .systemPrompt,
    );

    outputs.forEach((got, i) => {
      const thisBase = bases[i];
      // Each return reflects ITS OWN base, exactly once...
      expect(countOccurrences(got, thisBase)).toBe(1);
      expect(got.endsWith(thisBase)).toBe(true);
      // ...with exactly one identity line and one copy of each fragment (no leak
      // of a prior turn's assembled output stacking fragments).
      expect(countOccurrences(got, identity)).toBe(1);
      for (const sentinel of SELECTED_SENTINELS) {
        expect(countOccurrences(got, sentinel)).toBe(1);
      }
    });

    // The two BASE_A turns (indices 0 and 3) are byte-identical re-assemblies —
    // a2 is a MISS (lastKey was BASE_C) re-sourced from its own input, not leaked.
    expect(outputs[0]).toBe(outputs[3]);
    // And distinct bases yield distinct bytes (no cross-turn leak).
    expect(outputs[0]).not.toBe(outputs[1]);
    expect(outputs[1]).not.toBe(outputs[2]);
  });
});
