import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  CanonicalSourceSchema,
  GitRevisionSchema,
  MarketplaceSourceSchema,
  MarketplaceSourceVariantRegistry,
  NpmIntegritySchema,
  PluginSourceSchema,
  PluginSourceVariantRegistry,
  ResolvedMarketplaceSourceSchema,
  ResolvedPluginSourceSchema,
  ResolvedPluginSourceVariantRegistry,
  SourceHashSchema,
  createResolvedMarketplaceSource,
  createResolvedPluginSource,
  hashCanonicalSource,
  serializeMarketplaceSource,
  serializePluginSource,
  verifyResolvedMarketplaceSource,
  verifyResolvedPluginSource,
  type CanonicalSource,
  type MarketplaceSource,
  type PluginSource,
  type ResolvedMarketplaceSource,
  type ResolvedPluginSource,
  type Sha256,
  type SourceHash,
} from "../../src/domain/source.js";

const revision = "a".repeat(40);
const hashBytes: Sha256 = () => Uint8Array.from({ length: 32 }, (_, index) => index);
const sourceHash = "sha256:000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const validIntegrity = `sha512-${"A".repeat(86)}==`;

const resolvedGit = () =>
  createResolvedPluginSource(
    {
      kind: "git",
      url: "https://example.com/plugin.git",
      revision,
    },
    hashBytes,
  );

