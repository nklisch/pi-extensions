import { describe, expect, it } from "vitest";
import {
  createFallbackPolicy,
  selectBaselinePacks,
} from "../../src/policy/composer.ts";

describe("baseline policy composer", () => {
  it("selects individual baseline packs without a posture pseudo-pack", () => {
    const packs = selectBaselinePacks({ registeredToolNames: [] });
    expect(packs.some((pack) => pack.id.startsWith("posture:"))).toBe(false);
    expect(packs.map((pack) => pack.id)).toContain("bash.network.read");
    expect(packs.map((pack) => pack.id)).toContain("pi.home.safe");
  });

  it("provides a sealed-floor-only fallback", () => {
    const fallback = createFallbackPolicy();
    expect(fallback.active).toHaveLength(0);
    expect(fallback.floor?.length ?? 0).toBeGreaterThan(0);
    expect(fallback.rules).toHaveLength(0);
  });
});
