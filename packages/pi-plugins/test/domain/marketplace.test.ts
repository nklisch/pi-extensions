import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  MarketplaceAuthoritySchema,
  MarketplaceReadResultSchema,
  NormalizedMarketplaceEntrySchema,
  NormalizedMarketplaceSchema,
  type MarketplaceAuthority,
  type MarketplaceReadResult,
  type NormalizedMarketplace,
  type NormalizedMarketplaceEntry,
} from "../../src/domain/marketplace.js";
import { claim, type Provenance } from "../../src/domain/provenance.js";
import { MarketplaceNameSchema, PluginIdentitySchema } from "../../src/domain/identity.js";

const marketplace: Provenance = {
  location: {
    host: "claude",
    documentKind: "marketplace",
    path: ".claude-plugin/marketplace.json",
    pointer: "",
  },
};
const entry: Provenance = {
  location: {
    host: "claude",
    documentKind: "marketplace",
    path: ".claude-plugin/marketplace.json",
    pointer: "/plugins/0",
  },
};
const codexEntry: Provenance = {
  location: {
    host: "codex",
    documentKind: "marketplace",
    path: ".agents/plugins/marketplace.json",
    pointer: "/plugins/0",
  },
};

const identity = PluginIdentitySchema.parse({
  key: "demo@community",
  marketplaceName: "community",
  marketplaceEntryName: "demo",
});

const claudeAuthority: MarketplaceAuthority = {
  nativeHost: "claude",
  strict: claim(true, entry),
  manifest: claim("required", entry),
  catalogRuntime: claim("supplemental", entry),
};

const baseEntry: NormalizedMarketplaceEntry = {
  identity: claim(identity, entry),
  source: claim({ kind: "marketplace-path", path: "./plugins/demo" }, entry),
  version: claim("1.0.0", entry),
  description: claim("Demo plugin", entry),
  policy: {
    availability: claim("available", entry),
    authentication: claim("none", entry),
    declaration: claim({ availability: "AVAILABLE" }, entry),
  },
  authorities: [claudeAuthority],
  declarations: [
    {
      nativeHost: "claude",
      category: "runtime-metadata",
      field: "commands",
      declaration: claim(["demo"], entry),
    },
  ],
  metadata: [{ key: "category", claimed: claim("utility", entry) }],
  rawDeclaration: {
    value: { name: "demo", source: "./plugins/demo", strict: true },
    provenance: [{
      ...entry,
      declaration: { name: "demo", source: "./plugins/demo", strict: true },
    }],
  },
};

const baseMarketplace: NormalizedMarketplace = {
  name: claim(MarketplaceNameSchema.parse("community"), marketplace),
  entries: [baseEntry],
  metadata: [{ key: "owner", claimed: claim("team", marketplace) }],
  sourceDocuments: [marketplace],
};

describe("marketplace domain contracts", () => {
  it("accepts unresolved entries and keeps claims auditable", () => {
    const parsed = NormalizedMarketplaceSchema.parse(baseMarketplace);

    expect(parsed.entries[0]?.source.value).toEqual({
      kind: "marketplace-path",
      path: "./plugins/demo",
    });
    expect(parsed.entries[0]?.rawDeclaration.provenance[0]?.declaration).toEqual({
      name: "demo",
      source: "./plugins/demo",
      strict: true,
    });
    expect(parsed.entries[0]?.authorities[0]?.manifest.value).toBe("required");
  });

  it("rejects identity/root, entry, authority, and metadata conflicts", () => {
    expect(
      NormalizedMarketplaceSchema.safeParse({
        ...baseMarketplace,
        entries: [
          baseEntry,
          baseEntry,
        ],
      }).success,
    ).toBe(false);
    expect(
      NormalizedMarketplaceSchema.safeParse({
        ...baseMarketplace,
        entries: [
          {
            ...baseEntry,
            identity: claim(
              { ...identity, marketplaceName: "other", key: "demo@other" },
              codexEntry,
            ),
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      NormalizedMarketplaceEntrySchema.safeParse({
        ...baseEntry,
        authorities: [claudeAuthority, claudeAuthority],
      }).success,
    ).toBe(false);
    expect(
      NormalizedMarketplaceEntrySchema.safeParse({
        ...baseEntry,
        metadata: [...baseEntry.metadata, baseEntry.metadata[0]!],
      }).success,
    ).toBe(false);
  });

  it("accepts only host-specific authority combinations", () => {
    expect(MarketplaceAuthoritySchema.safeParse(claudeAuthority).success).toBe(true);
    expect(
      MarketplaceAuthoritySchema.safeParse({
        nativeHost: "claude",
        strict: claim(false, entry),
        manifest: claim("optional", entry),
        catalogRuntime: claim("authoritative", entry),
      }).success,
    ).toBe(true);
    expect(
      MarketplaceAuthoritySchema.safeParse({
        nativeHost: "codex",
        manifest: claim("required", codexEntry),
        catalogRuntime: claim("supplemental", codexEntry),
      }).success,
    ).toBe(true);
    expect(
      MarketplaceAuthoritySchema.safeParse({
        nativeHost: "codex",
        strict: claim(true, codexEntry),
        manifest: claim("required", codexEntry),
        catalogRuntime: claim("supplemental", codexEntry),
      }).success,
    ).toBe(false);
    expect(
      MarketplaceAuthoritySchema.safeParse({
        nativeHost: "claude",
        strict: claim(false, entry),
        manifest: claim("required", entry),
        catalogRuntime: claim("supplemental", entry),
      }).success,
    ).toBe(false);
  });

  it("derives public marketplace result types from schemas", () => {
    expectTypeOf<MarketplaceAuthority>().toEqualTypeOf<z.infer<typeof MarketplaceAuthoritySchema>>();
    expectTypeOf<NormalizedMarketplaceEntry>().toEqualTypeOf<z.infer<typeof NormalizedMarketplaceEntrySchema>>();
    expectTypeOf<NormalizedMarketplace>().toEqualTypeOf<z.infer<typeof NormalizedMarketplaceSchema>>();
    expectTypeOf<MarketplaceReadResult>().toEqualTypeOf<z.infer<typeof MarketplaceReadResultSchema>>();
  });
});
