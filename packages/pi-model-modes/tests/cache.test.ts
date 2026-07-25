import { describe, it, expect, beforeEach } from "vitest";
import {
  computeCacheKey,
  getCachedResult,
  setCachedResult,
  getChangeSignal,
  resetCacheForTesting,
  NO_MODE_SIGNATURE,
} from "../src/cache.js";
import type { CacheKeyInputs } from "../src/cache.js";

/**
 * Pure-module tests for `src/cache.ts` — cache key + per-turn result cache +
 * change-signal ring buffer. No pi event/ctx, so no `tests/harness.ts` builders.
 * Each test seeds state via direct calls; `beforeEach` reset isolates cases
 * (module state would otherwise leak across tests in one vitest process).
 *
 * Coverage mirrors the design's `## Testing` list. The change-detection
 * (term-necessity) tests FAIL if any key term is omitted — that is the
 * codex-required proof that the hash covers all four inputs.
 */

const BASE_INPUTS: CacheKeyInputs = {
  modelName: "Claude Sonnet 4.6",
  modelId: "claude-sonnet-4-6",
  modelProvider: "anthropic",
  modeSignature: NO_MODE_SIGNATURE,
  styleSignature: "",
  baseSystemPrompt: "You are an expert coding assistant.",
};

beforeEach(() => {
  resetCacheForTesting();
});

describe("computeCacheKey — purity + determinism", () => {
  it("produces a 64-char lowercase hex digest", () => {
    const key = computeCacheKey(BASE_INPUTS);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key.length).toBe(64);
  });

  it("is byte-identical for identical inputs across repeated calls (pure)", () => {
    expect(computeCacheKey(BASE_INPUTS)).toBe(computeCacheKey(BASE_INPUTS));
  });

  it("is unaffected by construction order of the inputs object (pure over values, not reference)", () => {
    const reordered: CacheKeyInputs = {
      modeSignature: BASE_INPUTS.modeSignature,
      styleSignature: BASE_INPUTS.styleSignature,
      baseSystemPrompt: BASE_INPUTS.baseSystemPrompt,
      modelProvider: BASE_INPUTS.modelProvider,
      modelId: BASE_INPUTS.modelId,
      modelName: BASE_INPUTS.modelName,
    };
    expect(computeCacheKey(reordered)).toBe(computeCacheKey(BASE_INPUTS));
  });
});

describe("computeCacheKey — change-detection (term necessity; codex-required)", () => {
  // These FAIL if any key term is omitted — each proves one input matters.

  it("base-change: same model+mode, different baseSystemPrompt → different key", () => {
    const a = computeCacheKey({ ...BASE_INPUTS, baseSystemPrompt: "base A" });
    const b = computeCacheKey({ ...BASE_INPUTS, baseSystemPrompt: "base B" });
    expect(a).not.toBe(b);
  });

  it("model-change: different modelId (same provider+mode+base) → different key", () => {
    const a = computeCacheKey({ ...BASE_INPUTS, modelId: "claude-sonnet-4-6" });
    const b = computeCacheKey({ ...BASE_INPUTS, modelId: "gpt-5" });
    expect(a).not.toBe(b);
  });

  it("model-change: different modelName (same id+provider+mode+base) → different key", () => {
    const a = computeCacheKey({ ...BASE_INPUTS, modelName: "Claude Sonnet 4.6" });
    const b = computeCacheKey({ ...BASE_INPUTS, modelName: "Claude Sonnet 4.7" });
    expect(a).not.toBe(b);
  });

  it("model-change: different modelProvider (same id+mode+base) → different key", () => {
    const a = computeCacheKey({ ...BASE_INPUTS, modelProvider: "anthropic" });
    const b = computeCacheKey({ ...BASE_INPUTS, modelProvider: "openai" });
    expect(a).not.toBe(b);
  });

  it("mode-change: different modeSignature (same model+base) → different key", () => {
    // Two distinct non-empty composed signatures (forward-looking; the
    // sentinel is not used here).
    const a = computeCacheKey({
      ...BASE_INPUTS,
      modeSignature: "base:chill|agency:autonomous",
    });
    const b = computeCacheKey({
      ...BASE_INPUTS,
      modeSignature: "base:focus|agency:default",
    });
    expect(a).not.toBe(b);
  });

  it("style-change: different styleSignature produces a different key", () => {
    const a = computeCacheKey({ ...BASE_INPUTS, styleSignature: "style-a" });
    const b = computeCacheKey({ ...BASE_INPUTS, styleSignature: "style-b" });
    expect(a).not.toBe(b);
  });

  it("length-delimited encoding nullifies cross-field ambiguity", () => {
    // A naive concatenation would collide these two. The byte-length prefix
    // makes ("ab","c",sig,base) ≠ ("a","bc",sig,base).
    const sig = "sig";
    const base = "base";
    const a = computeCacheKey({
      modelName: "name",
      modelId: "ab",
      modelProvider: "c",
      modeSignature: sig,
      styleSignature: "",
      baseSystemPrompt: base,
    });
    const b = computeCacheKey({
      modelName: "name",
      modelId: "a",
      modelProvider: "bc",
      modeSignature: sig,
      styleSignature: "",
      baseSystemPrompt: base,
    });
    expect(a).not.toBe(b);
  });
});

