import { describe, expect, it } from "vitest";
import { resolveEffectiveThinkingLevel } from "#src/session/thinking-level";
import { makeModel } from "#test/helpers/make-model";

describe("resolveEffectiveThinkingLevel", () => {
  it("preserves an explicit supported level", () => {
    const model = makeModel({ reasoning: true });
    expect(resolveEffectiveThinkingLevel(model, "high")).toBe("high");
  });

  it("uses the inherited level when no explicit level is supplied", () => {
    const model = makeModel({ reasoning: true });
    expect(resolveEffectiveThinkingLevel(model, undefined, "low")).toBe("low");
  });

  it("reports off for a model without reasoning support", () => {
    expect(resolveEffectiveThinkingLevel(makeModel({ reasoning: false }), "high")).toBe("off");
  });

  it("preserves Pi's pending level when the model will be resolved during session creation", () => {
    expect(resolveEffectiveThinkingLevel(undefined, "high", "low")).toBe("high");
    expect(resolveEffectiveThinkingLevel(undefined, undefined, "low")).toBe("low");
    expect(resolveEffectiveThinkingLevel(undefined)).toBe("medium");
  });

  it("clamps unsupported levels to the model's supported range", () => {
    const model = makeModel({
      reasoning: true,
      thinkingLevelMap: { high: null, medium: "medium" },
    });
    expect(resolveEffectiveThinkingLevel(model, "high")).toBe("medium");
  });

  it("keeps an explicit off value instead of treating it as missing", () => {
    const model = makeModel({ reasoning: true });
    expect(resolveEffectiveThinkingLevel(model, "off", "high")).toBe("off");
  });
});
