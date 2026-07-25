import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../extensions/index.js";
import { handleBeforeAgentStart } from "../src/handler.js";
import { MODE_COMMAND, MODE_INSPECT_COMMAND } from "../src/commands.js";
import { STYLE_COMMAND } from "../src/style-command.js";
import { resetStyleForTesting } from "../src/style.js";
import {
  MODE_FOOTER_KEY,
  refreshModeFooter,
  resetFooterForTesting,
} from "../src/footer.js";
import { CYCLE_BACKWARD_KEY, CYCLE_FORWARD_KEY } from "../src/keybinding.js";
import { resetConfigForTesting, setConfigPathsForTesting } from "../src/config.js";
import { resetResolverForTesting } from "../src/resolver.js";
import { makeContext, makePi, makeUi } from "./harness.js";

/**
 * Registration wiring — the factory registers the `before_agent_start` handler
 * exactly once, by reference (the same function object the unit tests import),
 * the `session_start` config-seed + autocomplete handlers once each, and the
 * `/mode:inspect` command once.
 * Proves the "single registration surface" property from ARCHITECTURE.md: the
 * factory wires the handler, the session-start handlers, and the command, and
 * nothing more.
 */
let dir: string | undefined;

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "registration-"));
  dir = d;
  return d;
}

function writeJson(path: string, obj: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(obj), "utf8");
}

function setGlobalConfig(obj: unknown): void {
  const d = freshDir();
  const global = join(d, "global.json");
  writeJson(global, obj);
  setConfigPathsForTesting({ global, project: join(d, "project.json") });
}

function setMissingConfig(): void {
  const d = freshDir();
  setConfigPathsForTesting({
    global: join(d, "global.json"),
    project: join(d, "project.json"),
  });
}

function renderedFooterText(): string | undefined {
  const ui = makeUi();
  const ctx = makeContext({
    hasUI: true,
    ui,
  } as unknown as Partial<ExtensionContext>);
  refreshModeFooter(ctx);
  expect(ui.statusCalls[0]?.key).toBe(MODE_FOOTER_KEY);
  return ui.statusCalls[0]?.text;
}

describe("factory registration wiring", () => {
  beforeEach(() => {
    resetConfigForTesting();
    resetFooterForTesting();
    resetResolverForTesting();
    resetStyleForTesting();
    setMissingConfig();
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    resetConfigForTesting();
    resetFooterForTesting();
    resetResolverForTesting();
    resetStyleForTesting();
    vi.restoreAllMocks();
  });

  it("registers the transform before_agent_start by reference exactly once plus one footer refresh handler", () => {
    const { pi, calls } = makePi();
    factory(pi);

    const registrations = calls.filter(
      (c) => c.method === "on" && c.args[0] === "before_agent_start",
    );
    expect(registrations).toHaveLength(2);

    const transformRegistrations = registrations.filter(
      (call) => call.args[1] === handleBeforeAgentStart,
    );
    expect(transformRegistrations).toHaveLength(1);
    expect(transformRegistrations[0].args[0]).toBe("before_agent_start");
    // Registered by reference: the registered handler IS the same function
    // object the unit tests import (not an inline arrow).
    expect(transformRegistrations[0].args[1]).toBe(handleBeforeAgentStart);

    const footerRegistrations = registrations.filter(
      (call) => call.args[1] !== handleBeforeAgentStart,
    );
    expect(footerRegistrations).toHaveLength(1);
    expect(typeof footerRegistrations[0].args[1]).toBe("function");
  });

  it("registers the session_start handlers exactly once each", () => {
    const { pi, calls } = makePi();
    factory(pi);

    const registrations = calls.filter(
      (c) => c.method === "on" && c.args[0] === "session_start",
    );
    expect(registrations).toHaveLength(3);
    for (const registration of registrations) {
      expect(typeof registration.args[1]).toBe("function");
    }
  });

  it("registers the /mode + /mode:inspect + /style commands and nothing unexpected", () => {
    const { pi, calls } = makePi();
    factory(pi);

    const commands = calls
      .filter((c) => c.method === "registerCommand")
      .map((c) => c.args[0])
      .sort();
    expect(commands).toEqual([MODE_COMMAND, MODE_INSPECT_COMMAND, STYLE_COMMAND].sort());

    // The only `on` registrations are two before_agent_start handlers
    // (transform + footer refresh) and three session_start handlers
    // (mode autocomplete + style autocomplete + config seed/footer refresh).
    const events = calls
      .filter((c) => c.method === "on")
      .map((c) => c.args[0])
      .sort();
    expect(events).toEqual([
      "before_agent_start",
      "before_agent_start",
      "session_start",
      "session_start",
      "session_start",
    ]);

    // Nothing beyond the `on` registrations and the three commands (no automatic
    // shortcuts, tools, flags, renderers, providers, no emit at registration).
    const unexpected = calls.filter(
      (c) =>
        c.method !== "on" &&
        c.method !== "registerCommand",
    );
    expect(unexpected).toHaveLength(0);
  });

  it("defaults to no mode-cycle shortcuts and no footer cycle hint", () => {
    const { pi, calls } = makePi();
    factory(pi);

    const shortcuts = calls.filter((c) => c.method === "registerShortcut");
    expect(shortcuts).toHaveLength(0);
    expect(renderedFooterText()).toBe("mode: ◆ unset");
  });

  it("registers both cycle shortcuts and enables the footer hint when globally enabled", () => {
    setGlobalConfig({ cycleKeybinding: true });
    const { pi, calls } = makePi();
    factory(pi);

    const shortcuts = calls.filter((c) => c.method === "registerShortcut");
    expect(shortcuts).toHaveLength(2);
    expect(shortcuts.map((c) => c.args[0]).sort()).toEqual(
      [CYCLE_BACKWARD_KEY, CYCLE_FORWARD_KEY].sort(),
    );
    expect(
      shortcuts.filter((c) => c.args[0] === CYCLE_FORWARD_KEY),
    ).toHaveLength(1);
    expect(
      shortcuts.filter((c) => c.args[0] === CYCLE_BACKWARD_KEY),
    ).toHaveLength(1);
    expect(renderedFooterText()).toBe(
      `mode: ◆ unset · ${CYCLE_FORWARD_KEY}/${CYCLE_BACKWARD_KEY} cycle`,
    );
  });

  it.each([false, "yes"] as const)(
    "does not register shortcuts or enable the hint for cycleKeybinding=%s",
    (cycleKeybinding) => {
      if (cycleKeybinding !== false) {
        vi.spyOn(console, "warn").mockImplementation(() => {});
      }
      setGlobalConfig({ cycleKeybinding });
      const { pi, calls } = makePi();
      factory(pi);

      const shortcuts = calls.filter((c) => c.method === "registerShortcut");
      expect(shortcuts).toHaveLength(0);
      expect(renderedFooterText()).toBe("mode: ◆ unset");
    },
  );
});
