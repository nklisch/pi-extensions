import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  setActiveMode,
  getActiveMode,
  clearActiveMode,
  resolveActiveModePlan,
  resetResolverForTesting,
  type ModeSpec,
} from "../src/resolver.js";
import {
  setFragmentRootForTesting,
  resetFragmentsForTesting,
} from "../src/fragments.js";
import {
  resetPresetsForTesting,
  type ResolvedMode,
} from "../src/presets.js";
import { NO_MODE_SIGNATURE } from "../src/cache.js";

/**
 * Tests for `src/resolver.ts` — specifier → ResolvedMode → materialized
 * ModePlan + content-hash signature. Fixtures are built into a temp prompts
 * tree via `setFragmentRootForTesting`, and preset specs feed through
 * `loadPresets({ json })`. `beforeEach` resets resolver + fragment + preset
 * module state so cases are isolated.
 *
 * The signature edit-sensitivity and base:pi-participation cases are genuine
 * property proofs: they materialize, capture the signature, and re-materialize
 * after a real content/mtime change (or a single base-field change) and assert
 * the signature moved (or held).
 */

let tmp: string | undefined;

/** Create a fresh temp fixture root and point the loader at it. */
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "resolver-"));
  tmp = root;
  setFragmentRootForTesting(root);
  return root;
}

