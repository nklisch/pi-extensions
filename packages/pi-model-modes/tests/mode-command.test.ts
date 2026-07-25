import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import factory from "../extensions/index.js";
import {
  MODE_COMMAND,
  MODE_LISTING_MESSAGE_TYPE,
  registerModeCommand,
} from "../src/commands.js";
import { MODE_FOOTER_KEY } from "../src/footer.js";
import {
  getActiveMode,
  getEffectiveModeSource,
  setDefaultMode,
  resetResolverForTesting,
} from "../src/resolver.js";
import {
  setFragmentRootForTesting,
  resetFragmentsForTesting,
} from "../src/fragments.js";
import { resetPresetsForTesting } from "../src/presets.js";
import { resetCacheForTesting } from "../src/cache.js";
import {
  setConfigPathsForTesting,
  resetConfigForTesting,
  loadPluginConfig,
} from "../src/config.js";
import { makePi, makeContext, makeModel, makeUi } from "./harness.js";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Tests for the `/mode` command family (`registerModeCommand`). The handler is
 * extracted from the recording pi stub and driven with a fixture prompts tree
 * (covering the real `safe` preset's fragments) + the real bundled presets.json,
 * plus a stub ctx that captures `ctx.ui.notify` calls. Covers: no-arg listing,
 * `<preset>` sets the override, `off` reverts to default, unknown preset errors.
 */

let tmp: string | undefined;

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mode-command-"));
  tmp = root;
  setFragmentRootForTesting(root);
  return root;
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** Build a fixture covering the `safe` + `extend` presets' fragments so those
 *  real presets resolve through the loader. */
function buildFixture(): string {
  const root = freshRoot();
  write(root, "axis/agency/autonomous.md", "AGENCY-autonomous");
  write(root, "axis/agency/collaborative.md", "AGENCY-collaborative");
  write(root, "axis/quality/pragmatic.md", "QUALITY-pragmatic");
  write(root, "axis/quality/minimal.md", "QUALITY-minimal");
  write(root, "axis/scope/adjacent.md", "SCOPE-adjacent");
  write(root, "axis/scope/narrow.md", "SCOPE-narrow");
  write(root, "base.json", JSON.stringify({ overlays: [] }));
  return root;
}

/** Extract the `/mode` command handler from a fresh recording pi. */
function getModeHandler(): {
  pi: ExtensionAPI;
  calls: ReturnType<typeof makePi>["calls"];
  handler: (
    args: string,
    ctx: ExtensionCommandContext,
  ) => Promise<void>;
} {
  const { pi, calls } = makePi();
  registerModeCommand(pi);
  const reg = calls.find(
    (c) => c.method === "registerCommand" && c.args[0] === MODE_COMMAND,
  );
  if (!reg) {
    throw new Error("registerModeCommand did not register a 'mode' command");
  }
  const options = reg.args[1] as {
    handler: (a: string, c: ExtensionCommandContext) => Promise<void>;
  };
  return { pi, calls, handler: options.handler };
}

type NotifyCall = { message: string; type?: string };

/** A ctx stub that records `ctx.ui.notify` calls + carries a model. */
function makeNotifyCtx(opts: { cwd?: string } = {}): {
  ctx: ExtensionCommandContext;
  notifies: NotifyCall[];
} {
  const ui = makeUi();
  const ctx = makeContext({
    model: makeModel({ name: "claude-sonnet-4-5", provider: "anthropic" }),
    hasUI: true,
    ui,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  } as unknown as Partial<ExtensionCommandContext>) as ExtensionCommandContext;
  return { ctx, notifies: ui.notifyCalls };
}

beforeEach(() => {
  resetResolverForTesting();
  resetFragmentsForTesting();
  resetPresetsForTesting();
  resetCacheForTesting();
  resetConfigForTesting();
});

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
  resetResolverForTesting();
  resetFragmentsForTesting();
  resetPresetsForTesting();
  resetCacheForTesting();
  resetConfigForTesting();
});

