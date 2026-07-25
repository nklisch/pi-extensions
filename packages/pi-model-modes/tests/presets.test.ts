import { describe, it, expect, beforeEach } from "vitest";
import {
  PI_BASE,
  NONE_PRESET,
  loadPresets,
  getPreset,
  listPresetNames,
  resetPresetsForTesting,
  type ResolvedMode,
  type PresetRegistry,
} from "../src/presets.js";
import { NO_MODE_SIGNATURE } from "../src/cache.js";

// A well-formed synthetic registry text for the override seam.
const SYNTHETIC = JSON.stringify({
  alpha: {
    base: "pi",
    agency: "collaborative",
    quality: "pragmatic",
    scope: "adjacent",
    modifiers: [],
  },
  beta: {
    base: "chill",
    agency: "autonomous",
    quality: "rigorous",
    scope: "wide",
    modifiers: ["flow", "terse"],
  },
});

beforeEach(() => {
  resetPresetsForTesting();
});

describe("getPreset — lookup (hit) returns the exact preset", () => {
  it("getPreset('flow') returns the curated SPEC-canonical object", () => {
    const reg = loadPresets();
    expect(getPreset("flow", reg)).toEqual({
      base: "flow",
      agency: "autonomous",
      quality: "architect",
      scope: "adjacent",
      modifiers: ["flow"],
    });
  });
});

describe("atomic expansion — a preset carries all five components at once", () => {
  it("'extend' expands to every axis in one object (empty modifiers included)", () => {
    const reg = loadPresets();
    const preset = getPreset("extend", reg);
    // Selecting a preset yields every axis at once — no partial selection.
    expect(preset).toEqual({
      base: "pi",
      agency: "autonomous",
      quality: "pragmatic",
      scope: "adjacent",
      modifiers: [],
    });
    // All five keys are present (the atomicity contract).
    expect(Object.keys(preset).sort()).toEqual([
      "agency",
      "base",
      "modifiers",
      "quality",
      "scope",
    ]);
  });
});

