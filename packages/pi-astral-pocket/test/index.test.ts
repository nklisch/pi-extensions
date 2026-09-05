import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import extension from "../src/index.js";
import { writeNote } from "../src/store.js";

interface RegisteredTool { name: string; execute: (...args: any[]) => Promise<any> }
interface RegisteredCommand { description: string; handler: (args: string, ctx: any) => Promise<void> }

let agentDir: string;

function fakePi() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const events = new Map<string, (event: any, ctx: any) => any>();
  let activeTools = ["read", "bash", "write"];
  const pi = {
    registerTool: (definition: RegisteredTool) => tools.set(definition.name, definition),
    registerCommand: (name: string, definition: RegisteredCommand) => commands.set(name, definition),
    on: (event: string, handler: (e: any, c: any) => any) => events.set(event, handler),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools = [...names]; },
  } as unknown as ExtensionAPI;
  return { pi, tools, commands, events, getActiveTools: () => activeTools };
}

function fakeCtx(model = { provider: "openai-codex", id: "gpt-6-astra" }, registry?: any) {
  return {
    model,
    cwd: "/home/nathan/dev/proj",
    ui: { notify: vi.fn() },
    modelRegistry: registry ?? { find: () => undefined, getProvider: () => undefined, getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }) },
  };
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pocket-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(agentDir, { recursive: true, force: true });
});

