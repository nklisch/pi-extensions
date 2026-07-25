import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createContentManifest,
} from "../../src/domain/content-manifest.js";
import {
  createResolvedMarketplaceSource,
  createResolvedPluginSource,
  type Sha256,
} from "../../src/domain/source.js";
import {
  createSourceMaterializers,
  normalizeMarketplaceSourcePath,
  SourceMaterializationError,
  type SecureContentSession,
  type SourceMaterializationDependencies,
} from "../../src/application/source-materialization.js";

const sha256: Sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = (): AbortSignal => new AbortController().signal;
const marketplace = createResolvedMarketplaceSource({
  declared: { kind: "local-git", path: "/marketplace" },
  revision: "a".repeat(40),
}, sha256);
const plugin = createResolvedPluginSource({
  kind: "git",
  url: "https://example.test/plugin.git",
  revision: "b".repeat(40),
}, sha256);

function session(options: { failFinalize?: boolean; root?: string; failAbort?: boolean } = {}): SecureContentSession & { aborts: number } {
  const content = createContentManifest([], sha256);
  const value = {
    aborts: 0,
    workRoot: "/slot/.work",
    contentRoot: options.root ?? "/slot/content",
    async add() {},
    async finalize() {
      if (options.failFinalize) throw new Error("finalize failed");
      return { root: options.root ?? "/slot/content", content };
    },
    async abort() {
      value.aborts += 1;
      if (options.failAbort) throw new Error("cleanup failed");
    },
  };
  return value;
}

type DependencyOverrides = Omit<Partial<SourceMaterializationDependencies>, "content"> & {
  content?: Partial<SourceMaterializationDependencies["content"]>;
};

function dependencies(overrides: DependencyOverrides = {}): SourceMaterializationDependencies {
  const current = session();
  const baseContent = {
    canonicalize: vi.fn(async (slot: { root: string }) => ({ root: slot.root.startsWith("/") ? slot.root : "/slot" })),
    open: vi.fn(async () => current),
  };
  return {
    git: {
      materializeMarketplace: vi.fn(async () => marketplace),
      materializePlugin: vi.fn(async () => plugin),
    },
    npm: { materialize: vi.fn(async () => plugin) },
    sha256,
    ...overrides,
    content: { ...baseContent, ...(overrides.content ?? {}) },
  };
}

