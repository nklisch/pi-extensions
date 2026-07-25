import { describe, it, expect, beforeEach } from "vitest";
import { loadPresets, resetPresetsForTesting } from "../src/presets.js";
import {
  setActiveMode,
  resolveActiveModePlan,
  resetResolverForTesting,
} from "../src/resolver.js";
import { resetFragmentsForTesting } from "../src/fragments.js";

/**
 * Catalog-integration acceptance — the load-bearing proof that the curated
 * `presets.json` references ONLY authored fragments. No fragment-root override:
 * we run against the REAL bundled `prompts/` tree so every base/axis/modifier a
 * preset names must actually resolve. For EVERY shipped preset, `setActiveMode`
 * must not throw (set-time materialization validates existence), and
 * `resolveActiveModePlan` must yield a plan whose `mode` matches and whose
 * fragments fully resolve. A misspelled or missing value would surface here as a
 * thrown missing/ambiguous-fragment error — that is the test's entire purpose.
 *
 * Design: `.work/active/features/epic-fragment-library-preset-bundles.md` (Unit 3).
 */

beforeEach(() => {
  resetResolverForTesting();
  resetPresetsForTesting();
  resetFragmentsForTesting();
});

describe("preset catalog — every shipped preset is settable against the real prompts/ tree", () => {
  it("every preset name materializes via setActiveMode + resolveActiveModePlan", () => {
    const reg = loadPresets();
    const names = Object.keys(reg);
    // Sanity: we are exercising the full curated catalog, not an empty set.
    expect(names.length).toBeGreaterThan(0);

    for (const name of names) {
      // Set-time validation: throws on unknown preset / missing / ambiguous.
      expect(() => setActiveMode(name), name).not.toThrow();

      const plan = resolveActiveModePlan();
      expect(plan.mode, name).toBeDefined();
      // The resolved mode reflects this preset's selection.
      const preset = reg[name];
      expect(plan.mode?.base, name).toBe(preset.base);
      expect(plan.mode?.agency, name).toBe(preset.agency);
      expect(plan.mode?.quality, name).toBe(preset.quality);
      expect(plan.mode?.scope, name).toBe(preset.scope);

      // Every selected fragment resolved (loaded content) in canonical order.
      // The three axes always contribute a fragment; a non-pi base and every
      // modifier add one too. So a real mode always has at least the 3 axes.
      expect(plan.fragments.length, name).toBeGreaterThanOrEqual(3);
      const slots = plan.fragments.map((f) => f.slot);
      expect(slots, name).toContain("agency");
      expect(slots, name).toContain("quality");
      expect(slots, name).toContain("scope");
      for (const frag of plan.fragments) {
        // Each planned fragment was actually loaded from disk.
        expect(frag.path.length, `${name}:${frag.value}`).toBeGreaterThan(0);
        expect(frag.content.length, `${name}:${frag.value}`).toBeGreaterThan(0);
      }

      // A non-"pi" base contributes a base overlay fragment.
      if (preset.base !== "pi") {
        expect(slots, name).toContain("base");
      }
      // Every declared modifier contributes a fragment.
      for (const mod of preset.modifiers) {
        const hit = plan.fragments.find(
          (f) => f.slot === "modifier" && f.value === mod,
        );
        expect(hit, `${name}:${mod}`).toBeDefined();
      }
    }
  });
});
