import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  ContentDigestSchema,
  createContentManifest,
  createMaterializationBinding,
  hashContent,
} from "../../src/domain/content-manifest.js";
import {
  ContentStoreIdentitySchema,
  ContentStoreKindRegistry,
  createMarketplaceStoreIdentity,
  createPluginStoreIdentity,
  type ContentStoreIdentity,
} from "../../src/domain/content-store.js";
import {
  createResolvedMarketplaceSource,
  createResolvedPluginSource,
} from "../../src/domain/source.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const content = (value: string) => createContentManifest([{
  kind: "file" as const,
  path: "plugin.txt",
  mode: 0o644 as const,
  size: bytes(value).byteLength,
  digest: hashContent(bytes(value), sha256),
}], sha256);

const marketplace = createResolvedMarketplaceSource({
  declared: { kind: "github", repository: "example/marketplace" },
  revision: "a".repeat(40),
}, sha256);
const plugin = createResolvedPluginSource({
  kind: "git",
  url: "https://example.com/plugin.git",
  revision: "b".repeat(40),
}, sha256);

describe("immutable content store identities", () => {
  it("derives distinct, tagged keys from verified source and content evidence", () => {
    const firstContent = content("one");
    const marketplaceIdentity = createMarketplaceStoreIdentity(
      marketplace,
      firstContent,
      createMaterializationBinding(marketplace.hash, firstContent.rootDigest, sha256),
      sha256,
    );
    const pluginIdentity = createPluginStoreIdentity(
      plugin,
      firstContent,
      createMaterializationBinding(plugin.hash, firstContent.rootDigest, sha256),
      sha256,
    );

    expect(marketplaceIdentity.key.startsWith(`${ContentStoreKindRegistry.marketplace.tag}:sha256:`)).toBe(true);
    expect(pluginIdentity.key.startsWith(`${ContentStoreKindRegistry.plugin.tag}:sha256:`)).toBe(true);
    expect(marketplaceIdentity.key).not.toBe(pluginIdentity.key);
    expect(ContentStoreIdentitySchema.parse(marketplaceIdentity)).toEqual(marketplaceIdentity);
  });

  it("changes when source, immutable revision, or manifest changes", () => {
    const first = content("one");
    const second = content("two");
    const firstIdentity = createPluginStoreIdentity(
      plugin,
      first,
      createMaterializationBinding(plugin.hash, first.rootDigest, sha256),
      sha256,
    );
    const secondIdentity = createPluginStoreIdentity(
      plugin,
      second,
      createMaterializationBinding(plugin.hash, second.rootDigest, sha256),
      sha256,
    );
    const otherSource = createResolvedPluginSource({
      kind: "git",
      url: "https://example.com/other.git",
      revision: "b".repeat(40),
    }, sha256);
    const otherIdentity = createPluginStoreIdentity(
      otherSource,
      first,
      createMaterializationBinding(otherSource.hash, first.rootDigest, sha256),
      sha256,
    );

    expect(firstIdentity.key).not.toBe(secondIdentity.key);
    expect(firstIdentity.key).not.toBe(otherIdentity.key);
  });

  it("rejects forged bindings before producing an identity", () => {
    expect(() => createPluginStoreIdentity(
      plugin,
      content("one"),
      ContentDigestSchema.parse(`sha256:${"0".repeat(64)}`),
      sha256,
    )).toThrow(/binding/);
  });

  it("infers public identity types from schemas", () => {
    expectTypeOf<ContentStoreIdentity>().toEqualTypeOf<z.infer<typeof ContentStoreIdentitySchema>>();
  });
});
