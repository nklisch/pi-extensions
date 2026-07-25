import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  loadPluginConfig,
  loadGlobalPluginConfig,
  applyDefaultFromConfig,
  applySessionStart,
  applyStyleFromConfig,
  readStyleConfigScopes,
  setConfigPathsForTesting,
  resetConfigForTesting,
  writeDefaultToConfig,
  writeStyleDefaultToConfig,
  effectiveDefaultSource,
  effectiveStyleDefaultSource,
  readDefaultSources,
  readStyleDefaultSources,
  DEFAULT_OFF,
} from "../src/config.js";
import {
  getDefaultMode,
  getEffectiveModeSource,
  resolveActiveModePlan,
  resetResolverForTesting,
  setActiveMode,
  getActiveMode,
} from "../src/resolver.js";
import {
  setFragmentRootForTesting,
  resetFragmentsForTesting,
} from "../src/fragments.js";
import { resetPresetsForTesting } from "../src/presets.js";
import {
  getActiveStyle,
  getEffectiveStyleSelectionSource,
  resetStyleForTesting,
  resolveActiveStylePlan,
  setActiveStyle,
} from "../src/style.js";

/**
 * Tests for `src/config.ts` — the plugin-owned config loader + default-tier
 * seeding. The two config file paths are overridden via the test seam
 * (`setConfigPathsForTesting`) so tests never touch the real home dir; temp
 * files supply the actual JSON. A fragment fixture is built so a valid
 * `defaultMode` resolves through `setDefaultMode`.
 */

let dir: string | undefined;
let fragRoot: string | undefined;

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "config-"));
  dir = d;
  return d;
}

function writeJson(path: string, obj: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(obj), "utf8");
}

function writeRaw(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text, "utf8");
}

/** Build a fragment fixture covering the shipped "extend" preset. */
function buildFragments(): void {
  const root = mkdtempSync(join(tmpdir(), "config-frag-"));
  fragRoot = root;
  const w = (rel: string, content: string): void => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };
  w("axis/agency/autonomous.md", "AGENCY-autonomous");
  w("axis/quality/pragmatic.md", "QUALITY-pragmatic");
  w("axis/scope/adjacent.md", "SCOPE-adjacent");
  w("modifiers/tdd.md", "MOD-tdd");
  setFragmentRootForTesting(root);
}

beforeEach(() => {
  resetResolverForTesting();
  resetConfigForTesting();
  resetFragmentsForTesting();
  resetPresetsForTesting();
  resetStyleForTesting();
});

afterEach(() => {
  for (const d of [dir, fragRoot]) {
    if (d) rmSync(d, { recursive: true, force: true });
  }
  dir = undefined;
  fragRoot = undefined;
  resetResolverForTesting();
  resetConfigForTesting();
  resetFragmentsForTesting();
  resetPresetsForTesting();
  resetStyleForTesting();
  vi.restoreAllMocks();
});

