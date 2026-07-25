import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  renderModeInspect,
  registerModeInspectCommand,
  MODE_INSPECT_COMMAND,
  MODE_INSPECT_MESSAGE_TYPE,
  parseModeDefaultArgs,
  formatDefaultListing,
  formatDefaultNotify,
  formatDefaultNoopNotify,
  formatFencedBlock,
} from "../src/commands.js";
import { deriveIdentityLine } from "../src/identity.js";
import {
  resetCacheForTesting,
  getChangeSignal,
  setCachedResult,
  getCachedResult,
  computeCacheKey,
} from "../src/cache.js";
import type { CacheKeyInputs, ChangeSignalEntry } from "../src/cache.js";
import type { ResolvedMode } from "../src/presets.js";
import {
  assembleForInspect,
  getLastBaseSystemPrompt,
  handleBeforeAgentStart,
  resetHandlerForTesting,
} from "../src/handler.js";
import { setActiveMode, resetResolverForTesting } from "../src/resolver.js";
import {
  resetFragmentsForTesting,
  setFragmentRootForTesting,
} from "../src/fragments.js";
import { makeContext, makeEvent, makeModel, makePi, makeUi } from "./harness.js";
import { configureStyleDefaults, resetStyleForTesting, setActiveStyle } from "../src/style.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RecordedCall } from "./harness.js";

/**
 * `/mode:inspect` — render core (byte-exact across reasons + edges) plus the
 * registration/emission seam (the first time `commands.ts` meets `cache.ts` +
 * `identity.ts` behind the live pi command surface).
 *
 * The change signal is module-scope stateful → reset before every test.
 */
