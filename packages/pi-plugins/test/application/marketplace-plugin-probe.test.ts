import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMarketplacePluginProbe } from "../../src/application/marketplace-plugin-probe.js";
import { createContentManifest, createMaterializationBinding } from "../../src/domain/content-manifest.js";
import { CompatibilityReportSchema } from "../../src/domain/compatibility.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { createResolvedMarketplaceSource, createResolvedPluginSource } from "../../src/domain/source.js";
import { createInstalledRevisionRecord } from "../../src/domain/state/installed-state.js";
import { deriveMarketplaceSourceIdentity, derivePluginSourceIdentity } from "../../src/domain/update-policy.js";
import { readClaudeMarketplace } from "../../src/formats/claude/marketplace-reader.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;
const declaredSource = { kind: "github" as const, repository: "example/community" };
const revision = "c".repeat(40);
const marketplaceSource = createResolvedMarketplaceSource({ declared: declaredSource, revision }, sha256);

const names = ["alpha", "bravo", "charlie", "delta", "echo"];
const entryByName = new Map(names.map((name) => [
  name,
  readClaudeMarketplace({ name: "community", plugins: [{ name, source: `./plugins/${name}`, strict: false }] }).marketplace.entries[0]!,
]));
const entries = names.map((name) => entryByName.get(name)!);

function pluginAt(name: string, marketplaceRevision: string) {
  const entry = entryByName.get(name)!;
  const path = entry.source.value.kind === "marketplace-path" ? entry.source.value.path : "plugin";
  return NormalizedPluginSchema.parse({
    identity: { key: `${name}@community`, marketplaceName: "community", marketplaceEntryName: name },
    source: createResolvedPluginSource({ kind: "marketplace-path", marketplaceRevision, path }, sha256),
    configuration: { options: [] },
    components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
    metadata: [],
  });
}

function pluginFor(name: string) {
  return pluginAt(name, revision);
}

const content = createContentManifest([], sha256);

function installedRecord(name: string) {
  // The installed copy trails the marketplace tip, so every probe finds an update.
  const plugin = pluginAt(name, "b".repeat(40));
  const compatibility = CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
  const entry = entryByName.get(name)!;
  const installedRevision = createInstalledRevisionRecord({
    plugin,
    compatibility,
    content,
    scope: { kind: "user" },
    marketplaceSourceIdentity: deriveMarketplaceSourceIdentity(declaredSource, sha256),
    pluginSourceIdentity: derivePluginSourceIdentity(entry.source.value, sha256),
  }, sha256);
  return {
    plugin: plugin.identity.key,
    activation: "enabled" as const,
    selectedRevision: installedRevision.revision,
    revisions: [installedRevision],
  };
}

describe("marketplace plugin probe", () => {
  it("preserves sorted plugin order when parallel probes finish out of order", async () => {
    // Reverse-alphabetical completion: echo returns first, alpha last.
    const delays = new Map(names.map((name, index) => [name, (names.length - index) * 5]));
    const probe = createMarketplacePluginProbe({
      state: {
        async read() {
          return {
            ok: true,
            snapshot: {
              scope: { kind: "user" },
              installed: { plugins: names.map(installedRecord) },
            },
          };
        },
      } as never,
      content: {
        async allocateStaging() { return { slot: {} }; },
        async discardStaging() { return undefined; },
      } as never,
      materializer: {
        async materialize(source: { kind: string; path?: string }) {
          const name = names.find((candidate) => (source.path ?? "").includes(candidate) || candidate === nameFromPath(source))!;
          await new Promise((resolve) => setTimeout(resolve, delays.get(name)));
          const plugin = pluginFor(name);
          return {
            source: plugin.source,
            content,
            binding: createMaterializationBinding(plugin.source.hash, content.rootDigest, sha256),
          };
        },
      } as never,
      inspector: {
        async inspect(request: { materialized: { source: { hash: string } } }) {
          const plugin = names.map(pluginFor).find((candidate) => candidate.source.hash === request.materialized.source.hash)!;
          return { ok: true, value: plugin };
        },
      } as never,
      compatibility: {
        async assess(request: { plugin: ReturnType<typeof pluginFor> }) {
          return CompatibilityReportSchema.parse({ plugin: request.plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
        },
      } as never,
      sha256,
    });

    const results = await probe({
      scope: { kind: "user" },
      record: { source: declaredSource },
      snapshot: { marketplace: "community" },
      catalog: { marketplace: { entries } },
      marketplace: { root: {}, source: marketplaceSource, content, binding: {} },
      signal,
    } as never);

    // Every probe reports an update (the re-derived revision differs from the
    // installed one by construction here), in sorted plugin order regardless
    // of reverse-alphabetical async completion.
    expect(results.map((result) => result.plugin)).toEqual(names.map((name) => `${name}@community`).sort());
  });
});

function nameFromPath(source: { path?: string }): string {
  return names.find((name) => source.path?.includes(name)) ?? names[0]!;
}