describe("/mode command registration", () => {
  it("the factory registers a 'mode' command with a handler", () => {
    const { pi, calls } = makePi();
    factory(pi);
    const reg = calls.find(
      (c) => c.method === "registerCommand" && c.args[0] === MODE_COMMAND,
    );
    expect(reg).toBeDefined();
    expect(typeof (reg!.args[1] as { handler: unknown }).handler).toBe(
      "function",
    );
  });
});

describe("/mode (no arg) — listing", () => {
  it("emits a display-only listing with the effective state + a real preset", async () => {
    buildFixture();
    const { calls, handler } = getModeHandler();
    const { ctx } = makeNotifyCtx();

    await handler("", ctx);

    const sent = calls.find((c) => c.method === "sendMessage");
    expect(sent).toBeDefined();
    const msg = sent!.args[0] as {
      customType: string;
      content: string;
      display: boolean;
    };
    expect(msg.customType).toBe(MODE_LISTING_MESSAGE_TYPE);
    expect(msg.display).toBe(true);
    // Unset effective state + a real bundled preset name appears in the listing.
    expect(msg.content).toContain("Effective mode: unset");
    expect(msg.content).toContain("Available presets:");
    expect(msg.content).toContain("safe");
  });


  it("shows the default tier + spec name when a default is set", async () => {
    buildFixture();
    setDefaultMode("safe");
    const { calls, handler } = getModeHandler();
    const { ctx } = makeNotifyCtx();

    await handler("", ctx);

    const sent = calls.find((c) => c.method === "sendMessage");
    const msg = sent!.args[0] as { content: string };
    expect(msg.content).toContain("safe (default)");
    expect(msg.content).toContain("agency:collaborative");
  });
});

describe("/mode <preset> — set override", () => {
  it("sets the override; getActiveMode reflects it; notifies success", async () => {
    buildFixture();
    const { handler } = getModeHandler();
    const { ctx, notifies } = makeNotifyCtx();

    await handler("safe", ctx);

    expect(getActiveMode()).toBe("safe");
    expect(getEffectiveModeSource()).toBe("override");
    expect(notifies).toEqual([{ message: 'mode set to "safe"', type: "info" }]);
  });

  it("sets the virtual none override without requiring fragments", async () => {
    buildFixture();
    const { handler } = getModeHandler();
    const { ctx, notifies } = makeNotifyCtx();

    await handler("none", ctx);

    expect(getActiveMode()).toBe("none");
    expect(getEffectiveModeSource()).toBe("override");
    expect(notifies).toEqual([{ message: 'mode set to "none"', type: "info" }]);
  });
});

describe("/mode off — clear override", () => {
  it("clears the override; effective falls back to the default", async () => {
    buildFixture();
    setDefaultMode("safe");
    const { handler } = getModeHandler();
    const { ctx, notifies } = makeNotifyCtx();

    // First set an override, then clear it.
    await handler("safe", ctx);
    expect(getEffectiveModeSource()).toBe("override");

    await handler("off", ctx);
    expect(getActiveMode()).toBeUndefined();
    expect(getEffectiveModeSource()).toBe("default");
    expect(notifies.at(-1)?.message).toContain("safe");
    expect(notifies.at(-1)?.type).toBe("info");
  });

  it("with no default, off reverts to unset", async () => {
    buildFixture();
    const { handler } = getModeHandler();
    const { ctx, notifies } = makeNotifyCtx();

    await handler("safe", ctx);
    await handler("off", ctx);
    expect(getEffectiveModeSource()).toBe("unset");
    expect(notifies.at(-1)?.message).toContain("unset");
  });
});

