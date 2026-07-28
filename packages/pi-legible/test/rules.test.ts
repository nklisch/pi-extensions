import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearGlobalRulesPathForTest,
  DEFAULT_RULES,
  loadRules,
  RULES_FILE_NAME,
  setGlobalRulesPathForTest,
} from "../src/rules.js";

let dir: string;
let globalRules: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-legible-rules-"));
  globalRules = join(dir, "global-LEGIBLE.md");
  setGlobalRulesPathForTest(globalRules);
});

afterEach(() => {
  clearGlobalRulesPathForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe("loadRules", () => {
  it("falls back to built-in defaults when no file exists", () => {
    const rules = loadRules(dir);
    expect(rules.text).toBe(DEFAULT_RULES);
    expect(rules.source).toBeUndefined();
  });

  it("prefers the project LEGIBLE.md", () => {
    writeFileSync(join(dir, RULES_FILE_NAME), "project rules");
    writeFileSync(globalRules, "global rules");
    const rules = loadRules(dir);
    expect(rules.text).toBe("project rules");
    expect(rules.source).toBe(join(dir, RULES_FILE_NAME));
  });

  it("uses the global file when the project has none", () => {
    writeFileSync(globalRules, "global rules");
    const rules = loadRules(dir);
    expect(rules.text).toBe("global rules");
    expect(rules.source).toBe(globalRules);
  });

  it("skips the project file when the project is not trusted", () => {
    writeFileSync(join(dir, RULES_FILE_NAME), "injected rules");
    writeFileSync(globalRules, "global rules");
    const rules = loadRules(dir, { trusted: false });
    expect(rules.text).toBe("global rules");
    expect(rules.source).toBe(globalRules);
  });

  it("treats an empty project file as absent", () => {
    writeFileSync(join(dir, RULES_FILE_NAME), "  \n ");
    const rules = loadRules(dir);
    expect(rules.text).toBe(DEFAULT_RULES);
  });
});