describe("source schemas", () => {
  it("parses every declared marketplace variant from its registry", () => {
    const samples = {
      github: { kind: "github", repository: "owner/repository" },
      git: { kind: "git", url: "https://example.com/catalog.git" },
      localGit: { kind: "local-git", path: "./catalog" },
    } as const;

    for (const [name, entry] of Object.entries(MarketplaceSourceVariantRegistry)) {
      expect(entry.schema.safeParse(samples[name as keyof typeof samples]).success).toBe(true);
      expect(MarketplaceSourceSchema.safeParse(samples[name as keyof typeof samples]).success).toBe(true);
    }
  });

  it("uses GitHub's verified owner/repository lexical grammar", () => {
    for (const repository of ["owner/repository", "owner/.github", "owner/.repository", "owner/repo_name"]) {
      expect(MarketplaceSourceSchema.safeParse({ kind: "github", repository }).success).toBe(true);
    }
    for (const repository of [
      "",
      "owner/",
      "/repository",
      "owner/.",
      "owner/..",
      "owner/repository.git",
      "owner/repository.GIT",
      "owner/repository.",
      "owner/repo/name",
      "owner/repository#fragment",
      "owner/repository?query",
      "owner/repository\\u0000",
      "https://github.com/owner/repository",
    ]) {
      expect(MarketplaceSourceSchema.safeParse({ kind: "github", repository }).success).toBe(false);
    }
  });

  it("parses every declared plugin variant from its registry", () => {
    const samples = {
      marketplacePath: { kind: "marketplace-path", path: "./plugins/demo" },
      git: { kind: "git", url: "https://example.com/plugin.git" },
      gitSubdir: {
        kind: "git-subdir",
        url: "ssh://git@example.com/plugin.git",
        path: "packages/demo",
      },
      npm: { kind: "npm", package: "@example/plugin" },
    } as const;

    for (const [name, entry] of Object.entries(PluginSourceVariantRegistry)) {
      expect(entry.schema.safeParse(samples[name as keyof typeof samples]).success).toBe(true);
      expect(PluginSourceSchema.safeParse(samples[name as keyof typeof samples]).success).toBe(true);
    }
  });

  it("accepts full Git SHAs and actual SHA-512 integrity digests only", () => {
    expect(GitRevisionSchema.safeParse(revision).success).toBe(true);
    expect(GitRevisionSchema.safeParse("A".repeat(40)).success).toBe(false);
    expect(GitRevisionSchema.safeParse("a".repeat(39)).success).toBe(false);
    expect(GitRevisionSchema.safeParse("a".repeat(64)).success).toBe(false);
    expect(NpmIntegritySchema.safeParse(validIntegrity).success).toBe(true);
    expect(NpmIntegritySchema.safeParse("sha512-abc=").success).toBe(false);
    expect(NpmIntegritySchema.safeParse(`sha512-${"A".repeat(86)}B==`).success).toBe(false);
    expect(NpmIntegritySchema.safeParse(`sha256-${"A".repeat(86)}==`).success).toBe(false);
  });

  it("rejects unsupported protocols, credentials, malformed escapes, and unknown fields", () => {
    for (const url of ["ftp://example.com/plugin.git", "file:///tmp/plugin", "data:text/plain,plugin", "http://example.com/plugin.git"]) {
      expect(PluginSourceSchema.safeParse({ kind: "git", url }).success).toBe(false);
    }
    expect(PluginSourceSchema.safeParse({ kind: "git", url: "https://user:password@example.com/plugin.git" }).success).toBe(false);
    expect(PluginSourceSchema.safeParse({ kind: "git", url: "ssh://git@example.com/plugin.git" }).success).toBe(true);
    expect(PluginSourceSchema.safeParse({ kind: "git", url: "git@example.com:owner/plugin.git" }).success).toBe(true);
    expect(PluginSourceSchema.safeParse({ kind: "git", url: "https://example.com/%zz" }).success).toBe(false);
    expect(PluginSourceSchema.safeParse({ kind: "git", url: "https://example.com/%25zz" }).success).toBe(true);
    expect(PluginSourceSchema.safeParse({ kind: "git", url: "https://example.com/plugin.git", extra: true }).success).toBe(false);
    expect(PluginSourceSchema.safeParse({ kind: "npm", package: "@example/plugin", registry: "http://registry.example.com" }).success).toBe(false);
    expect(PluginSourceSchema.safeParse({ kind: "npm", package: "@example/plugin", registry: "https://user:password@registry.example.com" }).success).toBe(false);
    expect(PluginSourceSchema.safeParse({ kind: "npm", package: "@example/plugin", registry: "https://registry.example.com", extra: true }).success).toBe(false);
    expect(PluginSourceSchema.safeParse({ kind: "git", url: "https://example.com/plugin.git", sha: "a".repeat(39) }).success).toBe(false);
  });

  it("rejects lone UTF-16 surrogates in every source boundary", () => {
    const high = String.fromCharCode(0xd800);
    const low = String.fromCharCode(0xdc00);
    const invalidSources: readonly [z.ZodTypeAny, unknown][] = [
      [MarketplaceSourceSchema, { kind: "github", repository: `owner/repository${high}` }],
      [MarketplaceSourceSchema, { kind: "git", url: `https://example.com/plugin.git`, ref: `main${low}` }],
      [MarketplaceSourceSchema, { kind: "local-git", path: `./catalog${high}` }],
      [PluginSourceSchema, { kind: "marketplace-path", path: `./plugins/demo${low}` }],
      [PluginSourceSchema, { kind: "git", url: `ssh://git@example.com/plugin${high}.git` }],
      [PluginSourceSchema, { kind: "git-subdir", url: "https://example.com/plugin.git", path: `packages/demo${low}` }],
      [PluginSourceSchema, { kind: "npm", package: `@example/plugin${high}` }],
      [PluginSourceSchema, { kind: "npm", package: "@example/plugin", selector: `^1.0.0${low}` }],
      [PluginSourceSchema, { kind: "npm", package: "@example/plugin", registry: `https://registry.example.com/${high}` }],
    ];

    for (const [index, [schema, source]] of invalidSources.entries()) {
      expect(schema.safeParse(source).success, `invalid source case ${index}`).toBe(false);
    }
    expect(CanonicalSourceSchema.safeParse(`source-v1|git|url:3:${high}`).success).toBe(false);
    expect(() => hashCanonicalSource(`source-v1|git|url:3:${low}` as CanonicalSource, hashBytes)).toThrow();
  });

  it("accepts only package-produced canonical field signatures", () => {
    const invalidCanonicalSources = [
      "source-v1|git|foo:1:x",
      "source-v1|git|url:01:x",
      "source-v1|npm|package:0:",
      "source-v1|git|ref:4:main|url:30:https://example.com/plugin.git",
      "source-v1|git|url:30:https://example.com/plugin.git|sha:40:" + revision + "|ref:4:main",
      "source-v1|unknown|url:30:https://example.com/plugin.git",
      "source-v1|git|url:21:scp://server/repo.git",
    ];

    for (const canonical of invalidCanonicalSources) {
      expect(CanonicalSourceSchema.safeParse(canonical).success).toBe(false);
    }
    expect(CanonicalSourceSchema.safeParse(
      "source-v1|git|url:30:https://example.com/plugin.git|sha:40:" + revision,
    ).success).toBe(true);
  });

  it("derives declared and resolved types from their schemas", () => {
    expectTypeOf<z.infer<typeof MarketplaceSourceSchema>>().toEqualTypeOf<MarketplaceSource>();
    expectTypeOf<z.infer<typeof PluginSourceSchema>>().toEqualTypeOf<PluginSource>();
    expectTypeOf<z.infer<typeof ResolvedMarketplaceSourceSchema>>().toEqualTypeOf<ResolvedMarketplaceSource>();
    expectTypeOf<z.infer<typeof ResolvedPluginSourceSchema>>().toEqualTypeOf<ResolvedPluginSource>();

    const declared: PluginSource = {
      kind: "git",
      url: "https://example.com/plugin.git",
      ref: "main",
    };
    const requiresResolved = (source: ResolvedPluginSource): ResolvedPluginSource => source;
    // @ts-expect-error declared selectors and resolved revisions are different contracts
    requiresResolved(declared);
    expectTypeOf<PluginSource>().not.toMatchTypeOf<ResolvedPluginSource>();
  });
});

