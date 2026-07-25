import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readClaudePluginManifest } from "../../../src/formats/claude/manifest-reader.js";
import { PluginKeySchema } from "../../../src/domain/identity.js";

const plugin = PluginKeySchema.parse("agile-workflow@nklisch-skills");
const path = ".claude-plugin/plugin.json";
const context = { plugin, path };
const fixture = JSON.parse(readFileSync(
  new URL("../../fixtures/plugins/manifests/nklisch-skills-agile-workflow-claude.json", import.meta.url),
).toString()) as unknown;

describe("Claude plugin manifest reader", () => {
  it("normalizes the real metadata-only nklisch/skills manifest", () => {
    const result = readClaudePluginManifest(fixture, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name?.value).toBe("agile-workflow");
    expect(result.value.version?.value).toBe("0.16.1");
    expect(result.value.locators).toEqual([]);
    expect(result.value.foreign).toEqual([]);
    expect(result.value.metadata.map((item) => item.key)).toEqual([
      "claude.author",
      "claude.license",
      "claude.repository",
    ]);
    expect(result.value.document.location).toMatchObject({
      host: "claude",
      documentKind: "manifest",
      path,
      pointer: "",
    });
  });

  it("normalizes Claude userConfig descriptors without retaining a configured value", () => {
    const result = readClaudePluginManifest({
      name: "demo",
      userConfig: {
        API_KEY: { type: "string", title: "API key", sensitive: true },
        RETRIES: { type: "number", default: 2, min: 0, max: 3 },
      },
    }, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.configuration).toMatchObject([
      { key: "API_KEY", label: { value: "API key" }, sensitive: true, value: { kind: "string" } },
      { key: "RETRIES", value: { kind: "number", default: 2, min: 0, max: 3 } },
    ]);
    expect(result.value.foreign).toEqual([]);
    expect(result.value).not.toHaveProperty("configured");
  });

  it("keeps unsupported runtime declarations and unknown fields as foreign data", () => {
    const result = readClaudePluginManifest({
      name: "demo",
      agents: "./agents",
      lspServers: { languageServer: { command: "server" } },
      futureShape: { command: "server" },
      interface: { displayName: "Demo" },
    }, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.foreign.map((item) => item.nativeKind.value)).toEqual([
      "agents",
      "futureShape",
      "lspServers",
    ]);
    expect(result.value.foreign[0]?.declaration.provenance[0]?.location.pointer).toBe("/agents");
    expect(result.value.metadata.map((item) => item.key)).toContain("claude.interface");
    expect(result.value).not.toHaveProperty("verdict");
  });

  it("reads explicit supported pointers and rejects unsafe paths", () => {
    const result = readClaudePluginManifest({
      name: "demo",
      skills: ["./skills", "./more-skills/"],
      hooks: "./hooks/hooks.json",
      mcpServers: { local: { command: "server" } },
    }, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.locators.map((item) => item.target)).toEqual([
      { kind: "directory", path: "./skills" },
      { kind: "directory", path: "./more-skills" },
      { kind: "file", path: "./hooks/hooks.json" },
      { kind: "inline", declaration: { local: { command: "server" } } },
    ]);

    const unsafe = readClaudePluginManifest({ name: "demo", skills: "./skills/../escape" }, context);
    expect(unsafe.ok).toBe(false);
    expect(unsafe).toMatchObject({ diagnostics: [{ code: "SCHEMA_INVALID", location: { pointer: "/skills" } }] });
  });

  it("is a pure unknown-input reader and fails malformed roots without partial claims", () => {
    const result = readClaudePluginManifest({ name: 7 }, context);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ diagnostics: [{ code: "SCHEMA_INVALID", location: { pointer: "/name" } }] });
    expect(readClaudePluginManifest([], context).ok).toBe(false);
  });
});
