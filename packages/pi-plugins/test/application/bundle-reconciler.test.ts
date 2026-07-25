import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reconcilePluginBundle } from "../../src/application/bundle-reconciler.js";
import { readClaudePluginManifest } from "../../src/formats/claude/manifest-reader.js";
import { readClaudeHooks } from "../../src/formats/claude/hook-reader.js";
import { readClaudeMarketplace } from "../../src/formats/claude/marketplace-reader.js";
import { readCodexMarketplace } from "../../src/formats/codex/marketplace-reader.js";
import { readCodexPluginManifest } from "../../src/formats/codex/manifest-reader.js";
import { mergeMarketplaces } from "../../src/formats/marketplace-merger.js";
import { createResolvedPluginSource } from "../../src/domain/source.js";
import { PluginKeySchema } from "../../src/domain/identity.js";
import { claim, type Provenance } from "../../src/domain/provenance.js";
import { McpServerComponentSchema } from "../../src/domain/components.js";
import { deriveComponentId } from "../../src/domain/component-identity.js";
import type { ForeignComponentDeclaration, PluginManifestClaims } from "../../src/domain/bundle-ingestion.js";
import type { NormalizedMarketplaceEntry } from "../../src/domain/marketplace.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const plugin = PluginKeySchema.parse("demo@catalog");

function entryForClaude(fields: Record<string, unknown> = {}): NormalizedMarketplaceEntry {
  const result = readClaudeMarketplace({
    name: "catalog",
    plugins: [{ name: "demo", source: "./plugin", strict: false, ...fields }],
  });
  const entry = result.marketplace.entries[0];
  if (entry === undefined) throw new Error("missing test entry");
  return entry;
}

function source(entry: NormalizedMarketplaceEntry) {
  const declared = entry.source.value;
  if (declared.kind !== "marketplace-path") throw new Error("test entry is not a marketplace path");
  return createResolvedPluginSource({
    kind: "marketplace-path",
    marketplaceRevision: "a".repeat(40),
    path: declared.path,
  }, sha256);
}

function manifest(host: "claude" | "codex", value: unknown): PluginManifestClaims {
  const result = host === "claude"
    ? readClaudePluginManifest(value, { plugin, path: ".claude-plugin/plugin.json" })
    : readCodexPluginManifest(value, { plugin, path: ".codex-plugin/plugin.json" });
  if (!result.ok) throw new Error(result.diagnostics[0]?.message ?? "manifest failed");
  return result.value;
}

function foreignFromEntry(entry: NormalizedMarketplaceEntry): ForeignComponentDeclaration[] {
  return entry.declarations.map((declaration) => {
    const provenance = declaration.declaration.provenance[0];
    if (provenance === undefined) throw new Error("test declaration is missing provenance");
    return {
      nativeHost: declaration.nativeHost,
      nativeKind: claim(declaration.field, provenance),
      declarationSubkey: "default",
      declaration: declaration.declaration,
    };
  });
}

function reconcile(
  entry: NormalizedMarketplaceEntry,
  input: Partial<Parameters<typeof reconcilePluginBundle>[0]> = {},
) {
  return reconcilePluginBundle({
    entry,
    source: source(entry),
    manifestClaims: [],
    configuration: [],
    components: [],
    metadata: [],
    sha256,
    ...input,
  });
}