describe("canonical source serialization", () => {
  it("uses field lengths to protect values containing grammar delimiters", () => {
    const source = {
      kind: "npm",
      package: "a|ref:3:x",
      selector: "b:c|d",
    } as const;

    expect(serializePluginSource(source)).toBe(
      "source-v1|npm|package:9:a|ref:3:x|selector:5:b:c|d",
    );
    expect(CanonicalSourceSchema.safeParse(serializePluginSource(source)).success).toBe(true);
    expect(CanonicalSourceSchema.safeParse("source-v1|github").success).toBe(false);
  });

  it("uses registry order rather than caller object key order", () => {
    const source = {
      ref: "main",
      url: "HTTPS://Example.COM:443/repository.git",
      kind: "git",
    } as const;

    expect(serializeMarketplaceSource(source)).toBe(
      "source-v1|git|url:34:https://example.com/repository.git|ref:4:main",
    );
    expect(serializeMarketplaceSource({ kind: "git", url: "https://example.com/repository.git", ref: "main" })).toBe(
      serializeMarketplaceSource(source),
    );
  });

  it("omits absent optionals without inventing defaults", () => {
    expect(serializePluginSource({ kind: "git", url: "https://example.com/plugin.git" })).toBe(
      "source-v1|git|url:30:https://example.com/plugin.git",
    );
    expect(serializePluginSource({ kind: "git", url: "https://example.com/plugin.git", ref: "main" })).toBe(
      "source-v1|git|url:30:https://example.com/plugin.git|ref:4:main",
    );
  });

  it("counts UTF-8 bytes and percent-encodes path segments", () => {
    expect(serializeMarketplaceSource({ kind: "local-git", path: "é/🙂" })).toBe(
      "source-v1|local-git|path:19:%C3%A9/%F0%9F%99%82",
    );
    expect(serializePluginSource({ kind: "git-subdir", url: "https://example.com/repository.git", path: "packages/naïve plugin" })).toBe(
      "source-v1|git-subdir|url:34:https://example.com/repository.git|path:28:packages/na%C3%AFve%20plugin",
    );
    expect(serializePluginSource({ kind: "git-subdir", url: "https://example.com/repository.git", path: "./packages/demo" })).toBe(
      serializePluginSource({ kind: "git-subdir", url: "https://example.com/repository.git", path: "packages/demo" }),
    );
  });

  it("normalizes URL syntax without aliasing encoded delimiters", () => {
    expect(serializePluginSource({ kind: "git", url: "HTTPS://Example.COM:443/repo%2Fname" })).toBe(
      "source-v1|git|url:31:https://example.com/repo%2Fname",
    );
    expect(serializePluginSource({ kind: "git", url: "git@example.com:owner/repo.git" })).toBe(
      "source-v1|git|url:36:scp://git@example.com/owner/repo.git",
    );
    expect(serializePluginSource({ kind: "git", url: "git@example.com:owner/repo.git" })).not.toBe(
      serializePluginSource({ kind: "git", url: "ssh://git@example.com/owner/repo.git" }),
    );
    expect(serializePluginSource({ kind: "git", url: "ssh://git@example.com:22/owner/repo.git" })).toBe(
      serializePluginSource({ kind: "git", url: "ssh://git@example.com/owner/repo.git" }),
    );
    expect(serializePluginSource({ kind: "git-subdir", url: "https://example.com/plugin.git", path: "a/b" })).not.toBe(
      serializePluginSource({ kind: "git-subdir", url: "https://example.com/plugin.git", path: "a%2Fb" }),
    );
    expect(() => serializePluginSource({ kind: "git", url: "https://example.com/%zz" })).toThrow();
  });

  it("preserves SCP remote-home-relative and literal-percent semantics", () => {
    const canonical = serializePluginSource({
      kind: "git",
      url: "GIT@Example.COM:owner/%zz.git",
    });

    expect(canonical).toBe("source-v1|git|url:35:scp://GIT@example.com/owner/%zz.git");
    expect(CanonicalSourceSchema.safeParse(canonical).success).toBe(true);
    expect(canonical).not.toBe(
      serializePluginSource({ kind: "git", url: "ssh://git@example.com/owner/%25zz.git" }),
    );
  });
});