describe("result cache — hit/miss", () => {
  it("uninitialized state: getCachedResult returns undefined before any set (never surfaces undefined as a HIT)", () => {
    const key = computeCacheKey(BASE_INPUTS);
    expect(getCachedResult(key)).toBeUndefined();
  });

  it("after setCachedResult(key, A), getCachedResult(key) returns A (HIT)", () => {
    const key = computeCacheKey(BASE_INPUTS);
    getCachedResult(key); // miss → populate
    setCachedResult(key, "RESULT-A", BASE_INPUTS);
    expect(getCachedResult(key)).toBe("RESULT-A");
  });

  it("after setCachedResult(keyA, A), getCachedResult(keyB) returns undefined (MISS)", () => {
    const keyA = computeCacheKey(BASE_INPUTS);
    getCachedResult(keyA);
    setCachedResult(keyA, "A", BASE_INPUTS);
    const keyB = computeCacheKey({ ...BASE_INPUTS, baseSystemPrompt: "different base" });
    expect(getCachedResult(keyB)).toBeUndefined();
  });

  it("base-change after storing A is a MISS (not a HIT): prior result not surfaced (codex-required)", () => {
    const inputs1 = { ...BASE_INPUTS, baseSystemPrompt: "base A" };
    const key1 = computeCacheKey(inputs1);
    getCachedResult(key1);
    setCachedResult(key1, "RESULT-A", inputs1);

    const inputs2 = { ...BASE_INPUTS, baseSystemPrompt: "base B" };
    const key2 = computeCacheKey(inputs2);
    const hit = getCachedResult(key2);

    expect(hit).toBeUndefined(); // MISS, not HIT
    expect(key2).not.toBe(key1); // base change actually invalidated the key
  });
});