describe("renderModeInspect — render core", () => {
  beforeEach(() => resetCacheForTesting());

  /** Populate the cache via one real handler turn (the production write path). */
  function runTurn(systemPrompt: string, model = makeModel({ name: "GLM-4.6", provider: "zai" })) {
    handleBeforeAgentStart(makeEvent(systemPrompt), makeContext({ model }));
  }

  it("renders the canonical panel shape after a model switch", () => {
    const glm45 = makeModel({ id: "glm-4.5", name: "GLM-4.5", provider: "zai" });
    const glm46 = makeModel({ id: "glm-4.6", name: "GLM-4.6", provider: "zai" });
    runTurn("base prompt", glm45); // turn 1 — initial
    runTurn("base prompt", glm46); // turn 2 — model-switched (id changed)

    const snap = getChangeSignal();
    expect(snap.lastEntry?.reason).toBe("model-switched");

    const out = renderModeInspect(snap, glm46, undefined);
    const lines = out.split("\n");
    expect(lines[0]).toBe("Mode: unset");
    expect(lines[1]).toBe("Style: (unset)");
    expect(lines[2]).toBe("Identity: You are GLM-4.6 from Zhipu AI.");
    expect(lines[3]).toBe(
      "Effective prompt last changed: this turn — reason: model switched",
    );
    expect(lines[4]).toBe("  (zai/glm-4.5 (GLM-4.5) → zai/glm-4.6 (GLM-4.6))");
    expect(lines[5]).toBe(`Cache key: ${snap.currentKey!.slice(0, 4)}...${snap.currentKey!.slice(-4)}`);
  });

  it("renders the initial population with NO parenthetical and no `undefined →`", () => {
    runTurn("base prompt");
    const snap = getChangeSignal();
    expect(snap.lastEntry?.reason).toBe("initial");

    const out = renderModeInspect(snap, makeModel({ name: "GLM-4.6", provider: "zai" }), undefined);
    expect(out).toContain(
      "Effective prompt last changed: this turn — reason: initial",
    );
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("→"); // no detail parenthetical on initial
  });

  it("renders an empty ring (no turn yet) as 'never' with no cache key", () => {
    const out = renderModeInspect(getChangeSignal(), makeModel({ name: "GLM-4.6", provider: "zai" }), undefined);
    expect(out).toContain(
      "Effective prompt last changed: never (no turn has run yet)",
    );
    expect(out).toContain("Cache key: (none)");
  });

  it("renders `Cache key: (none)` when currentKey is undefined", () => {
    const snap = { currentTurn: 0, currentKey: undefined, entries: [], lastEntry: undefined };
    expect(renderModeInspect(snap, makeModel({ name: "GLM-4.6", provider: "zai" }), undefined)).toContain(
      "Cache key: (none)",
    );
  });

  it("renders `Identity: (no model)` when the model is undefined", () => {
    runTurn("base prompt");
    expect(renderModeInspect(getChangeSignal(), undefined, undefined)).toContain(
      "Identity: (no model)",
    );
  });

  it("renders the literal deriveIdentityLine for the identity field", () => {
    runTurn("base prompt");
    const model = makeModel({ name: "Claude Opus", provider: "anthropic" });
    expect(renderModeInspect(getChangeSignal(), model, undefined)).toContain(
      `Identity: ${deriveIdentityLine(model)}`,
    );
  });

  describe("turn-offset wording", () => {
    /** Build a minimal snapshot with a single entry `ago` turns in the past. */
    function snapAgo(currentTurn: number, entryTurn: number) {
      const entry: ChangeSignalEntry = {
        turn: entryTurn,
        previousKey: undefined,
        newKey: "k",
        reason: "initial",
        detail: {
          modelName: { from: undefined, to: "name" },
          modelId: { from: undefined, to: "m" },
          modelProvider: { from: undefined, to: "p" },
          modeSignature: { from: undefined, to: "" },
          styleSignature: { from: undefined, to: "" },
          baseHash: { from: undefined, to: "h" },
        },
      };
      return { currentTurn, currentKey: "k", entries: [entry], lastEntry: entry };
    }
    const model = makeModel({ name: "GLM-4.6", provider: "zai" });

    it("'this turn' when the last change is this turn (ago 0)", () => {
      expect(renderModeInspect(snapAgo(3, 3), model, undefined)).toContain(
        "Effective prompt last changed: this turn — reason: initial",
      );
    });

    it("'1 turn ago' (singular) when ago is 1", () => {
      expect(renderModeInspect(snapAgo(4, 3), model, undefined)).toContain(
        "Effective prompt last changed: 1 turn ago — reason: initial",
      );
    });

    it("'N turns ago' (plural) when ago is greater than 1", () => {
      expect(renderModeInspect(snapAgo(7, 3), model, undefined)).toContain(
        "Effective prompt last changed: 4 turns ago — reason: initial",
      );
    });
  });

  describe("shortHex truncation (via the cache key field)", () => {
    const model = makeModel({ name: "GLM-4.6", provider: "zai" });

    it("truncates a 64-char hex key to first4...last4", () => {
      const key = "0123456789abcdef".repeat(4); // 64 chars
      const snap = { currentTurn: 1, currentKey: key, entries: [], lastEntry: undefined };
      expect(renderModeInspect(snap, model, undefined)).toContain("Cache key: 0123...cdef");
    });

    it("shows a short (<12 char) key whole", () => {
      const snap = { currentTurn: 1, currentKey: "abcdef", entries: [], lastEntry: undefined };
      expect(renderModeInspect(snap, model, undefined)).toContain("Cache key: abcdef");
    });
  });

  it("renders the base-changed detail as `(base <4>...<4> → <4>...<4>)`", () => {
    const model = makeModel({ id: "glm-4.6", name: "GLM-4.6", provider: "zai" });
    runTurn("base prompt A", model); // initial
    runTurn("base prompt B", model); // base-changed (same model/mode, new base)

    const snap = getChangeSignal();
    expect(snap.lastEntry?.reason).toBe("base-changed");

    const entry = snap.lastEntry!;
    const fromHash = entry.detail.baseHash.from!;
    const toHash = entry.detail.baseHash.to;
    const expected = `(base ${fromHash.slice(0, 4)}...${fromHash.slice(-4)} → ${toHash.slice(0, 4)}...${toHash.slice(-4)})`;

    const out = renderModeInspect(snap, model, undefined);
    expect(out).toContain("reason: base changed");
    expect(out).toContain(expected);
    expect(out).not.toContain("undefined");
  });

  it("renders the mode-switched detail as `(from → to)` with 'unset' for empty signatures", () => {
    // Direct write path: model/base constant, only the mode signature moves.
    const base: CacheKeyInputs = {
      modelName: "GLM-4.6",
      modelId: "glm-4.6",
      modelProvider: "zai",
      modeSignature: "",
      styleSignature: "",
      baseSystemPrompt: "base",
    };
    const k1 = computeCacheKey(base);
    getCachedResult(k1); // advance to turn 1
    setCachedResult(k1, "r1", base); // initial

    const switched: CacheKeyInputs = { ...base, modeSignature: "flow" };
    const k2 = computeCacheKey(switched);
    getCachedResult(k2); // advance to turn 2
    setCachedResult(k2, "r2", switched); // mode-switched

    const snap = getChangeSignal();
    expect(snap.lastEntry?.reason).toBe("mode-switched");
    expect(renderModeInspect(snap, makeModel({ name: "GLM-4.6", provider: "zai" }), undefined)).toContain(
      "(unset → flow)",
    );
  });

  it("renders the composed mode summary on the Mode line for a resolved mode", () => {
    const model = makeModel({ name: "GLM-4.6", provider: "zai" });
    const mode: ResolvedMode = {
      base: "chill",
      agency: "autonomous",
      quality: "pragmatic",
      scope: "adjacent",
      modifiers: ["flow", "tdd"],
    };
    const snap = { currentTurn: 1, currentKey: "abcdef", entries: [], lastEntry: undefined };
    const out = renderModeInspect(snap, model, mode);
    expect(out.split("\n")[0]).toBe(
      "Mode: base:chill • agency:autonomous • quality:pragmatic • scope:adjacent • +flow • +tdd",
    );
  });

  it.each([
    [{ name: undefined, fragmentSource: "unset", selectionSource: "unset", error: undefined } as const, "Style: (unset)"],
    [{ name: undefined, fragmentSource: "none", selectionSource: "override", error: undefined } as const, "Style: none (override)"],
    [{ name: "clear", fragmentSource: "bundled", selectionSource: "override", error: undefined } as const, "Style: clear (override; bundled)"],
    [{ name: "team", fragmentSource: "custom-global", selectionSource: "project", error: undefined } as const, "Style: team (project default; custom, global)"],
    [{ name: "team", fragmentSource: "custom-project", selectionSource: "global", error: undefined } as const, "Style: team (global default; custom, project)"],
    [{ name: undefined, fragmentSource: "unset", selectionSource: "unset", error: "vanished" } as const, "Style: (unresolvable — vanished)"],
  ])("renders style inspect state as %s", (styleInfo, expected) => {
    const out = renderModeInspect(getChangeSignal(), undefined, undefined, undefined, styleInfo);
    expect(out).toContain(expected);
  });

  it("renders a style-switched reason with style signature detail", () => {
    const base: CacheKeyInputs = {
      modelName: "GLM",
      modelId: "glm",
      modelProvider: "zai",
      modeSignature: "",
      styleSignature: "",
      baseSystemPrompt: "base",
    };
    const firstKey = computeCacheKey(base);
    getCachedResult(firstKey);
    setCachedResult(firstKey, "one", base);
    const next = { ...base, styleSignature: "a".repeat(64) };
    const nextKey = computeCacheKey(next);
    getCachedResult(nextKey);
    setCachedResult(nextKey, "two", next);
    const out = renderModeInspect(getChangeSignal(), undefined, undefined);
    expect(out).toContain("reason: style switched");
    expect(out).toContain("(style unset → aaaa...aaaa)");
  });

  it("renders `Mode: (unresolvable — …)` when modeError is set", () => {
    const model = makeModel({ name: "GLM-4.6", provider: "zai" });
    const snap = { currentTurn: 1, currentKey: "abcdef", entries: [], lastEntry: undefined };
    // modeError takes precedence over any mode value.
    const out = renderModeInspect(snap, model, undefined, 'mode agency "ghost" has no fragment file');
    expect(out.split("\n")[0]).toBe(
      'Mode: (unresolvable — mode agency "ghost" has no fragment file)',
    );
  });

  it("shortens 64-char mode signatures in the mode-switched detail", () => {
    // A mode-switched ring entry whose from/to are real 64-char hashes: the
    // rendered detail must be the shortened first4...last4 form, not the hash.
    const from = "a".repeat(60) + "1234"; // 64 chars, distinct tail
    const to = "b".repeat(60) + "5678"; // 64 chars, distinct tail
    const entry: ChangeSignalEntry = {
      turn: 2,
      previousKey: "k1",
      newKey: "k2",
      reason: "mode-switched",
      detail: {
        modelName: { from: "GLM-4.6", to: "GLM-4.6" },
        modelId: { from: "glm-4.6", to: "glm-4.6" },
        modelProvider: { from: "zai", to: "zai" },
        modeSignature: { from, to },
        styleSignature: { from: "", to: "" },
        baseHash: { from: "h", to: "h" },
      },
    };
    const snap = { currentTurn: 2, currentKey: "k2", entries: [entry], lastEntry: entry };
    const out = renderModeInspect(snap, makeModel({ name: "GLM-4.6", provider: "zai" }), undefined);
    expect(out).toContain("(aaaa...1234 → bbbb...5678)");
    expect(out).not.toContain(from); // the full hash never appears
    expect(out).not.toContain(to);
  });
});

