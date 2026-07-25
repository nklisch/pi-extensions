import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readCodexPluginManifest } from "../../../src/formats/codex/manifest-reader.js";
import { PluginKeySchema } from "../../../src/domain/identity.js";

const context = {
  plugin: PluginKeySchema.parse("agile-workflow@nklisch-skills"),
  path: ".codex-plugin/plugin.json",
};
const fixture = JSON.parse(readFileSync(
  new URL("../../fixtures/plugins/manifests/nklisch-skills-agile-workflow-codex.json", import.meta.url),
).toString()) as unknown;

describe("Codex plugin manifest reader", () => {
  it("normalizes the real paired manifest without deriving Claude metadata into components", () => {
    const result = readCodexPluginManifest(fixture, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name?.value).toBe("agile-workflow");
    expect(result.value.locators.map((locator) => locator.target)).toEqual([
      { kind: "directory", path: "./skills" },
      { kind: "file", path: "./hooks/hooks.json" },
    ]);
    expect(result.value.locators.every((locator) => locator.nativeHost === "codex")).toBe(true);
    expect(result.value.metadata.map((item) => item.key)).toContain("codex.interface");
    expect(result.value.foreign).toEqual([]);
  });

  it("retains Codex-only runtime declarations as foreign inventory", () => {
    const result = readCodexPluginManifest({
      name: "demo",
      apps: "./.app.json",
      connectors: { github: { enabled: true } },
      interface: { displayName: "Demo", futureField: { color: "blue" } },
    }, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.foreign.map((item) => item.nativeKind.value)).toEqual(["apps", "connectors"]);
    expect(result.value.metadata[0]?.key).toBe("codex.interface");
    expect(result.value.foreign[1]?.declaration.value).toEqual({ enabled: true });
    expect(result.value.foreign[1]?.declarationSubkey).toBe("key:github");
  });

  it("rejects unsupported path forms before discovery can see them", () => {
    const result = readCodexPluginManifest({ name: "demo", skills: "skills" }, context);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ diagnostics: [{ code: "SCHEMA_INVALID", location: { pointer: "/skills" } }] });
  });
});
