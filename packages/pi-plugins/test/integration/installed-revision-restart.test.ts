import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInstalledRevisionDescriptor } from "../../src/application/installed-revision-descriptor.js";
import { createPromotionPlan } from "../../src/application/content-promotion.js";
import { CompatibilityReportSchema } from "../../src/domain/compatibility.js";
import { createContentManifest, createMaterializationBinding } from "../../src/domain/content-manifest.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { createInstalledRevisionRecord } from "../../src/domain/state/installed-state.js";
import { createResolvedMarketplaceSource, createResolvedPluginSource } from "../../src/domain/source.js";
import { createNodeContentInfrastructureWithPlatform } from "../../src/infrastructure/filesystem/create-content-store.js";
import { createNodeContentStorePlatform, renameNoReplaceByProbe } from "../../src/infrastructure/filesystem/content-store-durability.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;

function evidence(revisionCharacter = "a") {
  const source = createResolvedPluginSource({ kind: "marketplace-path", marketplaceRevision: revisionCharacter.repeat(40), path: "./plugin" }, sha256);
  const plugin = NormalizedPluginSchema.parse({
    identity: { key: "fixture@community", marketplaceName: "community", marketplaceEntryName: "fixture" },
    source,
    configuration: { options: [] },
    components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
    metadata: [],
  });
  const compatibility = CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
  const content = createContentManifest([], sha256);
  const binding = createMaterializationBinding(source.hash, content.rootDigest, sha256);
  const revision = createInstalledRevisionRecord({ plugin, compatibility, content, scope: { kind: "user" } }, sha256);
  const loaded = {
    plugin,
    compatibility,
    marketplaceSource: createResolvedMarketplaceSource({ declared: { kind: "github", repository: "example/plugins" }, revision: revisionCharacter.repeat(40) }, sha256),
    content,
    binding,
  };
  return { source, plugin, compatibility, content, binding, revision, loaded };
}

async function makeWritable(publishedContentRoot: string): Promise<void> {
  const root = dirname(publishedContentRoot);
  await chmod(join(root, "content"), 0o755).catch(() => undefined);
  await chmod(join(root, "metadata.json"), 0o644).catch(() => undefined);
  await chmod(join(root, "READY"), 0o644).catch(() => undefined);
  await chmod(root, 0o755).catch(() => undefined);
}

describe("installed revision restart loading", () => {
  it("reconstructs v2 metadata exactly and fails closed for v1 metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugin-host-installed-loader-"));
    const published: string[] = [];
    try {
      const infrastructure = await createNodeContentInfrastructureWithPlatform({
        hostRoot: join(root, "host"),
        platform: createNodeContentStorePlatform({ renameNoReplace: renameNoReplaceByProbe }),
      });
      const current = evidence("a");
      const allocation = await infrastructure.content.allocateStaging(signal);
      await mkdir(join(allocation.slot.root, "content"));
      const descriptor = createInstalledRevisionDescriptor({ loaded: current.loaded, revision: current.revision, sha256 });
      const plan = createPromotionPlan({
        kind: "plugin",
        allocation,
        materialized: { root: join(allocation.slot.root, "content"), source: current.source, content: current.content, binding: current.binding },
        descriptor,
      }, sha256);
      const promoted = await infrastructure.content.promote(plan, signal);
      published.push(promoted.root);
      const loaded = await infrastructure.installed.load({ scope: { kind: "user" }, revision: current.revision }, signal);
      expect(loaded).toEqual(current.loaded);
      expect(Object.isFrozen(loaded)).toBe(true);

      const legacy = evidence("b");
      const legacyAllocation = await infrastructure.content.allocateStaging(signal);
      await mkdir(join(legacyAllocation.slot.root, "content"));
      const legacyPlan = createPromotionPlan({
        kind: "plugin",
        allocation: legacyAllocation,
        materialized: { root: join(legacyAllocation.slot.root, "content"), source: legacy.source, content: legacy.content, binding: legacy.binding },
      }, sha256);
      const legacyPromoted = await infrastructure.content.promote(legacyPlan, signal);
      published.push(legacyPromoted.root);
      await expect(infrastructure.installed.load({ scope: { kind: "user" }, revision: legacy.revision }, signal))
        .rejects.toMatchObject({ code: "INSTALLED_DESCRIPTOR_UNAVAILABLE" });
    } finally {
      await Promise.all(published.map(makeWritable));
      await rm(root, { recursive: true, force: true });
    }
  });
});
