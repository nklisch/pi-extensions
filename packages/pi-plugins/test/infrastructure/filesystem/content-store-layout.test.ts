import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContentStoreLayout } from "../../../src/infrastructure/filesystem/content-store-layout.js";
import { createHash } from "node:crypto";
import { createContentManifest, createMaterializationBinding, hashContent } from "../../../src/domain/content-manifest.js";
import { createResolvedPluginSource } from "../../../src/domain/source.js";
import { createPluginStoreIdentity } from "../../../src/domain/content-store.js";
import { derivePluginDataRef, deriveProjectionRootRef } from "../../../src/domain/state/references.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const digest = (value: string) => hashContent(new TextEncoder().encode(value), sha256);

describe("content store layout", () => {
  it("bootstraps private roots and encodes only validated digest segments", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-content-layout-"));
    try {
      const layout = await createContentStoreLayout(join(root, "host"));
      const content = createContentManifest([{ kind: "file", path: "x", mode: 0o644, size: 1, digest: digest("x") }], sha256);
      const source = createResolvedPluginSource({ kind: "git", url: "https://example.com/x.git", revision: "a".repeat(40) }, sha256);
      const identity = createPluginStoreIdentity(source, content, createMaterializationBinding(source.hash, content.rootDigest, sha256), sha256);
      const dataRef = derivePluginDataRef({ scope: { kind: "user" }, plugin: "x@market" }, sha256);
      const projectionRef = deriveProjectionRootRef({ scope: { kind: "user" }, plugin: "x@market", projectionDigest: digest("projection") }, sha256);

      expect(layout.pluginPath(identity)).toBe(join(layout.pluginStoreRoot, identity.key.slice("plugin-store-v1:sha256:".length)));
      expect(layout.dataPath(dataRef)).toMatch(/data[\\/]v1[\\/][0-9a-f]{64}$/u);
      expect(layout.projectionPath(projectionRef)).toMatch(/generated[\\/]v1[\\/][0-9a-f]{64}$/u);
      expect(layout.pluginPath(identity)).not.toContain("example.com");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked host root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-content-layout-link-"));
    const target = join(root, "target");
    const link = join(root, "link");
    try {
      await symlink(target, link);
      await expect(createContentStoreLayout(link)).rejects.toThrow(/symlink|root/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