describe("/mode <unknown> — graceful error", () => {
  it("notifies an error and leaves the prior override intact", async () => {
    buildFixture();
    const { handler } = getModeHandler();
    const { ctx, notifies } = makeNotifyCtx();

    // Establish a valid override first.
    await handler("safe", ctx);
    expect(getActiveMode()).toBe("safe");

    await handler("does-not-exist", ctx);

    // The prior override is intact.
    expect(getActiveMode()).toBe("safe");
    const last = notifies.at(-1)!;
    expect(last.type).toBe("error");
    expect(last.message).toMatch(/unknown preset "does-not-exist"/);
  });
});

describe("/mode default [...] — durable default subcommand", () => {
  /** Per-test temp dir for the writer; both config paths point inside it so
   *  tests never touch the real home dir. `cwd` is the synthetic project root. */
  function setupDirs(): {
    cwd: string;
    globalPath: string;
    projectPath: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "mode-default-"));
    tmp = dir; // afterEach cleans up
    const cwd = join(dir, "cwd");
    const globalPath = join(dir, "global.json");
    const projectPath = join(cwd, ".pi", "pi-model-modes.json");
    setConfigPathsForTesting({ global: globalPath, project: projectPath });
    return { cwd, globalPath, projectPath };
  }

  it("bare `/mode default` emits the 3-line display panel (display-only)", async () => {
    buildFixture();
    const { cwd } = setupDirs();
    const { calls, handler } = getModeHandler();
    const { ctx } = makeNotifyCtx({ cwd });

    await handler("default", ctx);

    const send = calls.find((c) => c.method === "sendMessage");
    expect(send).toBeDefined();
    const msg = send!.args[0] as { content: string; display: boolean };
    expect(msg.display).toBe(true);
    expect(msg.content).toContain("Default mode (durable config):");
    expect(msg.content).toContain("global:  (unset)");
    expect(msg.content).toContain("project: (unset)");
    expect(msg.content).toContain("Effective default: (unset)");
  });

  it("`/mode default extend` writes the PROJECT config + reseeds + notifies", async () => {
    buildFixture();
    const { cwd, projectPath, globalPath } = setupDirs();
    const { handler } = getModeHandler();
    const { ctx, notifies } = makeNotifyCtx({ cwd });

    await handler("default extend", ctx);

    expect(loadPluginConfig(cwd).defaultMode).toBe("extend");
    expect(existsSync(projectPath)).toBe(true);
    expect(existsSync(globalPath)).toBe(false); // global untouched
    expect(notifies.at(-1)?.type).toBe("info");
    expect(notifies.at(-1)?.message).toBe(
      'default set to "extend" (project); effective mode is now "extend" (default)',
    );
  });

  it("`/mode default extend --global` writes the GLOBAL config", async () => {
    buildFixture();
    const { cwd, projectPath, globalPath } = setupDirs();
    const { handler } = getModeHandler();
    const { ctx } = makeNotifyCtx({ cwd });

    await handler("default extend --global", ctx);

    expect(existsSync(globalPath)).toBe(true);
    expect(existsSync(projectPath)).toBe(false);
    expect(loadPluginConfig(cwd).defaultMode).toBe("extend");
  });

  it("`--global` is position-flexible (before the action)", async () => {
    buildFixture();
    const { cwd, globalPath } = setupDirs();
    const { handler } = getModeHandler();
    const { ctx } = makeNotifyCtx({ cwd });

    await handler("default --global extend", ctx);

    expect(existsSync(globalPath)).toBe(true);
    expect(loadPluginConfig(cwd).defaultMode).toBe("extend");
  });

  it("`/mode default off` clears the PROJECT key", async () => {
    buildFixture();
    const { cwd, projectPath } = setupDirs();
    mkdirSync(dirname(projectPath), { recursive: true });
    writeFileSync(
      projectPath,
      JSON.stringify({ cycleKeybinding: true, defaultMode: "extend" }),
    );
    const { handler } = getModeHandler();
    const { ctx, notifies } = makeNotifyCtx({ cwd });

    await handler("default off", ctx);

    const reloaded = loadPluginConfig(cwd) as Record<string, unknown>;
    expect("defaultMode" in reloaded).toBe(false);
    expect(reloaded.cycleKeybinding).toBe(true); // sibling preserved
    expect(notifies.at(-1)?.message).toBe(
      "default cleared (project); effective default is (unset)",
    );
  });

  it("CLEAR-WHEN-EMPTY blocker: `/mode default off` on missing project target writes nothing and only notifies no-op", async () => {
    buildFixture();
    const { cwd, projectPath } = setupDirs();
    const { handler } = getModeHandler();
    const ui = makeUi();
    const ctx = makeContext({
      cwd,
      hasUI: true,
      ui,
      model: makeModel({ name: "x", provider: "y" }),
    } as unknown as Partial<ExtensionCommandContext>) as ExtensionCommandContext;

    await handler("default off", ctx);

    expect(existsSync(projectPath)).toBe(false);
    expect(existsSync(dirname(projectPath))).toBe(false);
    expect(ui.notifyCalls).toEqual([
      { message: "no default set in project", type: "info" },
    ]);
    expect(ui.statusCalls).toHaveLength(0); // no footer refresh on noop
  });

  it("noop project clear mentions a surviving global default", async () => {
    buildFixture();
    const { cwd, projectPath, globalPath } = setupDirs();
    mkdirSync(dirname(globalPath), { recursive: true });
    writeFileSync(globalPath, JSON.stringify({ defaultMode: "extend" }));
    const { handler } = getModeHandler();
    const { ctx, notifies } = makeNotifyCtx({ cwd });

    await handler("default off", ctx);

    expect(existsSync(projectPath)).toBe(false);
    expect(notifies.at(-1)).toEqual({
      message: 'no default set in project; effective default remains "extend" (global)',
      type: "info",
    });
  });

  it("CLEAR-WHEN-EMPTY blocker: `/mode default off --global` on missing global target writes nothing", async () => {
    buildFixture();
    const { cwd, globalPath } = setupDirs();
    const { handler } = getModeHandler();
    const { ctx, notifies } = makeNotifyCtx({ cwd });

    await handler("default off --global", ctx);

    expect(existsSync(globalPath)).toBe(false);
    expect(notifies.at(-1)).toEqual({
      message: "no default set in global",
      type: "info",
    });
  });

  it("CLEAR-WHEN-EMPTY blocker: existing sibling-only target is byte-stable and no footer refresh", async () => {
    buildFixture();
    const { cwd, projectPath } = setupDirs();
    mkdirSync(dirname(projectPath), { recursive: true });
    const original = `${JSON.stringify({ cycleKeybinding: true }, null, 2)}\n`;
    writeFileSync(projectPath, original);
    const { handler } = getModeHandler();
    const ui = makeUi();
    const ctx = makeContext({
      cwd,
      hasUI: true,
      ui,
      model: makeModel({ name: "x", provider: "y" }),
    } as unknown as Partial<ExtensionCommandContext>) as ExtensionCommandContext;

    await handler("default off", ctx);

    expect(readFileSync(projectPath, "utf8")).toBe(original);
    expect(ui.notifyCalls).toEqual([
      { message: "no default set in project", type: "info" },
    ]);
    expect(ui.statusCalls).toHaveLength(0);
  });

  it("the OPUS BLOCKER: project `off` falls back to a surviving global default", async () => {
    buildFixture();
    const { cwd, projectPath, globalPath } = setupDirs();
    mkdirSync(dirname(globalPath), { recursive: true });
    writeFileSync(globalPath, JSON.stringify({ defaultMode: "extend" }));
    mkdirSync(dirname(projectPath), { recursive: true });
    writeFileSync(projectPath, JSON.stringify({ defaultMode: "extend" }));
    const { handler } = getModeHandler();
    const { ctx, notifies } = makeNotifyCtx({ cwd });

    await handler("default off", ctx);

    // Effective falls back to global (extend), not unset.
    expect(notifies.at(-1)?.message).toBe(
      'default cleared (project); effective default is now "extend" (global)',
    );
  });

  it("override-still-wins: setting a default under an active override notifies with the next step", async () => {
    buildFixture();
    const { cwd } = setupDirs();
    const { handler } = getModeHandler();
    const { ctx, notifies } = makeNotifyCtx({ cwd });

    // Establish an override first.
    await handler("safe", ctx);
    expect(getEffectiveModeSource()).toBe("override");

    await handler("default extend", ctx);

    // Override still active; notify points at /mode off.
    expect(getEffectiveModeSource()).toBe("override");
    expect(getActiveMode()).toBe("safe");
    expect(notifies.at(-1)?.message).toBe(
      'default set to "extend" (project) — override "safe" still active; /mode off to use it now',
    );
  });

  it("unknown preset → error toast; file NOT written", async () => {
    buildFixture();
    const { cwd, projectPath } = setupDirs();
    const { handler } = getModeHandler();
    const { ctx, notifies } = makeNotifyCtx({ cwd });

    await handler("default does-not-exist", ctx);

    expect(notifies.at(-1)?.type).toBe("error");
    expect(notifies.at(-1)?.message).toMatch(/unknown preset/);
    expect(existsSync(projectPath)).toBe(false);
  });

  it.each([
    ["default --global --global flow", /unexpected repeated flag/],
    ["default --global=true flow", /unknown \/mode default flag/],
    ["default --Global flow", /unknown \/mode default flag/],
    ["default flow extra", /unexpected extra tokens/],
    ["default --global", /given but no/],
  ])(
    "parser rejects `%s` with an error toast and writes nothing",
    async (arg, expectedError) => {
      buildFixture();
      const { cwd, projectPath, globalPath } = setupDirs();
      const { handler } = getModeHandler();
      const { ctx, notifies } = makeNotifyCtx({ cwd });

      await handler(arg, ctx);

      expect(notifies.at(-1)?.type).toBe("error");
      expect(notifies.at(-1)?.message).toMatch(expectedError);
      expect(existsSync(projectPath)).toBe(false);
      expect(existsSync(globalPath)).toBe(false);
    },
  );

  it("refreshes the footer after a successful write", async () => {
    buildFixture();
    const { cwd } = setupDirs();
    const { handler } = getModeHandler();
    // Wire a setStatus capture onto the ui.
    const ui = makeUi();
    const ctx = makeContext({
      cwd,
      hasUI: true,
      ui,
      model: makeModel({ name: "x", provider: "y" }),
    } as unknown as Partial<ExtensionCommandContext>) as ExtensionCommandContext;

    await handler("default extend", ctx);

    // Exactly one setStatus call for the footer refresh, with the newly
    // effective default rendered through the same footer seam users see.
    expect(ui.statusCalls).toEqual([
      { key: MODE_FOOTER_KEY, text: "mode: ◆ extend" },
    ]);
  });

  it("written file is 2-space indented + trailing newline", async () => {
    buildFixture();
    const { cwd, projectPath } = setupDirs();
    const { handler } = getModeHandler();
    const { ctx } = makeNotifyCtx({ cwd });

    await handler("default extend", ctx);

    const text = readFileSync(projectPath, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "defaultMode"');
  });

  it("`/mode default` (bare) does NOT trigger a turn", async () => {
    buildFixture();
    const { cwd } = setupDirs();
    const { calls, handler } = getModeHandler();
    const { ctx } = makeNotifyCtx({ cwd });

    await handler("default", ctx);

    const send = calls.find((c) => c.method === "sendMessage");
    const [, sendOpts] = send!.args as [
      { triggerTurn?: boolean },
      { triggerTurn?: boolean } | undefined,
    ];
    expect(sendOpts?.triggerTurn).toBeUndefined();
  });
});
