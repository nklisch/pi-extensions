import { describe, expect, it } from "vitest";
import { BoundaryError } from "../../../src/domain/errors.js";
import {
  readCodexMarketplace,
  readCodexMarketplaceJson,
} from "../../../src/formats/codex/marketplace-reader.js";

describe("Codex marketplace reader", () => {
  it("retains complete provenance when pluginRoot derives a local marketplace path", () => {
    const result = readCodexMarketplace({
      name: "rooted-catalog",
      metadata: { pluginRoot: "./plugins" },
      plugins: [{
        name: "rooted",
        source: { source: "local", path: "./entry" },
        policy: { installation: "AVAILABLE" },
      }],
    });

    const source = result.marketplace.entries[0]?.source;
    expect(source?.value).toEqual({ kind: "marketplace-path", path: "./plugins/entry" });
    expect(source?.provenance).toEqual([
      {
        location: {
          host: "codex",
          documentKind: "marketplace",
          path: ".agents/plugins/marketplace.json",
          pointer: "/metadata/pluginRoot",
        },
        declaration: "./plugins",
      },
      {
        location: {
          host: "codex",
          documentKind: "marketplace",
          path: ".agents/plugins/marketplace.json",
          pointer: "/plugins/0/source",
        },
        declaration: { source: "local", path: "./entry" },
      },
    ]);
  });

  it("normalizes native and Claude-compatible sources", () => {
    const result = readCodexMarketplace({
      name: "codex-catalog",
      interface: { displayName: "Codex Catalog" },
      plugins: [
        {
          name: "local",
          source: { source: "local", path: "./plugins/local" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
          interface: { displayName: "Local" },
        },
        {
          name: "remote",
          source: { source: "git-subdir", url: "https://github.com/example/plugins.git", path: "plugin", ref: "main" },
          policy: { installation: "INSTALLED_BY_DEFAULT" },
          skills: ["./skills"],
        },
        {
          name: "compatible",
          source: "./plugins/compatible",
          policy: { installation: "NOT_AVAILABLE" },
        },
      ],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.marketplace.metadata.map((metadata) => metadata.key)).toEqual(["codex.interface"]);
    expect(result.marketplace.entries.map((entry) => entry.source.value)).toEqual([
      { kind: "marketplace-path", path: "./plugins/local" },
      { kind: "git-subdir", url: "https://github.com/example/plugins.git", path: "plugin", ref: "main" },
      { kind: "marketplace-path", path: "./plugins/compatible" },
    ]);
    expect(result.marketplace.entries.map((entry) => entry.policy?.availability.value)).toEqual([
      "available",
      "installed-by-default",
      "not-available",
    ]);
    expect(result.marketplace.entries[0]?.authorities[0]).toMatchObject({
      nativeHost: "codex",
      manifest: { value: "required" },
      catalogRuntime: { value: "supplemental" },
    });
    expect(result.marketplace.entries[0]?.authorities[0]).not.toHaveProperty("strict");
    expect(result.marketplace.entries[0]?.metadata.map((metadata) => metadata.key)).toEqual(["codex.category", "codex.interface"]);
    expect(result.marketplace.entries[0]?.metadata[0]?.claimed.value).toBe("Productivity");
    expect(result.marketplace.entries[0]?.metadata[0]?.claimed.provenance[0]?.location.pointer).toBe("/plugins/0/category");
    expect(result.marketplace.entries[1]?.declarations[0]?.field).toBe("skills");
  });

  it("drops missing/unknown policy, Claude strictness, and malformed entries atomically", () => {
    const result = readCodexMarketplace({
      name: "codex-partial",
      plugins: [
        { name: "good", source: { source: "local", path: "./good" }, policy: { installation: "AVAILABLE" } },
        { name: "missing-policy", source: "./missing" },
        { name: "unknown-policy", source: "./unknown", policy: { installation: "MAYBE" } },
        { name: "claude-strict", source: "./strict", strict: true, policy: { installation: "AVAILABLE" } },
        { name: "bad-runtime", source: "./runtime", policy: { installation: "AVAILABLE" }, hooks: null },
        { name: "good-sibling", source: "./sibling", policy: { installation: "NOT_AVAILABLE" } },
      ],
    });
    expect(result.marketplace.entries.map((entry) => entry.identity.value.marketplaceEntryName)).toEqual(["good", "good-sibling"]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "ENTRY_INVALID",
      "ENTRY_INVALID",
      "ENTRY_INVALID",
      "ENTRY_INVALID",
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.location?.pointer)).toEqual([
      "/plugins/1/policy",
      "/plugins/2/policy/installation",
      "/plugins/3/strict",
      "/plugins/4/hooks",
    ]);
  });

  it("validates Codex nested runtime and dependency records without losing supported shapes", () => {
    const result = readCodexMarketplace({
      name: "codex-declaration-shapes",
      plugins: [
        { name: "empty-hooks", source: "./empty-hooks", policy: { installation: "AVAILABLE" }, hooks: { SessionStart: [] } },
        { name: "unknown-server", source: "./unknown-server", policy: { installation: "AVAILABLE" }, mcpServers: { main: { mystery: true } } },
        { name: "bad-dependency", source: "./bad-dependency", policy: { installation: "AVAILABLE" }, dependencies: { runtime: {} } },
        {
          name: "valid",
          source: "./valid",
          policy: { installation: "AVAILABLE" },
          hooks: { SessionStart: [{ type: "command", command: "echo ready" }] },
          mcpServers: {
            main: {
              command: "node",
              args: ["server.js"],
              http_headers: { Authorization: "Bearer token" },
              startup_timeout_sec: 5,
            },
          },
          dependencies: { "runtime-helper": "^1.0.0" },
          plugins: [{ name: "nested-plugin", source: "./nested-plugin" }],
        },
        { name: "sibling", source: "./sibling", policy: { installation: "NOT_AVAILABLE" } },
      ],
    });

    expect(result.marketplace.entries.map((entry) => entry.identity.value.marketplaceEntryName)).toEqual([
      "valid",
      "sibling",
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.location?.pointer)).toEqual([
      "/plugins/0/hooks/SessionStart",
      "/plugins/1/mcpServers/main",
      "/plugins/2/dependencies/runtime",
    ]);
    const valid = result.marketplace.entries[0]!;
    expect(valid.declarations.map((declaration) => declaration.field)).toEqual([
      "hooks",
      "mcpServers",
      "dependencies",
      "plugins",
    ]);
    expect(valid.declarations[1]?.declaration.value).toMatchObject({
      main: { command: "node", http_headers: { Authorization: "Bearer token" } },
    });
    expect(valid.declarations[1]?.declaration.provenance[0]).toMatchObject({
      location: { pointer: "/plugins/3/mcpServers" },
      declaration: { main: { command: "node", args: ["server.js"], http_headers: { Authorization: "Bearer token" }, startup_timeout_sec: 5 } },
    });
  });

  it("validates nested OAuth and policy value types without discarding valid raw declarations", () => {
    const result = readCodexMarketplace({
      name: "nested-value-types",
      plugins: [
        {
          name: "bad-oauth",
          source: "./bad-oauth",
          policy: { installation: "AVAILABLE" },
          mcpServers: { main: { command: "node", oauth: { clientId: {} } } },
        },
        {
          name: "bad-plugin-policy",
          source: "./bad-plugin-policy",
          policy: { installation: "AVAILABLE" },
          plugins: [{ name: "nested", source: "./nested", policy: { installation: {} } }],
        },
        {
          name: "bad-dependency-authentication",
          source: "./bad-dependency-authentication",
          policy: { installation: "AVAILABLE" },
          dependencies: [{ name: "helper", policy: { authentication: [] } }],
        },
        {
          name: "valid",
          source: "./valid",
          policy: { installation: "AVAILABLE" },
          mcpServers: {
            main: {
              command: "node",
              oauth: {
                clientId: "client-id",
                clientSecret: "client-secret",
                authorizationUrl: "https://example.com/authorize",
                tokenUrl: "https://example.com/token",
                accessTokenEnvVar: "MCP_TOKEN",
                scopes: ["read"],
              },
            },
          },
          plugins: [{ name: "nested", source: "./nested", policy: { installation: "AVAILABLE" } }],
          dependencies: [{ name: "helper", policy: { authentication: "ON_INSTALL" } }],
        },
        { name: "sibling", source: "./sibling", policy: { installation: "NOT_AVAILABLE" } },
      ],
    });

    expect(result.marketplace.entries.map((entry) => entry.identity.value.marketplaceEntryName)).toEqual([
      "valid",
      "sibling",
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.location?.pointer)).toEqual([
      "/plugins/0/mcpServers/main/oauth/clientId",
      "/plugins/1/plugins/0/policy/installation",
      "/plugins/2/dependencies/0/policy/authentication",
    ]);
    const valid = result.marketplace.entries[0]!;
    expect(valid.declarations.map((declaration) => declaration.field)).toEqual([
      "mcpServers",
      "dependencies",
      "plugins",
    ]);
    expect(valid.declarations[0]?.declaration.value).toMatchObject({
      main: { oauth: { clientId: "client-id", scopes: ["read"] } },
    });
    expect(valid.declarations[1]?.declaration.value).toEqual([
      { name: "helper", policy: { authentication: "ON_INSTALL" } },
    ]);
    expect(valid.declarations[2]?.declaration.provenance[0]?.location.pointer).toBe("/plugins/3/plugins");
  });

  it("normalizes repository subdirectory aliases while retaining raw spelling", () => {
    const result = readCodexMarketplace({
      name: "codex-catalog",
      plugins: [
        { name: "bare", source: { source: "git-subdir", url: "https://example.com/repo.git", path: "plugin" }, policy: { installation: "AVAILABLE" } },
        { name: "dotted", source: { source: "git-subdir", url: "https://example.com/repo.git", path: "./plugin" }, policy: { installation: "AVAILABLE" } },
      ],
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.marketplace.entries.map((entry) => entry.source.value)).toEqual([
      { kind: "git-subdir", url: "https://example.com/repo.git", path: "plugin" },
      { kind: "git-subdir", url: "https://example.com/repo.git", path: "plugin" },
    ]);
    expect(result.marketplace.entries.map((entry) => entry.source.provenance[0]?.declaration)).toEqual([
      { source: "git-subdir", url: "https://example.com/repo.git", path: "plugin" },
      { source: "git-subdir", url: "https://example.com/repo.git", path: "./plugin" },
    ]);
  });

  it("rejects unsupported source forms and preserves exact source declarations", () => {
    const result = readCodexMarketplace({
      name: "codex-catalog",
      plugins: [
        { name: "unsupported", source: { source: "github", repo: "owner/repo" }, policy: { installation: "AVAILABLE" } },
        { name: "traversal", source: { source: "local", path: "./../escape" }, policy: { installation: "AVAILABLE" } },
        { name: "good", source: { source: "local", path: "./good" }, policy: { installation: "AVAILABLE" } },
      ],
    });
    expect(result.marketplace.entries).toHaveLength(1);
    expect(result.marketplace.entries[0]?.source.provenance[0]?.declaration).toEqual({ source: "local", path: "./good" });
    expect(result.diagnostics.map((diagnostic) => diagnostic.location?.pointer)).toEqual([
      "/plugins/0/source/source",
      "/plugins/1/source/path",
    ]);
  });

  it("maps JSON syntax and root failures to typed boundary errors", () => {
    try {
      readCodexMarketplaceJson("[1,2,3]");
      throw new Error("expected root failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BoundaryError);
      expect((error as BoundaryError).code).toBe("MARKETPLACE_ROOT_INVALID");
      expect((error as BoundaryError).location?.pointer).toBe("");
    }
    try {
      readCodexMarketplaceJson("{broken");
      throw new Error("expected JSON failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BoundaryError);
      expect((error as BoundaryError).operation).toBe("readCodexMarketplaceJson");
      expect((error as BoundaryError).cause).toBeInstanceOf(SyntaxError);
    }
  });
});