/** Write a file, creating parent dirs as needed. Returns the absolute path. */
function write(root: string, rel: string, content: string): string {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

/**
 * Build a complete starter fixture tree: one value per axis, a couple of
 * modifiers, and a real base overlay (`chill`) declared in base.json. Returns
 * the root.
 */
function buildFixture(): string {
  const root = freshRoot();
  write(root, "axis/agency/autonomous.md", "AGENCY-autonomous");
  write(root, "axis/quality/pragmatic.md", "QUALITY-pragmatic");
  write(root, "axis/scope/adjacent.md", "SCOPE-adjacent");
  write(root, "modifiers/tdd.md", "MOD-tdd");
  write(root, "modifiers/terse.md", "MOD-terse");
  write(root, "base/chill.md", "BASE-chill");
  write(root, "base.json", JSON.stringify({ overlays: ["base/chill.md"] }));
  return root;
}

const PI_MODE: ResolvedMode = {
  base: "pi",
  agency: "autonomous",
  quality: "pragmatic",
  scope: "adjacent",
  modifiers: [],
};

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

describe("fast-path no-mode", () => {
  it("returns the empty plan with NO fragment root configured (zero discovery)", () => {
    // No setFragmentRootForTesting at all — any discovery would throw against
    // the real package root only if it ran. The no-mode path must NOT discover.
    expect(getActiveMode()).toBeUndefined();
    const plan = resolveActiveModePlan();
    expect(plan).toEqual({
      mode: undefined,
      signature: NO_MODE_SIGNATURE,
      fragments: [],
    });
  });

  it("does not throw even when fragment discovery WOULD throw (empty fixture root)", () => {
    // A root that has NO axis dirs — discovery would fail-fast if invoked. The
    // no-mode fast-path must short-circuit before any discovery.
    freshRoot();
    expect(() => resolveActiveModePlan()).not.toThrow();
    expect(resolveActiveModePlan().fragments).toEqual([]);
  });
});

describe("explicit ResolvedMode spec — ordered fragment materialization", () => {
  it("resolves to base?→agency→quality→scope→modifiers with loaded trimmed content", () => {
    buildFixture();
    // An explicit ResolvedMode spec (not a preset name) so arbitrary axis combos
    // can be exercised without disk coupling; the shipped-preset (string-spec)
    // path is covered separately below.
    const spec: ResolvedMode = {
      base: "chill",
      agency: "autonomous",
      quality: "pragmatic",
      scope: "adjacent",
      modifiers: ["tdd", "terse"],
    };
    setActiveMode(spec);
    const plan = resolveActiveModePlan();

    expect(plan.fragments.map((f) => [f.slot, f.value])).toEqual([
      ["base", "chill"],
      ["agency", "autonomous"],
      ["quality", "pragmatic"],
      ["scope", "adjacent"],
      ["modifier", "tdd"],
      ["modifier", "terse"],
    ]);
    expect(plan.fragments.map((f) => f.content)).toEqual([
      "BASE-chill",
      "AGENCY-autonomous",
      "QUALITY-pragmatic",
      "SCOPE-adjacent",
      "MOD-tdd",
      "MOD-terse",
    ]);
    for (const f of plan.fragments) {
      expect(f.path.length).toBeGreaterThan(0);
      expect(f.content).toBe(f.content.trim());
    }
    expect(plan.signature.length).toBeGreaterThan(0);
    expect(plan.mode).toEqual(spec);
  });

  it("a string preset spec resolves through loadPresets()", () => {
    buildFixture();
    // The resolver resolves string specs via the disk presets.json memo; here
    // we exercise that path against a real shipped preset name.
    resetPresetsForTesting();
    setActiveMode("extend"); // a shipped preset (base:pi, autonomous/pragmatic/adjacent)
    const plan = resolveActiveModePlan();
    // base:pi → no base fragment; three axes present.
    expect(plan.fragments.map((f) => f.slot)).toEqual([
      "agency",
      "quality",
      "scope",
    ]);
    expect(plan.signature.length).toBeGreaterThan(0);
  });

  it("the virtual none preset is an explicit no-mode override", () => {
    buildFixture();
    setActiveMode("none");

    expect(getActiveMode()).toBe("none");
    expect(resolveActiveModePlan()).toEqual({
      mode: undefined,
      signature: NO_MODE_SIGNATURE,
      fragments: [],
    });
  });
});

describe("base:pi signature participation", () => {
  it("base:pi yields NO base fragment but a different signature than a real base", () => {
    buildFixture();
    setActiveMode(PI_MODE);
    const piPlan = resolveActiveModePlan();
    // No base fragment in the plan.
    expect(piPlan.fragments.map((f) => f.slot)).toEqual([
      "agency",
      "quality",
      "scope",
    ]);
    const piSig = piPlan.signature;
    // base:pi is a REAL mode, not no-mode: its signature is a content-hash, never
    // the empty no-mode sentinel. (A resolver that treated base:pi as "no base
    // participation" and collapsed toward the unset path would fail here.)
    expect(piSig).not.toBe(NO_MODE_SIGNATURE);
    expect(piSig.length).toBeGreaterThan(0);

    // Same mode except a real base overlay → the base slot now carries a real
    // fragment+hash instead of the virtual pi entry, so signatures differ.
    const realBase: ResolvedMode = { ...PI_MODE, base: "chill" };
    setActiveMode(realBase);
    const realPlan = resolveActiveModePlan();
    expect(realPlan.fragments[0].slot).toBe("base");
    expect(realPlan.fragments[0].value).toBe("chill");
    expect(realPlan.signature).not.toBe(piSig);
  });
});

describe("signature edit-sensitivity + stability", () => {
  it("editing a selected fragment (mtime bump) changes the signature; no edit → stable across N calls", () => {
    const root = buildFixture();
    setActiveMode(PI_MODE);

    const sig1 = resolveActiveModePlan().signature;
    // Stable across repeated calls with no change.
    for (let i = 0; i < 5; i++) {
      expect(resolveActiveModePlan().signature).toBe(sig1);
    }

    // Edit a selected fragment's content + force a distinct mtime.
    const agencyPath = join(root, "axis/agency/autonomous.md");
    writeFileSync(agencyPath, "AGENCY-autonomous-EDITED", "utf8");
    const future = Date.now() / 1000 + 3600;
    utimesSync(agencyPath, future, future);

    const sig2 = resolveActiveModePlan().signature;
    expect(sig2).not.toBe(sig1);

    // Stable again at the new value.
    expect(resolveActiveModePlan().signature).toBe(sig2);
  });
});

describe("modifier dedup + order", () => {
  it("duplicate modifiers are de-duped first-occurrence-wins, preserving order", () => {
    buildFixture();
    const spec: ResolvedMode = {
      ...PI_MODE,
      modifiers: ["terse", "tdd", "terse"], // duplicate 'terse'
    };
    setActiveMode(spec);
    const plan = resolveActiveModePlan();
    const mods = plan.fragments.filter((f) => f.slot === "modifier");
    // First-occurrence order: terse then tdd, no second terse.
    expect(mods.map((f) => f.value)).toEqual(["terse", "tdd"]);
    expect(plan.mode?.modifiers).toEqual(["terse", "tdd"]);
  });
});

describe("fail-fast: missing / ambiguous fragments", () => {
  it("a missing axis value throws at set AND resolve", () => {
    buildFixture();
    const bad: ResolvedMode = { ...PI_MODE, agency: "does-not-exist" };
    expect(() => setActiveMode(bad)).toThrow(/agency "does-not-exist"/);
    // Set was rejected → still no active mode.
    expect(getActiveMode()).toBeUndefined();
    // Prove resolve-time integrity: a mode that was valid at set but whose
    // selected fragment file later vanishes throws on the next resolve. Keep
    // another .md in the dir so discovery still succeeds and matchOne is the one
    // that fails (proving the missing-VALUE check at resolve time, not an empty
    // axis dir).
    setActiveMode(PI_MODE);
    rmSync(join(tmp!, "axis/agency/autonomous.md"));
    write(tmp!, "axis/agency/other.md", "OTHER");
    resetFragmentsForTesting(); // also clears the root override
    setFragmentRootForTesting(tmp!);
    expect(() => resolveActiveModePlan()).toThrow(
      /agency "autonomous" has no fragment file/,
    );
  });

  it("a missing base overlay throws", () => {
    buildFixture();
    const bad: ResolvedMode = { ...PI_MODE, base: "nonexistent-base" };
    expect(() => setActiveMode(bad)).toThrow(/base "nonexistent-base"/);
  });

  it("a missing modifier throws", () => {
    buildFixture();
    const bad: ResolvedMode = { ...PI_MODE, modifiers: ["ghost"] };
    expect(() => setActiveMode(bad)).toThrow(/modifier "ghost"/);
  });

  it("an ambiguous base match (>1 basename) throws", () => {
    const root = buildFixture();
    // Two overlay files with the SAME basename in different dirs, both declared.
    write(root, "base/dupe.md", "DUPE-A");
    write(root, "base/nested/dupe.md", "DUPE-B");
    write(
      root,
      "base.json",
      JSON.stringify({ overlays: ["base/dupe.md", "base/nested/dupe.md"] }),
    );
    const spec: ResolvedMode = { ...PI_MODE, base: "dupe" };
    expect(() => setActiveMode(spec)).toThrow(/ambiguous base "dupe"/);
  });
});

describe("setActiveMode validation + clone-on-set", () => {
  it("a bad spec throws and does NOT become active", () => {
    buildFixture();
    const bad: ResolvedMode = { ...PI_MODE, quality: "bogus" };
    expect(() => setActiveMode(bad)).toThrow(/quality "bogus"/);
    expect(getActiveMode()).toBeUndefined();
    expect(resolveActiveModePlan()).toEqual({
      mode: undefined,
      signature: NO_MODE_SIGNATURE,
      fragments: [],
    });
  });

  it("a prior valid mode survives a failed set (state intact on throw)", () => {
    buildFixture();
    setActiveMode(PI_MODE);
    const goodSig = resolveActiveModePlan().signature;
    const bad: ResolvedMode = { ...PI_MODE, scope: "nope" };
    expect(() => setActiveMode(bad)).toThrow(/scope "nope"/);
    // Prior mode is still active and resolves to the same signature.
    expect(resolveActiveModePlan().signature).toBe(goodSig);
  });

  it("explicit ResolvedMode specs are cloned: post-set caller mutation is inert", () => {
    buildFixture();
    const spec: ResolvedMode = {
      ...PI_MODE,
      modifiers: ["tdd"],
    };
    setActiveMode(spec);
    const before = resolveActiveModePlan();

    // Mutate the caller's object AND its modifiers array after set.
    spec.base = "chill";
    spec.agency = "does-not-exist";
    spec.modifiers.push("terse");
    spec.modifiers[0] = "terse";

    const after = resolveActiveModePlan();
    // The plan reflects the value AT SET TIME, not the mutated caller object.
    expect(after.signature).toBe(before.signature);
    expect(after.fragments.map((f) => [f.slot, f.value])).toEqual(
      before.fragments.map((f) => [f.slot, f.value]),
    );
    expect(after.mode?.base).toBe("pi");
    expect(after.mode?.modifiers).toEqual(["tdd"]);
  });

  it("getActiveMode returns a CLONE: mutating it does not corrupt active state", () => {
    buildFixture();
    const spec: ResolvedMode = { ...PI_MODE, modifiers: ["tdd"] };
    setActiveMode(spec);
    const before = resolveActiveModePlan().signature;

    // Mutate the value returned by getActiveMode (object + its modifiers array).
    const got = getActiveMode();
    expect(typeof got).not.toBe("string");
    const gotMode = got as ResolvedMode;
    gotMode.base = "chill";
    gotMode.agency = "does-not-exist";
    gotMode.modifiers.push("terse");

    // Active state is untouched — the next resolve matches the original.
    expect(resolveActiveModePlan().signature).toBe(before);
    expect(getActiveMode()).toEqual({ ...PI_MODE, modifiers: ["tdd"] });
  });
});

describe("active-mode seam basics", () => {
  it("getActiveMode reflects set; clearActiveMode + reset clear it", () => {
    buildFixture();
    expect(getActiveMode()).toBeUndefined();
    const spec: ModeSpec = { ...PI_MODE };
    setActiveMode(spec);
    expect(getActiveMode()).toBeDefined();

    clearActiveMode();
    expect(getActiveMode()).toBeUndefined();

    setActiveMode(spec);
    resetResolverForTesting();
    expect(getActiveMode()).toBeUndefined();
  });
});
