import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  STYLE_COMMAND,
  STYLE_DEFAULT_MESSAGE_TYPE,
  STYLE_LISTING_MESSAGE_TYPE,
  formatStyleDefaultListing,
  formatStyleDefaultNotify,
  formatStyleListing,
  parseStyleDefaultArgs,
  registerStyleCommand,
} from "../src/style-command.js";
import {
  applyStyleFromConfig,
  resetConfigForTesting,
  setConfigPathsForTesting,
} from "../src/config.js";
import {
  getActiveStyle,
  getEffectiveStyleSelectionSource,
  listAvailableStyles,
  resetStyleForTesting,
  resolveActiveStylePlan,
  setActiveStyle,
} from "../src/style.js";
import { getActiveMode, resetResolverForTesting, setActiveMode } from "../src/resolver.js";
import { resetFooterForTesting } from "../src/footer.js";
import { getChangeSignal, resetCacheForTesting } from "../src/cache.js";
import { handleBeforeAgentStart, resetHandlerForTesting } from "../src/handler.js";
import { makeContext, makeEvent, makeModel, makePi, makeUi } from "./harness.js";

let tmp: string | undefined;

function fixture(): { cwd: string; globalPath: string; projectPath: string } {
  tmp = mkdtempSync(join(tmpdir(), "style-command-"));
  const cwd = join(tmp, "project");
  const globalPath = join(tmp, "global.json");
  const projectPath = join(cwd, ".pi", "pi-model-modes.json");
  setConfigPathsForTesting({ global: globalPath, project: projectPath });
  return { cwd, globalPath, projectPath };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function command() {
  const { pi, calls } = makePi();
  registerStyleCommand(pi);
  const registration = calls.find(
    (call) => call.method === "registerCommand" && call.args[0] === STYLE_COMMAND,
  );
  if (!registration) throw new Error("style command was not registered");
  return {
    calls,
    handler: (registration.args[1] as {
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    }).handler,
  };
}

function context(cwd: string) {
  const ui = makeUi();
  return {
    ui,
    ctx: makeContext({ cwd, hasUI: true, ui }) as ExtensionCommandContext,
  };
}

beforeEach(() => {
  resetConfigForTesting();
  resetStyleForTesting();
  resetResolverForTesting();
  resetFooterForTesting();
  resetCacheForTesting();
  resetHandlerForTesting();
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  resetConfigForTesting();
  resetStyleForTesting();
  resetResolverForTesting();
  resetFooterForTesting();
  resetCacheForTesting();
  resetHandlerForTesting();
});

describe("style default grammar", () => {
  it("supports display, set, none, clear, and position-flexible global scope", () => {
    expect(parseStyleDefaultArgs("")).toEqual({ kind: "display" });
    expect(parseStyleDefaultArgs("clear")).toEqual({ kind: "set", value: "clear", scope: "project" });
    expect(parseStyleDefaultArgs("none")).toEqual({ kind: "set", value: "none", scope: "project" });
    expect(parseStyleDefaultArgs("off --global")).toEqual({ kind: "clear", scope: "global" });
    expect(parseStyleDefaultArgs("--global compact")).toEqual({ kind: "set", value: "compact", scope: "global" });
  });

  it.each([
    ["--global", /no <name\|none\|off>/],
    ["--global --global clear", /repeated flag/],
    ["--Global clear", /unknown \/style default flag/],
    ["clear extra", /unexpected extra tokens/],
  ])("rejects malformed `%s` precisely", (args, error) => {
    const result = parseStyleDefaultArgs(args);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toMatch(error);
  });
});

describe("style panel formatters", () => {
  it("shows independent selection and fragment provenance", () => {
    const plan = {
      name: "team",
      fragmentSource: "custom-project" as const,
      selectionSource: "override" as const,
      content: "TEAM",
      signature: "hash",
    };
    expect(formatStyleListing(plan, [
      { name: "clear", fragmentSource: "bundled" },
      { name: "team", fragmentSource: "custom-project" },
    ])).toBe([
      "Effective style: team (override)",
      "  fragment: custom, project",
      "Available styles:",
      "  - clear (bundled)",
      "  - team (custom, project)",
    ].join("\n"));
  });

  it("omits fragment lines for none/unset and renders failures without hiding the catalog", () => {
    expect(formatStyleListing({ error: "vanished" }, [
      { name: "clear", fragmentSource: "bundled" },
    ])).toContain("Effective style: (unresolvable — vanished)\nAvailable styles:\n  - clear");
    expect(formatStyleListing({
      name: undefined,
      fragmentSource: "none",
      selectionSource: "project",
      content: "",
      signature: "",
    }, [])).not.toContain("fragment:");
  });

  it("formats durable scopes and masking notifications truthfully", () => {
    expect(formatStyleDefaultListing("clear", "none", { value: "none", source: "project" }))
      .toContain("Effective default: none (project)");
    expect(formatStyleDefaultNotify({
      writtenScope: "global",
      writtenValue: "compact",
      effective: { value: "clear", source: "project" },
      activeOverride: "expressive",
    })).toBe(
      'style default set to "compact" (global) — override "expressive" still active; project default "clear" would still win after /style off',
    );
  });
});

describe("/style command", () => {
  it("registers one command and no other Pi seam", () => {
    const { pi, calls } = makePi();
    registerStyleCommand(pi);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("registerCommand");
    expect(calls[0].args[0]).toBe(STYLE_COMMAND);
  });

  it("no arg emits a display-only status/catalog panel", async () => {
    const { cwd } = fixture();
    const { calls, handler } = command();
    const { ctx } = context(cwd);
    await handler("", ctx);

    const send = calls.find((call) => call.method === "sendMessage")!;
    const [message, options] = send.args as [{ customType: string; content: string; display: boolean }, unknown];
    expect(message.customType).toBe(STYLE_LISTING_MESSAGE_TYPE);
    expect(message.display).toBe(true);
    expect(message.content).toContain("Effective style: unset");
    expect(message.content).toContain("  - clear (bundled)");
    expect(options).toBeUndefined();
  });

  it("sets none or a bundled session override, clears it, and never changes mode/footer", async () => {
    const { cwd, projectPath } = fixture();
    writeJson(projectPath, { writingStyle: "compact" });
    applyStyleFromConfig(cwd);
    setActiveMode("none");
    const { handler } = command();
    const { ctx, ui } = context(cwd);

    await handler("clear", ctx);
    expect(getActiveStyle()).toBe("clear");
    expect(resolveActiveStylePlan().selectionSource).toBe("override");
    await handler("none", ctx);
    expect(resolveActiveStylePlan().fragmentSource).toBe("none");
    await handler("off", ctx);
    expect(getActiveStyle()).toBeUndefined();
    expect(resolveActiveStylePlan()).toMatchObject({ name: "compact", selectionSource: "project" });
    expect(ui.notifyCalls.at(-1)?.message).toBe("style override cleared — effective style compact (project)");
    expect(getActiveMode()).toBe("none");
    expect(ui.statusCalls).toEqual([]);
  });

  it("a command-selected override changes the next assembled prompt and cache reason", async () => {
    const { cwd } = fixture();
    const model = makeModel({ name: "GLM-5.2", provider: "zai" });
    const base = "BASE";
    handleBeforeAgentStart(makeEvent(base), makeContext({ model }));
    const { handler } = command();
    await handler("clear", context(cwd).ctx);

    const result = handleBeforeAgentStart(makeEvent(base), makeContext({ model }));
    expect(result.systemPrompt).toContain("# Clear");
    expect(result.systemPrompt.endsWith(base)).toBe(true);
    expect(getChangeSignal().lastEntry?.reason).toBe("style-switched");
  });

  it("unknown or malformed input preserves the prior override", async () => {
    const { cwd, projectPath, globalPath } = fixture();
    const { handler } = command();
    const { ctx, ui } = context(cwd);
    setActiveStyle("clear");

    await handler("ghost", ctx);
    await handler("default --global --global compact", ctx);

    expect(getActiveStyle()).toBe("clear");
    expect(ui.notifyCalls.map((call) => call.type)).toEqual(["error", "error"]);
    expect(existsSync(projectPath)).toBe(false);
    expect(existsSync(globalPath)).toBe(false);
  });

  it("bare default is display-only and names all durable tiers", async () => {
    const { cwd, globalPath, projectPath } = fixture();
    writeJson(globalPath, { writingStyle: "clear" });
    writeJson(projectPath, { writingStyle: "none" });
    applyStyleFromConfig(cwd);
    const { calls, handler } = command();
    const { ctx } = context(cwd);

    await handler("default", ctx);

    const send = calls.find((call) => call.method === "sendMessage")!;
    const [message, options] = send.args as [{ customType: string; content: string; display: boolean }, unknown];
    expect(message.customType).toBe(STYLE_DEFAULT_MESSAGE_TYPE);
    expect(message.content).toContain("global:  clear");
    expect(message.content).toContain("project: none");
    expect(message.content).toContain("Effective default: none (project)");
    expect(options).toBeUndefined();
  });

  it("default none persists suppression; default off removes only the selected scope key", async () => {
    const { cwd, globalPath, projectPath } = fixture();
    writeJson(globalPath, { writingStyle: "clear", custom: 1 });
    writeJson(projectPath, { defaultMode: "none" });
    const { handler } = command();
    const { ctx } = context(cwd);

    await handler("default none", ctx);
    expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({ defaultMode: "none", writingStyle: "none" });
    expect(resolveActiveStylePlan()).toMatchObject({ fragmentSource: "none", selectionSource: "project" });

    await handler("default off", ctx);
    expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({ defaultMode: "none" });
    expect(resolveActiveStylePlan()).toMatchObject({ name: "clear", selectionSource: "global" });
    expect(JSON.parse(readFileSync(globalPath, "utf8"))).toEqual({ writingStyle: "clear", custom: 1 });
  });

  it("a durable write preserves an active override and reports masking", async () => {
    const { cwd } = fixture();
    const { handler } = command();
    const { ctx, ui } = context(cwd);
    setActiveStyle("expressive");

    await handler("default compact", ctx);

    expect(getEffectiveStyleSelectionSource()).toBe("override");
    expect(resolveActiveStylePlan().name).toBe("expressive");
    expect(ui.notifyCalls.at(-1)?.message).toBe(
      'style default set to "compact" (project) — override "expressive" still active; /style off to use it now',
    );
  });

  it("strict config failures leave file and effective state unchanged", async () => {
    const { cwd, projectPath } = fixture();
    mkdirSync(dirname(projectPath), { recursive: true });
    writeFileSync(projectPath, "{ broken", "utf8");
    setActiveStyle("clear");
    const { handler } = command();
    const { ctx, ui } = context(cwd);

    await handler("default compact", ctx);

    expect(readFileSync(projectPath, "utf8")).toBe("{ broken");
    expect(getActiveStyle()).toBe("clear");
    expect(ui.notifyCalls.at(-1)?.type).toBe("error");
  });

  it("clear of an absent key is write-free", async () => {
    const { cwd, projectPath } = fixture();
    const { handler } = command();
    const { ctx, ui } = context(cwd);
    await handler("default off", ctx);
    expect(existsSync(projectPath)).toBe(false);
    expect(ui.notifyCalls).toEqual([{ message: "no style default set in project", type: "info" }]);
  });

  it("catalog reflects a registered custom style with fragment provenance", async () => {
    const { cwd, projectPath } = fixture();
    const stylesDir = dirname(projectPath);
    mkdirSync(join(stylesDir, "styles"), { recursive: true });
    writeFileSync(join(stylesDir, "styles", "team.md"), "TEAM", "utf8");
    writeJson(projectPath, {
      writingStyle: "team",
      customStyles: { team: "styles/team.md" },
    });
    applyStyleFromConfig(cwd);
    expect(listAvailableStyles()).toContainEqual({ name: "team", fragmentSource: "custom-project" });

    const { calls, handler } = command();
    await handler("", context(cwd).ctx);
    const message = calls.find((call) => call.method === "sendMessage")!.args[0] as { content: string };
    expect(message.content).toContain("Effective style: team (project)");
    expect(message.content).toContain("fragment: custom, project");
  });
});