describe("change signal — reason classification (codex-required)", () => {
  it('first setCachedResult records reason "initial" with previousKey undefined and detail.from all undefined', () => {
    const key = computeCacheKey(BASE_INPUTS);
    getCachedResult(key);
    setCachedResult(key, "R", BASE_INPUTS);

    const last = getChangeSignal().lastEntry;
    expect(last?.reason).toBe("initial");
    expect(last?.previousKey).toBeUndefined();
    expect(last?.detail.modelName.from).toBeUndefined();
    expect(last?.detail.modelId.from).toBeUndefined();
    expect(last?.detail.modelProvider.from).toBeUndefined();
    expect(last?.detail.modeSignature.from).toBeUndefined();
    expect(last?.detail.styleSignature.from).toBeUndefined();
    expect(last?.detail.baseHash.from).toBeUndefined();
  });

  it("modelName change (same id+provider+mode+base) records reason model-switched with modelName detail", () => {
    const i1 = { ...BASE_INPUTS, modelName: "Model One" };
    const k1 = computeCacheKey(i1);
    getCachedResult(k1);
    setCachedResult(k1, "A", i1);

    const i2 = { ...BASE_INPUTS, modelName: "Model Two" };
    const k2 = computeCacheKey(i2);
    getCachedResult(k2);
    setCachedResult(k2, "B", i2);

    const last = getChangeSignal().lastEntry;
    expect(last?.reason).toBe("model-switched");
    expect(last?.detail.modelName).toEqual({ from: "Model One", to: "Model Two" });
  });

  it("modelId change (same provider+mode+base) records reason model-switched with modelId detail", () => {
    const i1 = { ...BASE_INPUTS, modelId: "m1" };
    const k1 = computeCacheKey(i1);
    getCachedResult(k1);
    setCachedResult(k1, "A", i1);

    const i2 = { ...BASE_INPUTS, modelId: "m2" };
    const k2 = computeCacheKey(i2);
    getCachedResult(k2);
    setCachedResult(k2, "B", i2);

    const last = getChangeSignal().lastEntry;
    expect(last?.reason).toBe("model-switched");
    expect(last?.detail.modelId).toEqual({ from: "m1", to: "m2" });
  });

  it("modelProvider change (same id+mode+base) records reason model-switched", () => {
    const i1 = { ...BASE_INPUTS, modelProvider: "anthropic" };
    const k1 = computeCacheKey(i1);
    getCachedResult(k1);
    setCachedResult(k1, "A", i1);

    const i2 = { ...BASE_INPUTS, modelProvider: "openai" };
    const k2 = computeCacheKey(i2);
    getCachedResult(k2);
    setCachedResult(k2, "B", i2);

    const last = getChangeSignal().lastEntry;
    expect(last?.reason).toBe("model-switched");
    expect(last?.detail.modelProvider).toEqual({ from: "anthropic", to: "openai" });
  });

  it("modeSignature change records reason mode-switched with modeSignature detail", () => {
    const i1 = { ...BASE_INPUTS, modeSignature: "base:chill|agency:autonomous" };
    const k1 = computeCacheKey(i1);
    getCachedResult(k1);
    setCachedResult(k1, "A", i1);

    const i2 = { ...BASE_INPUTS, modeSignature: "base:focus|agency:default" };
    const k2 = computeCacheKey(i2);
    getCachedResult(k2);
    setCachedResult(k2, "B", i2);

    const last = getChangeSignal().lastEntry;
    expect(last?.reason).toBe("mode-switched");
    expect(last?.detail.modeSignature).toEqual({
      from: "base:chill|agency:autonomous",
      to: "base:focus|agency:default",
    });
  });

  it("styleSignature change records style-switched with detail", () => {
    const i1 = { ...BASE_INPUTS, styleSignature: "style-a" };
    const k1 = computeCacheKey(i1);
    getCachedResult(k1);
    setCachedResult(k1, "A", i1);

    const i2 = { ...BASE_INPUTS, styleSignature: "style-b" };
    const k2 = computeCacheKey(i2);
    getCachedResult(k2);
    setCachedResult(k2, "B", i2);

    expect(getChangeSignal().lastEntry?.reason).toBe("style-switched");
    expect(getChangeSignal().lastEntry?.detail.styleSignature).toEqual({
      from: "style-a",
      to: "style-b",
    });
  });

  it("mode change wins when mode and style change together", () => {
    const i1 = { ...BASE_INPUTS, modeSignature: "mode-a", styleSignature: "style-a" };
    const k1 = computeCacheKey(i1);
    getCachedResult(k1);
    setCachedResult(k1, "A", i1);
    const i2 = { ...BASE_INPUTS, modeSignature: "mode-b", styleSignature: "style-b" };
    const k2 = computeCacheKey(i2);
    getCachedResult(k2);
    setCachedResult(k2, "B", i2);
    expect(getChangeSignal().lastEntry?.reason).toBe("mode-switched");
  });

  it("style change wins when style and base change together", () => {
    const i1 = {
      ...BASE_INPUTS,
      styleSignature: "style-a",
      baseSystemPrompt: "base A",
    };
    const k1 = computeCacheKey(i1);
    getCachedResult(k1);
    setCachedResult(k1, "A", i1);

    const i2 = {
      ...BASE_INPUTS,
      styleSignature: "style-b",
      baseSystemPrompt: "base B",
    };
    const k2 = computeCacheKey(i2);
    getCachedResult(k2);
    setCachedResult(k2, "B", i2);

    expect(getChangeSignal().lastEntry?.reason).toBe("style-switched");
  });

  it("base change (same model+mode) records reason base-changed with baseHash detail", () => {
    const i1 = { ...BASE_INPUTS, baseSystemPrompt: "base A" };
    const k1 = computeCacheKey(i1);
    getCachedResult(k1);
    setCachedResult(k1, "A", i1);

    const i2 = { ...BASE_INPUTS, baseSystemPrompt: "base B" };
    const k2 = computeCacheKey(i2);
    getCachedResult(k2);
    setCachedResult(k2, "B", i2);

    const last = getChangeSignal().lastEntry;
    expect(last?.reason).toBe("base-changed");
    expect(last?.detail.baseHash.from).toBeDefined();
    expect(last?.detail.baseHash.to).toBeDefined();
    expect(last?.detail.baseHash.from).not.toBe(last?.detail.baseHash.to);
  });

  it("simultaneous model+base change classifies as model-switched (priority: model > mode > base)", () => {
    const i1 = { ...BASE_INPUTS, modelId: "m1", baseSystemPrompt: "base A" };
    const k1 = computeCacheKey(i1);
    getCachedResult(k1);
    setCachedResult(k1, "A", i1);

    const i2 = { ...BASE_INPUTS, modelId: "m2", baseSystemPrompt: "base B" };
    const k2 = computeCacheKey(i2);
    getCachedResult(k2);
    setCachedResult(k2, "B", i2);

    expect(getChangeSignal().lastEntry?.reason).toBe("model-switched");
  });

  it("simultaneous model+mode change classifies as model-switched (priority: model > mode > base)", () => {
    const i1 = {
      ...BASE_INPUTS,
      modelId: "m1",
      modeSignature: "base:chill",
    };
    const k1 = computeCacheKey(i1);
    getCachedResult(k1);
    setCachedResult(k1, "A", i1);

    const i2 = {
      ...BASE_INPUTS,
      modelId: "m2",
      modeSignature: "base:focus",
    };
    const k2 = computeCacheKey(i2);
    getCachedResult(k2);
    setCachedResult(k2, "B", i2);

    expect(getChangeSignal().lastEntry?.reason).toBe("model-switched");
  });

  it("simultaneous mode+base change classifies as mode-switched (priority)", () => {
    const i1 = {
      ...BASE_INPUTS,
      modeSignature: "base:chill",
      baseSystemPrompt: "base A",
    };
    const k1 = computeCacheKey(i1);
    getCachedResult(k1);
    setCachedResult(k1, "A", i1);

    const i2 = {
      ...BASE_INPUTS,
      modeSignature: "base:focus",
      baseSystemPrompt: "base B",
    };
    const k2 = computeCacheKey(i2);
    getCachedResult(k2);
    setCachedResult(k2, "B", i2);

    expect(getChangeSignal().lastEntry?.reason).toBe("mode-switched");
  });
});

