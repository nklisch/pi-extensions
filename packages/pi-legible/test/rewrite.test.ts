import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { parseModelSpec, resolveRewriterModel, rewriteText, type RewriterModelRegistry } from "../src/rewrite.js";

function model(provider: string, id: string): Model<Api> {
  return { provider, id } as Model<Api>;
}

function registry(models: Model<Api>[], authed: (m: Model<Api>) => boolean): RewriterModelRegistry {
  return {
    find: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
    getAll: () => models,
    hasConfiguredAuth: authed,
    getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
  };
}

describe("parseModelSpec", () => {
  it("splits provider/modelId", () => {
    expect(parseModelSpec("openai/gpt-5.6")).toEqual({ provider: "openai", modelId: "gpt-5.6" });
  });

  it("accepts a bare model id", () => {
    expect(parseModelSpec("gpt-5.6")).toEqual({ modelId: "gpt-5.6" });
  });

  it("rejects empty and dangling specs", () => {
    expect(parseModelSpec("")).toBeUndefined();
    expect(parseModelSpec("openai/")).toBeUndefined();
  });
});

describe("resolveRewriterModel", () => {
  const models = [model("openai", "gpt-5.6"), model("zai", "glm-4.7")];

  it("resolves a configured provider/id with auth", () => {
    const outcome = resolveRewriterModel(registry(models, () => true), "zai/glm-4.7", undefined);
    expect(outcome).toMatchObject({ kind: "resolved" });
    expect(outcome.kind !== "unavailable" && outcome.model.id).toBe("glm-4.7");
  });

  it("resolves a bare id against any provider with auth", () => {
    const reg = registry(models, (m) => m.provider === "zai");
    const outcome = resolveRewriterModel(reg, "glm-4.7", undefined);
    expect(outcome.kind !== "unavailable" && outcome.model.provider).toBe("zai");
  });

  it("reports a configured spec without auth as unavailable — no silent session-model fallback", () => {
    const reg = registry(models, () => false);
    const outcome = resolveRewriterModel(reg, "openai/gpt-5.6", model("openai", "fallback"));
    expect(outcome.kind).toBe("unavailable");
    expect(outcome.kind === "unavailable" && outcome.error).toContain("openai/gpt-5.6");
  });

  it("reports an invalid spec as unavailable", () => {
    const outcome = resolveRewriterModel(registry(models, () => true), "openai/", undefined);
    expect(outcome.kind).toBe("unavailable");
  });

  it("falls back to the session model only when nothing is configured", () => {
    const fallback = model("openai", "session");
    const outcome = resolveRewriterModel(registry(models, () => true), undefined, fallback);
    expect(outcome).toEqual({ kind: "fallback", model: fallback });
  });
});

describe("rewriteText", () => {
  const models = [model("openai", "gpt-5.6")];
  const request = { rules: "be clear", contextTranscript: "User: hi", text: "dense prose" };

  function invokerReturning(text: string) {
    return async (_m: Model<Api>, _c: Context, _o: SimpleStreamOptions) => ({
      content: [{ type: "text", text }],
      stopReason: "stop",
    });
  }

  it("returns rewritten text on success", async () => {
    const result = await rewriteText(request, {
      registry: registry(models, () => true),
      spec: undefined,
      fallback: models[0],
      invoker: invokerReturning("clear prose"),
    });
    expect(result).toEqual({ ok: true, text: "clear prose" });
  });

  it("builds a prompt containing rules, transcript, and target text", async () => {
    let captured: Context | undefined;
    await rewriteText(request, {
      registry: registry(models, () => true),
      spec: undefined,
      fallback: models[0],
      invoker: async (_m, context) => {
        captured = context;
        return { content: [{ type: "text", text: "x" }], stopReason: "stop" };
      },
    });
    expect(captured?.systemPrompt).toContain("be clear");
    const userContent = captured?.messages[0]?.content;
    expect(userContent).toContain("User: hi");
    expect(userContent).toContain("dense prose");
  });

  it("omits the transcript section when empty", async () => {
    let captured: Context | undefined;
    await rewriteText({ ...request, contextTranscript: "" }, {
      registry: registry(models, () => true),
      spec: undefined,
      fallback: models[0],
      invoker: async (_m, context) => {
        captured = context;
        return { content: [{ type: "text", text: "x" }], stopReason: "stop" };
      },
    });
    expect(captured?.messages[0]?.content).not.toContain("Recent conversation");
  });

  it("fails cleanly with no model", async () => {
    const result = await rewriteText(request, { registry: registry([], () => false), spec: undefined, fallback: undefined });
    expect(result.ok).toBe(false);
  });

  it("fails cleanly when a configured spec cannot resolve instead of burning the session model", async () => {
    const result = await rewriteText(request, {
      registry: registry(models, () => false),
      spec: "openai/gpt-5.6",
      fallback: models[0],
    });
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain("openai/gpt-5.6");
  });

  it("passes a timeout-bounded signal to the invoker", async () => {
    let capturedSignal: AbortSignal | undefined;
    await rewriteText(request, {
      registry: registry(models, () => true),
      spec: undefined,
      fallback: models[0],
      timeoutMs: 50,
      invoker: async (_m, _c, options) => {
        capturedSignal = options.signal;
        return { content: [{ type: "text", text: "x" }], stopReason: "stop" };
      },
    });
    expect(capturedSignal).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("fails cleanly when auth is not configured", async () => {
    const reg: RewriterModelRegistry = {
      ...registry(models, () => true),
      getApiKeyAndHeaders: async () => ({ ok: false as const, error: "no key" }),
    };
    const result = await rewriteText(request, { registry: reg, spec: undefined, fallback: models[0] });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("no key");
  });

  it("fails cleanly when the invoker throws", async () => {
    const result = await rewriteText(request, {
      registry: registry(models, () => true),
      spec: undefined,
      fallback: models[0],
      invoker: async () => {
        throw new Error("network down");
      },
    });
    expect((result as { error: string }).error).toContain("network down");
  });

  it("fails cleanly on empty model output", async () => {
    const result = await rewriteText(request, {
      registry: registry(models, () => true),
      spec: undefined,
      fallback: models[0],
      invoker: invokerReturning("   "),
    });
    expect(result.ok).toBe(false);
  });
});
