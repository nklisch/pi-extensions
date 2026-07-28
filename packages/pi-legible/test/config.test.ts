import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clampDepth,
  clearConfigPathsForTest,
  DEFAULTS,
  globalConfigPath,
  loadConfig,
  MAX_CONTEXT_DEPTH,
  saveGlobalConfig,
  setConfigPathsForTest,
} from "../src/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-legible-config-"));
  setConfigPathsForTest(join(dir, "global.json"), join(dir, "project.json"));
});

afterEach(() => {
  clearConfigPathsForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns defaults when no files exist", () => {
    expect(loadConfig(dir)).toEqual(DEFAULTS);
  });

  it("treats malformed JSON as empty config", () => {
    writeFileSync(globalConfigPath(), "{not json");
    expect(loadConfig(dir)).toEqual(DEFAULTS);
  });

  it("merges global and project, project wins per key", () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ enabled: false, model: "openai/gpt-5.6", contextDepth: 3 }));
    writeFileSync(join(dir, "project.json"), JSON.stringify({ contextDepth: 10 }));
    expect(loadConfig(dir)).toEqual({
      enabled: false,
      model: "openai/gpt-5.6",
      contextDepth: 10,
      includeToolCalls: true,
    });
  });

  it("ignores an empty model string", () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ model: "   " }));
    expect(loadConfig(dir).model).toBeUndefined();
  });

  it("drops wrong-typed fields instead of coercing them", () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ enabled: "false", includeToolCalls: "no", contextDepth: "six", model: 42 }));
    expect(loadConfig(dir)).toEqual(DEFAULTS);
  });

  it("ignores the project file when the project is not trusted", () => {
    writeFileSync(join(dir, "project.json"), JSON.stringify({ enabled: false, model: "evil/injected" }));
    expect(loadConfig(dir, { trusted: false })).toEqual(DEFAULTS);
    expect(loadConfig(dir, { trusted: true }).enabled).toBe(false);
  });
});

describe("saveGlobalConfig", () => {
  it("writes atomically and patches only given keys", () => {
    saveGlobalConfig({ enabled: false });
    saveGlobalConfig({ contextDepth: 2 });
    const saved = JSON.parse(readFileSync(globalConfigPath(), "utf8"));
    expect(saved).toEqual({ enabled: false, contextDepth: 2 });
  });

  it("deletes keys patched with undefined", () => {
    saveGlobalConfig({ model: "openai/gpt-5.6" });
    saveGlobalConfig({ model: undefined });
    const saved = JSON.parse(readFileSync(globalConfigPath(), "utf8"));
    expect(saved).toEqual({});
  });
});

describe("clampDepth", () => {
  it("clamps into range and floors", () => {
    expect(clampDepth(-5)).toBe(0);
    expect(clampDepth(3.9)).toBe(3);
    expect(clampDepth(999)).toBe(MAX_CONTEXT_DEPTH);
    expect(clampDepth(Number.NaN)).toBe(DEFAULTS.contextDepth);
  });
});