describe("change signal — ring buffer", () => {
  it("evicts the oldest entry when capacity (16) is exceeded; entries stays length 16", () => {
    // 17 distinct bases → 17 misses → 17 sets → ring caps at 16, oldest gone.
    for (let i = 0; i < 17; i++) {
      const inputs = { ...BASE_INPUTS, baseSystemPrompt: `base-${i}` };
      const key = computeCacheKey(inputs);
      getCachedResult(key);
      setCachedResult(key, `R-${i}`, inputs);
    }
    const sig = getChangeSignal();
    expect(sig.entries).toHaveLength(16);
    // base-0 was evicted; the oldest surviving entry is base-1.
    const expectedOldest = computeCacheKey({ ...BASE_INPUTS, baseSystemPrompt: "base-1" });
    expect(sig.entries[0]?.newKey).toBe(expectedOldest);
  });

  it("entries is oldest-first; lastEntry is the most recent", () => {
    for (let i = 0; i < 3; i++) {
      const inputs = { ...BASE_INPUTS, baseSystemPrompt: `b-${i}` };
      const key = computeCacheKey(inputs);
      getCachedResult(key);
      setCachedResult(key, `R-${i}`, inputs);
    }
    const sig = getChangeSignal();
    expect(sig.entries[0]?.newKey).toBe(
      computeCacheKey({ ...BASE_INPUTS, baseSystemPrompt: "b-0" }),
    );
    expect(sig.entries[2]?.newKey).toBe(
      computeCacheKey({ ...BASE_INPUTS, baseSystemPrompt: "b-2" }),
    );
    // lastEntry references the same object as the final entries slot.
    expect(sig.lastEntry).toBe(sig.entries[2]);
  });

  it("entries returned by getChangeSignal is a copy: mutating it does not affect the module ring", () => {
    const key = computeCacheKey(BASE_INPUTS);
    getCachedResult(key);
    setCachedResult(key, "R", BASE_INPUTS);

    const sig = getChangeSignal();
    expect(sig.entries).toHaveLength(1);
    sig.entries.pop(); // mutate the returned copy
    expect(getChangeSignal().entries).toHaveLength(1); // module ring untouched
  });
});

