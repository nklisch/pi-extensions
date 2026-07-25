import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContentStoreLayout } from "../../../src/infrastructure/filesystem/content-store-layout.js";
import { derivePluginContentRef, derivePluginDataRef } from "../../../src/domain/state/references.js";
import { createResolvedPluginSource } from "../../../src/domain/source.js";
import { createContentRootResolver } from "../../../src/infrastructure/filesystem/content-root-resolver.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;

describe("logical content root resolver", () => {
  it("does not accept a path-bearing or unready marketplace record", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-content-resolver-"));
    try {
      const layout = await createContentStoreLayout(join(root, "host"));
      const resolver = createContentRootResolver({ layout, sha256 });
      const record = {
        marketplace: "community",
        source: { kind: "github", sourceHash: `sha256:${"a".repeat(64)}`, revision: "b".repeat(40) },
        contentDigest: `sha256:${"c".repeat(64)}`,
        binding: `sha256:${"d".repeat(64)}`,
        contentRef: `marketplace-content-v1:sha256:${"e".repeat(64)}`,
      } as never;
      await expect(resolver.resolveMarketplace(record, signal)).rejects.toThrow();
      expect(layout.hostRoot).not.toContain("community");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves exact project scope instead of defaulting to user scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-content-project-scope-"));
    try {
      const layout = await createContentStoreLayout(join(root, "host"));
      const resolver = createContentRootResolver({ layout, sha256 });
      const source = createResolvedPluginSource({ kind: "git", url: "https://example.com/demo.git", revision: "a".repeat(40) }, sha256);
      const contentDigest = `sha256:${"b".repeat(64)}` as const;
      const revision = `sha256:${"c".repeat(64)}` as const;
      const plugin = "demo@community" as const;
      const userScope = { kind: "user" } as const;
      const projectScope = { kind: "project", projectKey: `project-v1:sha256:${"d".repeat(64)}` } as const;
      const record = {
        revision,
        evidence: { plugin: { key: plugin }, source },
        contentDigest,
        contentRef: derivePluginContentRef({ scope: userScope, plugin, source, content: contentDigest, binding: revision }, sha256),
        dataRef: derivePluginDataRef({ scope: userScope, plugin, purpose: "persistent-plugin-data" }, sha256),
      };

      await expect(resolver.resolvePlugin(record as never, signal, projectScope)).rejects.toMatchObject({ code: "CONTENT_VERIFICATION_FAILED" });
      await expect(resolver.resolvePlugin(record as never, signal, undefined as never)).rejects.toMatchObject({ code: "CONTENT_VERIFICATION_FAILED" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
