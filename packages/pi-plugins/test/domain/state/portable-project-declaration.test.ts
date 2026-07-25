import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  PortableMarketplaceSourceSchema,
  PortablePluginSourceSchema,
  PortableProjectDeclarationSchema,
  assertPortableProjectDeclarationSafe,
  decodePortableProjectDeclaration,
  isSafePortableRelativePath,
  parsePortableProjectDeclaration,
  type PortableProjectDeclaration,
} from "../../../src/domain/state/portable-project-declaration.js";

const validDeclaration = {
  schemaVersion: 1,
  marketplaces: [
    { marketplace: "team", source: { kind: "github", repository: "example/plugins" } },
  ],
  plugins: [
    {
      plugin: "demo@team",
      enabled: true,
      constraint: {
        kind: "source",
        source: { kind: "marketplace-path", path: "./plugins/demo" },
      },
    },
    {
      plugin: "remote@team",
      enabled: false,
      constraint: {
        kind: "source",
        source: {
          kind: "git",
          url: "ssh://git@example.com/remote.git",
          ref: "main",
          sha: "0123456789abcdef0123456789abcdef01234567",
        },
      },
    },
  ],
} as const;

describe("portable project plugin intent", () => {
  it("round-trips only portable marketplace and plugin intent", () => {
    const parsed = parsePortableProjectDeclaration(validDeclaration);
    expect(parsed).toEqual(validDeclaration);
    expect(decodePortableProjectDeclaration(parsed)).toEqual(parsed);
    expect(JSON.stringify(parsed)).not.toMatch(/(?:cache|trust|secret|absolute|revision)/i);
  });

  it("derives a portable marketplace union from the existing source registry", () => {
    expect(PortableMarketplaceSourceSchema.safeParse({
      kind: "github",
      repository: "example/plugins",
    }).success).toBe(true);
    expect(PortableMarketplaceSourceSchema.safeParse({
      kind: "git",
      url: "https://example.com/plugins.git",
    }).success).toBe(true);
    expect(PortableMarketplaceSourceSchema.safeParse({
      kind: "local-git",
      path: "/home/user/plugins",
    }).success).toBe(false);
  });

  it("requires safe relative paths for marketplace and repository subdirectory constraints", () => {
    for (const path of [
      "./plugins/demo",
      "./nested/plugin",
      "./space%20name/plugin",
    ]) {
      expect(isSafePortableRelativePath(path), path).toBe(true);
    }
    for (const path of [
      "plugins/demo",
      "./",
      "./../outside",
      "./plugins/../outside",
      "./plugins/%2e%2e/outside",
      "./plugins/%2Foutside",
      "/home/user/plugin",
      "~/plugin",
      "C:/plugin",
      "\\\\server\\share\\plugin",
      "./C:/plugin",
    ]) {
      expect(isSafePortableRelativePath(path), path).toBe(false);
    }

    expect(PortablePluginSourceSchema.safeParse({
      kind: "git-subdir",
      url: "https://example.com/plugins.git",
      path: "plugin",
    }).success).toBe(true);
    expect(PortablePluginSourceSchema.safeParse({
      kind: "git-subdir",
      url: "https://example.com/plugins.git",
      path: "../outside",
    }).success).toBe(false);
  });

  it("enforces unique declaration identities", () => {
    expect(PortableProjectDeclarationSchema.safeParse({
      ...validDeclaration,
      marketplaces: [
        ...validDeclaration.marketplaces,
        validDeclaration.marketplaces[0],
      ],
    }).success).toBe(false);
    expect(PortableProjectDeclarationSchema.safeParse({
      ...validDeclaration,
      plugins: [
        ...validDeclaration.plugins,
        validDeclaration.plugins[0],
      ],
    }).success).toBe(false);
  });

  it("allows plugin intent to use the host-global marketplace registry", () => {
    expect(PortableProjectDeclarationSchema.safeParse({
      ...validDeclaration,
      marketplaces: [],
      plugins: [{ plugin: "missing@other", enabled: true }],
    }).success).toBe(true);
  });

  it("rejects local/file/path credentials and machine-state fields at every depth", () => {
    const invalidValues: unknown[] = [
      {
        ...validDeclaration,
        marketplaces: [{ marketplace: "team", source: { kind: "local-git", path: "/tmp/catalog" } }],
      },
      {
        ...validDeclaration,
        marketplaces: [{ marketplace: "team", source: { kind: "git", url: "file:///tmp/catalog" } }],
      },
      {
        ...validDeclaration,
        marketplaces: [{ marketplace: "team", source: { kind: "git", url: "https://user:password@example.com/catalog.git" } }],
      },
      {
        ...validDeclaration,
        plugins: [{
          plugin: "demo@team",
          enabled: true,
          constraint: { kind: "source", source: { kind: "git", url: "https://example.com/catalog.git", ref: "/tmp/revision" } },
        }],
      },
      {
        ...validDeclaration,
        plugins: [{ plugin: "demo@team", enabled: true, secret: "do-not-store" }],
      },
      {
        ...validDeclaration,
        plugins: [{ plugin: "demo@team", enabled: true, constraint: {
          kind: "source",
          source: { kind: "marketplace-path", path: "./plugins/demo", nested: { cache: "/tmp/cache" } },
        } }],
      },
      {
        ...validDeclaration,
        plugins: [{ plugin: "demo@team", enabled: true, constraint: {
          kind: "declared-version",
          value: "1.0.0",
          diagnostics: [],
        } }],
      },
      {
        ...validDeclaration,
        projectKey: "project-v1:sha256:" + "00".repeat(32),
      },
      {
        ...validDeclaration,
        generation: 4,
      },
    ];

    for (const invalid of invalidValues) {
      expect(() => parsePortableProjectDeclaration(invalid), JSON.stringify(invalid)).toThrow();
      expect(PortableProjectDeclarationSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("fails closed for unknown nested keys and never returns a partial declaration", () => {
    const malformed = {
      ...validDeclaration,
      plugins: [
        validDeclaration.plugins[0],
        { plugin: "broken@team", enabled: true, unknownFutureField: "value" },
      ],
    };

    expect(() => parsePortableProjectDeclaration(malformed)).toThrow();
    expect(() => assertPortableProjectDeclarationSafe(malformed)).not.toThrow();
    expect(PortableProjectDeclarationSchema.safeParse(malformed).success).toBe(false);
    expect(() => parsePortableProjectDeclaration({
      ...validDeclaration,
      schemaVersion: 2,
    })).toThrow();
  });

  it("derives the public declaration type from the single current schema", () => {
    expect(PortableProjectDeclarationSchema.parse(validDeclaration)).toEqual(validDeclaration);
    expectTypeOf<z.infer<typeof PortableProjectDeclarationSchema>>().toEqualTypeOf<PortableProjectDeclaration>();
  });
});
