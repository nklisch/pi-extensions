import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveIdentityLine } from "../src/identity.js";
import {
  assembleForInspect,
  handleBeforeAgentStart,
  resetHandlerForTesting,
} from "../src/handler.js";
import { getChangeSignal, resetCacheForTesting } from "../src/cache.js";
import { resetResolverForTesting, setActiveMode } from "../src/resolver.js";
import {
  resetFragmentsForTesting,
  setFragmentRootForTesting,
} from "../src/fragments.js";
import { resetPresetsForTesting } from "../src/presets.js";
import {
  configureStyleDefaults,
  resetStyleForTesting,
  setActiveStyle,
} from "../src/style.js";
import { makeContext, makeEvent, makeModel } from "./harness.js";

let tmp: string | undefined;

function write(root: string, rel: string, content: string): string {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

function fixture(): { root: string; stylePath: string } {
  const root = mkdtempSync(join(tmpdir(), "handler-style-"));
  tmp = root;
  write(root, "base.json", JSON.stringify({ overlays: [] }));
  write(root, "axis/agency/autonomous.md", "AGENCY");
  write(root, "axis/quality/pragmatic.md", "QUALITY");
  write(root, "axis/scope/adjacent.md", "SCOPE");
  mkdirSync(join(root, "modifiers"), { recursive: true });
  const stylePath = write(root, "styles/team.md", "STYLE ONE");
  setFragmentRootForTesting(root);
  configureStyleDefaults({
    selection: undefined,
    source: "unset",
    registry: new Map([
      ["team", { rawRel: "styles/team.md", configDir: root, scope: "project" }],
    ]),
  });
  setActiveStyle("team");
  return { root, stylePath };
}

const model = makeModel({ name: "GLM-5.2", provider: "zai" });
const base = "PI BASE";

beforeEach(() => {
  resetCacheForTesting();
  resetHandlerForTesting();
  resetResolverForTesting();
  resetFragmentsForTesting();
  resetPresetsForTesting();
  resetStyleForTesting();
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  resetCacheForTesting();
  resetHandlerForTesting();
  resetResolverForTesting();
  resetFragmentsForTesting();
  resetPresetsForTesting();
  resetStyleForTesting();
  vi.restoreAllMocks();
});

describe("writing style handler integration", () => {
  it("preserves legacy bytes when both style and mode are unset", () => {
    const result = handleBeforeAgentStart(makeEvent(base), makeContext({ model }));
    expect(result.systemPrompt).toBe(`${deriveIdentityLine(model)}\n${base}`);
  });

  it("injects style independently when no mode is active", () => {
    fixture();
    const result = handleBeforeAgentStart(makeEvent(base), makeContext({ model }));
    expect(result.systemPrompt).toBe(
      [deriveIdentityLine(model), "STYLE ONE", base].join("\n\n"),
    );
    expect(assembleForInspect(model, base)).toBe(result.systemPrompt);
  });

  it("orders style before the complete mode composition", () => {
    fixture();
    setActiveMode({
      base: "pi",
      agency: "autonomous",
      quality: "pragmatic",
      scope: "adjacent",
      modifiers: [],
    });
    const result = handleBeforeAgentStart(makeEvent(base), makeContext({ model }));
    expect(result.systemPrompt).toBe(
      [deriveIdentityLine(model), "STYLE ONE", "AGENCY", "QUALITY", "SCOPE", base].join("\n\n"),
    );
  });

  it("splices every populated fragment slot in the complete fixed order", () => {
    const { root } = fixture();
    write(root, "base/overlay.md", "BASE OVERLAY");
    write(root, "modifiers/tdd.md", "MODIFIER");
    writeFileSync(
      join(root, "base.json"),
      JSON.stringify({ overlays: ["base/overlay.md"] }),
      "utf8",
    );
    setActiveMode({
      base: "overlay",
      agency: "autonomous",
      quality: "pragmatic",
      scope: "adjacent",
      modifiers: ["tdd"],
    });

    const result = handleBeforeAgentStart(makeEvent(base), makeContext({ model }));

    expect(result.systemPrompt).toBe([
      deriveIdentityLine(model),
      "STYLE ONE",
      "BASE OVERLAY",
      "AGENCY",
      "QUALITY",
      "SCOPE",
      "MODIFIER",
      base,
    ].join("\n\n"));
  });

  it("degrades a vanished custom style to no-style and warns once", () => {
    const { stylePath } = fixture();
    rmSync(stylePath);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = handleBeforeAgentStart(makeEvent(base), makeContext({ model }));
    const second = handleBeforeAgentStart(makeEvent(base), makeContext({ model }));

    expect(first.systemPrompt).toBe(`${deriveIdentityLine(model)}\n${base}`);
    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("preserves the active mode when a custom style vanishes", () => {
    const { stylePath } = fixture();
    setActiveMode({
      base: "pi",
      agency: "autonomous",
      quality: "pragmatic",
      scope: "adjacent",
      modifiers: [],
    });
    rmSync(stylePath);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = handleBeforeAgentStart(makeEvent(base), makeContext({ model }));
    const second = handleBeforeAgentStart(makeEvent(base), makeContext({ model }));
    const expected = [
      deriveIdentityLine(model),
      "AGENCY",
      "QUALITY",
      "SCOPE",
      base,
    ].join("\n\n");

    expect(first.systemPrompt).toBe(expected);
    expect(second.systemPrompt).toBe(expected);
    expect(first.systemPrompt).not.toContain("STYLE ONE");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("content edits invalidate while a touch with identical content keeps the result key stable", () => {
    const { stylePath } = fixture();
    const first = handleBeforeAgentStart(makeEvent(base), makeContext({ model }));
    const firstKey = getChangeSignal().currentKey;

    const future = new Date(Date.now() + 2000);
    utimesSync(stylePath, future, future);
    const touched = handleBeforeAgentStart(makeEvent(base), makeContext({ model }));
    expect(touched.systemPrompt).toBe(first.systemPrompt);
    expect(getChangeSignal().currentKey).toBe(firstKey);

    writeFileSync(stylePath, "STYLE TWO", "utf8");
    const later = new Date(Date.now() + 4000);
    utimesSync(stylePath, later, later);
    const edited = handleBeforeAgentStart(makeEvent(base), makeContext({ model }));
    expect(edited.systemPrompt).toContain("STYLE TWO");
    expect(edited.systemPrompt).not.toContain("STYLE ONE");
    expect(getChangeSignal().lastEntry?.reason).toBe("style-switched");
  });
});