describe("registerModeInspectCommand — registration + emission seam", () => {
  beforeEach(() => resetCacheForTesting());

  it("registers exactly one command named 'mode:inspect' with a description and handler", () => {
    const { pi, calls } = makePi();
    registerModeInspectCommand(pi);

    const commands = calls.filter((c) => c.method === "registerCommand");
    expect(commands).toHaveLength(1);
    const [name, options] = commands[0].args as [string, { description?: string; handler?: unknown }];
    expect(name).toBe("mode:inspect");
    expect(name).toBe(MODE_INSPECT_COMMAND);
    expect(typeof options.description).toBe("string");
    expect(options.description!.length).toBeGreaterThan(0);
    expect(typeof options.handler).toBe("function");
  });

  it("the handler reports a command-selected bundled style as an override", async () => {
    const { pi, calls } = makePi();
    registerModeInspectCommand(pi);
    const command = calls.find((c) => c.method === "registerCommand")!;
    const options = command.args[1] as {
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    };
    try {
      setActiveStyle("clear");
      await options.handler(
        "",
        makeContext({ model: makeModel({ name: "GLM-5.2", provider: "zai" }) }) as ExtensionCommandContext,
      );
      const send = calls.find((c: RecordedCall) => c.method === "sendMessage")!;
      expect((send.args[0] as { content: string }).content).toContain(
        "Style: clear (override; bundled)",
      );
    } finally {
      resetStyleForTesting();
    }
  });

  it("the handler resolves and renders a custom project style", async () => {
    const root = mkdtempSync(join(tmpdir(), "inspect-style-"));
    try {
      writeFileSync(join(root, "team.md"), "TEAM", "utf8");
      configureStyleDefaults({
        selection: "team",
        source: "project",
        registry: new Map([
          ["team", { rawRel: "team.md", configDir: root, scope: "project" }],
        ]),
      });
      const { pi, calls } = makePi();
      registerModeInspectCommand(pi);
      const command = calls.find((c) => c.method === "registerCommand")!;
      const options = command.args[1] as {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      };

      await options.handler(
        "",
        makeContext({
          model: makeModel({ name: "GLM-5.2", provider: "zai" }),
        }) as ExtensionCommandContext,
      );

      const send = calls.find((c: RecordedCall) => c.method === "sendMessage")!;
      const message = send.args[0] as { content: string };
      expect(message.content).toContain("Style: team (project default; custom, project)");
    } finally {
      resetStyleForTesting();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the handler reads the cache populated by the handler and emits a display-only message with no triggerTurn", async () => {
    const model = makeModel({ id: "glm-4.6", name: "GLM-4.6", provider: "zai" });

    // Seam: the handler populates the cache → inspect reads it.
    handleBeforeAgentStart(makeEvent("base prompt"), makeContext({ model }));
    const turnBefore = getChangeSignal().currentTurn;

    const { pi, calls } = makePi();
    registerModeInspectCommand(pi);
    const command = calls.find((c) => c.method === "registerCommand")!;
    const options = command.args[1] as {
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    };

    await options.handler("", makeContext({ model }) as ExtensionCommandContext);

    const sends = calls.filter((c: RecordedCall) => c.method === "sendMessage");
    expect(sends).toHaveLength(1);
    const [message, sendOptions] = sends[0].args as [
      { customType: string; content: string; display: boolean; triggerTurn?: boolean },
      { triggerTurn?: boolean } | undefined,
    ];
    expect(message.customType).toBe(MODE_INSPECT_MESSAGE_TYPE);
    expect(message.display).toBe(true);
    // Content carries the live identity line and the cache-key field.
    expect(message.content).toContain(deriveIdentityLine(model));
    expect(message.content).toContain("Cache key:");
    // Must NOT provoke a model turn: no triggerTurn — neither as a send option
    // nor smuggled into the message object.
    expect(sendOptions?.triggerTurn).toBeUndefined();
    expect("triggerTurn" in message).toBe(false);
    // Inspect is a pure read: invoking it must not advance the turn counter.
    expect(getChangeSignal().currentTurn).toBe(turnBefore);
  });
});

describe("formatFencedBlock", () => {
  it("uses a fence longer than any backtick run in the content", () => {
    const block = formatFencedBlock("before\n```ts\nconst x = 1;\n```\nafter");
    const lines = block.split("\n");
    expect(lines[0]).toBe("````");
    expect(lines.at(-1)).toBe("````");
  });

  it("uses a normal triple fence when the content has no longer run", () => {
    expect(formatFencedBlock("plain")).toBe("```\nplain\n```");
  });
});

describe("renderModeInspect — `--prompt` append block", () => {
  beforeEach(() => {
    resetCacheForTesting();
    resetResolverForTesting();
  });

  it("appends the assembled prompt under a `System prompt:` header in a fenced block", () => {
    const out = renderModeInspect(
      getChangeSignal(),
      undefined,
      undefined,
      undefined,
      undefined,
      "HELLO-BASE",
    );
    expect(out).toContain("System prompt:");
    expect(out).toContain("```\nHELLO-BASE\n```");
  });

  it("is unchanged byte-for-byte when assembledPrompt is undefined", () => {
    const bare = renderModeInspect(getChangeSignal(), undefined, undefined);
    const withUndefined = renderModeInspect(
      getChangeSignal(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(withUndefined).toBe(bare);
    expect(bare).not.toContain("System prompt:");
  });

  it("chooses a longer fence when the prompt itself contains triple backticks", () => {
    const out = renderModeInspect(
      getChangeSignal(),
      undefined,
      undefined,
      undefined,
      undefined,
      "prompt with ``` fence",
    );
    expect(out).toContain("````\nprompt with ``` fence\n````");
  });

  it("places a blank line between the bare panel and the prompt block", () => {
    const out = renderModeInspect(
      getChangeSignal(),
      undefined,
      undefined,
      undefined,
      undefined,
      "X",
    );
    const lines = out.split("\n");
    // …, "Cache key: …", "", "System prompt:", "```", "X", "```"
    const headerIdx = lines.indexOf("System prompt:");
    expect(headerIdx).toBeGreaterThan(0);
    expect(lines[headerIdx - 1]).toBe("");
  });
});

describe("assembleForInspect — single-source-of-truth splice", () => {
  beforeEach(() => {
    resetCacheForTesting();
    resetResolverForTesting();
    resetHandlerForTesting();
  });

  it("byte-identical to handleBeforeAgentStart output for the same model + base (mode-unset)", () => {
    const model = makeModel({ name: "GLM-5.2", provider: "zai" });
    const base = "pi's assembled base prompt";

    // Drive the live handler once on a fresh cache to capture its splice.
    const result = handleBeforeAgentStart(
      makeEvent(base),
      makeContext({ model }),
    );

    // The inspect path (resolving mode NOW, against the same base) must agree.
    expect(assembleForInspect(model, base)).toBe(result.systemPrompt);
    // And the handler memoized the base it just saw, so the inspect command
    // layer can read it without reaching into ctx.getSystemPrompt() (which would
    // return the SPLICED prompt and double-splice).
    expect(getLastBaseSystemPrompt()).toBe(base);
  });

  it("byte-identical to the live handler output when a mode is active", () => {
    // Set a real bundled preset so fragments resolve.
    setActiveMode("none"); // virtual no-mode override — still triggers the
    // mode-active branch (plan.mode !== undefined for `none`).
    const model = makeModel({ name: "GLM-5.2", provider: "zai" });
    const base = "pi's assembled base prompt";

    const result = handleBeforeAgentStart(
      makeEvent(base),
      makeContext({ model }),
    );

    expect(assembleForInspect(model, base)).toBe(result.systemPrompt);
  });

  it("falls back to the bare base when there is no model (no identity line)", () => {
    expect(assembleForInspect(undefined, "JUST-BASE")).toBe("JUST-BASE");
  });
});

describe("registerModeInspectCommand — `--prompt` flag handling", () => {
  let inspectBrokenRoot: string | undefined;

  const validPiMode: ResolvedMode = {
    base: "pi",
    agency: "autonomous",
    quality: "pragmatic",
    scope: "adjacent",
    modifiers: [],
  };

  function writeFragment(root: string, rel: string, content: string): void {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  function switchToBrokenFragmentRoot(): void {
    const root = mkdtempSync(join(tmpdir(), "inspect-broken-"));
    inspectBrokenRoot = root;
    // Keep the axis dir non-empty so resolve fails on the selected VALUE rather
    // than on missing fixture infrastructure.
    writeFragment(root, "axis/agency/other.md", "OTHER");
    writeFragment(root, "axis/quality/pragmatic.md", "QUALITY");
    writeFragment(root, "axis/scope/adjacent.md", "SCOPE");
    mkdirSync(join(root, "modifiers"), { recursive: true });
    writeFileSync(join(root, "base.json"), JSON.stringify({ overlays: [] }));
    resetFragmentsForTesting();
    setFragmentRootForTesting(root);
  }

  beforeEach(() => {
    resetCacheForTesting();
    resetResolverForTesting();
    resetHandlerForTesting();
    resetFragmentsForTesting();
  });

  afterEach(() => {
    resetFragmentsForTesting();
    if (inspectBrokenRoot) {
      rmSync(inspectBrokenRoot, { recursive: true, force: true });
      inspectBrokenRoot = undefined;
    }
  });

  function getHandler() {
    const { pi, calls } = makePi();
    registerModeInspectCommand(pi);
    const command = calls.find((c) => c.method === "registerCommand")!;
    return {
      calls,
      handler: (command.args[1] as {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      }).handler,
    };
  }

  function ctxWithNotify() {
    const ui = makeUi();
    const ctx = makeContext({
      model: makeModel({ name: "GLM-5.2", provider: "zai" }),
      ui,
    }) as ExtensionCommandContext;
    return { ctx, notifies: ui.notifyCalls };
  }

  it("`--prompt` emits the panel with the full assembled prompt in a fenced block", async () => {
    const model = makeModel({ name: "GLM-5.2", provider: "zai" });
    // Populate the base-prompt memo via one real handler turn.
    handleBeforeAgentStart(
      makeEvent("pi-base-content"),
      makeContext({ model }),
    );

    const { calls, handler } = getHandler();
    const { ctx } = ctxWithNotify();
    await handler("--prompt", ctx);

    const send = calls.find((c: RecordedCall) => c.method === "sendMessage")!;
    const msg = send.args[0] as { content: string; display: boolean };
    expect(msg.display).toBe(true);
    expect(msg.content).toContain("System prompt:");
    // The assembled bytes appear verbatim in the fenced block: identity line,
    // then pi-base-content (mode-unset → identity-only single-\n splice).
    expect(msg.content).toContain(
      `${deriveIdentityLine(model)}\npi-base-content`,
    );
  });

  it("`--prompt` with no turn having run emits an honest sentinel, not an empty block", async () => {
    // No handleBeforeAgentStart call → memo is empty.
    expect(getLastBaseSystemPrompt()).toBeUndefined();

    const { calls, handler } = getHandler();
    const { ctx } = ctxWithNotify();
    await handler("--prompt", ctx);

    const send = calls.find((c: RecordedCall) => c.method === "sendMessage")!;
    const msg = send.args[0] as { content: string };
    expect(msg.content).toContain(
      "(no turn has run yet — run a turn to populate the base prompt)",
    );
  });

  it("`--prompt` degrades to the diagnostic panel when the active mode no longer resolves", async () => {
    const model = makeModel({ name: "GLM-5.2", provider: "zai" });
    handleBeforeAgentStart(makeEvent("memoized-base"), makeContext({ model }));
    setActiveMode(validPiMode);
    switchToBrokenFragmentRoot();

    const { calls, handler } = getHandler();
    const { ctx, notifies } = ctxWithNotify();
    await handler("--prompt", ctx);

    expect(notifies).toEqual([]);
    const send = calls.find((c: RecordedCall) => c.method === "sendMessage")!;
    const msg = send.args[0] as { content: string };
    expect(msg.content).toContain(
      'Mode: (unresolvable — mode agency "autonomous" has no fragment file)',
    );
    expect(msg.content).toContain(
      '(could not assemble — mode agency "autonomous" has no fragment file)',
    );
  });

  it("`--prompt` keeps mode resolvable when only style assembly fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "inspect-broken-style-"));
    const stylePath = join(root, "team.md");
    writeFileSync(stylePath, "TEAM STYLE", "utf8");
    configureStyleDefaults({
      selection: "team",
      source: "project",
      registry: new Map([
        ["team", { rawRel: "team.md", configDir: root, scope: "project" }],
      ]),
    });

    try {
      const model = makeModel({ name: "GLM-5.2", provider: "zai" });
      handleBeforeAgentStart(makeEvent("memoized-base"), makeContext({ model }));
      rmSync(stylePath);

      const { calls, handler } = getHandler();
      const { ctx, notifies } = ctxWithNotify();
      await handler("--prompt", ctx);

      expect(notifies).toEqual([]);
      const send = calls.find((c: RecordedCall) => c.method === "sendMessage")!;
      const msg = send.args[0] as { content: string };
      expect(msg.content).toContain("Mode: unset");
      expect(msg.content).toContain("Style: (unresolvable — custom style file not found:");
      expect(msg.content).not.toContain("Mode: (unresolvable");
      // Inspect uses the handler's graceful style resolver for assembly, so the
      // diagnostic prompt remains available with only the broken style omitted.
      expect(msg.content).toContain(`${deriveIdentityLine(model)}\nmemoized-base`);
      expect(msg.content).not.toContain("TEAM STYLE");
      expect(msg.content).not.toContain("(could not assemble");
    } finally {
      resetStyleForTesting();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bare `/mode:inspect` (no flag) is byte-for-byte unchanged", async () => {
    const model = makeModel({ name: "GLM-5.2", provider: "zai" });
    handleBeforeAgentStart(makeEvent("base"), makeContext({ model }));

    const { calls, handler } = getHandler();
    const { ctx } = ctxWithNotify();
    await handler("", ctx);

    const send = calls.find((c: RecordedCall) => c.method === "sendMessage")!;
    const msg = send.args[0] as { content: string };
    expect(msg.content).not.toContain("System prompt:");
  });

  it.each([
    ["--verbose", `unknown /mode:inspect flag "--verbose" (only --prompt is supported)`],
    ["--prompt --prompt", `unexpected repeated flag "--prompt"`],
    ["extra", `unknown /mode:inspect flag "extra" (only --prompt is supported)`],
    ["--Prompt", `unknown /mode:inspect flag "--Prompt" (only --prompt is supported)`],
    ["--prompt=true", `unknown /mode:inspect flag "--prompt=true" (only --prompt is supported)`],
  ])(
    "rejects `%s` with an error toast and emits no message",
    async (arg, expectedError) => {
      const { calls, handler } = getHandler();
      const { ctx, notifies } = ctxWithNotify();
      await handler(arg, ctx);

      expect(notifies).toEqual([{ message: expectedError, type: "error" }]);
      expect(calls.filter((c: RecordedCall) => c.method === "sendMessage"))
        .toHaveLength(0);
    },
  );
});

describe("parseModeDefaultArgs — subcommand grammar", () => {
  it("bare → display", () => {
    expect(parseModeDefaultArgs("")).toEqual({ kind: "display" });
    expect(parseModeDefaultArgs("   ")).toEqual({ kind: "display" });
  });

  it("<preset> → set project", () => {
    expect(parseModeDefaultArgs("flow")).toEqual({
      kind: "set",
      value: "flow",
      scope: "project",
    });
  });

  it("none → set project (none is a real value, not an action keyword)", () => {
    expect(parseModeDefaultArgs("none")).toEqual({
      kind: "set",
      value: "none",
      scope: "project",
    });
  });

  it("off → clear project", () => {
    expect(parseModeDefaultArgs("off")).toEqual({
      kind: "clear",
      scope: "project",
    });
  });

  it("--global may appear before OR after the action", () => {
    expect(parseModeDefaultArgs("--global flow")).toEqual({
      kind: "set",
      value: "flow",
      scope: "global",
    });
    expect(parseModeDefaultArgs("flow --global")).toEqual({
      kind: "set",
      value: "flow",
      scope: "global",
    });
    expect(parseModeDefaultArgs("--global off")).toEqual({
      kind: "clear",
      scope: "global",
    });
  });

  it.each([
    ["--global --global flow", /unexpected repeated flag/],
    ["flow --global --global", /unexpected repeated flag/],
    ["--global=true flow", /unknown \/mode default flag/],
    ["--Global flow", /unknown \/mode default flag/],
    ["--verbose flow", /unknown \/mode default flag/],
    ["flow extra", /unexpected extra tokens after "flow"/],
    ["--global", /given but no/],
    ["flow off", /unexpected extra tokens after "flow"/],
  ])("rejects `%s` with parser error", (arg, expected) => {
    const result = parseModeDefaultArgs(arg);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toMatch(expected);
    }
  });
});

describe("formatDefaultListing — 3-line display panel", () => {
  it("renders both scopes + the effective default + source label", () => {
    const out = formatDefaultListing("flow", undefined, {
      value: "flow",
      source: "global",
    });
    const lines = out.split("\n");
    expect(lines).toEqual([
      "Default mode (durable config):",
      "  global:  flow",
      "  project: (unset)",
      "Effective default: flow (global)",
    ]);
  });

  it("shows (unset) for the effective line when no default in either scope", () => {
    const out = formatDefaultListing(undefined, undefined, {
      value: undefined,
      source: "unset",
    });
    expect(out).toContain("Effective default: (unset)");
  });

  it("surfaces (unreadable) for a malformed file rather than crashing", () => {
    const out = formatDefaultListing("(unreadable)", "safe", {
      value: "safe",
      source: "project",
    });
    expect(out).toContain("global:  (unreadable)");
  });

  it("includes the source label so global-vs-project merge is unambiguous", () => {
    const out = formatDefaultListing("flow", "safe", {
      value: "safe",
      source: "project",
    });
    expect(out).toContain("Effective default: safe (project)");
  });
});

describe("formatDefaultNotify — override-still-wins wording", () => {
  it("set + unmasked → effective is now the new default", () => {
    expect(
      formatDefaultNotify({
        writtenScope: "project",
        writtenValue: "extend",
        effective: { value: "extend", source: "project" },
        activeOverride: undefined,
      }),
    ).toBe(
      'default set to "extend" (project); effective mode is now "extend" (default)',
    );
  });

  it("set + override masks it → actionable dual-line wording", () => {
    expect(
      formatDefaultNotify({
        writtenScope: "project",
        writtenValue: "extend",
        effective: { value: "extend", source: "project" },
        activeOverride: "safe",
      }),
    ).toBe(
      'default set to "extend" (project) — override "safe" still active; /mode off to use it now',
    );
  });

  it("set + override + higher-precedence default avoids promising `/mode off` will use the write", () => {
    expect(
      formatDefaultNotify({
        writtenScope: "global",
        writtenValue: "flow",
        effective: { value: "extend", source: "project" },
        activeOverride: "safe",
      }),
    ).toBe(
      'default set to "flow" (global) — override "safe" still active; project default "extend" would still win after /mode off',
    );
  });

  it("set global while project default wins → names the winning scope and next step", () => {
    expect(
      formatDefaultNotify({
        writtenScope: "global",
        writtenValue: "flow",
        effective: { value: "extend", source: "project" },
        activeOverride: undefined,
      }),
    ).toBe(
      'default set to "flow" (global) — project default "extend" still wins; /mode default off to use it now',
    );
  });

  it("cleared + surviving default → falls back to global wording", () => {
    expect(
      formatDefaultNotify({
        writtenScope: "project",
        writtenValue: undefined,
        effective: { value: "flow", source: "global" },
        activeOverride: undefined,
      }),
    ).toBe(
      'default cleared (project); effective default is now "flow" (global)',
    );
  });

  it("cleared + active override → names both default state and masking override", () => {
    expect(
      formatDefaultNotify({
        writtenScope: "project",
        writtenValue: undefined,
        effective: { value: "flow", source: "global" },
        activeOverride: "safe",
      }),
    ).toBe(
      'default cleared (project); effective default is now "flow" (global) — override "safe" still active',
    );
  });

  it("cleared + no surviving default → unset wording", () => {
    expect(
      formatDefaultNotify({
        writtenScope: "project",
        writtenValue: undefined,
        effective: { value: undefined, source: "unset" },
        activeOverride: undefined,
      }),
    ).toBe("default cleared (project); effective default is (unset)");
  });
});

describe("formatDefaultNoopNotify — unset scope wording", () => {
  it("keeps the compact wording when nothing else is effective", () => {
    expect(
      formatDefaultNoopNotify({
        scope: "project",
        effective: { value: undefined, source: "unset" },
        activeOverride: undefined,
      }),
    ).toBe("no default set in project");
  });

  it("mentions a surviving cross-scope default", () => {
    expect(
      formatDefaultNoopNotify({
        scope: "project",
        effective: { value: "flow", source: "global" },
        activeOverride: undefined,
      }),
    ).toBe('no default set in project; effective default remains "flow" (global)');
  });

  it("mentions the active override when it still masks the default", () => {
    expect(
      formatDefaultNoopNotify({
        scope: "project",
        effective: { value: "flow", source: "global" },
        activeOverride: "safe",
      }),
    ).toBe(
      'no default set in project; effective default remains "flow" (global) — override "safe" still active',
    );
  });
});
