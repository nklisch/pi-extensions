import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import extension from "../src/index.js";

interface RegisteredTool {
  name: string;
  execute: (...args: unknown[]) => Promise<unknown>;
}
interface RegisteredCommand {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

let agentDir: string;

function fakePi() {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let activeTools = ["read", "bash", "write"];
  const pi = {
    registerTool: (def: RegisteredTool) => tools.set(def.name, def),
    registerCommand: (name: string, def: RegisteredCommand) => commands.set(name, def),
    on: (event: string, handler: (e: unknown, c: unknown) => unknown) => events.set(event, handler),
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      activeTools = [...names];
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, commands, events, getActiveTools: () => activeTools };
}

function fakeCtx(model: { provider: string; id: string }) {
  return {
    model,
    cwd: "/home/nathan/dev/proj",
    ui: { notify: vi.fn() },
    modelRegistry: { find: () => null, getProvider: () => null },
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

describe("extension factory", () => {
  it("registers pocket tools, the /pocket command, and lifecycle events", () => {
    const { pi, tools, commands, events } = fakePi();
    extension(pi);
    expect([...tools.keys()].sort()).toEqual(["pocket_note", "pocket_recall"]);
    expect(commands.has("pocket")).toBe(true);
    for (const event of ["session_start", "model_select", "before_agent_start"]) {
      expect(events.has(event)).toBe(true);
    }
  });

  it("activates tools and injects guidance only for astra sessions", () => {
    const { pi, tools, events, getActiveTools } = fakePi();
    extension(pi);
    const astraCtx = fakeCtx({ provider: "openai-codex", id: "gpt-6-astra" });
    events.get("session_start")!({}, astraCtx);
    expect(getActiveTools()).toEqual(expect.arrayContaining(["pocket_note", "pocket_recall"]));

    const injected = events.get("before_agent_start")!(
      { systemPrompt: "BASE" },
      astraCtx,
    ) as { systemPrompt: string };
    expect(injected.systemPrompt).toContain("BASE");
    expect(injected.systemPrompt).toContain("Astral Pocket");

    // Switching away deactivates tools and stops injection.
    const terraCtx = fakeCtx({ provider: "openai-codex", id: "gpt-5.6-terra" });
    events.get("model_select")!({}, terraCtx);
    expect(getActiveTools()).not.toContain("pocket_note");
    expect(events.get("before_agent_start")!({ systemPrompt: "BASE" }, terraCtx)).toBeUndefined();
  });

  it("/pocket off persists and deactivates; /pocket on re-enables", async () => {
    const { pi, commands, events, getActiveTools } = fakePi();
    extension(pi);
    const astraCtx = fakeCtx({ provider: "openai-codex", id: "gpt-6-astra" });
    events.get("session_start")!({}, astraCtx);
    expect(getActiveTools()).toContain("pocket_note");

    await commands.get("pocket")!.handler("off", astraCtx);
    expect(getActiveTools()).not.toContain("pocket_note");

    await commands.get("pocket")!.handler("on", astraCtx);
    expect(getActiveTools()).toContain("pocket_note");
  });

  it("tool execute throws the inactive guard outside astra sessions", async () => {
    const { pi, tools, events } = fakePi();
    extension(pi);
    const terraCtx = fakeCtx({ provider: "openai-codex", id: "gpt-5.6-terra" });
    events.get("session_start")!({}, terraCtx);
    const note = tools.get("pocket_note")!;
    await expect(
      note.execute("t1", { title: "x", body: "y" }, undefined, undefined, terraCtx),
    ).rejects.toThrow("only active in gpt-6-astra");
  });
});
