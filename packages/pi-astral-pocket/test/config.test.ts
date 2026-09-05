import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_DISTILLER_MODEL, DEFAULT_DISTILLER_REASONING, loadConfig, saveConfig } from "../src/config.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "pocket-config-"));
  roots.push(value);
  return value;
}

describe("pocket config", () => {
  it("defaults malformed and legacy-null model settings to Astra minimal without blocking load", () => {
    const dir = root();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ distiller: { model: null, reasoning: "invalid" } }));
    const config = loadConfig(dir);
    expect(config.distiller.model).toBe(DEFAULT_DISTILLER_MODEL);
    expect(config.distiller.reasoning).toBe(DEFAULT_DISTILLER_REASONING);
  });

  it("atomically persists explicit model and reasoning settings", () => {
    const dir = root();
    const config = loadConfig(dir);
    config.distiller.model = "provider/model";
    config.distiller.reasoning = "high";
    saveConfig(dir, config);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).distiller).toMatchObject({ model: "provider/model", reasoning: "high" });
  });
});
