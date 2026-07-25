import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BeforeAgentStartEvent,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import factory from "../extensions/index.js";
import { handleBeforeAgentStart } from "../src/handler.js";
import {
  MODE_COMMAND,
  registerModeCommand,
} from "../src/commands.js";
import { MODE_FOOTER_KEY, resetFooterForTesting } from "../src/footer.js";
import {
  CYCLE_FORWARD_KEY,
  registerModeKeybindings,
} from "../src/keybinding.js";
import {
  getActiveMode,
  resetResolverForTesting,
  setDefaultMode,
} from "../src/resolver.js";
import {
  resetConfigForTesting,
  setConfigPathsForTesting,
} from "../src/config.js";
import { resetCacheForTesting } from "../src/cache.js";
import {
  resetFragmentsForTesting,
} from "../src/fragments.js";
import { resetPresetsForTesting } from "../src/presets.js";
import { makeContext, makeEvent, makeModel, makePi, makeUi } from "./harness.js";

let tmp: string | undefined;

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "footer-wiring-"));
  tmp = dir;
  return dir;
}

function writeJson(path: string, obj: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(obj), "utf8");
}

function getModeHandler(): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  const { pi, calls } = makePi();
  registerModeCommand(pi);
  const reg = calls.find(
    (call) => call.method === "registerCommand" && call.args[0] === MODE_COMMAND,
  );
  if (!reg) {
    throw new Error("registerModeCommand did not register /mode");
  }
  return (reg.args[1] as {
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  }).handler;
}

function getForwardShortcut(): (ctx: ExtensionContext) => Promise<void> {
  const { pi, calls } = makePi();
  registerModeKeybindings(pi);
  const reg = calls.find(
    (call) => call.method === "registerShortcut" && call.args[0] === CYCLE_FORWARD_KEY,
  );
  if (!reg) {
    throw new Error("registerModeKeybindings did not register forward shortcut");
  }
  return (reg.args[1] as {
    handler: (ctx: ExtensionContext) => Promise<void>;
  }).handler;
}

function getFooterBeforeAgentStartHandler(): (
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
) => unknown {
  const { pi, calls } = makePi();
  factory(pi);
  const registrations = calls.filter(
    (call) => call.method === "on" && call.args[0] === "before_agent_start",
  );
  const footerRegistration = registrations.find(
    (call) => call.args[1] !== handleBeforeAgentStart,
  );
  if (!footerRegistration) {
    throw new Error("factory did not register a footer before_agent_start handler");
  }
  return footerRegistration.args[1] as (
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
  ) => unknown;
}

function getConfigSessionStartHandler(): (
  event: SessionStartEvent,
  ctx: ExtensionContext,
) => void {
  const { pi, calls } = makePi();
  factory(pi);
  const registrations = calls.filter(
    (call) => call.method === "on" && call.args[0] === "session_start",
  );
  const handler = registrations.at(-1)?.args[1];
  if (typeof handler !== "function") {
    throw new Error("factory did not register config session_start handler");
  }
  return handler as (event: SessionStartEvent, ctx: ExtensionContext) => void;
}

function makeFooterCtx(): { ctx: ExtensionContext; ui: ReturnType<typeof makeUi> } {
  const ui = makeUi();
  const ctx = makeContext({
    hasUI: true,
    cwd: "/test",
    model: makeModel({ name: "GLM-4.6", provider: "zai" }),
    ui,
  } as unknown as Partial<ExtensionContext>);
  return { ctx, ui };
}

describe("footer refresh wiring", () => {
  beforeEach(() => {
    resetResolverForTesting();
    resetFooterForTesting();
    resetCacheForTesting();
    resetConfigForTesting();
    resetFragmentsForTesting();
    resetPresetsForTesting();
  });

  afterEach(() => {
    if (tmp) {
      rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
    resetResolverForTesting();
    resetFooterForTesting();
    resetCacheForTesting();
    resetConfigForTesting();
    resetFragmentsForTesting();
    resetPresetsForTesting();
  });

  it("refreshes immediately after /mode <preset> succeeds", async () => {
    const handler = getModeHandler();
    const { ctx, ui } = makeFooterCtx();

    await handler("safe", ctx as ExtensionCommandContext);

    expect(getActiveMode()).toBe("safe");
    expect(ui.statusCalls).toContainEqual({
      key: MODE_FOOTER_KEY,
      text: "mode: ◆ safe",
    });
    expect(ui.notifyCalls).toEqual([
      { message: 'mode set to "safe"', type: "info" },
    ]);
  });

  it("refreshes immediately after /mode off reflects the default fallback", async () => {
    setDefaultMode("safe");
    const handler = getModeHandler();
    const { ctx, ui } = makeFooterCtx();

    await handler("create", ctx as ExtensionCommandContext);
    await handler("off", ctx as ExtensionCommandContext);

    expect(getActiveMode()).toBeUndefined();
    expect(ui.statusCalls.at(-1)).toEqual({
      key: MODE_FOOTER_KEY,
      text: "mode: ◆ safe",
    });
  });

  it("does not refresh for /mode display-only listing or an unknown preset", async () => {
    const handler = getModeHandler();
    const { ctx, ui } = makeFooterCtx();

    await handler("", ctx as ExtensionCommandContext);
    await handler("does-not-exist", ctx as ExtensionCommandContext);

    expect(ui.statusCalls).toHaveLength(0);
    expect(ui.notifyCalls.at(-1)?.type).toBe("error");
    expect(ui.notifyCalls.at(-1)?.message).toContain(
      'unknown preset "does-not-exist"',
    );
  });

  it("refreshes immediately after a cycle keypress reflects the next preset", async () => {
    const forward = getForwardShortcut();
    const { ctx, ui } = makeFooterCtx();

    await forward(ctx);

    expect(getActiveMode()).toBe("create");
    expect(ui.statusCalls.at(-1)).toEqual({
      key: MODE_FOOTER_KEY,
      text: "mode: ◆ create",
    });
  });

  it("refreshes on session_start after config reseeding", () => {
    const dir = freshDir();
    const global = join(dir, "global.json");
    const project = join(dir, "project.json");
    writeJson(project, { defaultMode: "safe" });
    setConfigPathsForTesting({ global, project });
    const handler = getConfigSessionStartHandler();
    const { ctx, ui } = makeFooterCtx();

    handler({ type: "session_start", reason: "startup" }, ctx);

    expect(ui.statusCalls).toEqual([
      { key: MODE_FOOTER_KEY, text: "mode: ◆ safe" },
    ]);
  });

  it("refreshes on before_agent_start as an idempotent per-turn safety net", () => {
    const handler = getFooterBeforeAgentStartHandler();
    const { ctx, ui } = makeFooterCtx();
    const event = makeEvent("base prompt");

    const r1 = handler(event, ctx);
    const r2 = handler(event, ctx);

    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    expect(ui.statusCalls).toEqual([
      { key: MODE_FOOTER_KEY, text: "mode: ◆ unset" },
      { key: MODE_FOOTER_KEY, text: "mode: ◆ unset" },
    ]);
  });
});