describe("loadPluginConfig — merge + tolerance", () => {
  it("global only", () => {
    const d = freshDir();
    const global = join(d, "global.json");
    writeJson(global, { defaultMode: "flow" });
    setConfigPathsForTesting({ global, project: join(d, "missing-project.json") });
    expect(loadPluginConfig("/unused")).toEqual({ defaultMode: "flow" });
  });

  it("project only", () => {
    const d = freshDir();
    const project = join(d, "project.json");
    writeJson(project, { defaultMode: "extend" });
    setConfigPathsForTesting({
      global: join(d, "missing-global.json"),
      project,
    });
    expect(loadPluginConfig("/unused")).toEqual({ defaultMode: "extend" });
  });

  it("project overrides global (shallow merge, project wins)", () => {
    const d = freshDir();
    const global = join(d, "global.json");
    const project = join(d, "project.json");
    writeJson(global, { defaultMode: "extend" });
    writeJson(project, { defaultMode: "flow" });
    setConfigPathsForTesting({ global, project });
    expect(loadPluginConfig("/unused")).toEqual({ defaultMode: "flow" });
  });

  it("per-key merges customStyles while project scalar values still win", () => {
    const d = freshDir();
    const global = join(d, "global.json");
    const project = join(d, "project.json");
    writeJson(global, {
      writingStyle: "clear",
      customStyles: { shared: "global.md", global: "global.md" },
    });
    writeJson(project, {
      writingStyle: "none",
      customStyles: { shared: "project.md", project: "project.md" },
    });
    setConfigPathsForTesting({ global, project });
    expect(loadPluginConfig("/unused")).toEqual({
      writingStyle: "none",
      customStyles: {
        shared: "project.md",
        global: "global.md",
        project: "project.md",
      },
    });
  });

  it("both files missing → {}", () => {
    const d = freshDir();
    setConfigPathsForTesting({
      global: join(d, "nope-global.json"),
      project: join(d, "nope-project.json"),
    });
    expect(loadPluginConfig("/unused")).toEqual({});
  });

  it("malformed JSON → warn + {} (no throw)", () => {
    const d = freshDir();
    const global = join(d, "bad.json");
    writeRaw(global, "{ not valid json ");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setConfigPathsForTesting({
      global,
      project: join(d, "missing-project.json"),
    });
    expect(loadPluginConfig("/unused")).toEqual({});
    expect(warn).toHaveBeenCalled();
  });

  it("non-object JSON (array) → warn + {}", () => {
    const d = freshDir();
    const global = join(d, "arr.json");
    writeRaw(global, "[1, 2, 3]");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setConfigPathsForTesting({
      global,
      project: join(d, "missing-project.json"),
    });
    expect(loadPluginConfig("/unused")).toEqual({});
    expect(warn).toHaveBeenCalled();
  });
});

