import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

vi.mock("../src/rewrite.js", () => ({
  resolveRewriterModel: vi.fn(() => ({ kind: "fallback", model: { provider: "test", id: "rewriter" } })),
  rewriteText: vi.fn(async () => ({ ok: true, text: "REWRITTEN" })),
}));

import extension from "../src/index.js";

type Handler = (...args: any[]) => Promise<unknown>;

function makeExtension(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  extension(pi);
  return handlers;
}

describe("pi-legible event integration", () => {
  it("keeps a successful rewrite when stale status cleanup throws", async () => {
    const handlers = makeExtension();
    const statuses: (string | undefined)[] = [];
    const ctx = {
      cwd: "/tmp/pi-legible-test",
      model: { provider: "openai", id: "session-model" },
      modelRegistry: {},
      signal: new AbortController().signal,
      ui: {
        setStatus(_key: string, text: string | undefined) {
          statuses.push(text);
          if (text === undefined) throw new Error("stale UI context");
        },
        notify() {},
      },
    };
    const message = {
      role: "assistant",
      timestamp: 1,
      stopReason: "stop",
      content: [{ type: "text", text: "ORIGINAL" }],
    };

    const result = await handlers.get("message_end")!({ message }, ctx);

    expect((result as { message: typeof message }).message.content).toEqual([
      { type: "text", text: "REWRITTEN" },
    ]);
    expect(statuses).toEqual(["✍ legible: rewriting…", undefined]);
  });
});
