import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleBeforeAgentStart } from "../src/handler.js";
import { deriveIdentityLine } from "../src/identity.js";
import {
  resetCacheForTesting,
  computeCacheKey,
  NO_MODE_SIGNATURE,
} from "../src/cache.js";
import {
  setActiveMode,
  clearActiveMode,
  resolveActiveModePlan,
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
 * Handler wiring smoke coverage — the mode engine driving the live per-turn
 * path. The full N-turn Invariant-1/2 acceptance suite is owned by
 * `engine-invariant-tests`; here we prove the integration shape:
 *   - an active mode MISS assembles identity + ordered fragments + base
 *     (blank-line join via `assemble.ts`),
 *   - the active-mode key differs from the unset key,
 *   - switching the active mode → different bytes,
 *   - `clearActiveMode()` → back to the identity-only single-`\n` form,
 *   - identity="" (no model) + an active mode → fragments + base, no identity.
 *
 * All module-scope state (cache, resolver active mode, fragment content cache,
 * preset memo) is reset in `beforeEach`; the fragment root points at a temp
 * fixture tree so discovery/load is deterministic.
 */

let tmp: string | undefined;

/** Write a file under `root/rel`, creating parent dirs as needed. */
function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/**
 * Build a minimal-but-complete fixture prompts tree: a base overlay manifest +
 * one base overlay, one fragment per axis, and one modifier. Returns the root.
 */
function buildFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "handler-mode-"));
  tmp = root;
  write(root, "base/chill.md", "CHILL BASE");
  write(root, "base.json", JSON.stringify({ overlays: ["base/chill.md"] }));
  write(root, "axis/agency/autonomous.md", "AGENCY AUTONOMOUS");
  write(root, "axis/quality/pragmatic.md", "QUALITY PRAGMATIC");
  write(root, "axis/scope/adjacent.md", "SCOPE ADJACENT");
  write(root, "modifiers/tdd.md", "MODIFIER TDD");
  setFragmentRootForTesting(root);
  return root;
}

/** The explicit ResolvedMode the fixture above resolves cleanly. */
const FIXTURE_MODE: ResolvedMode = {
  base: "chill",
  agency: "autonomous",
  quality: "pragmatic",
  scope: "adjacent",
  modifiers: ["tdd"],
};

const model = makeModel({ id: "glm-4.6", name: "GLM-4.6", provider: "zai" });
const identity = deriveIdentityLine(model);

beforeEach(() => {
  resetCacheForTesting();
  resetResolverForTesting();
  resetFragmentsForTesting();
  resetPresetsForTesting();
  buildFixture();
});

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
  resetFragmentsForTesting();
  resetResolverForTesting();
});

describe("handleBeforeAgentStart — active-mode wiring (smoke)", () => {
  it("MISS with an active mode assembles identity + ordered fragments + base (blank-line join)", () => {
    setActiveMode(FIXTURE_MODE);
    const base = "pi base prompt";
    const r = handleBeforeAgentStart(makeEvent(base), makeContext({ model }));
    // Base overlay → agency → quality → scope → modifier → pi base, all joined
    // by a blank line, with identity leading.
    expect(r.systemPrompt).toBe(
      [
        identity,
        "CHILL BASE",
        "AGENCY AUTONOMOUS",
        "QUALITY PRAGMATIC",
        "SCOPE ADJACENT",
        "MODIFIER TDD",
        base,
      ].join("\n\n"),
    );
  });

  it("the active-mode key differs from the unset key", () => {
    const base = "pi base prompt";
    const unsetSig = resolveActiveModePlan().signature;
    expect(unsetSig).toBe(NO_MODE_SIGNATURE);

    setActiveMode(FIXTURE_MODE);
    const activeSig = resolveActiveModePlan().signature;
    expect(activeSig).not.toBe(NO_MODE_SIGNATURE);

    const common = {
      modelName: model.name,
      modelId: model.id,
      modelProvider: model.provider,
      styleSignature: "",
      baseSystemPrompt: base,
    };
    const unsetKey = computeCacheKey({ ...common, modeSignature: unsetSig });
    const activeKey = computeCacheKey({ ...common, modeSignature: activeSig });
    expect(activeKey).not.toBe(unsetKey);
  });

  it("switching the active mode → MISS → different bytes", () => {
    const base = "pi base prompt";
    setActiveMode(FIXTURE_MODE);
    const r1 = handleBeforeAgentStart(makeEvent(base), makeContext({ model }));

    // Switch the mode (drop the modifier) → new signature → MISS → new bytes.
    setActiveMode({ ...FIXTURE_MODE, modifiers: [] });
    const r2 = handleBeforeAgentStart(makeEvent(base), makeContext({ model }));

    expect(r2.systemPrompt).not.toBe(r1.systemPrompt);
    expect(r1.systemPrompt).toContain("MODIFIER TDD");
    expect(r2.systemPrompt).not.toContain("MODIFIER TDD");
  });

  it("clearActiveMode() returns to the identity-only single-`\\n` form", () => {
    const base = "pi base prompt";
    setActiveMode(FIXTURE_MODE);
    handleBeforeAgentStart(makeEvent(base), makeContext({ model }));

    clearActiveMode();
    const r = handleBeforeAgentStart(makeEvent(base), makeContext({ model }));
    // Back to the legacy identity-only shape: single newline, no fragments.
    expect(r.systemPrompt).toBe(`${identity}\n${base}`);
    expect(r.systemPrompt).not.toContain("CHILL BASE");
  });

  it("identity='' (no model) + active mode → fragments + base, no identity line", () => {
    setActiveMode(FIXTURE_MODE);
    const base = "pi base prompt";
    const r = handleBeforeAgentStart(makeEvent(base), makeContext({ model: undefined }));
    // No identity part (empty dropped by assemble); fragments + base remain.
    expect(r.systemPrompt).toBe(
      [
        "CHILL BASE",
        "AGENCY AUTONOMOUS",
        "QUALITY PRAGMATIC",
        "SCOPE ADJACENT",
        "MODIFIER TDD",
        base,
      ].join("\n\n"),
    );
    expect(r.systemPrompt.startsWith(identity)).toBe(false);
    expect(r.systemPrompt.startsWith("CHILL BASE")).toBe(true);
  });
});
