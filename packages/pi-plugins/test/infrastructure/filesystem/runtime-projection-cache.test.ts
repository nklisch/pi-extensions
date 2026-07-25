import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntimeProjectionCache } from "../../../src/infrastructure/filesystem/runtime-projection-cache.js";
import { createNodeContentStoreWithPlatform } from "../../../src/infrastructure/filesystem/create-content-store.js";
import { createNodeContentStorePlatform, renameNoReplaceByProbe } from "../../../src/infrastructure/filesystem/content-store-durability.js";
import { createActiveProjectionExpectation, createPluginRuntimeProjection } from "../../../src/application/ports/runtime-projection.js";
import { CompatibilityReportSchema } from "../../../src/domain/compatibility.js";
import { createContentManifest } from "../../../src/domain/content-manifest.js";
import { NormalizedPluginSchema } from "../../../src/domain/plugin.js";
import { createResolvedPluginSource } from "../../../src/domain/source.js";
import { createInstalledRevisionRecord } from "../../../src/domain/state/installed-state.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;

async function makeWritable(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined);
  if (stat === undefined) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const child of await readdir(path)) await makeWritable(join(path, child));
    await chmod(path, 0o755).catch(() => undefined);
  } else if (!stat.isSymbolicLink()) {
    await chmod(path, 0o644).catch(() => undefined);
  }
}

function fixture() {
  const source = createResolvedPluginSource({ kind: "marketplace-path", marketplaceRevision: "b".repeat(40), path: "./plugin" }, sha256);
  const plugin = NormalizedPluginSchema.parse({
    identity: { key: "fixture@community", marketplaceName: "community", marketplaceEntryName: "fixture" }, source,
    configuration: { options: [] }, components: { skills: [], hooks: [], mcpServers: [], foreign: [] }, metadata: [],
  });
  const compatibility = CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
  const revision = createInstalledRevisionRecord({ plugin, compatibility, content: createContentManifest([], sha256), scope: { kind: "user" } }, sha256);
  return createActiveProjectionExpectation(createPluginRuntimeProjection({ scope: { kind: "user" }, plugin, compatibility, revision, sha256 }), sha256);
}

describe("filesystem runtime projection cache", () => {
  it("publishes and reads the complete cache through generated-root ports", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-runtime-projection-cache-"));
    try {
      const content = await createNodeContentStoreWithPlatform({ hostRoot: join(root, "host"), platform: createNodeContentStorePlatform({ renameNoReplace: renameNoReplaceByProbe }) });
      const cache = createRuntimeProjectionCache({ content, sha256 });
      const expectation = fixture();
      expect(await cache.prepare(expectation, signal)).toEqual(expectation);
      const result = await cache.read(expectation, signal);
      expect(result.kind).toBe("ready");
      if (result.kind === "ready") expect(result.value.projection).toEqual(expectation.projection);
    } finally {
      await makeWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  });
});