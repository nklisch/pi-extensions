import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverBundledStyles,
  getActiveStyle,
  getDefaultStyle,
  getEffectiveStyleSelectionSource,
  isValidStyleName,
  listAvailableStyles,
  configureStyleDefaults,
  resetStyleForTesting,
  resolveActiveStylePlan,
  resolveCustomStylePath,
  setActiveStyle,
} from "../src/style.js";
import { resetFragmentsForTesting } from "../src/fragments.js";

let tmp: string | undefined;

function freshDir(): string {
  tmp = mkdtempSync(join(tmpdir(), "style-"));
  return tmp;
}

function write(root: string, rel: string, content: string): string {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

beforeEach(() => {
  resetStyleForTesting();
  resetFragmentsForTesting();
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  resetStyleForTesting();
  resetFragmentsForTesting();
});

describe("resolveCustomStylePath — containment boundary", () => {
  it("accepts a relative Markdown regular file", () => {
    const root = freshDir();
    const target = write(root, "styles/team.md", "TEAM");
    expect(resolveCustomStylePath("styles/team.md", root)).toBe(target);
  });

  it("rejects empty, absolute, non-Markdown, missing, directory, and .. escape paths distinctly", () => {
    const root = freshDir();
    const outside = write(join(root, ".."), `outside-${basename(root)}.md`, "SECRET");
    mkdirSync(join(root, "directory.md"));
    expect(() => resolveCustomStylePath("", root)).toThrow(/empty/);
    expect(() => resolveCustomStylePath(outside, root)).toThrow(/must be relative/);
    expect(() => resolveCustomStylePath("style.txt", root)).toThrow(/must end in/);
    expect(() => resolveCustomStylePath("missing.md", root)).toThrow(/not found/);
    expect(() => resolveCustomStylePath("directory.md", root)).toThrow(/not a regular file/);
    expect(() => resolveCustomStylePath(`../${basename(outside)}`, root)).toThrow(/escapes/);
    rmSync(outside, { force: true });
  });

  it("accepts in-root symlinks and rejects symlinks escaping the root", () => {
    const root = freshDir();
    write(root, "inside.md", "INSIDE");
    const outside = write(join(root, ".."), `outside-link-${basename(root)}.md`, "SECRET");
    symlinkSync("inside.md", join(root, "inside-link.md"));
    symlinkSync(outside, join(root, "outside-link.md"));
    expect(resolveCustomStylePath("inside-link.md", root)).toBe(join(root, "inside.md"));
    expect(() => resolveCustomStylePath("outside-link.md", root)).toThrow(/escapes/);
    rmSync(outside, { force: true });
  });
});

describe("style catalog and resolution", () => {
  it("discovers the four bundled styles in sorted order", () => {
    expect(discoverBundledStyles().map((path) => basename(path))).toEqual([
      "clear.md",
      "compact.md",
      "explanatory.md",
      "expressive.md",
    ]);
  });

  it.each([
    ["clear", true],
    ["my-team-voice", true],
    ["../x", false],
    ["Bad Name", false],
    ["UPPER", false],
    ["", false],
  ])("validates style name %j", (name, valid) => {
    expect(isValidStyleName(name)).toBe(valid);
  });

  it("returns unset, explicit none, and bundled plans", () => {
    expect(resolveActiveStylePlan()).toMatchObject({ fragmentSource: "unset", content: "", signature: "" });
    setActiveStyle("none");
    expect(resolveActiveStylePlan()).toMatchObject({ fragmentSource: "none", content: "", signature: "" });
    setActiveStyle("clear");
    const bundled = resolveActiveStylePlan();
    expect(bundled.name).toBe("clear");
    expect(bundled.fragmentSource).toBe("bundled");
    expect(bundled.content.length).toBeGreaterThan(0);
    expect(bundled.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("resolves override none with empty content and signature", () => {
    setActiveStyle("none");
    expect(resolveActiveStylePlan()).toEqual({
      name: undefined,
      fragmentSource: "none",
      selectionSource: "override",
      content: "",
      signature: "",
    });
  });

  it.each(["project", "global"] as const)(
    "resolves none with empty content and signature for the %s default",
    (source) => {
      configureStyleDefaults({ selection: "none", source, registry: new Map() });
      expect(resolveActiveStylePlan()).toEqual({
        name: undefined,
        fragmentSource: "none",
        selectionSource: source,
        content: "",
        signature: "",
      });
    },
  );

  it("resolves a global custom style with its defining source", () => {
    const root = freshDir();
    write(root, "team.md", "GLOBAL TEAM");
    configureStyleDefaults({
      selection: undefined,
      source: "unset",
      registry: new Map([
        ["team", { rawRel: "team.md", configDir: root, scope: "global" }],
      ]),
    });
    setActiveStyle("team");

    expect(resolveActiveStylePlan()).toMatchObject({
      name: "team",
      fragmentSource: "custom-global",
      content: "GLOBAL TEAM",
    });
  });

  it("supports override/default precedence and preserves a valid override on failure", () => {
    const root = freshDir();
    write(root, "team.md", "TEAM");
    configureStyleDefaults({
      selection: "clear",
      source: "global",
      registry: new Map([["team", { rawRel: "team.md", configDir: root, scope: "global" }]]),
    });
    expect(getDefaultStyle()).toBe("clear");
    expect(getEffectiveStyleSelectionSource()).toBe("global");
    setActiveStyle("team");
    expect(resolveActiveStylePlan()).toMatchObject({ name: "team", selectionSource: "override" });
    expect(() => setActiveStyle("unknown")).toThrow(/has no bundled/);
    expect(resolveActiveStylePlan()).toMatchObject({ name: "team", selectionSource: "override" });
    // Configure refresh replaces the durable tier but intentionally preserves
    // the same-session override.
    configureStyleDefaults({ selection: "none", source: "project", registry: new Map() });
    expect(getActiveStyle()).toBe("team");
    expect(getEffectiveStyleSelectionSource()).toBe("override");
    expect(() => resolveActiveStylePlan()).toThrow(/has no bundled/);
  });

  it("lists deterministic bundled/custom provenance and excludes control names", () => {
    const root = freshDir();
    write(root, "clear.md", "CUSTOM CLEAR");
    write(root, "team.md", "TEAM");
    configureStyleDefaults({
      selection: undefined,
      source: "unset",
      registry: new Map([
        ["clear", { rawRel: "clear.md", configDir: root, scope: "project" }],
        ["team", { rawRel: "team.md", configDir: root, scope: "global" }],
        ["off", { rawRel: "team.md", configDir: root, scope: "project" }],
      ]),
    });
    expect(listAvailableStyles()).toEqual([
      { name: "clear", fragmentSource: "custom-project" },
      { name: "compact", fragmentSource: "bundled" },
      { name: "explanatory", fragmentSource: "bundled" },
      { name: "expressive", fragmentSource: "bundled" },
      { name: "team", fragmentSource: "custom-global" },
    ]);
  });

  it("returns a defensive catalog snapshot", () => {
    const root = freshDir();
    write(root, "team.md", "TEAM");
    configureStyleDefaults({
      selection: undefined,
      source: "unset",
      registry: new Map([
        ["team", { rawRel: "team.md", configDir: root, scope: "global" }],
      ]),
    });

    const returned = listAvailableStyles() as Array<{
      name: string;
      fragmentSource: string;
    }>;
    returned.pop();
    returned[0]!.name = "corrupted";
    returned.push({ name: "injected", fragmentSource: "bundled" });

    expect(listAvailableStyles()).toEqual([
      { name: "clear", fragmentSource: "bundled" },
      { name: "compact", fragmentSource: "bundled" },
      { name: "explanatory", fragmentSource: "bundled" },
      { name: "expressive", fragmentSource: "bundled" },
      { name: "team", fragmentSource: "custom-global" },
    ]);
  });

  it("custom registration wins on a bundled-name collision and vanished files throw", () => {
    const root = freshDir();
    const path = write(root, "clear.md", "CUSTOM CLEAR");
    configureStyleDefaults({
      selection: undefined,
      source: "unset",
      registry: new Map([
        ["clear", { rawRel: "clear.md", configDir: root, scope: "project" }],
      ]),
    });
    setActiveStyle("clear");
    expect(resolveActiveStylePlan()).toMatchObject({
      name: "clear",
      fragmentSource: "custom-project",
      content: "CUSTOM CLEAR",
    });
    rmSync(path);
    expect(() => resolveActiveStylePlan()).toThrow(/not found/);
  });
});
