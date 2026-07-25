import { describe, expect, it } from "vitest";
import { BoundaryError } from "../../src/domain/errors.js";
import { readClaudeMarketplace } from "../../src/formats/claude/marketplace-reader.js";
import { readCodexMarketplace } from "../../src/formats/codex/marketplace-reader.js";
import { mergeMarketplaceEntries, mergeMarketplaces } from "../../src/formats/marketplace-merger.js";

function claudeCatalog(plugins: readonly object[]) {
  return readClaudeMarketplace({ name: "shared-catalog", owner: { name: "claude" }, plugins });
}

function codexCatalog(plugins: readonly object[]) {
  return readCodexMarketplace({ name: "shared-catalog", interface: { displayName: "Codex" }, plugins });
}

const sharedClaude = {
  name: "shared",
  source: "./plugins/shared",
  version: "1.2.3",
  description: "Shared plugin",
  policy: { installation: "AVAILABLE" },
  skills: ["./skills"],
};

const sharedCodex = {
  name: "shared",
  source: { source: "local", path: "./plugins/shared" },
  version: "1.2.3",
  description: "Shared plugin",
  policy: { installation: "AVAILABLE" },
  dependencies: ["runtime-helper"],
};

describe("dual marketplace merger", () => {
  it("uses canonical host and entry ordering, preserving both raw declarations", () => {
    const claude = claudeCatalog([
      { name: "zeta", source: "./plugins/zeta" },
      sharedClaude,
    ]);
    const codex = codexCatalog([
      { name: "alpha", source: "./plugins/alpha", policy: { installation: "NOT_AVAILABLE" } },
      sharedCodex,
    ]);

    const normal = mergeMarketplaces([
      { nativeHost: "claude", result: claude },
      { nativeHost: "codex", result: codex },
    ]);
    const permuted = mergeMarketplaces([
      { nativeHost: "codex", result: { ...codex, marketplace: { ...codex.marketplace, entries: [...codex.marketplace.entries].reverse() } } },
      { nativeHost: "claude", result: { ...claude, marketplace: { ...claude.marketplace, entries: [...claude.marketplace.entries].reverse() } } },
    ]);

    expect(permuted).toEqual(normal);
    expect(normal.marketplace.entries.map((entry) => entry.identity.value.marketplaceEntryName)).toEqual([
      "alpha",
      "shared",
      "zeta",
    ]);
    const shared = normal.marketplace.entries.find((entry) => entry.identity.value.marketplaceEntryName === "shared")!;
    expect(shared.source.value).toEqual({ kind: "marketplace-path", path: "./plugins/shared" });
    expect(shared.source.provenance.map((claim) => claim.location.host)).toEqual(["claude", "codex"]);
    expect(shared.authorities.map((authority) => authority.nativeHost)).toEqual(["claude", "codex"]);
    expect(shared.declarations.map((declaration) => declaration.field)).toEqual(["skills", "dependencies"]);
    expect(shared.rawDeclaration.provenance.map((claim) => claim.location.host)).toEqual(["claude", "codex"]);
  });

  it("binds each catalog label to every normalized host claim", () => {
    const claude = claudeCatalog([{ name: "only", source: "./only" }]);
    expect(() => mergeMarketplaces([{ nativeHost: "codex", result: claude }])).toThrowError(BoundaryError);

    const mixed = {
      ...claude,
      marketplace: {
        ...claude.marketplace,
        sourceDocuments: claude.marketplace.sourceDocuments.map((document) => ({
          ...document,
          location: { ...document.location, host: "codex" as const },
        })),
      },
    };
    expect(() => mergeMarketplaces([{ nativeHost: "claude", result: mixed }])).toThrowError(BoundaryError);
  });

  it("rejects host-forged metadata keys even when their claims look local", () => {
    const claude = claudeCatalog([{ name: "only", source: "./only" }]);
    const forged = {
      ...claude,
      marketplace: {
        ...claude.marketplace,
        metadata: [{
          key: "codex.displayName",
          claimed: {
            ...claude.marketplace.name,
            value: "forged",
            provenance: [{
              location: {
                ...claude.marketplace.name.provenance[0]!.location,
                pointer: "/forged",
              },
              declaration: "forged",
            }],
          },
        }],
      },
    };

    expect(() => mergeMarketplaces([{ nativeHost: "claude", result: forged }])).toThrowError(BoundaryError);

    const originalEntry = claude.marketplace.entries[0]!;
    const forgedEntryResult = {
      ...claude,
      marketplace: {
        ...claude.marketplace,
        metadata: [],
        entries: [{
          ...originalEntry,
          metadata: [{
            key: "codex.entryLabel",
            claimed: {
              value: "forged",
              provenance: originalEntry.rawDeclaration.provenance,
            },
          }],
        }],
      },
    };
    expect(() => mergeMarketplaces([{ nativeHost: "claude", result: forgedEntryResult }])).toThrowError(BoundaryError);
  });

  it("merges direct entry API inputs when only subdirectory spelling differs", () => {
    const left = readClaudeMarketplace({
      name: "shared-catalog",
      plugins: [{ name: "shared", source: { source: "git-subdir", url: "https://example.com/repo.git", path: "./plugin" } }],
    }).marketplace.entries[0]!;
    const right = readCodexMarketplace({
      name: "shared-catalog",
      plugins: [{ name: "shared", source: { source: "git-subdir", url: "https://example.com/repo.git", path: "plugin" }, policy: { installation: "AVAILABLE" } }],
    }).marketplace.entries[0]!;
    const merged = mergeMarketplaceEntries("shared-catalog", left, right);
    expect(merged.source.value).toEqual({
      kind: "git-subdir",
      url: "https://example.com/repo.git",
      path: "plugin",
    });
    expect(merged.source.provenance.map((claim) => claim.location.host)).toEqual(["claude", "codex"]);
    expect(mergeMarketplaceEntries("shared-catalog", right, left)).toEqual(merged);
  });

  it("rejects unequal raw declarations at one location in direct entry merging", () => {
    const left = readClaudeMarketplace({
      name: "shared-catalog",
      plugins: [{ name: "shared", source: "./shared" }],
    }).marketplace.entries[0]!;
    const sourceProvenance = left.source.provenance[0]!;
    const right = {
      ...left,
      source: {
        ...left.source,
        provenance: [{ ...sourceProvenance, declaration: "./different" }],
      },
    };

    expect(() => mergeMarketplaceEntries("shared-catalog", left, right)).toThrowError();
    try {
      mergeMarketplaceEntries("shared-catalog", left, right);
      throw new Error("expected same-location conflict");
    } catch (error) {
      expect(error).toMatchObject({
        code: "CLAIM_CONFLICT",
        details: { field: "source" },
      });
    }
  });

  it("rejects contradictory same-location provenance in catalog merging and keeps permutation output stable", () => {
    const claude = claudeCatalog([{ name: "shared", source: "./shared" }]);
    const original = claude.marketplace.entries[0]!;
    const sourceProvenance = original.source.provenance[0]!;
    const forgedClaude = {
      ...claude,
      marketplace: {
        ...claude.marketplace,
        entries: [{
          ...original,
          source: {
            ...original.source,
            provenance: [
              sourceProvenance,
              { ...sourceProvenance, declaration: "./different" },
            ],
          },
        }],
      },
    };
    const codex = codexCatalog([{ name: "shared", source: "./shared", policy: { installation: "AVAILABLE" } }]);

    const normal = mergeMarketplaces([
      { nativeHost: "claude", result: forgedClaude },
      { nativeHost: "codex", result: codex },
    ]);
    const permuted = mergeMarketplaces([
      { nativeHost: "codex", result: codex },
      { nativeHost: "claude", result: forgedClaude },
    ]);

    expect(normal).toEqual(permuted);
    expect(normal.marketplace.entries).toEqual([]);
    expect(normal.diagnostics).toHaveLength(1);
    expect(normal.diagnostics[0]).toMatchObject({
      code: "CLAIM_CONFLICT",
      details: { field: "source" },
    });
  });

  it.each([
    [undefined, ""],
    [undefined, "/"],
    ["", "/"],
  ] as const)("keeps provenance pointers distinct: %s vs %s", (leftPointer, rightPointer) => {
    const base = readClaudeMarketplace({
      name: "shared-catalog",
      plugins: [{ name: "shared", source: "./shared" }],
    }).marketplace.entries[0]!;
    const withSourcePointer = (pointer: string | undefined) => {
      const sourceProvenance = base.source.provenance[0]!;
      const { pointer: _pointer, ...locationWithoutPointer } = sourceProvenance.location;
      return {
        ...base,
        source: {
          ...base.source,
          provenance: [{
            ...sourceProvenance,
            location: pointer === undefined
              ? locationWithoutPointer
              : { ...locationWithoutPointer, pointer },
          }],
        },
      };
    };

    const merged = mergeMarketplaceEntries(
      "shared-catalog",
      withSourcePointer(leftPointer),
      withSourcePointer(rightPointer),
    );
    expect(merged.source.provenance).toHaveLength(2);
    expect(merged.source.provenance.map((claim) => claim.location.pointer)).toEqual(
      expect.arrayContaining([leftPointer, rightPointer]),
    );
  });

  it("rejects every direct-entry host-forged claim surface", () => {
    const left = readClaudeMarketplace({
      name: "shared-catalog",
      plugins: [{
        name: "shared",
        source: "./shared",
        version: "1.2.3",
        description: "Shared plugin",
        policy: { installation: "AVAILABLE", authentication: "oauth" },
        strict: false,
        skills: ["./skills"],
        dependencies: ["runtime-helper"],
        displayName: "Shared",
      }],
    }).marketplace.entries[0]!;
    const right = readCodexMarketplace({
      name: "shared-catalog",
      plugins: [{
        name: "shared",
        source: { source: "local", path: "./shared" },
        version: "1.2.3",
        description: "Shared plugin",
        policy: { installation: "AVAILABLE", authentication: "oauth" },
        dependencies: ["runtime-helper"],
      }],
    }).marketplace.entries[0]!;

    const forgeClaim = <T extends { readonly provenance: readonly { readonly location: { readonly host: string } }[] }>(claim: T): T => ({
      ...claim,
      provenance: claim.provenance.map((provenance) => ({
        ...provenance,
        location: { ...provenance.location, host: "codex" as const },
      })),
    }) as T;
    const replaceAuthority = (
      entry: typeof left,
      replace: (authority: typeof left.authorities[number]) => typeof left.authorities[number],
    ) => ({
      ...entry,
      authorities: [replace(entry.authorities[0]!)],
    });
    const replacePolicy = (
      entry: typeof left,
      replace: (policy: NonNullable<typeof left.policy>) => NonNullable<typeof left.policy>,
    ) => ({ ...entry, policy: replace(entry.policy!) });
    const replaceDeclaration = (
      entry: typeof left,
      replace: (declaration: typeof left.declarations[number]) => typeof left.declarations[number],
    ) => ({
      ...entry,
      declarations: [replace(entry.declarations[0]!)],
    });
    const cases: readonly [string, (entry: typeof left) => typeof left][] = [
      ["identity provenance", (entry) => ({ ...entry, identity: forgeClaim(entry.identity) })],
      ["source provenance", (entry) => ({ ...entry, source: forgeClaim(entry.source) })],
      ["version provenance", (entry) => ({ ...entry, version: forgeClaim(entry.version!) })],
      ["description provenance", (entry) => ({ ...entry, description: forgeClaim(entry.description!) })],
      ["policy availability provenance", (entry) => replacePolicy(entry, (policy) => ({ ...policy, availability: forgeClaim(policy.availability) }))],
      ["policy authentication provenance", (entry) => replacePolicy(entry, (policy) => ({ ...policy, authentication: forgeClaim(policy.authentication!) }))],
      ["policy declaration provenance", (entry) => replacePolicy(entry, (policy) => ({ ...policy, declaration: forgeClaim(policy.declaration) }))],
      ["authority strict provenance", (entry) => replaceAuthority(entry, (authority) => ({ ...authority, strict: forgeClaim(authority.strict!) }))],
      ["authority manifest provenance", (entry) => replaceAuthority(entry, (authority) => ({ ...authority, manifest: forgeClaim(authority.manifest) }))],
      ["authority runtime provenance", (entry) => replaceAuthority(entry, (authority) => ({ ...authority, catalogRuntime: forgeClaim(authority.catalogRuntime) }))],
      ["authority host", (entry) => replaceAuthority(entry, (authority) => {
        const { strict: _strict, ...withoutStrict } = authority;
        return {
          ...withoutStrict,
          nativeHost: "codex" as const,
          manifest: { ...authority.manifest, value: "required" as const },
          catalogRuntime: { ...authority.catalogRuntime, value: "supplemental" as const },
        };
      })],
      ["declaration provenance", (entry) => replaceDeclaration(entry, (declaration) => ({ ...declaration, declaration: forgeClaim(declaration.declaration) }))],
      ["declaration host", (entry) => replaceDeclaration(entry, (declaration) => ({ ...declaration, nativeHost: "codex" as const }))],
      ["raw declaration provenance", (entry) => ({ ...entry, rawDeclaration: forgeClaim(entry.rawDeclaration) })],
      ["metadata provenance", (entry) => ({ ...entry, metadata: [{ ...entry.metadata[0]!, claimed: forgeClaim(entry.metadata[0]!.claimed) }] })],
      ["metadata key", (entry) => ({ ...entry, metadata: [{ ...entry.metadata[0]!, key: "codex.displayName" }] })],
    ];

    for (const [surface, forge] of cases) {
      expect(() => mergeMarketplaceEntries("shared-catalog", forge(left), right), surface)
        .toThrowError(BoundaryError);
    }
  });

  it("binds catalog diagnostics to their native host before merging", () => {
    const invalid = claudeCatalog([{ name: "invalid", source: { source: "unsupported" } }]);
    const diagnostic = invalid.diagnostics[0]!;
    const forged = {
      ...invalid,
      diagnostics: [{
        ...diagnostic,
        location: { ...diagnostic.location!, host: "codex" as const },
      }],
    };
    expect(() => mergeMarketplaces([{ nativeHost: "claude", result: forged }])).toThrowError(BoundaryError);
  });

  it("drops only conflicting overlaps and keeps valid siblings", () => {
    const result = mergeMarketplaces([
      {
        nativeHost: "claude",
        result: claudeCatalog([
          { name: "conflict", source: "./plugins/one", version: "1" },
          { name: "claude-only", source: "./plugins/claude-only" },
        ]),
      },
      {
        nativeHost: "codex",
        result: codexCatalog([
          { name: "conflict", source: "./plugins/two", version: "1", policy: { installation: "AVAILABLE" } },
          { name: "codex-only", source: "./plugins/codex-only", policy: { installation: "AVAILABLE" } },
        ]),
      },
    ]);

    expect(result.marketplace.entries.map((entry) => entry.identity.value.marketplaceEntryName)).toEqual([
      "claude-only",
      "codex-only",
    ]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "CLAIM_CONFLICT",
      operation: "mergeMarketplaceEntries",
      details: { field: "source" },
    });
    const details = result.diagnostics[0]!.details as { left: { provenance: readonly unknown[] }; right: { provenance: readonly unknown[] } };
    expect(details.left.provenance).toHaveLength(1);
    expect(details.right.provenance).toHaveLength(1);
  });

  it("degrades description, version, category, and policy drift to canonical precedence", () => {
    // Dual-root catalogs drift on presentational fields constantly (the
    // nklisch/skills marketplace diverged on every entry). Real hosts resolve
    // this by precedence; the entry must survive with both provenances.
    const result = mergeMarketplaces([
      {
        nativeHost: "claude",
        result: claudeCatalog([{
          name: "drifted",
          source: "./plugins/drifted",
          version: "1.0.0",
          description: "claude text",
          category: "claude-category",
          policy: { installation: "AVAILABLE" },
        }]),
      },
      {
        nativeHost: "codex",
        result: codexCatalog([{
          name: "drifted",
          source: { source: "local", path: "./plugins/drifted" },
          version: "2.0.0",
          description: "codex text",
          category: "codex-category",
          policy: { installation: "INSTALLED_BY_DEFAULT" },
        }]),
      },
    ]);

    expect(result.diagnostics).toHaveLength(0);
    const entry = result.marketplace.entries.find((candidate) =>
      candidate.identity.value.marketplaceEntryName === "drifted");
    expect(entry).toBeDefined();
    expect(entry?.version?.value).toBe("1.0.0");
    expect(entry?.description?.value).toBe("claude text");
    expect(entry?.policy?.availability.value).toBe("available");
    // Superseded declarations remain auditable in merged provenance.
    expect(entry?.version?.provenance.length).toBe(2);
    expect(entry?.description?.provenance.length).toBe(2);
  });

  it("flips presentational winners to the codex host under codex-first precedence", () => {
    // Same drift shape as the canonical precedence test above; the user
    // configured codex-first, so Codex declarations win presentation while
    // both provenances remain auditable.
    const result = mergeMarketplaces([
      {
        nativeHost: "claude",
        result: claudeCatalog([{
          name: "drifted",
          source: "./plugins/drifted",
          version: "1.0.0",
          description: "claude text",
          category: "claude-category",
          policy: { installation: "AVAILABLE" },
        }]),
      },
      {
        nativeHost: "codex",
        result: codexCatalog([{
          name: "drifted",
          source: { source: "local", path: "./plugins/drifted" },
          version: "2.0.0",
          description: "codex text",
          category: "codex-category",
          policy: { installation: "INSTALLED_BY_DEFAULT" },
        }]),
      },
    ], { hostPrecedence: ["codex", "claude"] });

    expect(result.diagnostics).toHaveLength(0);
    const entry = result.marketplace.entries.find((candidate) =>
      candidate.identity.value.marketplaceEntryName === "drifted");
    expect(entry).toBeDefined();
    expect(entry?.version?.value).toBe("2.0.0");
    expect(entry?.description?.value).toBe("codex text");
    expect(entry?.policy?.availability.value).toBe("installed-by-default");
    expect(entry?.version?.provenance.length).toBe(2);
    expect(entry?.description?.provenance.length).toBe(2);
    // Canonical host ordering follows the configured precedence.
    expect(entry?.authorities.map((authority) => authority.nativeHost)).toEqual(["codex", "claude"]);
  });

  it("treats selectors and root identity as fatal to the appropriate scope", () => {
    const left = claudeCatalog([{ name: "shared", source: { source: "url", url: "https://example.com/plugin.git", ref: "main" } }]);
    const right = codexCatalog([{ name: "shared", source: { source: "git-subdir", url: "https://example.com/plugin.git", path: "plugin", ref: "main" }, policy: { installation: "AVAILABLE" } }]);
    const merged = mergeMarketplaces([
      { nativeHost: "claude", result: left },
      { nativeHost: "codex", result: right },
    ]);
    expect(merged.marketplace.entries).toEqual([]);
    expect(merged.diagnostics[0]).toMatchObject({ code: "CLAIM_CONFLICT", details: { field: "source" } });

    expect(() => mergeMarketplaces([
      { nativeHost: "claude", result: claudeCatalog([{ name: "one", source: "./one" }]) },
      { nativeHost: "codex", result: readCodexMarketplace({ name: "different", plugins: [] }) },
    ])).toThrowError(BoundaryError);
    try {
      mergeMarketplaces([
        { nativeHost: "claude", result: claudeCatalog([{ name: "one", source: "./one" }]) },
        { nativeHost: "codex", result: readCodexMarketplace({ name: "different", plugins: [] }) },
      ]);
    } catch (error) {
      expect(error).toMatchObject({
        code: "MARKETPLACE_ROOT_INVALID",
        details: { left: { provenance: [{ location: { host: "claude" } }] }, right: { provenance: [{ location: { host: "codex" } }] } },
      });
    }
  });
});
