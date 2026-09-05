import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

vi.mock("../src/rewrite.js", () => ({
  resolveRewriterModel: vi.fn(() => ({ kind: "fallback", model: { provider: "test", id: "rewriter" } })),
  rewriteText: vi.fn(async () => ({ ok: true, text: "REWRITTEN" })),
}));

vi.mock("../src/config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/config.js")>(),
  loadConfig: vi.fn(() => ({ enabled: true, model: undefined, contextDepth: 6, includeToolCalls: true })),
}));
vi.mock("../src/rules.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/rules.js")>(),
  loadRules: vi.fn(() => ({ text: "Fixture rules", source: undefined })),
}));

import extension from "../src/index.js";
import { rewriteText } from "../src/rewrite.js";

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
  it.each(["replacement", "shutdown", "abort"])("discards late rewrites after %s without leaking originals", async (boundary) => {
    const handlers = makeExtension();
    const controller = new AbortController();
    const ctx = {
      cwd: "/tmp/pi-legible-fixture",
      isProjectTrusted: () => false,
      modelRegistry: {},
      signal: controller.signal,
      ui: { setStatus: vi.fn(), notify: vi.fn() },
    };
    let finish!: (result: Awaited<ReturnType<typeof rewriteText>>) => void;
    vi.mocked(rewriteText).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const message = { role: "assistant", timestamp: 42, stopReason: "stop", content: [{ type: "text", text: "OLD ORIGINAL" }] };
    const pending = handlers.get("message_end")!({ message }, ctx);
    if (boundary === "replacement") await handlers.get("session_start")!({}, ctx);
    else if (boundary === "shutdown") await handlers.get("session_shutdown")!({}, ctx);
    else controller.abort();
    finish({ ok: true, text: "LATE REWRITE" });
    expect(await pending).toBeUndefined();
    const nextMessage = { ...message, content: [{ type: "text", text: "NEW SESSION TEXT" }] };
    await handlers.get("context")!({ messages: [nextMessage] }, ctx);
    expect(nextMessage.content[0]!.text).toBe("NEW SESSION TEXT");
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

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