describe("source materialization application contract", () => {
  it("maps catalog-relative ./ paths onto canonical content paths without weakening containment", () => {
    expect(normalizeMarketplaceSourcePath("./plugins/demo")).toBe("plugins/demo");
    expect(normalizeMarketplaceSourcePath("plugins/demo")).toBe("plugins/demo");
    expect(() => normalizeMarketplaceSourcePath("./../escape")).toThrow();
    expect(() => normalizeMarketplaceSourcePath(".//absolute")).toThrow();
  });

  it("dispatches external plugin sources and verifies the resolved handoff", async () => {
    const deps = dependencies();
    const result = await createSourceMaterializers(deps).plugins.materialize(
      { kind: "git", url: "https://example.test/plugin.git" },
      { kind: "external" },
      { root: "/slot" },
      signal(),
    );
    expect(result.root).toBe("/slot/content");
    expect(result.source).toEqual(plugin);
    expect(deps.git.materializePlugin).toHaveBeenCalledOnce();
  });

  it("rejects context mismatches before opening a sink", async () => {
    const deps = dependencies();
    await expect(createSourceMaterializers(deps).plugins.materialize(
      { kind: "marketplace-path", path: "../escape" },
      { kind: "external" },
      { root: "/slot" },
      signal(),
    )).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED", classification: "security" });
    expect(deps.content.open).not.toHaveBeenCalled();
  });

  it("cleans before rethrowing adapter failures and never returns a partial handoff", async () => {
    const current = session();
    const deps = dependencies({
      content: { open: vi.fn(async () => current) },
      git: {
        materializeMarketplace: vi.fn(async () => { throw new Error("secret remote stderr"); }),
        materializePlugin: vi.fn(async () => plugin),
      },
    });
    const materializers = createSourceMaterializers(deps);
    await expect(materializers.marketplaces.materialize(
      { kind: "local-git", path: "/marketplace" },
      { root: "/slot" },
      signal(),
    )).rejects.toMatchObject({ code: "ADAPTER_FAILED" });
    expect(current.aborts).toBe(1);
  });

  it("preserves caller cancellation instead of converting it to a diagnostic", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    const deps = dependencies();
    await expect(createSourceMaterializers(deps).marketplaces.materialize(
      { kind: "local-git", path: "/marketplace" },
      { root: "/slot" },
      controller.signal,
    )).rejects.toBe(reason);
    expect(deps.content.open).not.toHaveBeenCalled();
  });

  it("preserves primary and cleanup failures together", async () => {
    const current = session({ failAbort: true });
    const deps = dependencies({
      content: { open: vi.fn(async () => current) },
      git: {
        materializeMarketplace: vi.fn(async () => { throw new Error("primary failed"); }),
        materializePlugin: vi.fn(async () => plugin),
      },
    });
    const error = await createSourceMaterializers(deps).marketplaces.materialize(
      { kind: "local-git", path: "/marketplace" }, { root: "/slot" }, signal(),
    ).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "ADAPTER_FAILED" });
    expect((error as SourceMaterializationError).cause).toBeInstanceOf(AggregateError);
  });

  it("rejects a resolved source whose origin differs from the declaration", async () => {
    const current = session();
    const deps = dependencies({ content: { open: vi.fn(async () => current) } });
    await expect(createSourceMaterializers(deps).plugins.materialize(
      { kind: "git", url: "https://declared.example/plugin.git" },
      { kind: "external" },
      { root: "/slot" },
      signal(),
    )).rejects.toMatchObject({ code: "SOURCE_RESOLUTION_FAILED" });
    expect(current.aborts).toBe(1);
  });

  it("rejects a forged result root instead of returning content outside the slot", async () => {
    const current = session({ root: "/other/content" });
    const deps = dependencies({ content: { open: vi.fn(async () => current) } });
    await expect(createSourceMaterializers(deps).plugins.materialize(
      { kind: "git", url: "https://example.test/plugin.git" },
      { kind: "external" },
      { root: "/slot" },
      signal(),
    )).rejects.toMatchObject({ code: "ADAPTER_FAILED" });
    expect(current.aborts).toBe(1);
  });

  it("binds a SHA-shaped Git ref and canonicalizes relative slots before opening", async () => {
    const current = session({ root: "/canonical-slot/content" });
    const forged = createResolvedPluginSource({
      kind: "git",
      url: "https://example.test/plugin.git",
      revision: "b".repeat(40),
    }, sha256);
    const deps = dependencies({
      content: {
        canonicalize: vi.fn(async () => ({ root: "/canonical-slot" })),
        open: vi.fn(async () => current),
      },
      git: { materializeMarketplace: vi.fn(async () => marketplace), materializePlugin: vi.fn(async () => forged) },
    });
    await expect(createSourceMaterializers(deps).plugins.materialize(
      { kind: "git", url: "https://example.test/plugin.git", ref: "a".repeat(40) },
      { kind: "external" }, { root: "relative-slot" }, signal(),
    )).rejects.toMatchObject({ code: "SOURCE_RESOLUTION_FAILED" });
    expect(deps.content.open).toHaveBeenCalledWith({ root: "/canonical-slot" });
  });

  it("rejects a marketplace Git result that mismatches a SHA-shaped ref", async () => {
    const declared = { kind: "git" as const, url: "https://example.test/marketplace.git", ref: "a".repeat(40) };
    const forged = createResolvedMarketplaceSource({ declared, revision: "b".repeat(40) }, sha256);
    const current = session();
    const deps = dependencies({
      content: { open: vi.fn(async () => current) },
      git: { materializeMarketplace: vi.fn(async () => forged), materializePlugin: vi.fn(async () => plugin) },
    });
    await expect(createSourceMaterializers(deps).marketplaces.materialize(
      declared,
      { root: "/slot" },
      signal(),
    )).rejects.toMatchObject({
      code: "SOURCE_RESOLUTION_FAILED",
      operation: "materializeMarketplace",
      message: "resolved Git revision does not match the SHA-shaped ref",
    });
    expect(current.aborts).toBe(1);
  });

  it("binds an exact npm selector at the application handoff too", async () => {
    const npmPlugin = createResolvedPluginSource({
      kind: "npm",
      package: "fixture",
      version: "2.0.0",
      integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      registry: "https://registry.npmjs.org/",
    }, sha256);
    const deps = dependencies({
      npm: { materialize: vi.fn(async () => npmPlugin) },
    });
    await expect(createSourceMaterializers(deps).plugins.materialize(
      { kind: "npm", package: "fixture", selector: "1.0.0" },
      { kind: "external" }, { root: "/slot" }, signal(),
    )).rejects.toMatchObject({ code: "SOURCE_RESOLUTION_FAILED" });
  });

  it("rejects a session that does not prove the canonical content root", async () => {
    const current = session({ root: "/forged/content" });
    const deps = dependencies({
      content: {
        canonicalize: vi.fn(async () => ({ root: "/canonical-slot" })),
        open: vi.fn(async () => current),
      },
    });
    await expect(createSourceMaterializers(deps).plugins.materialize(
      { kind: "git", url: "https://example.test/plugin.git" },
      { kind: "external" }, { root: "relative-slot" }, signal(),
    )).rejects.toMatchObject({ code: "ADAPTER_FAILED" });
  });

  it("exposes a classified boundary error without leaking adapter text", () => {
    const error = new SourceMaterializationError({
      code: "SOURCE_RESOLUTION_FAILED",
      classification: "transient",
      operation: "resolveGitSource",
      message: "network unavailable",
    });
    expect(error.toDiagnostic().code).toBe("SOURCE_RESOLUTION_FAILED");
    expect(error.classification).toBe("transient");
  });
});
