import { describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";

import { createDistillerModelClient, type ModelInvoker } from "../src/provider.js";

const model = {
  provider: "openai-codex",
  id: "gpt-6-astra",
  name: "Astra",
  api: "openai-codex-responses",
  baseUrl: "https://example.test",
  reasoning: true,
  thinkingLevelMap: { off: null, minimal: "low" },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
} as Model<Api>;

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text: "memory" }], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...overrides,
  };
}

describe("distiller model client", () => {
  it("resolves fresh auth and sends headers, cancellation, output budget, and Pi-mapped reasoning on every request", async () => {
    const auth = vi.fn()
      .mockResolvedValueOnce({ ok: true, apiKey: "first", headers: { "x-auth": "one" } })
      .mockResolvedValueOnce({ ok: true, apiKey: "second", headers: { "x-auth": "two" } });
    const sentOptions: Array<{ apiKey?: string; maxTokens?: number; headers?: unknown; signal?: AbortSignal; reasoning?: string }> = [];
    const invoke: ModelInvoker = async (_provider, _model, _context, options) => {
      sentOptions.push(options);
      return assistant();
    };
    const registry = { find: () => model, getProvider: () => ({}) as Provider, getApiKeyAndHeaders: auth };
    const client = createDistillerModelClient(registry, "openai-codex/gpt-6-astra", "minimal", invoke);
    const signal = new AbortController().signal;

    await client.call("one", signal, 321);
    await client.call("two", signal, 654);

    expect(auth).toHaveBeenCalledTimes(2);
    expect(sentOptions[0]).toMatchObject({ apiKey: "first", headers: { "x-auth": "one" }, signal, maxTokens: 321, reasoning: "minimal" });
    expect(sentOptions[1]).toMatchObject({ apiKey: "second", headers: { "x-auth": "two" }, maxTokens: 654 });
    expect(client.status()).toMatchObject({ requestedReasoning: "minimal", effectiveReasoning: "low", resolvedModel: "openai-codex/gpt-6-astra" });
  });

  it("reports when an unsupported off request is clamped and mapped", async () => {
    const sent: any[] = [];
    const client = createDistillerModelClient({
      find: () => model,
      getProvider: () => ({}) as Provider,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key" }),
    }, "openai-codex/gpt-6-astra", "off", async (_provider, _model, _context, options) => {
      sent.push(options);
      return assistant();
    });
    await client.call("x", new AbortController().signal, 10);
    expect(client.status().effectiveReasoning).toBe("low");
    expect(sent[0].reasoning).toBe("minimal");
  });

  it("rejects missing auth and non-success terminal results", async () => {
    const unavailable = createDistillerModelClient({
      find: () => model,
      getProvider: () => ({}) as Provider,
      getApiKeyAndHeaders: async () => ({ ok: false as const, error: "login required" }),
    }, "openai-codex/gpt-6-astra", "minimal", async () => assistant());
    await expect(unavailable.call("x", new AbortController().signal, 10)).rejects.toThrow("login required");

    const truncated = createDistillerModelClient({
      find: () => model,
      getProvider: () => ({}) as Provider,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "key" }),
    }, "openai-codex/gpt-6-astra", "minimal", async () => assistant({ stopReason: "length" }));
    await expect(truncated.call("x", new AbortController().signal, 10)).rejects.toThrow("ended with length");
  });
});
