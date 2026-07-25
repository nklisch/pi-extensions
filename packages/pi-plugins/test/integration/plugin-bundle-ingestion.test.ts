import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPluginInspectionService } from "../../src/application/inspection-service.js";
import type { BundleReaderSet } from "../../src/application/ports/bundle-readers.js";
import { createMaterializationBinding, createContentManifest, hashContent, type ContentManifestEntry } from "../../src/domain/content-manifest.js";
import { createResolvedPluginSource } from "../../src/domain/source.js";
import { readClaudeHooks } from "../../src/formats/claude/hook-reader.js";
import { readClaudePluginManifest } from "../../src/formats/claude/manifest-reader.js";
import { readClaudeMcp } from "../../src/formats/claude/mcp-reader.js";
import { readCodexHooks } from "../../src/formats/codex/hook-reader.js";
import { readCodexPluginManifest } from "../../src/formats/codex/manifest-reader.js";
import { readCodexMcp } from "../../src/formats/codex/mcp-reader.js";
import { readAgentSkill } from "../../src/formats/agent-skills/skill-reader.js";
import { readBoundedYaml } from "../../src/formats/agent-skills/frontmatter-reader.js";
import { mergeMarketplaces } from "../../src/formats/marketplace-merger.js";
import { readClaudeMarketplace } from "../../src/formats/claude/marketplace-reader.js";
import { readCodexMarketplace } from "../../src/formats/codex/marketplace-reader.js";
import { BoundaryError, createNodePluginInspector, type BundleInspectionInput } from "../../src/index.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const fixtureRoot = new URL("../fixtures/plugins/dual-equivalent/", import.meta.url);
const conflictFixtureRoot = new URL("../fixtures/plugins/dual-conflicting/", import.meta.url);
const adversarialFixtureRoot = new URL("../fixtures/plugins/adversarial-bundles/", import.meta.url);

function fixtureBytes(path: string, root = fixtureRoot): Uint8Array {
  return new Uint8Array(readFileSync(new URL(path, root)));
}

function file(path: string, bytes: Uint8Array): ContentManifestEntry {
  return {
    kind: "file",
    path,
    mode: 0o644,
    size: bytes.byteLength,
    digest: hashContent(bytes, sha256),
  };
}

function makeReaders(): BundleReaderSet {
  return {
    claudeManifest: readClaudePluginManifest,
    codexManifest: readCodexPluginManifest,
    claudeHooks: readClaudeHooks,
    codexHooks: readCodexHooks,
    claudeMcp: readClaudeMcp,
    codexMcp: readCodexMcp,
    agentSkill: (markdown, context) => readAgentSkill(markdown, context, sha256),
    skillPresentation: readBoundedYaml,
  };
}

function makeInput(
  files: ReadonlyMap<string, Uint8Array>,
  entry: BundleInspectionInput["entry"],
  extraDirectories: readonly string[] = [],
  resolvedSource?: BundleInspectionInput["materialized"]["source"],
): BundleInspectionInput {
  const entries: ContentManifestEntry[] = [
    { kind: "directory", path: ".claude-plugin", mode: 0o755 },
    { kind: "directory", path: ".codex-plugin", mode: 0o755 },
    { kind: "directory", path: "hooks", mode: 0o755 },
    { kind: "directory", path: "skills", mode: 0o755 },
    { kind: "directory", path: "skills/demo", mode: 0o755 },
    { kind: "directory", path: "skills/demo/agents", mode: 0o755 },
    ...extraDirectories.map((path) => ({ kind: "directory" as const, path, mode: 0o755 as const })),
    ...[...files.entries()].map(([path, bytes]) => file(path, bytes)),
  ];
  const content = createContentManifest(entries, sha256);
  const source = resolvedSource ?? (() => {
    const declared = entry.source.value;
    if (declared.kind !== "marketplace-path") throw new Error("test entry is not a marketplace path");
    return createResolvedPluginSource({
      kind: "marketplace-path",
      marketplaceRevision: "a".repeat(40),
      path: declared.path,
    }, sha256);
  })();
  return {
    entry,
    materialized: {
      root: "/virtual/dual-equivalent",
      source,
      content,
      binding: createMaterializationBinding(source.hash, content.rootDigest, sha256),
    },
  };
}

