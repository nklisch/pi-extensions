import { describe, it, expect, beforeEach } from "vitest";
import { handleBeforeAgentStart } from "../src/handler.js";
import { deriveIdentityLine } from "../src/identity.js";
import { resetCacheForTesting, getChangeSignal } from "../src/cache.js";
import { makeContext, makeEvent, makeModel } from "./harness.js";

describe("handleBeforeAgentStart — cache-path coverage (always-return on HIT and MISS)", () => {
  const model = makeModel({ name: "GLM-4.6", provider: "zai" });

  beforeEach(() => resetCacheForTesting());

  it("first call (MISS) returns a present string", () => {
    const r = handleBeforeAgentStart(makeEvent("base prompt"), makeContext({ model }));
    expect(typeof r.systemPrompt).toBe("string");
    expect(r.systemPrompt.length).toBeGreaterThan(0);
  });

  it("second identical call (HIT) returns the cached present string", () => {
    const r1 = handleBeforeAgentStart(makeEvent("base prompt"), makeContext({ model }));
    const r2 = handleBeforeAgentStart(makeEvent("base prompt"), makeContext({ model }));
    expect(typeof r2.systemPrompt).toBe("string");
    expect(r2.systemPrompt).toBe(r1.systemPrompt); // HIT returns prior miss's bytes
  });

  it("changed input (MISS) re-assembles from the new base (clean-base, no stale output)", () => {
    const identity = deriveIdentityLine(model);
    handleBeforeAgentStart(makeEvent("base prompt A"), makeContext({ model }));
    handleBeforeAgentStart(makeEvent("base prompt B"), makeContext({ model })); // base change → MISS
    const r = handleBeforeAgentStart(makeEvent("base prompt A"), makeContext({ model })); // back to A → MISS
    // Asserts the actual assembled bytes, not merely "present": a constant
    // string or leaked prior output would fail here.
    expect(r.systemPrompt).toBe(`${identity}\nbase prompt A`);
  });

  it("does not stack identity across a MISS → HIT → different-base MISS sequence", () => {
    const identity = deriveIdentityLine(model);
    const miss1 = handleBeforeAgentStart(makeEvent("A"), makeContext({ model })); // MISS
    const hit = handleBeforeAgentStart(makeEvent("A"), makeContext({ model })); // HIT
    const miss2 = handleBeforeAgentStart(makeEvent("B"), makeContext({ model })); // MISS (base change)
    expect(miss1.systemPrompt).toBe(`${identity}\nA`);
    expect(hit.systemPrompt).toBe(`${identity}\nA`); // HIT returns prior MISS bytes
    expect(miss2.systemPrompt).toBe(`${identity}\nB`); // re-assembled, not stacked on the HIT output
    // Exactly one identity line on every path — never doubled by the cache.
    for (const r of [miss1, hit, miss2]) {
      expect(r.systemPrompt.split("\n").filter((l) => l === identity).length).toBe(1);
    }
  });

  it("switching model re-derives identity AND re-keys on modelId (per-turn live derivation)", () => {
    // Distinct provider AND distinct id: proves both feed the cache key + line.
    const modelA = makeModel({ id: "glm-4.6", name: "GLM-4.6", provider: "zai" });
    const modelB = makeModel({ id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" });
    const rA = handleBeforeAgentStart(makeEvent("base"), makeContext({ model: modelA }));
    const rB = handleBeforeAgentStart(makeEvent("base"), makeContext({ model: modelB }));
    expect(rA.systemPrompt.split("\n")[0]).toBe(deriveIdentityLine(modelA));
    expect(rB.systemPrompt.split("\n")[0]).toBe(deriveIdentityLine(modelB));
  });

  it("re-keys on modelId alone (same provider + base, different id → MISS, fresh derivation)", () => {
    // Same provider and base; ONLY the id differs. If modelId were dropped from
    // CacheKeyInputs, call 2 would be a stale HIT returning call 1's bytes.
    const modelA = makeModel({ id: "glm-4.5", name: "GLM-4.5", provider: "zai" });
    const modelB = makeModel({ id: "glm-4.6", name: "GLM-4.6", provider: "zai" });
    const rA = handleBeforeAgentStart(makeEvent("base"), makeContext({ model: modelA }));
    const rB = handleBeforeAgentStart(makeEvent("base"), makeContext({ model: modelB }));
    expect(rA.systemPrompt).toBe(`${deriveIdentityLine(modelA)}\nbase`);
    expect(rB.systemPrompt).toBe(`${deriveIdentityLine(modelB)}\nbase`); // not a stale HIT
  });

  it("re-keys on modelName alone (same id + provider + base → MISS, fresh identity)", () => {
    // The identity line reads model.name. If modelName is not part of the key,
    // a registry-side display-name rename would return a stale HIT.
    const modelA = makeModel({ id: "glm-4.6", name: "GLM-4.6", provider: "zai" });
    const modelB = makeModel({ id: "glm-4.6", name: "GLM-4.7", provider: "zai" });
    const rA = handleBeforeAgentStart(makeEvent("base"), makeContext({ model: modelA }));
    const rB = handleBeforeAgentStart(makeEvent("base"), makeContext({ model: modelB }));
    expect(rA.systemPrompt).toBe(`${deriveIdentityLine(modelA)}\nbase`);
    expect(rB.systemPrompt).toBe(`${deriveIdentityLine(modelB)}\nbase`);
    expect(getChangeSignal().lastEntry?.reason).toBe("model-switched");
  });
});

describe("handleBeforeAgentStart — undefined ctx.model (acceptance: skip identity, still cache + return)", () => {
  beforeEach(() => resetCacheForTesting());

  it("undefined model → no identity, no leading newline, result === e.systemPrompt", () => {
    const base = "pi assembled base prompt\n\nAvailable tools:\n- read";
    const r = handleBeforeAgentStart(makeEvent(base), makeContext({ model: undefined }));
    // Present string (never undefined) on the no-model path.
    expect(typeof r.systemPrompt).toBe("string");
    // Exactly the base — no identity prepended, NO leading newline.
    expect(r.systemPrompt).toBe(base);
    expect(r.systemPrompt.startsWith("\n")).toBe(false);
  });

  it("undefined model still engages the cache: a MISS records one change entry with empty model id/provider; the HIT records none", () => {
    const base = "base";
    const r1 = handleBeforeAgentStart(makeEvent(base), makeContext({ model: undefined }));
    // After the first (MISS) call the change signal recorded an entry whose
    // model components are the empty-string sentinels — proving the handler ran
    // the full key/cache path, not a no-model short-circuit.
    const afterMiss = getChangeSignal();
    expect(afterMiss.entries.length).toBe(1);
    expect(afterMiss.entries[0].reason).toBe("initial");
    expect(afterMiss.entries[0].detail.modelName.to).toBe("");
    expect(afterMiss.entries[0].detail.modelId.to).toBe("");
    expect(afterMiss.entries[0].detail.modelProvider.to).toBe("");

    const r2 = handleBeforeAgentStart(makeEvent(base), makeContext({ model: undefined }));
    // Second identical call is a HIT: same bytes, and NO new change entry
    // (a skip-the-cache impl would never reach setCachedResult and this would
    // still be 1 — but then the bytes-equality alone wouldn't prove caching;
    // the MISS-side assertions above close that gap).
    const afterHit = getChangeSignal();
    expect(r1.systemPrompt).toBe(base);
    expect(r2.systemPrompt).toBe(base);
    expect(afterHit.entries.length).toBe(1); // unchanged → the second call was a HIT, not a re-store
  });
});
