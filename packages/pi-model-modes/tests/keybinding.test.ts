import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  nextPresetName,
  registerModeKeybindings,
  CYCLE_FORWARD_KEY,
  CYCLE_BACKWARD_KEY,
} from "../src/keybinding.js";
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
import { makePi, makeContext, makeUi } from "./harness.js";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/**
 * Tests for the mode-cycle keybindings. Two halves: pure unit tests of
 * `nextPresetName` (forward/backward wrap, from-unset entry, empty list) and a
 * registration + handler test via `makePi` (two shortcuts registered with
 * handlers; the forward handler sets the override to the first preset from
 * unset). A temp prompts fixture + the real bundled presets back the handler.
 */

describe("nextPresetName (pure cycle math)", () => {
  const names = ["a", "b", "c"];

  it("forward steps and wraps", () => {
    expect(nextPresetName(names, "a", 1)).toBe("b");
    expect(nextPresetName(names, "b", 1)).toBe("c");
    expect(nextPresetName(names, "c", 1)).toBe("a"); // wrap
  });

  it("backward steps and wraps", () => {
    expect(nextPresetName(names, "c", -1)).toBe("b");
    expect(nextPresetName(names, "b", -1)).toBe("a");
    expect(nextPresetName(names, "a", -1)).toBe("c"); // wrap
  });

  it("from unset enters at the ends", () => {
    expect(nextPresetName(names, undefined, 1)).toBe("a");
    expect(nextPresetName(names, undefined, -1)).toBe("c");
  });

  it("from a non-preset current (indexOf -1) enters at the ends", () => {
    expect(nextPresetName(names, "not-a-preset", 1)).toBe("a");
    expect(nextPresetName(names, "not-a-preset", -1)).toBe("c");
  });

  it("empty list → undefined", () => {
    expect(nextPresetName([], undefined, 1)).toBeUndefined();
    expect(nextPresetName([], "a", -1)).toBeUndefined();
  });

  it("single-element list cycles to itself", () => {
    expect(nextPresetName(["only"], "only", 1)).toBe("only");
    expect(nextPresetName(["only"], "only", -1)).toBe("only");
    expect(nextPresetName(["only"], undefined, 1)).toBe("only");
  });
});

let tmp: string | undefined;

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "keybinding-"));
  tmp = root;
  setFragmentRootForTesting(root);
  return root;
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** Build a fixture covering EVERY fragment referenced by ANY bundled preset, so
 *  cycling onto any real preset (whichever the sorted list lands on) resolves
 *  through the loader. */
function buildFixture(): string {
  const root = freshRoot();
  // agency / quality / scope axes — the union across all bundled presets.
  for (const v of ["autonomous", "surgical", "collaborative", "partner"]) {
    write(root, `axis/agency/${v}.md`, `AGENCY-${v}`);
  }
  for (const v of ["pragmatic", "architect", "minimal"]) {
    write(root, `axis/quality/${v}.md`, `QUALITY-${v}`);
  }
  for (const v of ["adjacent", "unrestricted", "narrow"]) {
    write(root, `axis/scope/${v}.md`, `SCOPE-${v}`);
  }
  // modifiers — the union across all bundled presets.
  for (const v of [
    "bold",
    "muse",
    "readonly",
    "methodical",
    "debug",
    "flow",
    "playful",
    "director",
    "speak-plain",
    "tdd",
  ]) {
    write(root, `modifiers/${v}.md`, `MOD-${v}`);
  }
  // base overlays — the non-"pi" bases, registered in base.json.
  write(root, "base/flow.md", "BASE-flow");
  write(root, "base/chill.md", "BASE-chill");
  write(
    root,
    "base.json",
    JSON.stringify({ overlays: ["base/flow.md", "base/chill.md"] }),
  );
  return root;
}

type Recorded = ReturnType<typeof makePi>["calls"];

function getShortcutHandlers(): {
  calls: Recorded;
  forward: (ctx: ExtensionContext) => Promise<void>;
  backward: (ctx: ExtensionContext) => Promise<void>;
} {
  const { pi, calls } = makePi();
  registerModeKeybindings(pi as ExtensionAPI);
  const find = (key: string): ((ctx: ExtensionContext) => Promise<void>) => {
    const sc = calls.find(
      (c) => c.method === "registerShortcut" && c.args[0] === key,
    );
    if (!sc) {
      throw new Error(`no shortcut registered for ${key}`);
    }
    return (sc.args[1] as { handler: (ctx: ExtensionContext) => Promise<void> })
      .handler;
  };
  return {
    calls,
    forward: find(CYCLE_FORWARD_KEY),
    backward: find(CYCLE_BACKWARD_KEY),
  };
}

type NotifyCall = { message: string; type?: string };

function makeNotifyCtx(): { ctx: ExtensionContext; notifies: NotifyCall[] } {
  const ui = makeUi();
  const ctx = makeContext({
    hasUI: true,
    ui,
  } as unknown as Partial<ExtensionContext>);
  return { ctx, notifies: ui.notifyCalls };
}

describe("registerModeKeybindings", () => {
  beforeEach(() => {
    resetResolverForTesting();
    resetFragmentsForTesting();
    resetPresetsForTesting();
    resetCacheForTesting();
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
  });

  it("registers two shortcuts, each with a handler", () => {
    const { pi, calls } = makePi();
    registerModeKeybindings(pi as ExtensionAPI);
    const shortcuts = calls.filter((c) => c.method === "registerShortcut");
    expect(shortcuts).toHaveLength(2);
    expect(shortcuts.map((c) => c.args[0]).sort()).toEqual(
      [CYCLE_FORWARD_KEY, CYCLE_BACKWARD_KEY].sort(),
    );
    for (const sc of shortcuts) {
      expect(typeof (sc.args[1] as { handler: unknown }).handler).toBe(
        "function",
      );
    }
  });

  it("forward from unset sets the override to the first preset + notifies", async () => {
    buildFixture();
    const { forward } = getShortcutHandlers();
    const { ctx, notifies } = makeNotifyCtx();

    await forward(ctx);

    // The first sorted bundled preset name is the override now. Pin the actual
    // value so a wrap or catalog-order regression cannot substitute itself into
    // the expectation.
    expect(getActiveMode()).toBe("create");
    expect(getEffectiveModeSource()).toBe("override");
    expect(notifies).toHaveLength(1);
    expect(notifies[0].message).toBe("mode: ◆ create");
    expect(notifies[0].type).toBe("info");
  });

  it("backward from a default cycles relative to the effective mode", async () => {
    buildFixture();
    setDefaultMode("safe");
    const { backward } = getShortcutHandlers();
    const { ctx, notifies } = makeNotifyCtx();

    await backward(ctx);

    // Cycles backward RELATIVE TO the effective default "safe": in the sorted
    // catalog (…, "refactor", "safe", …), one step back is "refactor". An impl
    // that ignored the effective mode (treated it as unset) would land on the
    // LAST preset ("tinker") and fail this.
    expect(getActiveMode()).toBe("refactor");
    expect(getEffectiveModeSource()).toBe("override");
    expect(notifies.at(-1)?.message).toBe("mode: ◆ refactor");
  });
});
