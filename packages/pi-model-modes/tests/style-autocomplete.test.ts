import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AutocompleteProviderFactory,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import {
  buildStyleArgItems,
  buildStyleTopLevelItems,
  getStyleArgSuggestions,
  registerStyleAutocomplete,
} from "../src/style-autocomplete.js";
import { configureStyleDefaults, resetStyleForTesting } from "../src/style.js";
import { makeContext, makePi } from "./harness.js";

const STYLES = [
  { name: "clear", fragmentSource: "bundled" as const },
  { name: "team", fragmentSource: "custom-project" as const },
  { name: "voice", fragmentSource: "custom-global" as const },
];
const EVENT: SessionStartEvent = { type: "session_start", reason: "startup" };

function handler(calls: ReturnType<typeof makePi>["calls"]) {
  const registration = calls.find(
    (call) => call.method === "on" && call.args[0] === "session_start",
  );
  if (!registration) throw new Error("session_start handler missing");
  return registration.args[1] as (event: SessionStartEvent, ctx: ExtensionContext) => void;
}

function tuiContext() {
  const factories: AutocompleteProviderFactory[] = [];
  return {
    factories,
    ctx: makeContext({
      mode: "tui",
      ui: { addAutocompleteProvider: (factory: AutocompleteProviderFactory) => factories.push(factory) },
    } as unknown as Partial<ExtensionContext>),
  };
}

function predecessor() {
  const calls = { suggestions: 0, completion: 0, files: 0 };
  const current: AutocompleteProvider = {
    async getSuggestions() {
      calls.suggestions += 1;
      return { prefix: "fallback", items: [{ value: "fallback", label: "fallback" }] };
    },
    applyCompletion(lines, _line, _col, item) {
      calls.completion += 1;
      return { lines: [...lines, item.value], cursorLine: 1, cursorCol: item.value.length };
    },
    shouldTriggerFileCompletion() {
      calls.files += 1;
      return false;
    },
  };
  return { current, calls };
}

afterEach(() => {
  resetStyleForTesting();
  vi.restoreAllMocks();
});

describe("style autocomplete pure core", () => {
  it("projects bundled/custom provenance and control semantics", () => {
    const items = buildStyleArgItems(STYLES);
    expect(items.map((item) => item.value)).toEqual(["clear", "team", "voice", "none", "off"]);
    expect(items.find((item) => item.value === "team")?.description).toContain("project registration");
    expect(items.find((item) => item.value === "voice")?.description).toContain("global registration");
    expect(buildStyleTopLevelItems(STYLES).at(-1)?.value).toBe("default");
  });

  it("stage 1 returns deterministic case-insensitive names plus controls", () => {
    expect(getStyleArgSuggestions("/style ", STYLES)?.items.map((item) => item.value))
      .toEqual(["clear", "team", "voice", "none", "off", "default"]);
    expect(getStyleArgSuggestions("/style TE", STYLES)).toEqual({
      prefix: "TE",
      items: [expect.objectContaining({ value: "team" })],
    });
  });

  it("stage 2 excludes repeated default and stage 3 only offers --global", () => {
    expect(getStyleArgSuggestions("/style default ", STYLES)?.items.map((item) => item.value))
      .toEqual(["clear", "team", "voice", "none", "off"]);
    expect(getStyleArgSuggestions("/style default clear --", STYLES)).toEqual({
      prefix: "--",
      items: [expect.objectContaining({ value: "--global" })],
    });
  });

  it.each([
    "/style",
    "/mode ",
    "/mode:inspect ",
    "ordinary text",
    "/style clear extra",
    "/style default clear extra",
  ])("delegates nonmatching line `%s`", (line) => {
    expect(getStyleArgSuggestions(line, STYLES)).toBeNull();
  });
});

describe("style autocomplete Pi seam", () => {
  it("registers one session_start handler and no other surface", () => {
    const { pi, calls } = makePi();
    registerStyleAutocomplete(pi);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("on");
    expect(calls[0].args[0]).toBe("session_start");
  });

  it.each(["print", "json", "rpc"] as const)("does not register in %s mode", (mode) => {
    const { pi, calls } = makePi();
    registerStyleAutocomplete(pi);
    const addAutocompleteProvider = vi.fn();
    handler(calls)(EVENT, makeContext({
      mode,
      ui: { addAutocompleteProvider },
    } as unknown as Partial<ExtensionContext>));
    expect(addAutocompleteProvider).not.toHaveBeenCalled();
  });

  it("delegates nonmatches, aborted requests, completion application, and file decisions", async () => {
    const { pi, calls } = makePi();
    registerStyleAutocomplete(pi);
    const { ctx, factories } = tuiContext();
    handler(calls)(EVENT, ctx);
    const base = predecessor();
    const provider = factories[0](base.current);

    expect(await provider.getSuggestions(["/mode fl"], 0, 8, { signal: new AbortController().signal }))
      .toEqual({ prefix: "fallback", items: [{ value: "fallback", label: "fallback" }] });
    const aborted = new AbortController();
    aborted.abort();
    await provider.getSuggestions(["/style cl"], 0, 9, { signal: aborted.signal });
    expect(base.calls.suggestions).toBe(2);

    expect(provider.applyCompletion(["/style cl"], 0, 9, { value: "clear", label: "clear" }, "cl"))
      .toEqual({ lines: ["/style cl", "clear"], cursorLine: 1, cursorCol: 5 });
    expect(provider.shouldTriggerFileCompletion?.(["/style cl"], 0, 9)).toBe(false);
    expect(base.calls).toEqual({ suggestions: 2, completion: 1, files: 1 });
  });

  it("resolves the style catalog at suggestion time", async () => {
    const { pi, calls } = makePi();
    registerStyleAutocomplete(pi);
    const { ctx, factories } = tuiContext();
    handler(calls)(EVENT, ctx);
    const base = predecessor();
    const provider = factories[0](base.current);

    configureStyleDefaults({ selection: undefined, source: "unset", registry: new Map() });
    const before = await provider.getSuggestions(["/style te"], 0, 9, { signal: new AbortController().signal });
    expect(before?.items).toEqual([]);

    // A registry refresh after provider registration must be visible immediately.
    // Path validity is irrelevant to catalog projection; resolution validates it when selected.
    configureStyleDefaults({
      selection: undefined,
      source: "unset",
      registry: new Map([["team", { rawRel: "team.md", configDir: "/tmp", scope: "project" }]]),
    });
    const after = await provider.getSuggestions(["/style te"], 0, 9, { signal: new AbortController().signal });
    expect(after?.items).toEqual([
      expect.objectContaining({ value: "team", description: expect.stringContaining("project registration") }),
    ]);
  });
});
