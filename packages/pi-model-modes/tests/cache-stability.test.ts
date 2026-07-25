import { beforeEach, describe, expect, it } from "vitest";
import { handleBeforeAgentStart } from "../src/handler.js";
import { deriveIdentityLine } from "../src/identity.js";
import { resetCacheForTesting } from "../src/cache.js";
import { MODE_FOOTER_KEY, refreshModeFooter, resetFooterForTesting } from "../src/footer.js";
import { resetResolverForTesting, setActiveMode } from "../src/resolver.js";
import { resetFragmentsForTesting } from "../src/fragments.js";
import { resetPresetsForTesting } from "../src/presets.js";
import { resetStyleForTesting } from "../src/style.js";
import { makeContext, makeEvent, makeModel, makeUi } from "./harness.js";

/**
 * SPEC Invariant 2 — the assembled `systemPrompt` is byte-identical across N
 * consecutive turns in which nothing changed (same model, same no-mode, same
 * pi base). This file is the load-bearing enforcement: any drift — a
 * timestamp, a turn counter, a random id, an unordered-iteration leak — fails
 * here.
 *
 * The cache is module-scope stateful (`lastKey`/`lastResult` in src/cache.ts);
 * `resetCacheForTesting()` is the isolation mechanism. `beforeEach` resets it
 * so each `it` starts from a clean cache, and the forced-MISS and
 * negative-control tests reset explicitly inside their loops/sub-sequences.
 */

const N = 10;
const model = makeModel({ name: "GLM-4.6", provider: "zai" });
const base =
  "You are an expert coding assistant operating inside pi.\n\n" +
  "Available tools:\n- read\n- bash\n\n<project_context>...</project_context>";
const expected = `${deriveIdentityLine(model)}\n${base}`;

/** Drive one full turn through the real handler and return its systemPrompt. */
function runTurn(b: string = base, m = model): string {
  return handleBeforeAgentStart(makeEvent(b), makeContext({ model: m }))
    .systemPrompt;
}

describe("cache stability — SPEC Invariant 2 (byte-identical across no-change turns)", () => {
  beforeEach(() => {
    resetCacheForTesting();
    resetResolverForTesting();
    resetFooterForTesting();
    resetFragmentsForTesting();
    resetPresetsForTesting();
    resetStyleForTesting();
  });

  it("returns byte-identical systemPrompt across N no-change turns (HIT path)", () => {
    // Reset happened in beforeEach. Turn 1 is a MISS that assembles + stores;
    // turns 2..N are HITs replaying the cached bytes. All N must match the
    // exact expected shape (identity line + "\n" + base) — anchoring to the
    // exact bytes, not just self-equality, closes the "stably wrong" gap.
    const returns: string[] = [];
    for (let i = 0; i < N; i++) {
      returns.push(runTurn());
    }

    expect(returns).toHaveLength(N);
    for (const got of returns) {
      expect(got).toBe(expected);
    }
    // Self-consistency: every return equals the first (redundant with the
    // exact-anchor above, but documents the across-turns stability directly).
    expect(new Set(returns).size).toBe(1);
  });

  it("re-assembles byte-identically when forced to MISS every turn (assembly determinism)", () => {
    // The load-bearing direction: reset before EVERY turn so the handler
    // re-assembles from scratch each time, defeating the cache's replay. If
    // assembly injected any nondeterministic value (timestamp, counter, random
    // id, unordered-iteration ordering), the N re-assembled outputs would
    // diverge here even though the inputs are identical.
    const returns: string[] = [];
    for (let i = 0; i < N; i++) {
      resetCacheForTesting();
      returns.push(runTurn());
    }

    expect(returns).toHaveLength(N);
    for (const got of returns) {
      expect(got).toBe(expected);
    }
    expect(new Set(returns).size).toBe(1);
  });

  it("produces no dynamic content — output is exactly identity + base, nothing appended", () => {
    const got = runTurn();
    // Exact-shape: identity line + "\n" + base, and nothing else.
    expect(got).toBe(expected);
    // Length check proves no extra leading/trailing bytes slipped in — a
    // stronger statement than `toBe` alone for a "nothing appended" claim.
    expect(got.length).toBe(expected.length);
  });

  it("negative control: a real input change DOES change the bytes", () => {
    // Proves the byte-comparison can actually fail on a real change — a
    // stability test that can't observe a change is worthless. Each
    // sub-sequence starts from a fresh cache so it re-assembles independently.

    // Model name+provider differs → identity line differs → bytes differ.
    const modelA = makeModel({ name: "GLM-4.6", provider: "zai" });
    const modelB = makeModel({ name: "Claude", provider: "anthropic" });

    resetCacheForTesting();
    const bytesModelA = runTurn(base, modelA);
    resetCacheForTesting();
    const bytesModelB = runTurn(base, modelB);
    expect(bytesModelA).not.toBe(bytesModelB);

    // Base text differs → assembled bytes differ.
    const baseX = base;
    const baseY = base + "\n\n<extra>changed</extra>";

    resetCacheForTesting();
    const bytesBaseX = runTurn(baseX, model);
    resetCacheForTesting();
    const bytesBaseY = runTurn(baseY, model);
    expect(bytesBaseX).not.toBe(bytesBaseY);
  });

  it("footer refresh fires every turn while a mode-set prompt stays byte-identical", () => {
    setActiveMode("safe");
    const ui = makeUi();
    let currentSystemPrompt = "";
    const ctx = makeContext({
      model,
      hasUI: true,
      ui,
      getSystemPrompt: () => currentSystemPrompt,
    });
    const prompts: string[] = [];

    for (let i = 0; i < N; i++) {
      refreshModeFooter(ctx);
      currentSystemPrompt = handleBeforeAgentStart(makeEvent(base), ctx)
        .systemPrompt;
      prompts.push(ctx.getSystemPrompt());
    }

    expect(prompts).toHaveLength(N);
    expect(new Set(prompts).size).toBe(1);
    expect(ui.statusCalls).toHaveLength(N);
    for (const call of ui.statusCalls) {
      expect(call).toEqual({ key: MODE_FOOTER_KEY, text: "mode: ◆ safe" });
    }
  });
});