describe("extension lifecycle and commands", () => {
  it("registers tools, command, and shutdown-aware lifecycle events", () => {
    const { pi, tools, commands, events } = fakePi();
    extension(pi);
    expect([...tools.keys()].sort()).toEqual(["pocket_note", "pocket_recall"]);
    expect(commands.has("pocket")).toBe(true);
    for (const event of ["session_start", "model_select", "session_shutdown", "before_agent_start"]) expect(events.has(event)).toBe(true);
  });

  it("activates only for Astra and injects scoped historical-evidence guidance", () => {
    const { pi, events, getActiveTools } = fakePi();
    extension(pi);
    const astra = fakeCtx();
    events.get("session_start")!({}, astra);
    expect(getActiveTools()).toContain("pocket_note");
    const injected = events.get("before_agent_start")!({ systemPrompt: "BASE" }, astra);
    expect(injected.systemPrompt).toContain("historical evidence");
    expect(injected.systemPrompt).toContain("Current repository memory");

    const other = fakeCtx({ provider: "openai-codex", id: "gpt-5.6-terra" });
    events.get("model_select")!({}, other);
    expect(getActiveTools()).not.toContain("pocket_note");
    expect(events.get("before_agent_start")!({ systemPrompt: "BASE" }, other)).toBeUndefined();
  });

  it("caps recall at 20 results from each source", async () => {
    const { pi, tools, events } = fakePi();
    extension(pi);
    const ctx = fakeCtx();
    events.get("session_start")!({}, ctx);
    const root = join(agentDir, "astral-pocket");
    for (let i = 0; i < 25; i++) writeNote(root, { title: `bounded ${i}`, body: "recall-limit-signal", scope: "global" });
    const sessionDir = join(agentDir, "sessions", "--project--");
    mkdirSync(sessionDir, { recursive: true });
    const entries = [
      { type: "session", version: 3, id: "many", cwd: ctx.cwd },
      ...Array.from({ length: 25 }, (_, i) => ({
        type: "message", timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        message: { role: "assistant", provider: "openai-codex", model: "gpt-6-astra", content: [{ type: "text", text: `recall-limit-signal ${i}` }] },
      })),
    ];
    writeFileSync(join(sessionDir, "many.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    const result = await tools.get("pocket_recall")!.execute("r", { query: "recall-limit-signal", limit: 999 }, undefined, undefined, ctx);
    expect(result.content[0].text).toContain("Pocket notes (20)");
    expect(result.content[0].text).toContain("Past astra sessions (20)");
  });

  it("supports note scope and model/reasoning/distiller controls with truthful status", async () => {
    const { pi, tools, commands, events } = fakePi();
    extension(pi);
    const ctx = fakeCtx();
    events.get("session_start")!({}, ctx);
    await tools.get("pocket_note")!.execute("n", { title: "portable", body: "prefer concise", scope: "global" }, undefined, undefined, ctx);
    const noteFile = readFileSync(join(agentDir, "astral-pocket", "POCKET.md"), "utf8").match(/^- \[[^\]]+\]\(notes\/([^)]+)\)/m)![1];
    const note = readFileSync(join(agentDir, "astral-pocket", "notes", noteFile), "utf8");
    expect(note).toContain("scope: global");

    await commands.get("pocket")!.handler("model openai-codex/gpt-6-astra", ctx);
    await commands.get("pocket")!.handler("reasoning low", ctx);
    await commands.get("pocket")!.handler("distiller off", ctx);
    await commands.get("pocket")!.handler("status", ctx);
    const config = JSON.parse(readFileSync(join(agentDir, "astral-pocket", "config.json"), "utf8"));
    expect(config.distiller).toMatchObject({ model: "openai-codex/gpt-6-astra", reasoning: "low", enabled: false });
    expect(ctx.ui.notify.mock.calls.at(-1)?.[0]).toContain("Reasoning: low");
  });

  it("revokes and restarts work when a same-model session replaces the old session", async () => {
    const model = { provider: "openai-codex", id: "gpt-6-astra", name: "Astra", api: "x", baseUrl: "", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 1000 };
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const signals: AbortSignal[] = [];
    let calls = 0;
    const provider = { streamSimple: (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      calls += 1;
      if (calls === 1) {
        markFirstStarted();
        return { result: () => new Promise<any>((resolve) => { releaseFirst = () => resolve({ role: "assistant", content: [{ type: "text", text: "first" }], stopReason: "stop", usage: { totalTokens: 1 } }); }) };
      }
      markSecondStarted();
      return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "second" }], stopReason: "stop", usage: { totalTokens: 1 } }) };
    } };
    const registry = { find: () => model, getProvider: () => provider, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) };
    const { pi, events } = fakePi();
    extension(pi);
    writeNote(join(agentDir, "astral-pocket"), { title: "global", body: "portable", scope: "global" });
    const firstCtx = fakeCtx(undefined, registry);
    events.get("session_start")!({}, firstCtx);
    await firstStarted;

    const replacementCtx = fakeCtx(undefined, registry);
    events.get("session_start")!({}, replacementCtx);
    expect(signals[0]?.aborted).toBe(true);
    releaseFirst();
    await secondStarted;
    expect(calls).toBe(2);
  });

  it("revokes stale work when command reload sees an external distiller-only config change", async () => {
    const model = { provider: "openai-codex", id: "gpt-6-astra", name: "Astra", api: "x", baseUrl: "", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 1000 };
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let requestSignal!: AbortSignal;
    const provider = { streamSimple: (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => {
      requestSignal = options.signal;
      markStarted();
      return { result: () => new Promise(() => undefined) };
    } };
    const registry = { find: () => model, getProvider: () => provider, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) };
    const { pi, commands, events } = fakePi();
    extension(pi);
    writeNote(join(agentDir, "astral-pocket"), { title: "global", body: "portable", scope: "global" });
    const ctx = fakeCtx(undefined, registry);
    events.get("session_start")!({}, ctx);
    await started;

    const configPath = join(agentDir, "astral-pocket", "config.json");
    writeFileSync(configPath, JSON.stringify({ distiller: { maxSessionsPerPass: 3 } }));
    await commands.get("pocket")!.handler("status", ctx);
    expect(requestSignal.aborted).toBe(true);
  });

  it("aborts background work and never reports through a stale context after shutdown", async () => {
    const model = { provider: "openai-codex", id: "gpt-6-astra", name: "Astra", api: "x", baseUrl: "", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 1000 };
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const result = new Promise<any>((resolve) => { release = () => resolve({ role: "assistant", content: [{ type: "text", text: "digest" }], stopReason: "stop", usage: { totalTokens: 1 } }); });
    const provider = { streamSimple: () => { markStarted(); return { result: () => result }; } };
    const registry = { find: () => model, getProvider: () => provider, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }) };
    const { pi, events } = fakePi();
    extension(pi);
    writeNote(join(agentDir, "astral-pocket"), { title: "global", body: "portable", scope: "global" });
    const ctx = fakeCtx(undefined, registry);
    events.get("session_start")!({}, ctx);
    await started;
    events.get("session_shutdown")!({}, ctx);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
});
