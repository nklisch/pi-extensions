import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  formatReviewerModel,
  HIGH_COST_REVIEWER_MODEL_PATTERNS,
  isHighCostReviewerModel,
  parseModelSpec,
  type ReviewerModelRegistry,
  resolveReviewerModel,
} from "../../src/runtime/reviewer-model.ts";

describe("reviewer model helpers", () => {
  it("parses canonical and bare model specs", () => {
    expect(parseModelSpec("openai-codex/gpt-5.3-codex-spark")).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5.3-codex-spark",
    });
    expect(parseModelSpec("gpt-5.3-codex-spark")).toEqual({
      modelId: "gpt-5.3-codex-spark",
    });
    expect(parseModelSpec("/gpt-5.3-codex-spark")).toEqual({
      modelId: "gpt-5.3-codex-spark",
    });
    expect(parseModelSpec("")).toBeUndefined();
    expect(parseModelSpec("   ")).toBeUndefined();
    expect(parseModelSpec("provider/")).toBeUndefined();
  });

  it("resolves an authed canonical configured model", () => {
    const configured = fakeModel("openai-codex", "gpt-5.3-codex-spark");
    const fallback = fakeModel("openai-codex", "gpt-5.5");
    const resolved = resolveReviewerModel({
      registry: fakeRegistry({ models: [configured, fallback] }),
      spec: "openai-codex/gpt-5.3-codex-spark",
      fallback,
    });

    expect(resolved).toEqual({ model: configured, source: "configured" });
  });

  it("falls back when the configured model is unauthed or unresolvable", () => {
    const configured = fakeModel("openai-codex", "gpt-5.3-codex-spark");
    const fallback = fakeModel("openai-codex", "gpt-5.5");

    expect(
      resolveReviewerModel({
        registry: fakeRegistry({
          models: [configured, fallback],
          authed: [fallback],
        }),
        spec: "openai-codex/gpt-5.3-codex-spark",
        fallback,
      }),
    ).toMatchObject({
      model: fallback,
      source: "fallback",
      note: expect.stringContaining("unavailable or lacks configured auth"),
    });

    expect(
      resolveReviewerModel({
        registry: fakeRegistry({ models: [fallback] }),
        spec: "missing-provider/missing-model",
        fallback,
      }),
    ).toMatchObject({
      model: fallback,
      source: "fallback",
      note: expect.stringContaining("unavailable or lacks configured auth"),
    });
  });

  it("resolves a bare id to the first authed case-insensitive match and notes provider ambiguity", () => {
    const unauthedFirst = fakeModel("provider-a", "shared-model");
    const chosen = fakeModel("provider-b", "SHARED-MODEL");
    const later = fakeModel("provider-c", "shared-model");
    const registry = fakeRegistry({
      models: [unauthedFirst, chosen, later],
      authed: [chosen, later],
    });

    const resolved = resolveReviewerModel({
      registry,
      spec: "shared-model",
      fallback: undefined,
    });

    expect(resolved.model).toBe(chosen);
    expect(resolved.source).toBe("configured");
    expect(resolved.note).toContain("provider-a, provider-b, provider-c");
    expect(resolved.note).toContain("using provider-b/SHARED-MODEL");
  });

  it("uses fallback for null or empty specs and reports none without an authed model", () => {
    const fallback = fakeModel("openai-codex", "gpt-5.5");
    const registry = fakeRegistry({ models: [fallback] });

    expect(resolveReviewerModel({ registry, spec: null, fallback })).toEqual({
      model: fallback,
      source: "fallback",
    });
    expect(resolveReviewerModel({ registry, spec: " ", fallback })).toEqual({
      model: fallback,
      source: "fallback",
    });
    expect(
      resolveReviewerModel({
        registry: fakeRegistry({ models: [] }),
        spec: null,
        fallback: undefined,
      }),
    ).toEqual({
      model: undefined,
      source: "none",
      note: "no model configured",
    });
  });

  it("formats resolved model identities for display", () => {
    expect(formatReviewerModel(undefined)).toBe("none configured");
    expect(formatReviewerModel(fakeModel("openai-codex", "gpt-5.3"))).toBe(
      "openai-codex/gpt-5.3",
    );
  });

  it("identifies high-cost reviewer model ids case-insensitively by model-id portion", () => {
    expect(HIGH_COST_REVIEWER_MODEL_PATTERNS).toEqual([
      "gpt-5.5",
      "claude-opus-4-8",
      "glm-5.2",
      "kimi-k2.7-code",
    ]);
    expect(isHighCostReviewerModel("gpt-5.5")).toBe(true);
    expect(isHighCostReviewerModel("openai-codex/gpt-5.5")).toBe(true);
    expect(isHighCostReviewerModel("zai/GLM-5.2-preview")).toBe(true);
    expect(isHighCostReviewerModel("gpt-5.3-codex-spark")).toBe(false);
  });
});

function fakeRegistry(options: {
  readonly models: readonly Model<Api>[];
  readonly authed?: readonly Model<Api>[];
}): ReviewerModelRegistry {
  const authed = new Set(options.authed ?? options.models);
  return {
    find(provider, modelId) {
      return options.models.find(
        (model) => model.provider === provider && model.id === modelId,
      );
    },
    getAll: () => options.models,
    hasConfiguredAuth: (model) => authed.has(model),
  };
}

function fakeModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: `${provider}/${id}`,
    api: "openai-responses",
    provider,
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}
