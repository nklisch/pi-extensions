import { describe, it, expect, beforeEach } from "vitest";
import { handleBeforeAgentStart } from "../src/handler.js";
import { deriveIdentityLine } from "../src/identity.js";
import { resetCacheForTesting } from "../src/cache.js";
import {
  MODE_FOOTER_KEY,
  refreshModeFooter,
  resetFooterForTesting,
  setCycleHintEnabled,
} from "../src/footer.js";
import { CYCLE_BACKWARD_KEY, CYCLE_FORWARD_KEY } from "../src/keybinding.js";
import { resetResolverForTesting } from "../src/resolver.js";
import { resetStyleForTesting } from "../src/style.js";
import { makeContext, makeEvent, makeModel, makeUi } from "./harness.js";

describe("handleBeforeAgentStart — Invariant 3 evolved (identity-prepended, remainder byte-identical, never undefined)", () => {
  const model = makeModel({ name: "GLM-4.6", provider: "zai" });
  const identity = deriveIdentityLine(model);

  beforeEach(() => {
    resetCacheForTesting(); // module-scope cache state isolates per case
    resetResolverForTesting();
    resetFooterForTesting();
    resetStyleForTesting();
  });

  const fixtures: Record<string, string> = {
    typical: "You are an expert coding assistant...\n\nAvailable tools:\n- read",
    "project-context": "You are an expert...\n<project_context>...</project_context>",
    whitespace: "   \n\t  ",
  };

  const countIdentityLines = (s: string) =>
    s.split("\n").filter((l) => l === identity).length;

  for (const [name, input] of Object.entries(fixtures)) {
    it(`prepends identity, remainder byte-identical (${name})`, () => {
      const result = handleBeforeAgentStart(makeEvent(input), makeContext({ model }));

      // (d) always a present systemPrompt (never undefined).
      expect(typeof result.systemPrompt).toBe("string");
      expect(result.systemPrompt.length).toBeGreaterThan(0);

      // (a) identity line is the FIRST line and matches deriveIdentityLine(model).
      expect(result.systemPrompt.split("\n")[0]).toBe(identity);

      // (b) the remainder after the identity line is byte-identical to the input.
      expect(result.systemPrompt).toBe(`${identity}\n${input}`);
    });
  }

  it("does not duplicate identity across repeated same-input calls (cache does not stack)", () => {
    const input = "typical prompt body";
    const r1 = handleBeforeAgentStart(makeEvent(input), makeContext({ model }));
    const r2 = handleBeforeAgentStart(makeEvent(input), makeContext({ model }));
    const r3 = handleBeforeAgentStart(makeEvent(input), makeContext({ model }));

    // (c) exactly ONE identity line across repeated calls (r1 MISS, r2/r3 HIT).
    expect(countIdentityLines(r1.systemPrompt)).toBe(1);
    expect(countIdentityLines(r2.systemPrompt)).toBe(1);
    expect(countIdentityLines(r3.systemPrompt)).toBe(1);

    // HIT path returns the prior miss's bytes (no re-assembly, no stacking).
    expect(r2.systemPrompt).toBe(r1.systemPrompt);
    expect(r3.systemPrompt).toBe(r1.systemPrompt);
  });

  it("footer unset rendering does not perturb the identity-only no-op splice", () => {
    const input = "typical prompt body";
    const ui = makeUi();
    const ctx = makeContext({
      model,
      hasUI: true,
      ui,
    });

    setCycleHintEnabled(true);
    refreshModeFooter(ctx);
    const result = handleBeforeAgentStart(makeEvent(input), ctx);

    expect(ui.statusCalls).toEqual([
      {
        key: MODE_FOOTER_KEY,
        text: `mode: ◆ unset · ${CYCLE_FORWARD_KEY}/${CYCLE_BACKWARD_KEY} cycle`,
      },
    ]);
    expect(result.systemPrompt).toBe(`${identity}\n${input}`);
    expect(result.systemPrompt.split("\n")[0]).toBe(identity);
  });
});