describe("unknown-preset fail-fast", () => {
  it("getPreset('nope') throws naming the miss and listing available names", () => {
    const reg = loadPresets();
    expect(() => getPreset("nope", reg)).toThrow(/unknown preset "nope"/);
    // The message must list the available names so the user can self-correct.
    let message = "";
    try {
      getPreset("nope", reg);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("extend");
    expect(message).toContain("flow");
    expect(message).toContain("none");
  });
});

describe("duplicate-id fail-fast (raw-text detection)", () => {
  it("a repeated top-level key throws a duplicate-id error naming the key", () => {
    // JSON.parse alone would silently drop the first "flow"; the raw-text scan
    // must catch it. The two bodies differ to prove last-wins is NOT relied on.
    const json = `{
      "flow": { "base": "pi", "agency": "autonomous", "quality": "pragmatic", "scope": "adjacent", "modifiers": ["flow"] },
      "flow": { "base": "pi", "agency": "surgical", "quality": "rigorous", "scope": "narrow", "modifiers": [] }
    }`;
    expect(() => loadPresets({ json })).toThrow(
      /duplicate preset id "flow"/,
    );
  });

  it("does NOT false-positive when a preset name also appears as a NESTED key", () => {
    // "agency" is a nested field key inside every preset. A naive whole-document
    // scan for the top-level key "agency" would miscount it as a duplicate; the
    // depth-aware scan must register keys only at object depth 1.
    const json = `{
      "agency": { "base": "pi", "agency": "autonomous", "quality": "pragmatic", "scope": "adjacent", "modifiers": [] },
      "other":  { "base": "pi", "agency": "autonomous", "quality": "pragmatic", "scope": "adjacent", "modifiers": [] }
    }`;
    expect(() => loadPresets({ json })).not.toThrow();
    const reg = loadPresets({ json });
    expect(Object.keys(reg).sort()).toEqual(["agency", "other"]);
  });

  it("catches an escape-equivalent duplicate key (\"flow\" vs \"fl\\u006fw\")", () => {
    // JSON.parse collapses these to the same key "flow"; the scanner JSON-decodes
    // each top-level key token, so it recognizes them as the SAME id and throws.
    const json =
      '{ "flow": { "base": "pi", "agency": "autonomous", "quality": "pragmatic", "scope": "adjacent", "modifiers": [] },' +
      '  "fl\\u006fw": { "base": "pi", "agency": "surgical", "quality": "rigorous", "scope": "narrow", "modifiers": [] } }';
    expect(() => loadPresets({ json })).toThrow(/duplicate preset id "flow"/);
  });

  it("does NOT false-positive when a preset name appears inside a string VALUE", () => {
    // A modifier literally named like a preset id must not be mistaken for a
    // second top-level key (string-state-aware scan).
    const json = `{
      "flow":  { "base": "pi", "agency": "autonomous", "quality": "pragmatic", "scope": "adjacent", "modifiers": ["flow"] },
      "other": { "base": "pi", "agency": "autonomous", "quality": "pragmatic", "scope": "adjacent", "modifiers": [] }
    }`;
    expect(() => loadPresets({ json })).not.toThrow();
  });
});

describe("malformed-shape fail-fast", () => {
  it("(a) non-object top level throws", () => {
    expect(() => loadPresets({ json: "[1, 2, 3]" })).toThrow(
      /top-level object/,
    );
    expect(() => loadPresets({ json: '"a string"' })).toThrow(
      /top-level object/,
    );
  });

  it("(b) a preset missing 'scope' throws naming the field", () => {
    const json = JSON.stringify({
      x: { base: "pi", agency: "collaborative", quality: "pragmatic", modifiers: [] },
    });
    expect(() => loadPresets({ json })).toThrow(
      /preset "x": "scope" must be a non-empty string/,
    );
  });

  it("(c) a preset with agency:'' throws naming the field", () => {
    const json = JSON.stringify({
      x: { base: "pi", agency: "", quality: "pragmatic", scope: "adjacent", modifiers: [] },
    });
    expect(() => loadPresets({ json })).toThrow(
      /preset "x": "agency" must be a non-empty string/,
    );
  });

  it("(d) a preset with modifiers:'flow' (string not array) throws", () => {
    const json = JSON.stringify({
      x: { base: "pi", agency: "collaborative", quality: "pragmatic", scope: "adjacent", modifiers: "flow" },
    });
    expect(() => loadPresets({ json })).toThrow(
      /preset "x": "modifiers" must be a string array/,
    );
  });

  it("a modifiers entry that is not a non-empty string throws", () => {
    const json = JSON.stringify({
      x: { base: "pi", agency: "collaborative", quality: "pragmatic", scope: "adjacent", modifiers: [""] },
    });
    expect(() => loadPresets({ json })).toThrow(
      /preset "x": every "modifiers" entry must be a non-empty string/,
    );
  });

  it("invalid JSON throws a malformed-file error", () => {
    expect(() => loadPresets({ json: "{ not json" })).toThrow(
      /not valid JSON/,
    );
  });
});

describe("base:'pi' vs no-mode distinction (this feature's representational contract)", () => {
  it("PI_BASE ('pi') and NO_MODE_SIGNATURE ('') are distinct sentinels", () => {
    expect(PI_BASE).toBe("pi");
    expect(NO_MODE_SIGNATURE).toBe("");
    expect(PI_BASE).not.toBe(NO_MODE_SIGNATURE);
  });

  it("the 'extend' preset is a real, fully-populated mode with base === PI_BASE", () => {
    const reg = loadPresets();
    const preset = getPreset("extend", reg);
    // base:"pi" is a REAL mode (full axis fragments) — NOT the no-mode state.
    // The no-mode state has no ResolvedMode object at all (NO_MODE_SIGNATURE);
    // here every axis is populated.
    expect(preset.base).toBe(PI_BASE);
    const asResolved: ResolvedMode = preset;
    expect(asResolved.agency).toBeTruthy();
    expect(asResolved.quality).toBeTruthy();
    expect(asResolved.scope).toBeTruthy();
    expect(Array.isArray(asResolved.modifiers)).toBe(true);
  });

  it("'none' is a virtual preset name, not an on-disk ResolvedMode", () => {
    const reg = loadPresets();
    expect(NONE_PRESET).toBe("none");
    expect(Object.keys(reg)).not.toContain("none");
    expect(listPresetNames(reg)).toContain("none");
    expect(() => getPreset("none", reg)).toThrow(/unknown preset "none"/);
  });
});

describe("starter-set sanity / load-from-disk", () => {
  it("loadPresets() reads the real file; keys are exactly the curated catalog", () => {
    const reg = loadPresets();
    expect(Object.keys(reg).sort()).toEqual([
      "create",
      "debug",
      "director",
      "explore",
      "extend",
      "flow",
      "methodical",
      "muse",
      "partner",
      "refactor",
      "safe",
      "spark",
      "tinker",
    ]);
  });

  it("listPresetNames includes the virtual none mode for user-facing selectors", () => {
    expect(listPresetNames()).toEqual([
      "create",
      "debug",
      "director",
      "explore",
      "extend",
      "flow",
      "methodical",
      "muse",
      "none",
      "partner",
      "refactor",
      "safe",
      "spark",
      "tinker",
    ]);
  });

  it("every shipped preset is well-formed (all five components, correct types)", () => {
    const reg = loadPresets();
    for (const [name, preset] of Object.entries(reg)) {
      expect(typeof preset.base, name).toBe("string");
      expect(preset.base.length, name).toBeGreaterThan(0);
      expect(typeof preset.agency, name).toBe("string");
      expect(preset.agency.length, name).toBeGreaterThan(0);
      expect(typeof preset.quality, name).toBe("string");
      expect(preset.quality.length, name).toBeGreaterThan(0);
      expect(typeof preset.scope, name).toBe("string");
      expect(preset.scope.length, name).toBeGreaterThan(0);
      expect(Array.isArray(preset.modifiers), name).toBe(true);
      for (const mod of preset.modifiers) {
        expect(typeof mod, name).toBe("string");
        expect(mod.length, name).toBeGreaterThan(0);
      }
    }
  });
});

describe("validated-string (no closed union) — unknown axis VALUES load fine", () => {
  it("a future/unknown agency value is shape-valid and does NOT throw here", () => {
    // Existence of axis values is the resolver's job (it holds the discovered
    // fragment set). The preset table validates SHAPE only — an unknown but
    // well-formed string must load without error.
    const json = JSON.stringify({
      future: {
        base: "some-future-base",
        agency: "some-future-axis-value",
        quality: "another-future-value",
        scope: "yet-another",
        modifiers: ["a-future-modifier"],
      },
    });
    expect(() => loadPresets({ json })).not.toThrow();
    const reg = loadPresets({ json });
    expect(getPreset("future", reg).agency).toBe("some-future-axis-value");
  });

  it("the override seam parses a multi-preset synthetic registry", () => {
    const reg: PresetRegistry = loadPresets({ json: SYNTHETIC });
    expect(Object.keys(reg).sort()).toEqual(["alpha", "beta"]);
    expect(getPreset("beta", reg).modifiers).toEqual(["flow", "terse"]);
  });
});

describe("memoization + reset", () => {
  it("loadPresets() twice returns a stable view; reset re-reads", () => {
    const first = loadPresets();
    const second = loadPresets();
    expect(second).toBe(first); // memoized — same reference
    resetPresetsForTesting();
    const third = loadPresets();
    expect(third).not.toBe(first); // fresh read after reset
    expect(third).toEqual(first); // same content
  });

  it("an opts.json override does not poison the disk memo", () => {
    const fromDisk = loadPresets();
    loadPresets({ json: SYNTHETIC }); // override read — must not memoize
    const fromDiskAgain = loadPresets();
    expect(fromDiskAgain).toBe(fromDisk);
    expect(Object.keys(fromDiskAgain).sort()).toEqual([
      "create",
      "debug",
      "director",
      "explore",
      "extend",
      "flow",
      "methodical",
      "muse",
      "partner",
      "refactor",
      "safe",
      "spark",
      "tinker",
    ]);
  });
});