function mergedEntry() {
  const claude = readClaudeMarketplace({
    name: "fixture",
    plugins: [{
      name: "demo",
      source: "./plugin",
      strict: false,
      version: "1.0.0",
      description: "A deterministic fixture",
      skills: "./skills",
      hooks: "./hooks/hooks.json",
    }],
  });
  const codex = readCodexMarketplace({
    name: "fixture",
    plugins: [{
      name: "demo",
      source: "./plugin",
      policy: { installation: "AVAILABLE" },
      version: "1.0.0",
      description: "A deterministic fixture",
      skills: "./skills",
      hooks: "./hooks/hooks.json",
    }],
  });
  const merged = mergeMarketplaces([
    { nativeHost: "codex", result: codex },
    { nativeHost: "claude", result: claude },
  ]);
  expect(merged.diagnostics).toEqual([]);
  const entry = merged.marketplace.entries[0];
  if (entry === undefined) throw new Error("fixture entry was not merged");
  return entry;
}

function claudeOnlyEntry() {
  const result = readClaudeMarketplace({
    name: "fixture",
    plugins: [{ name: "demo", source: "./plugin", strict: false }],
  });
  const entry = result.marketplace.entries[0];
  if (entry === undefined) throw new Error("Claude fixture entry was not parsed");
  return entry;
}

