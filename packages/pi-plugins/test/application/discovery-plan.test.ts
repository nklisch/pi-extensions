import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createContentIndex } from "../../src/application/content-index.js";
import { createDiscoveryPlan } from "../../src/application/discovery-plan.js";
import { createContentManifest, hashContent, type ContentManifestEntry } from "../../src/domain/content-manifest.js";
import { readClaudeMarketplace } from "../../src/formats/claude/marketplace-reader.js";
import { readCodexMarketplace } from "../../src/formats/codex/marketplace-reader.js";
import { readClaudePluginManifest } from "../../src/formats/claude/manifest-reader.js";
import { readCodexPluginManifest } from "../../src/formats/codex/manifest-reader.js";
import { PluginKeySchema } from "../../src/domain/identity.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const file = (path: string, value = "{}"): ContentManifestEntry => ({
  kind: "file",
  path,
  mode: 0o644,
  size: bytes(value).byteLength,
  digest: hashContent(bytes(value), sha256),
});

function content(...entries: ContentManifestEntry[]) {
  return createContentIndex(createContentManifest(entries, sha256));
}

describe("authority-aware discovery planning", () => {
  it("allows absent Claude strict-false manifests and merges catalog locators with conventions", () => {
    const entry = readClaudeMarketplace({
      name: "catalog",
      plugins: [{
        name: "demo",
        source: "./demo",
        strict: false,
        skills: ["./skills"],
        hooks: "./hooks/hooks.json",
        agents: ["./agents"],
      }],
    }).marketplace.entries[0]!;
    const result = createDiscoveryPlan({
      entry,
      content: content(
        { kind: "directory", path: "skills", mode: 0o755 },
        { kind: "directory", path: "hooks", mode: 0o755 },
        file("SKILL.md", "skill"),
        file("hooks/hooks.json"),
        file(".mcp.json"),
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifests).toEqual([{
      nativeHost: "claude",
      path: ".claude-plugin/plugin.json",
      required: false,
      present: false,
    }]);
    expect(result.value.locators.map((locator) => locator.target)).toEqual([
      { kind: "file", path: "./hooks/hooks.json" },
      { kind: "file", path: "./.mcp.json" },
      { kind: "directory", path: "./skills" },
      { kind: "file", path: "./SKILL.md" },
    ]);
    expect(result.value.locators.find((locator) => locator.target.kind !== "inline" && locator.target.path === "./skills")?.provenance)
      .toHaveLength(2);
    expect(result.value.catalogForeign[0]?.nativeKind.value).toBe("agents");
  });

  it("requires the Claude default and Codex manifests", () => {
    const claudeEntry = readClaudeMarketplace({
      name: "catalog",
      plugins: [{ name: "demo", source: "./demo" }],
    }).marketplace.entries[0]!;
    const claude = createDiscoveryPlan({ entry: claudeEntry, content: content() });
    expect(claude).toMatchObject({ diagnostics: [{ code: "MANIFEST_ROOT_INVALID" }] });

    const codexEntry = readCodexMarketplace({
      name: "catalog",
      plugins: [{ name: "demo", source: "./demo", policy: { installation: "AVAILABLE" } }],
    }).marketplace.entries[0]!;
    const codex = createDiscoveryPlan({ entry: codexEntry, content: content() });
    expect(codex).toMatchObject({ diagnostics: [{ code: "MANIFEST_ROOT_INVALID" }] });
  });

  it("uses only Codex manifest locators and no synthetic root skill", () => {
    const entry = readCodexMarketplace({
      name: "catalog",
      plugins: [{ name: "demo", source: "./demo", policy: { installation: "AVAILABLE" } }],
    }).marketplace.entries[0]!;
    const manifest = readCodexPluginManifest(
      { name: "demo", skills: "./skills" },
      { plugin: PluginKeySchema.parse("demo@catalog"), path: ".codex-plugin/plugin.json" },
    );
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const result = createDiscoveryPlan({
      entry,
      codexManifest: manifest.value,
      content: content(
        { kind: "directory", path: ".codex-plugin", mode: 0o755 },
        file(".codex-plugin/plugin.json"),
        { kind: "directory", path: "skills", mode: 0o755 },
        { kind: "directory", path: "skills/demo", mode: 0o755 },
        file("SKILL.md", "root skill"),
        file("skills/demo/SKILL.md", "nested skill"),
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.locators).toEqual([expect.objectContaining({
      target: { kind: "directory", path: "./skills" },
    })]);
    expect(result.value.locators.some((locator) => locator.target.kind === "file")).toBe(false);
  });

  it("reconciles a present optional Claude manifest instead of skipping it", () => {
    const entry = readClaudeMarketplace({
      name: "catalog",
      plugins: [{ name: "demo", source: "./demo", strict: false }],
    }).marketplace.entries[0]!;
    const manifest = readClaudePluginManifest(
      { name: "demo", skills: "./declared-skills" },
      { plugin: PluginKeySchema.parse("demo@catalog"), path: ".claude-plugin/plugin.json" },
    );
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const result = createDiscoveryPlan({
      entry,
      claudeManifest: manifest.value,
      content: content(
        { kind: "directory", path: ".claude-plugin", mode: 0o755 },
        file(".claude-plugin/plugin.json"),
        { kind: "directory", path: "declared-skills", mode: 0o755 },
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifests[0]?.present).toBe(true);
    expect(result.value.locators).toHaveLength(1);
    expect(result.value.locators[0]?.source).toBe("manifest");
  });

  it("unions divergent catalog and manifest locators additively", () => {
    const entry = readClaudeMarketplace({
      name: "catalog",
      plugins: [{ name: "demo", source: "./demo", strict: false, skills: ["./catalog-skills"] }],
    }).marketplace.entries[0]!;
    const manifest = readClaudePluginManifest(
      { name: "demo", skills: "./manifest-skills" },
      { plugin: PluginKeySchema.parse("demo@catalog"), path: ".claude-plugin/plugin.json" },
    );
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const result = createDiscoveryPlan({
      entry,
      claudeManifest: manifest.value,
      content: content(
        { kind: "directory", path: ".claude-plugin", mode: 0o755 },
        file(".claude-plugin/plugin.json"),
        { kind: "directory", path: "catalog-skills", mode: 0o755 },
        { kind: "directory", path: "manifest-skills", mode: 0o755 },
      ),
    });
    // Real hosts treat catalog declarations as additive supplements to the
    // manifest, so divergent locators union rather than conflict.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const paths = result.value.locators.map((locator) =>
      locator.target.kind === "directory" || locator.target.kind === "file" ? locator.target.path : undefined);
    expect(paths).toContain("./catalog-skills");
    expect(paths).toContain("./manifest-skills");
  });

  it("fails explicit locators that are absent from the verified content index", () => {
    const entry = readClaudeMarketplace({
      name: "catalog",
      plugins: [{ name: "demo", source: "./demo", strict: false, skills: ["./missing"] }],
    }).marketplace.entries[0]!;
    const result = createDiscoveryPlan({ entry, content: content() });
    expect(result).toMatchObject({
      diagnostics: [{ code: "PATH_CONTAINMENT_FAILED", details: { path: "missing" } }],
    });
  });
});