describe("complete plugin bundle reconciliation", () => {
  it("materializes catalog foreign declarations with exact provenance", () => {
    const entry = entryForClaude({ agents: "./agents" });
    const declarations = foreignFromEntry(entry);
    const result = reconcile(entry, { foreignDeclarations: declarations });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.components.foreign).toHaveLength(1);
    expect(result.value.components.foreign[0]).toMatchObject({
      nativeHost: "claude",
      nativeKind: { value: "agents" },
      declaration: { value: "./agents", provenance: [{ location: { pointer: "/plugins/0/agents" } }] },
    });
  });

  it("merges configuration and produces byte-for-byte deterministic output across input order", () => {
    const entry = entryForClaude({ agents: "./agents", commands: "./commands" });
    const declarations = foreignFromEntry(entry);
    const config = manifest("claude", {
      name: "demo",
      userConfig: { TOKEN: { type: "string", title: "Token", sensitive: true } },
    });
    const first = reconcile(entry, {
      foreignDeclarations: declarations,
      manifestClaims: [config],
    });
    const second = reconcile(entry, {
      foreignDeclarations: [...declarations].reverse(),
      manifestClaims: [config],
    });
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.configuration.options).toMatchObject([{ key: "TOKEN", sensitive: true }]);
    expect(first.value.components.foreign.map((component) => component.nativeKind.value).sort()).toEqual([
      "agents",
      "commands",
    ]);
  });

  it("keeps genuinely different semantic subkeys distinct for one foreign kind", () => {
    const entry = entryForClaude();
    const remote = {
      nativeHost: "claude" as const,
      nativeKind: claim("agents", { ...entry.identity.provenance[0]!, location: { ...entry.identity.provenance[0]!.location, documentKind: "manifest", pointer: "/agents/remote" } }),
      declarationSubkey: "key:remote",
      declaration: claim("./remote-agents", { ...entry.identity.provenance[0]!, location: { ...entry.identity.provenance[0]!.location, documentKind: "manifest", pointer: "/agents/remote" } }),
    };
    const local = {
      nativeHost: "claude" as const,
      nativeKind: claim("agents", { ...remote.nativeKind.provenance[0]!, location: { ...remote.nativeKind.provenance[0]!.location, pointer: "/agents/local" } }),
      declarationSubkey: "key:local",
      declaration: claim("./local-agents", { ...remote.declaration.provenance[0]!, location: { ...remote.declaration.provenance[0]!.location, pointer: "/agents/local" } }),
    };

    const result = reconcile(entry, { foreignDeclarations: [remote, local] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.components.foreign).toHaveLength(2);
    expect(result.value.components.foreign.map((component) => component.declarationSubkey)).toEqual([
      "key:local",
      "key:remote",
    ]);
  });

  it("merges equivalent catalog/manifest foreign claims despite different provenance pointers", () => {
    const entry = entryForClaude({ agents: "./agents" });
    const catalog = foreignFromEntry(entry)[0];
    const manifestClaim = manifest("claude", { name: "demo", agents: "./agents" });
    if (catalog === undefined || manifestClaim.foreign[0] === undefined) {
      throw new Error("missing equivalent foreign claims");
    }

    const result = reconcile(entry, {
      foreignDeclarations: [catalog],
      manifestClaims: [manifestClaim],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.components.foreign).toHaveLength(1);
    expect(result.value.components.foreign[0]?.declaration.provenance).toHaveLength(2);
  });

  it("resolves contradictory catalog/manifest foreign claims by precedence with both declarations retained", () => {
    const entry = entryForClaude({ agents: "./agents" });
    const catalog = foreignFromEntry(entry)[0];
    const manifestClaim = manifest("claude", { name: "demo", agents: "./other-agents" });
    if (catalog === undefined || manifestClaim.foreign[0] === undefined) {
      throw new Error("missing contradictory foreign claims");
    }

    // Foreign components never execute, so divergent declarations are drift,
    // not a conflict: the precedence winner is kept and both raw declarations
    // survive in merged provenance.
    const result = reconcile(entry, {
      foreignDeclarations: [catalog],
      manifestClaims: [manifestClaim],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.components.foreign).toHaveLength(1);
    const declarations = result.value.components.foreign[0]!.declaration.provenance
      .map((provenance) => provenance.declaration);
    expect(declarations).toContain("./agents");
    expect(declarations).toContain("./other-agents");
  });

  it("resolves dual-host MCP launch recipes by precedence and records the superseded recipe", async () => {
    // The krometrail shape: Claude points at .mcp.json with a
    // ${CLAUDE_PLUGIN_ROOT} recipe, Codex at .mcp.codex.json with a direct
    // recipe, both naming the same server. Best-effort policy: the
    // precedence winner (Claude) runs; the loser is retained as resolution
    // metadata. Neither blocks the plugin.
    const entry = entryForClaude();
    const claudeRecipe = { command: "${CLAUDE_PLUGIN_ROOT}/bin/serve", args: ["mcp"] };
    const codexRecipe = { command: "sh", args: ["bin/serve", "mcp"], cwd: "." };
    const claudeManifest = manifest("claude", { name: "demo", mcpServers: "./.mcp.json" });
    const codexManifest = manifest("codex", { name: "demo", mcpServers: "./.mcp.codex.json" });
    const provenanceOf = (claims: PluginManifestClaims): Provenance => {
      const provenance = claims.locators[0]?.provenance[0];
      if (provenance === undefined) throw new Error("missing locator provenance");
      return provenance;
    };
    const claudeProvenance = provenanceOf(claudeManifest);
    const codexProvenance = provenanceOf(codexManifest);
    const makeServer = (recipe: Record<string, unknown>, provenance: Provenance) =>
      McpServerComponentSchema.parse({
        kind: "mcp-server",
        id: deriveComponentId(plugin, { kind: "mcp-server", nativeKey: "serve" }, sha256),
        nativeKey: { value: "serve", provenance: [provenance] },
        declaration: { value: recipe, provenance: [provenance] },
        metadata: [],
      });
    const result = reconcile(entry, {
      manifestClaims: [claudeManifest, codexManifest],
      components: [makeServer(codexRecipe, codexProvenance), makeServer(claudeRecipe, claudeProvenance)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.components.mcpServers).toHaveLength(1);
    const server = result.value.components.mcpServers[0]!;
    expect(server.declaration.value).toEqual(claudeRecipe);
    const note = server.metadata.find((entry2) => entry2.key === "pi.reconciliation.precedence-resolution:mcp.declaration");
    expect(note?.claimed.value).toMatchObject({ kept: "claude", superseded: "codex", supersededDeclaration: codexRecipe });
  });

  it("resolves dual-host MCP launch recipes by codex-first precedence and records the superseded recipe", async () => {
    // Same dual-recipe shape as the precedence test above, but with the
    // user's precedence flipped: the Codex recipe runs and the Claude recipe
    // is retained as resolution metadata.
    const entry = entryForClaude();
    const claudeRecipe = { command: "${CLAUDE_PLUGIN_ROOT}/bin/serve", args: ["mcp"] };
    const codexRecipe = { command: "sh", args: ["bin/serve", "mcp"], cwd: "." };
    const claudeManifest = manifest("claude", { name: "demo", mcpServers: "./.mcp.json" });
    const codexManifest = manifest("codex", { name: "demo", mcpServers: "./.mcp.codex.json" });
    const provenanceOf = (claims: PluginManifestClaims): Provenance => {
      const provenance = claims.locators[0]?.provenance[0];
      if (provenance === undefined) throw new Error("missing locator provenance");
      return provenance;
    };
    const claudeProvenance = provenanceOf(claudeManifest);
    const codexProvenance = provenanceOf(codexManifest);
    const makeServer = (recipe: Record<string, unknown>, provenance: Provenance) =>
      McpServerComponentSchema.parse({
        kind: "mcp-server",
        id: deriveComponentId(plugin, { kind: "mcp-server", nativeKey: "serve" }, sha256),
        nativeKey: { value: "serve", provenance: [provenance] },
        declaration: { value: recipe, provenance: [provenance] },
        metadata: [],
      });
    const result = reconcile(entry, {
      manifestClaims: [claudeManifest, codexManifest],
      components: [makeServer(claudeRecipe, claudeProvenance), makeServer(codexRecipe, codexProvenance)],
      hostPrecedence: ["codex", "claude"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.components.mcpServers).toHaveLength(1);
    const server = result.value.components.mcpServers[0]!;
    expect(server.declaration.value).toEqual(codexRecipe);
    const note = server.metadata.find((entry2) => entry2.key === "pi.reconciliation.precedence-resolution:mcp.declaration");
    expect(note?.claimed.value).toMatchObject({ kept: "codex", superseded: "claude", supersededDeclaration: claudeRecipe });
  });

  it("fails closed when a component kind and id disagree", () => {
    const entry = entryForClaude();
    const hooks = readClaudeHooks({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo" }] }] } }, {
      plugin,
      nativeHost: "claude",
      provenance: {
        location: { host: "claude", documentKind: "hooks", path: "hooks/hooks.json", pointer: "" },
      },
    });
    expect(hooks.ok).toBe(true);
    if (!hooks.ok) return;
    const hook = hooks.value[0];
    if (hook === undefined || hook.kind !== "hook") throw new Error("missing hook");
    const mismatched = {
      ...hook,
      kind: "mcp-server" as const,
      nativeKey: hook.event,
    };
    const result = reconcile(entry, { components: [mismatched as never] });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "SCHEMA_INVALID" }] });
    expect(result).not.toHaveProperty("value");
  });

  it("degrades marketplace/manifest description and version drift to canonical precedence", () => {
    const entry = entryForClaude({ description: "entry text", version: "1.0.1" });
    const claudeManifest = manifest("claude", { name: "demo", version: "1.0.0", description: "claude text" });
    const codexManifest = manifest("codex", { name: "demo", version: "1.0.2", description: "codex text" });
    // Real-world catalogs drift from their manifests constantly; both real
    // hosts resolve this by precedence rather than erroring.
    const result = reconcile(entry, { manifestClaims: [claudeManifest, codexManifest] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version?.value).toBe("1.0.1");
    expect(result.value.description?.value).toBe("entry text");
    // Superseded declarations remain auditable in merged provenance.
    expect(result.value.version?.provenance.length).toBe(3);
    expect(result.value.description?.provenance.length).toBe(3);
  });

  it("degrades manifest-only drift to host precedence (Claude before Codex)", () => {
    const entry = entryForClaude();
    const claudeManifest = manifest("claude", { name: "demo", description: "claude text" });
    const codexManifest = manifest("codex", { name: "demo", description: "codex text" });
    const result = reconcile(entry, { manifestClaims: [codexManifest, claudeManifest] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.description?.value).toBe("claude text");
  });

  it("merges divergent dual-manifest locators additively (each host may point at its own file)", () => {
    const claude = readClaudeMarketplace({
      name: "catalog",
      plugins: [{ name: "demo", source: "./plugin", strict: false }],
    });
    const codex = readCodexMarketplace({
      name: "catalog",
      plugins: [{ name: "demo", source: "./plugin", policy: { installation: "AVAILABLE" } }],
    });
    const merged = mergeMarketplaces([
      { nativeHost: "codex", result: codex },
      { nativeHost: "claude", result: claude },
    ]);
    const entry = merged.marketplace.entries[0];
    if (entry === undefined) throw new Error("missing merged entry");
    const claudeManifest = readClaudePluginManifest(
      { name: "demo", skills: "./claude-skills" },
      { plugin, path: ".claude-plugin/plugin.json" },
    );
    const codexManifest = readCodexPluginManifest(
      { name: "demo", skills: "./codex-skills" },
      { plugin, path: ".codex-plugin/plugin.json" },
    );
    expect(claudeManifest.ok).toBe(true);
    expect(codexManifest.ok).toBe(true);
    if (!claudeManifest.ok || !codexManifest.ok) return;
    // Claude `./claude-skills` and Codex `./codex-skills` are both read
    // upstream; divergent locators are an additive union, not a conflict.
    const result = reconcile(entry, { manifestClaims: [claudeManifest.value, codexManifest.value] });
    expect(result.ok).toBe(true);
  });
});