describe("change signal — read API", () => {
  it("getChangeSignal exposes currentTurn, currentKey, entries, lastEntry", () => {
    const sig = getChangeSignal();
    expect(Object.keys(sig).sort()).toEqual([
      "currentKey",
      "currentTurn",
      "entries",
      "lastEntry",
    ]);
  });

  it("before any set: currentKey undefined, entries empty, lastEntry undefined", () => {
    const sig = getChangeSignal();
    expect(sig.currentKey).toBeUndefined();
    expect(sig.entries).toEqual([]);
    expect(sig.lastEntry).toBeUndefined();
  });

  it("currentTurn - lastEntry.turn yields turns-since-last-change (across a hit-then-miss sequence)", () => {
    const kA = computeCacheKey(BASE_INPUTS);
    getCachedResult(kA); // turn 1, MISS
    setCachedResult(kA, "A", BASE_INPUTS); // entry.turn = 1
    getCachedResult(kA); // turn 2, HIT
    getCachedResult(kA); // turn 3, HIT

    const iB = { ...BASE_INPUTS, baseSystemPrompt: "changed" };
    const kB = computeCacheKey(iB);
    getCachedResult(kB); // turn 4, MISS
    setCachedResult(kB, "B", iB); // entry.turn = 4
    getCachedResult(kB); // turn 5, HIT
    getCachedResult(kB); // turn 6, HIT

    const sig = getChangeSignal();
    expect(sig.currentTurn).toBe(6);
    expect(sig.lastEntry).toBeDefined();
    expect(sig.lastEntry!.turn).toBe(4);
    expect(sig.currentTurn - sig.lastEntry!.turn).toBe(2); // 2 turns since last change
  });
});

describe("turn accounting", () => {
  it("turn counter increments by 1 per getCachedResult call (HIT or MISS)", () => {
    const key = computeCacheKey(BASE_INPUTS);
    expect(getChangeSignal().currentTurn).toBe(0);

    getCachedResult(key); // turn 1 (MISS, uninitialized)
    expect(getChangeSignal().currentTurn).toBe(1);

    getCachedResult(key); // turn 2 (still MISS — nothing set yet)
    expect(getChangeSignal().currentTurn).toBe(2);

    setCachedResult(key, "A", BASE_INPUTS);
    getCachedResult(key); // turn 3 (now a HIT)
    expect(getChangeSignal().currentTurn).toBe(3);
  });

  it("a change entry records the turn of the MISS (turn counter at the preceding getCachedResult)", () => {
    const kA = computeCacheKey(BASE_INPUTS);
    getCachedResult(kA); // turn 1, MISS
    setCachedResult(kA, "A", BASE_INPUTS);
    expect(getChangeSignal().lastEntry?.turn).toBe(1);

    const iB = { ...BASE_INPUTS, baseSystemPrompt: "base B" };
    const kB = computeCacheKey(iB);
    getCachedResult(kB); // turn 2, MISS
    setCachedResult(kB, "B", iB);
    expect(getChangeSignal().lastEntry?.turn).toBe(2);
  });
});

describe("miss-only contract (Fail Fast)", () => {
  it("setCachedResult throws when key === lastKey (caller misuse surfaces immediately)", () => {
    const key = computeCacheKey(BASE_INPUTS);
    getCachedResult(key); // MISS
    setCachedResult(key, "A", BASE_INPUTS);
    // Calling set again on the same key is a HIT path — misuse, must throw.
    expect(() => setCachedResult(key, "B", BASE_INPUTS)).toThrow();
  });
});
