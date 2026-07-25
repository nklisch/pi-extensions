import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  setActiveMode,
  getActiveMode,
  clearActiveMode,
  setDefaultMode,
  getDefaultMode,
  clearDefaultMode,
  getEffectiveModeSource,
  resolveActiveModePlan,
  resetResolverForTesting,
} from "../src/resolver.js";
import {
  setFragmentRootForTesting,
  resetFragmentsForTesting,
} from "../src/fragments.js";
import { resetPresetsForTesting, type ResolvedMode } from "../src/presets.js";
import { NO_MODE_SIGNATURE } from "../src/cache.js";

/**
 * Tests for the resolver's TWO-TIER mode state (override > default > unset).
 * The DEFAULT tier (`setDefaultMode`/`getDefaultMode`/`clearDefaultMode`) layers
 * under the existing OVERRIDE tier (`setActiveMode`); `resolveActiveModePlan`
 * materializes `override ?? default`, and `getEffectiveModeSource` reports which
 * tier won. Fixtures are built into a temp prompts tree (mirroring
 * resolver.test.ts) so string specs resolve through the loader.
 */

let tmp: string | undefined;

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "resolver-tiers-"));
  tmp = root;
  setFragmentRootForTesting(root);
  return root;
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** Build a complete starter fixture: one value per axis, two modifiers, a real
 *  base overlay (`chill`). Returns the root. */
function buildFixture(): string {
  const root = freshRoot();
  write(root, "axis/agency/autonomous.md", "AGENCY-autonomous");
  write(root, "axis/agency/surgical.md", "AGENCY-surgical");
  write(root, "axis/quality/pragmatic.md", "QUALITY-pragmatic");
  write(root, "axis/scope/adjacent.md", "SCOPE-adjacent");
  write(root, "modifiers/tdd.md", "MOD-tdd");
  write(root, "base/chill.md", "BASE-chill");
  write(root, "base.json", JSON.stringify({ overlays: ["base/chill.md"] }));
  return root;
}

const DEFAULT_MODE: ResolvedMode = {
  base: "pi",
  agency: "autonomous",
  quality: "pragmatic",
  scope: "adjacent",
  modifiers: [],
};

const OVERRIDE_MODE: ResolvedMode = { ...DEFAULT_MODE, agency: "surgical" };

beforeEach(() => {
  resetResolverForTesting();
  resetFragmentsForTesting();
  resetPresetsForTesting();
});

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
  resetResolverForTesting();
  resetFragmentsForTesting();
  resetPresetsForTesting();
});

describe("effective mode source", () => {
  it("reports unset / default / override correctly", () => {
    buildFixture();
    expect(getEffectiveModeSource()).toBe("unset");

    setDefaultMode(DEFAULT_MODE);
    expect(getEffectiveModeSource()).toBe("default");

    setActiveMode(OVERRIDE_MODE);
    expect(getEffectiveModeSource()).toBe("override");

    clearActiveMode();
    expect(getEffectiveModeSource()).toBe("default");

    clearDefaultMode();
    expect(getEffectiveModeSource()).toBe("unset");
  });
});

describe("override ?? default precedence in resolveActiveModePlan", () => {
  it("default only → resolves the default; override set → resolves the override", () => {
    buildFixture();

    // Default only → its plan resolves (the surgical override is NOT chosen).
    setDefaultMode(DEFAULT_MODE);
    const defaultPlan = resolveActiveModePlan();
    expect(defaultPlan.mode?.agency).toBe("autonomous");
    const defaultSig = defaultPlan.signature;
    expect(defaultSig).not.toBe(NO_MODE_SIGNATURE);

    // Override wins over default.
    setActiveMode(OVERRIDE_MODE);
    const overridePlan = resolveActiveModePlan();
    expect(overridePlan.mode?.agency).toBe("surgical");
    expect(overridePlan.signature).not.toBe(defaultSig);
  });

  it("clearActiveMode (/mode off) falls back to the default, not unset", () => {
    buildFixture();
    setDefaultMode(DEFAULT_MODE);
    setActiveMode(OVERRIDE_MODE);
    expect(resolveActiveModePlan().mode?.agency).toBe("surgical");

    // /mode off: clear the override → effective falls back to the default.
    clearActiveMode();
    expect(getEffectiveModeSource()).toBe("default");
    expect(resolveActiveModePlan().mode?.agency).toBe("autonomous");
    expect(resolveActiveModePlan().signature).not.toBe(NO_MODE_SIGNATURE);
  });

  it("both tiers unset → no-mode fast path (zero discovery)", () => {
    // No fragment root configured at all — any discovery would throw.
    expect(getEffectiveModeSource()).toBe("unset");
    expect(resolveActiveModePlan()).toEqual({
      mode: undefined,
      signature: NO_MODE_SIGNATURE,
      fragments: [],
    });
  });
});

describe("default tier: clone, clear, reset, validation", () => {
  it("getDefaultMode returns a clone; mutating it does not corrupt state", () => {
    buildFixture();
    const spec: ResolvedMode = { ...DEFAULT_MODE, modifiers: ["tdd"] };
    setDefaultMode(spec);

    const got = getDefaultMode();
    expect(got).toEqual({ ...DEFAULT_MODE, modifiers: ["tdd"] });
    const gotMode = got as ResolvedMode;
    gotMode.agency = "surgical";
    gotMode.modifiers.push("ghost");

    // State untouched.
    expect(getDefaultMode()).toEqual({ ...DEFAULT_MODE, modifiers: ["tdd"] });
    expect(resolveActiveModePlan().mode?.agency).toBe("autonomous");
  });

  it("clearDefaultMode removes only the default tier", () => {
    buildFixture();
    setDefaultMode(DEFAULT_MODE);
    expect(getDefaultMode()).toBeDefined();
    clearDefaultMode();
    expect(getDefaultMode()).toBeUndefined();
    expect(getEffectiveModeSource()).toBe("unset");
  });

  it("resetResolverForTesting clears BOTH override and default tiers", () => {
    buildFixture();
    setDefaultMode(DEFAULT_MODE);
    setActiveMode(OVERRIDE_MODE);
    resetResolverForTesting();
    expect(getActiveMode()).toBeUndefined();
    expect(getDefaultMode()).toBeUndefined();
    expect(getEffectiveModeSource()).toBe("unset");
  });

  it("a bad default throws at setDefaultMode and does NOT become the default", () => {
    buildFixture();
    const bad: ResolvedMode = { ...DEFAULT_MODE, agency: "does-not-exist" };
    expect(() => setDefaultMode(bad)).toThrow(/agency "does-not-exist"/);
    expect(getDefaultMode()).toBeUndefined();
    expect(getEffectiveModeSource()).toBe("unset");
  });

  it("a prior valid default survives a failed setDefaultMode (state intact on throw)", () => {
    buildFixture();
    setDefaultMode(DEFAULT_MODE);
    const bad: ResolvedMode = { ...DEFAULT_MODE, scope: "nope" };
    expect(() => setDefaultMode(bad)).toThrow(/scope "nope"/);
    expect(getDefaultMode()).toEqual(DEFAULT_MODE);
  });
});