describe("style config scopes + seeding", () => {
  it("reads each scope with its defining config directory", () => {
    const d = freshDir();
    const global = join(d, "g", "config.json");
    const project = join(d, "p", "config.json");
    writeJson(global, { writingStyle: "clear" });
    writeJson(project, { customStyles: { team: "styles/team.md" } });
    setConfigPathsForTesting({ global, project });
    expect(readStyleConfigScopes("/unused")).toEqual({
      global: { configDir: dirname(global), writingStyle: "clear", customStyles: {} },
      project: {
        configDir: dirname(project),
        writingStyle: undefined,
        customStyles: { team: "styles/team.md" },
      },
    });
  });

  it("drops malformed style field shapes while preserving valid siblings", () => {
    const d = freshDir();
    const global = join(d, "global", "config.json");
    const project = join(d, "project", "config.json");
    writeJson(global, { writingStyle: 42, customStyles: [] });
    writeJson(project, {
      writingStyle: "clear",
      customStyles: { valid: "valid.md", bad: 7 },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setConfigPathsForTesting({ global, project });

    expect(readStyleConfigScopes("/unused")).toEqual({
      global: {
        configDir: dirname(global),
        writingStyle: undefined,
        customStyles: {},
      },
      project: {
        configDir: dirname(project),
        writingStyle: "clear",
        customStyles: { valid: "valid.md" },
      },
    });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("seeds valid merged custom styles with project winning a collision", () => {
    const d = freshDir();
    const global = join(d, "global", "config.json");
    const project = join(d, "project", "config.json");
    writeRaw(join(dirname(global), "global.md"), "GLOBAL");
    writeRaw(join(dirname(project), "project.md"), "PROJECT");
    writeJson(global, { customStyles: { team: "global.md" }, writingStyle: "team" });
    writeJson(project, { customStyles: { team: "project.md" } });
    setConfigPathsForTesting({ global, project });
    applyStyleFromConfig("/unused");
    expect(resolveActiveStylePlan()).toMatchObject({
      name: "team",
      fragmentSource: "custom-project",
      content: "PROJECT",
    });
  });

  it("seeds project none as an explicit mask over a global writing style", () => {
    const d = freshDir();
    const global = join(d, "global.json");
    const project = join(d, "project.json");
    writeJson(global, { writingStyle: "clear" });
    writeJson(project, { writingStyle: "none" });
    setConfigPathsForTesting({ global, project });

    applyStyleFromConfig("/unused");

    expect(resolveActiveStylePlan()).toMatchObject({
      fragmentSource: "none",
      content: "",
      signature: "",
    });
  });

  it("drops bad entries without poisoning a selected valid sibling", () => {
    const d = freshDir();
    const global = join(d, "config.json");
    writeRaw(join(d, "valid.md"), "VALID");
    writeJson(global, {
      writingStyle: "valid",
      customStyles: { valid: "valid.md", bad: "../escape.md", "Bad Name": "valid.md" },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setConfigPathsForTesting({ global, project: join(d, "missing.json") });
    expect(() => applyStyleFromConfig("/unused")).not.toThrow();
    expect(resolveActiveStylePlan()).toMatchObject({
      name: "valid",
      fragmentSource: "custom-global",
      content: "VALID",
    });
    expect(warn).toHaveBeenCalled();
  });
});

describe("loadGlobalPluginConfig — cycle keybinding flag", () => {
  it("reads only the global file", () => {
    const d = freshDir();
    const global = join(d, "global.json");
    const project = join(d, "project.json");
    writeJson(global, { cycleKeybinding: true });
    writeRaw(project, "{ not valid json ");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setConfigPathsForTesting({ global, project });

    expect(loadGlobalPluginConfig()).toEqual({ cycleKeybinding: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it("defaults missing cycleKeybinding to false", () => {
    const d = freshDir();
    const global = join(d, "global.json");
    writeJson(global, {});
    setConfigPathsForTesting({
      global,
      project: join(d, "project.json"),
    });

    expect(loadGlobalPluginConfig().cycleKeybinding).toBe(false);
  });

  it("returns true for boolean true", () => {
    const d = freshDir();
    const global = join(d, "global.json");
    writeJson(global, { cycleKeybinding: true });
    setConfigPathsForTesting({
      global,
      project: join(d, "project.json"),
    });

    expect(loadGlobalPluginConfig().cycleKeybinding).toBe(true);
  });

  it.each(["yes", 1] as const)(
    "warns and disables non-boolean cycleKeybinding (%s)",
    (value) => {
      const d = freshDir();
      const global = join(d, "global.json");
      writeJson(global, { cycleKeybinding: value });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      setConfigPathsForTesting({
        global,
        project: join(d, "project.json"),
      });

      expect(() => loadGlobalPluginConfig()).not.toThrow();
      expect(loadGlobalPluginConfig().cycleKeybinding).toBe(false);
      expect(warn).toHaveBeenCalled();
    },
  );
});

describe("applyDefaultFromConfig — seeding", () => {
  it("seeds a valid default into the resolver's default tier", () => {
    buildFragments();
    const d = freshDir();
    const global = join(d, "global.json");
    writeJson(global, { defaultMode: "extend" });
    setConfigPathsForTesting({
      global,
      project: join(d, "missing-project.json"),
    });

    applyDefaultFromConfig("/unused");

    expect(getDefaultMode()).toBe("extend");
    expect(getEffectiveModeSource()).toBe("default");
    expect(resolveActiveModePlan().mode?.agency).toBe("autonomous");
  });

  it("no defaultMode in config → leaves the default tier unset (no-op)", () => {
    const d = freshDir();
    const global = join(d, "global.json");
    writeJson(global, {});
    setConfigPathsForTesting({
      global,
      project: join(d, "missing-project.json"),
    });

    applyDefaultFromConfig("/unused");
    expect(getDefaultMode()).toBeUndefined();
    expect(getEffectiveModeSource()).toBe("unset");
  });

  it("invalid default → warn + skip (no throw, default tier stays unset)", () => {
    buildFragments();
    const d = freshDir();
    const global = join(d, "global.json");
    writeJson(global, { defaultMode: "no-such-preset" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setConfigPathsForTesting({
      global,
      project: join(d, "missing-project.json"),
    });

    expect(() => applyDefaultFromConfig("/unused")).not.toThrow();
    expect(getDefaultMode()).toBeUndefined();
    expect(getEffectiveModeSource()).toBe("unset");
    expect(warn).toHaveBeenCalled();
  });

  it("reconciles on reseed: a config with no defaultMode CLEARS a prior default (not stale)", () => {
    // session_start fires repeatedly (reload/new/resume). A second seed whose
    // config no longer names a defaultMode must clear the prior one, not leave
    // it stale and effective.
    buildFragments();
    const d = freshDir();
    const withDefault = join(d, "with.json");
    const without = join(d, "without.json");
    writeJson(withDefault, { defaultMode: "extend" });
    writeJson(without, {});

    setConfigPathsForTesting({ global: withDefault, project: join(d, "missing.json") });
    applyDefaultFromConfig("/unused");
    expect(getDefaultMode()).toBe("extend"); // seeded

    // Reseed with a config that has no defaultMode → prior default cleared.
    setConfigPathsForTesting({ global: without, project: join(d, "missing.json") });
    applyDefaultFromConfig("/unused");
    expect(getDefaultMode()).toBeUndefined();
    expect(getEffectiveModeSource()).toBe("unset");
  });

  it("reconciles on reseed: an INVALID new defaultMode CLEARS a prior valid default", () => {
    buildFragments();
    const d = freshDir();
    const good = join(d, "good.json");
    const bad = join(d, "bad.json");
    writeJson(good, { defaultMode: "extend" });
    writeJson(bad, { defaultMode: "no-such-preset" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    setConfigPathsForTesting({ global: good, project: join(d, "missing.json") });
    applyDefaultFromConfig("/unused");
    expect(getDefaultMode()).toBe("extend");

    setConfigPathsForTesting({ global: bad, project: join(d, "missing.json") });
    applyDefaultFromConfig("/unused");
    expect(getDefaultMode()).toBeUndefined(); // stale prior default cleared, not retained
    expect(warn).toHaveBeenCalled();
  });
});

describe("applySessionStart — ephemeral override clearing", () => {
  const override = {
    base: "pi",
    agency: "autonomous",
    quality: "pragmatic",
    scope: "adjacent",
    modifiers: [],
  };

  function configWithNoDefault(): void {
    const d = freshDir();
    setConfigPathsForTesting({
      global: join(d, "missing-global.json"),
      project: join(d, "missing-project.json"),
    });
  }

  it.each(["new", "resume", "fork"] as const)(
    "clears the ephemeral override on a genuinely new session (reason: %s)",
    (reason) => {
      buildFragments();
      configWithNoDefault();
      setActiveMode(override); // a session override is active
      expect(getEffectiveModeSource()).toBe("override");

      applySessionStart(reason, "/unused");

      // The new session restarts from the config default (here: unset).
      expect(getActiveMode()).toBeUndefined();
      expect(getEffectiveModeSource()).toBe("unset");
    },
  );

  it.each(["reload", "startup"] as const)(
    "preserves the override on a same-session start (reason: %s)",
    (reason) => {
      buildFragments();
      configWithNoDefault();
      setActiveMode(override);

      applySessionStart(reason, "/unused");

      // A reload / initial startup keeps the active override.
      expect(getActiveMode()).toEqual(override);
      expect(getEffectiveModeSource()).toBe("override");
    },
  );

  it.each(["startup", "reload", "new", "resume", "fork"] as const)(
    "seeds writing style on every session-start reason (%s)",
    (reason) => {
      const d = freshDir();
      const global = join(d, "global.json");
      writeJson(global, { writingStyle: "clear" });
      setConfigPathsForTesting({ global, project: join(d, "missing.json") });
      resetStyleForTesting();
      applySessionStart(reason, "/unused");
      expect(resolveActiveStylePlan()).toMatchObject({ name: "clear", fragmentSource: "bundled" });
    },
  );

  it("still reconciles the default tier on every reason", () => {
    buildFragments();
    const d = freshDir();
    const global = join(d, "global.json");
    writeJson(global, { defaultMode: "extend" });
    setConfigPathsForTesting({ global, project: join(d, "missing.json") });

    applySessionStart("reload", "/unused");
    expect(getDefaultMode()).toBe("extend"); // default seeded from config
  });
});

describe("writeDefaultToConfig — write pipeline", () => {
  beforeEach(() => {
    buildFragments();
  });

  function setPaths(d: string): { global: string; project: string } {
    const global = join(d, "global.json");
    const project = join(d, "cwd", ".pi", "pi-model-modes.json");
    setConfigPathsForTesting({ global, project });
    return { global, project };
  }

  it("writes defaultMode to the project scope and reseeds the resolver", () => {
    const d = freshDir();
    const { project } = setPaths(d);

    const result = writeDefaultToConfig(d, "extend", "project");

    expect(result).toEqual({
      ok: true,
      writtenScope: "project",
      writtenValue: "extend",
      effective: { value: "extend", source: "project" },
    });
    expect(getDefaultMode()).toBe("extend");
    expect(getEffectiveModeSource()).toBe("default");
    expect(loadPluginConfig(d).defaultMode).toBe("extend");
    // File bootstrapped (the `.pi` dir + file did not exist before).
    expect(existsSync(project)).toBe(true);
  });

  it("writes to the global scope when --global is selected", () => {
    const d = freshDir();
    const { project } = setPaths(d);

    const result = writeDefaultToConfig(d, "extend", "global");

    expect(result.ok).toBe(true);
    expect(result.ok && result.writtenScope).toBe("global");
    // Project file NOT created when writing global.
    expect(existsSync(project)).toBe(false);
    expect(loadPluginConfig(d).defaultMode).toBe("extend");
    expect(getDefaultMode()).toBe("extend");
  });

  it("accepts and persists `none` as a real default value", () => {
    const d = freshDir();
    setPaths(d);

    const result = writeDefaultToConfig(d, "none", "project");

    expect(result.ok).toBe(true);
    expect(result.ok && result.writtenValue).toBe("none");
    expect(loadPluginConfig(d).defaultMode).toBe("none");
    expect(getDefaultMode()).toBe("none");
  });

  it("serializes as 2-space indented JSON with a trailing newline", () => {
    const d = freshDir();
    const { project } = setPaths(d);
    writeDefaultToConfig(d, "extend", "project");

    const text = readFileSync(project, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    // Indented key — 2 spaces, not flat.
    expect(text).toContain('\n  "defaultMode"');
    expect(text).not.toContain('{"defaultMode');
  });

  it("PRESERVES sibling keys (cycleKeybinding + unknown future keys) on set", () => {
    const d = freshDir();
    const { project } = setPaths(d);
    mkdirSync(dirname(project), { recursive: true });
    writeFileSync(
      project,
      JSON.stringify({
        cycleKeybinding: true,
        futureKey: "preserve-me",
        defaultMode: "safe",
      }),
    );

    writeDefaultToConfig(d, "extend", "project");

    const reloaded = loadPluginConfig(d) as Record<string, unknown>;
    expect(reloaded.cycleKeybinding).toBe(true);
    expect(reloaded.futureKey).toBe("preserve-me");
    expect(reloaded.defaultMode).toBe("extend");
  });

  it("`off` removes the defaultMode key but PRESERVES siblings", () => {
    const d = freshDir();
    const { project } = setPaths(d);
    mkdirSync(dirname(project), { recursive: true });
    writeFileSync(
      project,
      JSON.stringify({ cycleKeybinding: true, defaultMode: "extend" }),
    );

    const result = writeDefaultToConfig(d, DEFAULT_OFF, "project");

    expect(result.ok).toBe(true);
    expect(result.ok && result.writtenValue).toBeUndefined();
    const reloaded = loadPluginConfig(d) as Record<string, unknown>;
    expect("defaultMode" in reloaded).toBe(false);
    expect(reloaded.cycleKeybinding).toBe(true);
  });

  it("CLEAR-WHEN-EMPTY blocker: `off` on a missing target is a no-op (no file/dir, no resolver touch)", () => {
    const d = freshDir();
    const { project } = setPaths(d);
    const projectDir = dirname(project);

    const result = writeDefaultToConfig(d, DEFAULT_OFF, "project");

    expect(result).toEqual({
      ok: true,
      noop: true,
      writtenScope: "project",
      writtenValue: undefined,
      effective: { value: undefined, source: "unset" },
    });
    // Crucial Codex blocker: do NOT create `<cwd>/.pi/` or write `{}`.
    expect(existsSync(project)).toBe(false);
    expect(existsSync(projectDir)).toBe(false);
    // Resolver untouched.
    expect(getDefaultMode()).toBeUndefined();
    expect(getEffectiveModeSource()).toBe("unset");
  });

  it("CLEAR-WHEN-EMPTY blocker: `off` on existing sibling-only file is byte-stable and does not reseed", () => {
    const d = freshDir();
    const { project } = setPaths(d);
    mkdirSync(dirname(project), { recursive: true });
    const original = `${JSON.stringify({ cycleKeybinding: true }, null, 2)}\n`;
    writeFileSync(project, original);

    const result = writeDefaultToConfig(d, DEFAULT_OFF, "project");

    expect(result).toEqual({
      ok: true,
      noop: true,
      writtenScope: "project",
      writtenValue: undefined,
      effective: { value: undefined, source: "unset" },
    });
    expect(readFileSync(project, "utf8")).toBe(original);
    expect(getDefaultMode()).toBeUndefined();
  });

  it("CLEAR-WHEN-EMPTY blocker: global `off` on a missing target is also a no-op", () => {
    const d = freshDir();
    const { global } = setPaths(d);

    const result = writeDefaultToConfig(d, DEFAULT_OFF, "global");

    expect(result.ok).toBe(true);
    expect(result.ok && result.noop).toBe(true);
    expect(existsSync(global)).toBe(false);
    expect(existsSync(dirname(global))).toBe(true); // temp root exists, file absent
    expect(getDefaultMode()).toBeUndefined();
  });

  it("the OPUS BLOCKER: project `off` with a global default falls back to global", () => {
    const d = freshDir();
    const { global, project } = setPaths(d);
    mkdirSync(dirname(global), { recursive: true });
    writeFileSync(global, JSON.stringify({ defaultMode: "extend" }));
    mkdirSync(dirname(project), { recursive: true });
    // Both values use `extend` (the only preset with full fragment coverage in
    // buildFragments); the precedence is the point, not the value identity.
    writeFileSync(project, JSON.stringify({ defaultMode: "extend" }));

    // Project + global both `extend`. Effective is `extend` (project wins by
    // shallow-merge).
    applyDefaultFromConfig(d);
    expect(getDefaultMode()).toBe("extend");

    // Now clear the project default — effective must STILL be `extend`
    // (falling back to global), NOT to unset. This is the bug Opus caught: a
    // naive clearDefaultMode would leave the resolver at unset and the notify
    // would lie.
    const result = writeDefaultToConfig(d, DEFAULT_OFF, "project");

    expect(result).toEqual({
      ok: true,
      writtenScope: "project",
      writtenValue: undefined,
      effective: { value: "extend", source: "global" },
    });
    expect(getDefaultMode()).toBe("extend");
    expect(getEffectiveModeSource()).toBe("default");
  });

  it("DOES NOT touch the EPHEMERAL override tier (precedence preserved)", () => {
    const d = freshDir();
    setPaths(d);
    setActiveMode({
      base: "pi",
      agency: "autonomous",
      quality: "pragmatic",
      scope: "adjacent",
      modifiers: [],
    });
    expect(getEffectiveModeSource()).toBe("override");

    writeDefaultToConfig(d, "extend", "project");

    // Override still wins — writeDefaultToConfig never touched it.
    expect(getActiveMode()).toBeDefined();
    expect(getEffectiveModeSource()).toBe("override");
    // But the default tier was still reseeded truthfully underneath.
    expect(getDefaultMode()).toBe("extend");
  });

  it("STRICT read-for-write: a malformed target file → fail, no overwrite", () => {
    const d = freshDir();
    const { project } = setPaths(d);
    mkdirSync(dirname(project), { recursive: true });
    const original = "{ not valid json ";
    writeFileSync(project, original);

    const result = writeDefaultToConfig(d, "extend", "project");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe(project);
      expect(result.error).toMatch(/not valid JSON/);
    }
    // File byte-unchanged.
    expect(readFileSync(project, "utf8")).toBe(original);
    // Resolver untouched.
    expect(getDefaultMode()).toBeUndefined();
  });

  it("STRICT read-for-write: a non-object (array) file → fail, no overwrite", () => {
    const d = freshDir();
    const { project } = setPaths(d);
    mkdirSync(dirname(project), { recursive: true });
    writeFileSync(project, "[1, 2, 3]");

    const result = writeDefaultToConfig(d, "extend", "project");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not a JSON object/);
    }
    expect(readFileSync(project, "utf8")).toBe("[1, 2, 3]");
  });

  it("leaves no .tmp file behind on a successful write", () => {
    const d = freshDir();
    const { project } = setPaths(d);
    writeDefaultToConfig(d, "extend", "project");

    expect(existsSync(`${project}.tmp`)).toBe(false);
    expect(existsSync(project)).toBe(true);
  });

  it("bootstraps a missing parent dir for BOTH scopes", () => {
    const d = freshDir();
    const { global, project } = setPaths(d);
    // Neither path's parent exists yet (fresh dir).

    writeDefaultToConfig(d, "extend", "global");
    expect(existsSync(global)).toBe(true);

    writeDefaultToConfig(d, "safe", "project");
    expect(existsSync(project)).toBe(true);
  });

  it("write-failure contract: surfaces a fs error and leaves the resolver untouched", () => {
    const d = freshDir();
    setPaths(d);
    // Make renameSync throw by mocking the fs module's renameSync. Easiest:
    // point the project path at a directory whose PARENT is a regular file
    // so mkdirSync fails — but mkdirSync(recursive) tolerates that. Instead,
    // make the project path itself live under a path whose final segment is a
    // file: write a file at `<d>/cwd`, then set project to `<d>/cwd/.pi/x.json`
    // so the writeFileSync(tmp) fails with ENOTDIR.
    const cwdFile = join(d, "cwd");
    writeFileSync(cwdFile, "i am a file, not a directory");
    const project = join(cwdFile, ".pi", "pi-model-modes.json");
    setConfigPathsForTesting({
      global: join(d, "global.json"),
      project,
    });

    const result = writeDefaultToConfig(d, "extend", "project");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
    expect(getDefaultMode()).toBeUndefined();
  });
});

describe("style durable defaults + lifecycle", () => {
  function setStylePaths(d: string): { global: string; project: string } {
    const global = join(d, "global.json");
    const project = join(d, "cwd", ".pi", "pi-model-modes.json");
    setConfigPathsForTesting({ global, project });
    return { global, project };
  }

  it("writes project style defaults, preserves siblings, and keeps an override", () => {
    const d = freshDir();
    const { project } = setStylePaths(d);
    writeJson(project, { defaultMode: "extend", cycleKeybinding: true, writingStyle: "clear", customStyles: {} });
    setActiveStyle("clear");

    const result = writeStyleDefaultToConfig(d, "none", "project");
    expect(result).toEqual({
      ok: true,
      writtenScope: "project",
      writtenValue: "none",
      effective: { value: "none", source: "project" },
    });
    expect(JSON.parse(readFileSync(project, "utf8"))).toMatchObject({
      defaultMode: "extend",
      cycleKeybinding: true,
      writingStyle: "none",
    });
    expect(getActiveStyle()).toBe("clear");
    expect(getEffectiveStyleSelectionSource()).toBe("override");
  });

  it("clears project style and falls back to global, with absent clear as a no-op", () => {
    const d = freshDir();
    const { global, project } = setStylePaths(d);
    writeJson(global, { writingStyle: "clear" });
    writeJson(project, { writingStyle: "none" });
    applyStyleFromConfig(d);
    expect(resolveActiveStylePlan()).toMatchObject({ fragmentSource: "none", selectionSource: "project" });

    const cleared = writeStyleDefaultToConfig(d, DEFAULT_OFF, "project");
    expect(cleared).toMatchObject({ ok: true, writtenValue: undefined });
    expect(resolveActiveStylePlan()).toMatchObject({ name: "clear", fragmentSource: "bundled", selectionSource: "global" });

    rmSync(project);
    const noop = writeStyleDefaultToConfig(d, DEFAULT_OFF, "project");
    expect(noop).toMatchObject({ ok: true, noop: true });
    expect(existsSync(project)).toBe(false);
  });

  it("rejects project-only custom styles for global writes before touching disk", () => {
    const d = freshDir();
    const { global, project } = setStylePaths(d);
    writeRaw(join(dirname(project), "team.md"), "TEAM");
    writeJson(project, { customStyles: { team: "team.md" } });

    const result = writeStyleDefaultToConfig(d, "team", "global");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown writing style.*global/);
    expect(existsSync(global)).toBe(false);
  });

  it("accepts a globally registered custom style as a global default", () => {
    const d = freshDir();
    const { global } = setStylePaths(d);
    writeRaw(join(dirname(global), "team.md"), "TEAM");
    writeJson(global, { customStyles: { team: "team.md" } });

    const result = writeStyleDefaultToConfig(d, "team", "global");

    expect(result).toEqual({
      ok: true,
      writtenScope: "global",
      writtenValue: "team",
      effective: { value: "team", source: "global" },
    });
    expect(JSON.parse(readFileSync(global, "utf8"))).toMatchObject({
      writingStyle: "team",
      customStyles: { team: "team.md" },
    });
    expect(resolveActiveStylePlan()).toMatchObject({
      name: "team",
      fragmentSource: "custom-global",
      selectionSource: "global",
      content: "TEAM",
    });
  });

  it("warns and skips reserved custom names while control-like scalar values remain unknown", () => {
    const d = freshDir();
    const { global } = setStylePaths(d);
    writeRaw(join(d, "team.md"), "TEAM");
    writeJson(global, {
      customStyles: { none: "team.md", off: "team.md", default: "team.md", team: "team.md" },
      writingStyle: "off",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    applyStyleFromConfig(d);
    expect(resolveActiveStylePlan()).toMatchObject({ fragmentSource: "unset", selectionSource: "unset" });
    expect(warn.mock.calls.some(([message]) => String(message).includes('writingStyle "off"'))).toBe(true);
    expect(warn.mock.calls.filter(([message]) => String(message).includes("reserved")).length).toBe(3);
  });

  it("reports raw style scopes and effective durable provenance", () => {
    const d = freshDir();
    const { global, project } = setStylePaths(d);
    writeJson(global, { writingStyle: "clear" });
    writeJson(project, { writingStyle: "none" });
    expect(readStyleDefaultSources(d)).toEqual({ global: "clear", project: "none" });
    expect(effectiveStyleDefaultSource(d)).toEqual({ value: "none", source: "project" });
  });

  it.each(["reload", "startup"] as const)("preserves style override on %s", (reason) => {
    const d = freshDir();
    const { global } = setStylePaths(d);
    writeJson(global, { writingStyle: "clear" });
    setActiveStyle("expressive");
    applySessionStart(reason, d);
    expect(getActiveStyle()).toBe("expressive");
    expect(getEffectiveStyleSelectionSource()).toBe("override");
  });

  it.each(["new", "resume", "fork"] as const)("clears style override on %s", (reason) => {
    const d = freshDir();
    const { global } = setStylePaths(d);
    writeJson(global, { writingStyle: "clear" });
    setActiveStyle("expressive");
    applySessionStart(reason, d);
    expect(getActiveStyle()).toBeUndefined();
    expect(getEffectiveStyleSelectionSource()).toBe("global");
  });
});

describe("readDefaultSources + effectiveDefaultSource", () => {
  beforeEach(() => {
    buildFragments();
  });

  it("returns both scopes' raw values with project-winning effective", () => {
    const d = freshDir();
    const global = join(d, "global.json");
    const project = join(d, "project.json");
    mkdirSync(dirname(global), { recursive: true });
    writeFileSync(global, JSON.stringify({ defaultMode: "extend" }));
    mkdirSync(dirname(project), { recursive: true });
    writeFileSync(project, JSON.stringify({ defaultMode: "safe" }));
    setConfigPathsForTesting({ global, project });

    expect(readDefaultSources(d)).toEqual({
      global: "extend",
      project: "safe",
    });
    expect(effectiveDefaultSource(d)).toEqual({
      value: "safe",
      source: "project",
    });
  });

  it("unset when neither scope has a default", () => {
    const d = freshDir();
    setConfigPathsForTesting({
      global: join(d, "nope-g.json"),
      project: join(d, "nope-p.json"),
    });

    expect(readDefaultSources(d)).toEqual({
      global: undefined,
      project: undefined,
    });
    expect(effectiveDefaultSource(d)).toEqual({
      value: undefined,
      source: "unset",
    });
  });

  it("surfaces `(unreadable)` for a malformed file rather than crashing", () => {
    const d = freshDir();
    const global = join(d, "global.json");
    mkdirSync(dirname(global), { recursive: true });
    writeFileSync(global, "{ broken");
    setConfigPathsForTesting({
      global,
      project: join(d, "nope.json"),
    });

    expect(readDefaultSources(d)).toEqual({
      global: "(unreadable)",
      project: undefined,
    });
  });
});