describe("resolved source construction and verification", () => {
  it("constructs canonical immutable sources and injects their hash", () => {
    const marketplace = createResolvedMarketplaceSource({
      declared: { kind: "github", repository: "owner/repository", ref: "main" },
      revision,
    }, hashBytes);
    expect(marketplace.canonical).toBe(
      `source-v1|github|repository:16:owner/repository|revision:40:${revision}`,
    );
    expect(marketplace.hash).toBe(sourceHash);
    expect(ResolvedMarketplaceSourceSchema.safeParse(marketplace).success).toBe(true);

    const plugin = resolvedGit();
    if (plugin.kind !== "git") throw new Error("expected resolved Git source");
    expect(plugin.url).toBe("https://example.com/plugin.git");
    expect(plugin.canonical).toBe(`source-v1|git|url:30:https://example.com/plugin.git|revision:40:${revision}`);
    expect(ResolvedPluginSourceSchema.safeParse(plugin).success).toBe(true);
  });

  it("rejects kind/canonical mismatches before hash verification", () => {
    const plugin = resolvedGit();
    const mismatched = {
      ...plugin,
      kind: "git-subdir",
      path: "packages/demo",
    } as unknown as ResolvedPluginSource;
    expect(ResolvedPluginSourceSchema.safeParse(mismatched).success).toBe(false);

    const wrongCanonical = {
      ...plugin,
      canonical: "source-v1|npm|package:15:@example/plugin" as CanonicalSource,
    };
    expect(ResolvedPluginSourceSchema.safeParse(wrongCanonical).success).toBe(false);
    expect(() => verifyResolvedPluginSource({ ...plugin, hash: `sha256:${"f".repeat(64)}` }, hashBytes)).toThrow();
    expect(() => createResolvedPluginSource({ ...plugin, hash: `sha256:${"f".repeat(64)}` }, hashBytes)).toThrow();
  });

  it("rejects a resolved marketplace canonical claim that omits its immutable revision", () => {
    const valid = createResolvedMarketplaceSource({
      declared: { kind: "git", url: "https://example.com/catalog.git", ref: "main" },
      revision,
    }, hashBytes);
    expect(ResolvedMarketplaceSourceSchema.safeParse({
      ...valid,
      canonical: serializeMarketplaceSource(valid.declared),
    }).success).toBe(false);
    expect(() => verifyResolvedMarketplaceSource({ ...valid, hash: `sha256:${"f".repeat(64)}` }, hashBytes)).toThrow();
  });
});

describe("canonical source hashing", () => {
  it("hashes canonical UTF-8 bytes through the injected SHA-256 port", () => {
    const canonical = "source-v1|npm|package:15:@example/plugin" as CanonicalSource;
    let received = "";
    const sha256: Sha256 = (bytes) => {
      received = new TextDecoder().decode(bytes);
      return Uint8Array.from({ length: 32 }, (_, index) => index);
    };

    const hash = hashCanonicalSource(canonical, sha256);
    expect(received).toBe(canonical);
    expect(hash).toBe(sourceHash);
    expect(SourceHashSchema.safeParse(hash).success).toBe(true);
  });

  it.each([31, 33])("rejects an injected digest of %i bytes", (length) => {
    expect(() => hashCanonicalSource(
      "source-v1|git|url:30:https://example.com/plugin.git" as CanonicalSource,
      () => new Uint8Array(length),
    )).toThrow("exactly 32 bytes");
  });

  it("rejects a non-canonical input even when the type is forged", () => {
    expect(() => hashCanonicalSource("not-canonical" as CanonicalSource, () => new Uint8Array(32))).toThrow();
  });
});

function resolvedKind(source: ResolvedPluginSource): ResolvedPluginSource["kind"] {
  switch (source.kind) {
    case "marketplace-path":
    case "git":
    case "git-subdir":
    case "npm":
      return source.kind;
    default:
      return assertNever(source);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected source: ${String(value)}`);
}

void resolvedKind;
void assertNever;