describe("plugin bundle inspection integration", () => {
  it("produces one complete deterministic dual-format inventory", async () => {
    const files = new Map<string, Uint8Array>([
      [".claude-plugin/plugin.json", fixtureBytes(".claude-plugin/plugin.json")],
      [".codex-plugin/plugin.json", fixtureBytes(".codex-plugin/plugin.json")],
      ["hooks/hooks.json", fixtureBytes("hooks/hooks.json")],
      ["skills/demo/SKILL.md", fixtureBytes("skills/demo/SKILL.md")],
      ["skills/demo/agents/openai.yaml", fixtureBytes("skills/demo/agents/openai.yaml")],
    ]);
    const reads: string[] = [];
    const service = createPluginInspectionService({
      content: {
        async readFile(file) {
          reads.push(file.entry.path);
          const bytes = files.get(file.entry.path);
          if (bytes === undefined) throw new Error(`missing fixture ${file.entry.path}`);
          return bytes;
        },
      },
      readers: makeReaders(),
      sha256,
    });
    const input = makeInput(files, mergedEntry());
    const first = await service.inspect(input, new AbortController().signal);
    const second = await service.inspect(input, new AbortController().signal);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.identity.key).toBe("demo@fixture");
    expect(first.value.identity).not.toHaveProperty("manifestName");
    expect(first.value.components.skills).toHaveLength(1);
    expect(first.value.components.hooks).toHaveLength(1);
    expect(first.value.components.foreign).toHaveLength(0);
    expect(first.value.components.skills[0]?.metadata.map((item) => item.key)).toEqual([
      "agent-skills.description",
      "agent-skills.metadata",
      "codex.agents.interface",
      "codex.agents.policy",
    ]);
    expect(reads).toContain(".claude-plugin/plugin.json");
    expect(reads).toContain(".codex-plugin/plugin.json");
    expect(reads).toContain("skills/demo/SKILL.md");
  });

  it("runs the same fixture through the explicit Node composition root", async () => {
    const files = new Map<string, Uint8Array>([
      [".claude-plugin/plugin.json", fixtureBytes(".claude-plugin/plugin.json")],
      [".codex-plugin/plugin.json", fixtureBytes(".codex-plugin/plugin.json")],
      ["hooks/hooks.json", fixtureBytes("hooks/hooks.json")],
      ["skills/demo/SKILL.md", fixtureBytes("skills/demo/SKILL.md")],
      ["skills/demo/agents/openai.yaml", fixtureBytes("skills/demo/agents/openai.yaml")],
    ]);
    const input = makeInput(files, mergedEntry());
    const result = await createNodePluginInspector().inspect({
      ...input,
      materialized: {
        ...input.materialized,
        root: fileURLToPath(fixtureRoot),
      },
    }, new AbortController().signal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.components.skills).toHaveLength(1);
    expect(result.value.components.hooks).toHaveLength(1);
  });

  it("accepts valid immutable Git handoffs end to end for both source kinds", async () => {
    const files = new Map<string, Uint8Array>([
      [".claude-plugin/plugin.json", fixtureBytes(".claude-plugin/plugin.json")],
    ]);
    const service = createPluginInspectionService({
      content: { readFile: async (file) => files.get(file.entry.path) ?? text("{}") },
      readers: makeReaders(),
      sha256,
    });
    const revision = "a".repeat(40);
    const url = "https://example.test/plugin.git";

    for (const kind of ["git", "git-subdir"] as const) {
      for (const selectors of [
        { ref: "main", sha: revision },
        { ref: revision },
        { ref: "main" },
      ]) {
        const rawSource = kind === "git"
          ? { source: "url", url, ...selectors }
          : { source: "git-subdir", url, path: "plugins/demo", ...selectors };
        const parsed = readClaudeMarketplace({
          name: "fixture",
          plugins: [{ name: "demo", source: rawSource, strict: false }],
        });
        const entry = parsed.marketplace.entries[0];
        if (entry === undefined) throw new Error("Git fixture entry was not parsed");
        const declared = entry.source.value;
        const source = declared.kind === "git"
          ? createResolvedPluginSource({ kind: "git", url: declared.url, revision }, sha256)
          : declared.kind === "git-subdir"
            ? createResolvedPluginSource({ kind: "git-subdir", url: declared.url, path: declared.path, revision }, sha256)
            : (() => { throw new Error("expected a Git source"); })();
        const result = await service.inspect(
          makeInput(files, entry, [], source),
          new AbortController().signal,
        );
        expect(result.ok, `${kind} ${JSON.stringify(selectors)}`).toBe(true);
        if (!result.ok) continue;
        expect(result.value.source).toMatchObject({ kind, url, revision });
        if (kind === "git-subdir") {
          if (result.value.source.kind !== "git-subdir") throw new Error("expected a Git subdirectory source");
          expect(result.value.source.path).toBe("plugins/demo");
        }
      }
    }
  });

  it("reconciles equivalent catalog and manifest foreign claims end to end", async () => {
    const catalog = readClaudeMarketplace({
      name: "fixture",
      plugins: [{ name: "demo", source: "./plugin", strict: false, agents: "./agents" }],
    });
    const entry = catalog.marketplace.entries[0];
    if (entry === undefined) throw new Error("foreign fixture entry was not parsed");
    const files = new Map<string, Uint8Array>([
      [".claude-plugin/plugin.json", text(JSON.stringify({ name: "demo", agents: "./agents" }))],
    ]);
    const service = createPluginInspectionService({
      content: { readFile: async (file) => files.get(file.entry.path) ?? text("{}") },
      readers: makeReaders(),
      sha256,
    });

    const result = await service.inspect(makeInput(files, entry), new AbortController().signal);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.components.foreign).toHaveLength(1);
    expect(result.value.components.foreign[0]?.declaration.provenance).toHaveLength(2);
    expect(result.value.components.foreign[0]?.declaration.provenance.map((claim) => claim.location.documentKind))
      .toEqual(expect.arrayContaining(["marketplace", "manifest"]));
  });

  it("resolves contradictory catalog and manifest foreign claims by precedence end to end", async () => {
    const catalog = readClaudeMarketplace({
      name: "fixture",
      plugins: [{ name: "demo", source: "./plugin", strict: false, agents: "./agents" }],
    });
    const entry = catalog.marketplace.entries[0];
    if (entry === undefined) throw new Error("foreign fixture entry was not parsed");
    const files = new Map<string, Uint8Array>([
      [".claude-plugin/plugin.json", text(JSON.stringify({ name: "demo", agents: "./other-agents" }))],
    ]);
    const service = createPluginInspectionService({
      content: { readFile: async (file) => files.get(file.entry.path) ?? text("{}") },
      readers: makeReaders(),
      sha256,
    });

    const result = await service.inspect(makeInput(files, entry), new AbortController().signal);

    // Foreign components never execute: precedence wins, both declarations
    // remain in provenance, and the plugin still inspects cleanly.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.components.foreign).toHaveLength(1);
    const declarations = result.value.components.foreign[0]!.declaration.provenance
      .map((provenance) => provenance.declaration);
    expect(declarations).toContain("./agents");
    expect(declarations).toContain("./other-agents");
  });

  it("merges divergent dual manifest locators additively", async () => {
    const entry = mergedEntry();
    const files = new Map<string, Uint8Array>([
      [".claude-plugin/plugin.json", fixtureBytes(".claude-plugin/plugin.json", conflictFixtureRoot)],
      [".codex-plugin/plugin.json", fixtureBytes(".codex-plugin/plugin.json", conflictFixtureRoot)],
      ["hooks/hooks.json", text('{"hooks":{}}')],
      ["skills-a/SKILL.md", text('---\nname: a\ndescription: a\n---\n')],
      ["skills-b/SKILL.md", text('---\nname: b\ndescription: b\n---\n')],
    ]);
    const service = createPluginInspectionService({
      content: { readFile: async (file) => files.get(file.entry.path) ?? text("{}") },
      readers: makeReaders(),
      sha256,
    });
    // Claude's manifest points at ./skills-a, Codex's at ./skills-b; both
    // locator targets are read and their skills unioned.
    const result = await service.inspect(makeInput(files, entry, ["skills-a", "skills-b"]), new AbortController().signal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.components.skills.map((skill) => skill.name.value).sort()).toEqual(["a", "b"]);
  });

  it("keeps malformed present JSON at the value boundary and preserves abort", async () => {
    const entry = claudeOnlyEntry();
    const files = new Map<string, Uint8Array>([[
      ".claude-plugin/plugin.json",
      fixtureBytes("duplicate-json.json", adversarialFixtureRoot),
    ]]);
    const service = createPluginInspectionService({
      content: { readFile: async (file) => files.get(file.entry.path) ?? text("{}") },
      readers: makeReaders(),
      sha256,
    });
    const result = await service.inspect(makeInput(files, entry), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ diagnostics: [{ code: "MANIFEST_ROOT_INVALID" }] });
    expect(result).not.toHaveProperty("value");

    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(service.inspect(makeInput(files, entry), controller.signal)).rejects.toBe(reason);
  });

  it("converts an untrustworthy content adapter failure into BoundaryError", async () => {
    const files = new Map<string, Uint8Array>([
      [".claude-plugin/plugin.json", fixtureBytes(".claude-plugin/plugin.json")],
      [".codex-plugin/plugin.json", fixtureBytes(".codex-plugin/plugin.json")],
      ["hooks/hooks.json", fixtureBytes("hooks/hooks.json")],
      ["skills/demo/SKILL.md", fixtureBytes("skills/demo/SKILL.md")],
      ["skills/demo/agents/openai.yaml", fixtureBytes("skills/demo/agents/openai.yaml")],
    ]);
    const service = createPluginInspectionService({
      content: { readFile: async () => { throw new Error("native failure"); } },
      readers: makeReaders(),
      sha256,
    });
    await expect(service.inspect(makeInput(files, mergedEntry()), new AbortController().signal))
      .rejects.toMatchObject({ code: "ADAPTER_FAILED" });
    await expect(service.inspect(makeInput(files, mergedEntry()), new AbortController().signal))
      .rejects.toBeInstanceOf(BoundaryError);
  });
});