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
import { makeContext, makeEvent, makeModel } from "./harness.js";

/**
 * Engine-level stability + ordering invariants WITH A MODE SET — the two
 * properties a real composed mode makes testable:
 *
 *   - SPEC Invariant 2 (cache stability): across N no-change turns (same model,
 *     same mode, same base) the assembled `systemPrompt` is byte-identical —
 *     proved both on the HIT path (one MISS then N-1 replays) AND on a forced
 *     re-assembly every turn (reset only the RESULT cache, keep the mode active)
 *     so the splice + signature themselves are shown deterministic.
 *   - Deterministic ordering: fragments land in the fixed SPEC order
 *     (identity → base overlay → agency → quality → scope → modifiers → pi base),
 *     reproducibly across turns and independent of discovery iteration order.
 *
 * NOTE on the forced-MISS test: `resetCacheForTesting()` clears ONLY the cache
 * module's state (lastKey/lastResult/components/turn/ring); the resolver's
 * active mode lives in a SEPARATE module, so the mode stays active across the
 * loop — exactly the "re-assemble with a mode" path we want to stress.
 *
 * Fixture-driven with UNIQUE sentinel content per fragment + full module reset
 * in `beforeEach` so nothing leaks into the isolated test files.
 */

let tmp: string | undefined;

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** Unique sentinel content per fragment — order/occurrence is unambiguous. */
const SENTINELS = {
  base: "FRAG-base-chill",
  agency: "FRAG-agency-autonomous",
  quality: "FRAG-quality-pragmatic",
  scope: "FRAG-scope-adjacent",
  mod: "FRAG-mod-tdd",
  altMod: "FRAG-mod-terse",
} as const;

const PI_BASE_TEXT = "pi base prompt";

function buildFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "engine-stability-"));
  tmp = root;
  write(root, "base/chill.md", SENTINELS.base);
  write(root, "base.json", JSON.stringify({ overlays: ["base/chill.md"] }));
  write(root, "axis/agency/autonomous.md", SENTINELS.agency);
  write(root, "axis/quality/pragmatic.md", SENTINELS.quality);
  write(root, "axis/scope/adjacent.md", SENTINELS.scope);
  write(root, "modifiers/tdd.md", SENTINELS.mod);
  write(root, "modifiers/terse.md", SENTINELS.altMod);
  setFragmentRootForTesting(root);
  return root;
}

const FIXTURE_MODE: ResolvedMode = {
  base: "chill",
  agency: "autonomous",
  quality: "pragmatic",
  scope: "adjacent",
  modifiers: ["tdd"],
};

const model = makeModel({ id: "glm-4.6", name: "GLM-4.6", provider: "zai" });
const identity = deriveIdentityLine(model);

function runTurn(base: string = PI_BASE_TEXT): string {
  return handleBeforeAgentStart(makeEvent(base), makeContext({ model }))
    .systemPrompt;
}

beforeEach(() => {
  resetCacheForTesting();
  resetResolverForTesting();
  resetFragmentsForTesting();
  resetPresetsForTesting();
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

describe("engine stability — SPEC Invariant 2 with a mode set", () => {
  it("CACHE STABILITY (HIT path): byte-identical systemPrompt across N=10 no-change turns", () => {
    const N = 10;
    const returns: string[] = [];
    for (let i = 0; i < N; i++) returns.push(runTurn());

    expect(returns).toHaveLength(N);
    for (const got of returns) {
      expect(got).toBe(returns[0]);
    }
    expect(new Set(returns).size).toBe(1);
  });

  it("FORCED-MISS DETERMINISM: re-assembling every turn (result cache only reset, mode stays active) yields identical bytes", () => {
    const N = 10;
    const returns: string[] = [];
    for (let i = 0; i < N; i++) {
      // Reset ONLY the result cache — the resolver's active mode survives, so
      // each turn re-materializes + re-splices the same mode from scratch. If
      // the splice or signature injected anything nondeterministic, these N
      // re-assemblies would diverge.
      resetCacheForTesting();
      returns.push(runTurn());
    }

    expect(returns).toHaveLength(N);
    for (const got of returns) {
      expect(got).toBe(returns[0]);
    }
    expect(new Set(returns).size).toBe(1);
    // Sanity: the mode genuinely stayed active across the loop (fragments present).
    expect(returns[0]).toContain(SENTINELS.mod);
  });
});

describe("engine ordering — deterministic SPEC fragment order", () => {
  it("places identity → base overlay → agency → quality → scope → modifier → pi base, reproducibly", () => {
    const got = runTurn();

    const iIdentity = got.indexOf(identity);
    const iBase = got.indexOf(SENTINELS.base);
    const iAgency = got.indexOf(SENTINELS.agency);
    const iQuality = got.indexOf(SENTINELS.quality);
    const iScope = got.indexOf(SENTINELS.scope);
    const iMod = got.indexOf(SENTINELS.mod);
    const iPiBase = got.indexOf(PI_BASE_TEXT);

    // Every part is present...
    for (const idx of [iIdentity, iBase, iAgency, iQuality, iScope, iMod, iPiBase]) {
      expect(idx).toBeGreaterThanOrEqual(0);
    }
    // ...in the fixed SPEC order.
    expect(iIdentity).toBeLessThan(iBase);
    expect(iBase).toBeLessThan(iAgency);
    expect(iAgency).toBeLessThan(iQuality);
    expect(iQuality).toBeLessThan(iScope);
    expect(iScope).toBeLessThan(iMod);
    expect(iMod).toBeLessThan(iPiBase);

    // Re-run from a fresh result cache (mode still active) → byte-identical:
    // no discovery/iteration-order nondeterminism in the assembled output.
    resetCacheForTesting();
    const again = runTurn();
    expect(again).toBe(got);
  });

  it("NEGATIVE CONTROL: a different mode (different modifier set) → different bytes", () => {
    const withTdd = runTurn();
    expect(withTdd).toContain(SENTINELS.mod);

    // Swap the modifier set → different signature → MISS → different bytes.
    setActiveMode({ ...FIXTURE_MODE, modifiers: ["terse"] });
    const withTerse = runTurn();

    expect(withTerse).not.toBe(withTdd);
    expect(withTerse).toContain(SENTINELS.altMod);
    expect(withTerse).not.toContain(SENTINELS.mod);
  });
});
