import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createMarketplaceCatalogService } from "../../src/application/marketplace-catalog-service.js";
import { createMarketplaceConfigurationRecord } from "../../src/domain/update-policy.js";
import { createContentManifest, createMaterializationBinding } from "../../src/domain/content-manifest.js";
import { createMarketplaceSnapshotRecord, InstalledUserStateDocumentSchema } from "../../src/domain/state/installed-state.js";
import { createResolvedMarketplaceSource, type Sha256 } from "../../src/domain/source.js";
import { HostConfigDocumentSchema, GenerationSchema } from "../../src/domain/state/config-state.js";
import { TrustStateDocumentSchema } from "../../src/domain/state/trust-state.js";
import { StatePointersDocumentSchema } from "../../src/domain/state/pointers.js";
import { deriveStateBlobRef } from "../../src/domain/state/references.js";
import { deriveProjectKey } from "../../src/domain/state/scope.js";
import { readClaudeMarketplace } from "../../src/formats/claude/marketplace-reader.js";
import { MarketplaceCatalogError } from "../../src/application/marketplace-catalog-contract.js";
import type { GenerationSnapshot } from "../../src/application/state-contract.js";

const sha256: Sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const digest = (value: string) => `sha256:${value.repeat(64)}` as `sha256:${string}`;

function fixture(options: Readonly<{ currentProject?: boolean }> = {}) {
  let generation = GenerationSchema.parse(0);
  const source = { kind: "github" as const, repository: "example/community" };
  const resolved = createResolvedMarketplaceSource({ declared: source, revision: "a".repeat(40) }, sha256);
  const content = createContentManifest([], sha256);
  const snapshot = createMarketplaceSnapshotRecord({ marketplace: "community", source: resolved, content, binding: createMaterializationBinding(resolved.hash, content.rootDigest, sha256) }, sha256);
  const record = createMarketplaceConfigurationRecord({ marketplace: "community", source });
  const catalog = readClaudeMarketplace({
    name: "community",
    plugins: [
      { name: "zeta", source: "./zeta", description: "Zeta tools", strict: false },
      { name: "alpha", source: "./alpha", description: "Alpha tools", strict: false },
    ],
  });
  const resolveMarketplace = vi.fn(async () => ({ kind: "marketplace" as const, root: "/store/community", identity: {} as never, manifest: content, contentRef: snapshot.contentRef }));

  function snapshotState(): Extract<GenerationSnapshot, { scope: { kind: "user" } }> {
    return {
      scope: { kind: "user" },
      generation,
      pointers: StatePointersDocumentSchema.parse({
        schemaVersion: 1,
        scope: { kind: "user" },
        generation,
        documents: ["hostConfig", "installedUser", "trust"].map((document) => ({
          kind: document,
          generation,
          blob: deriveStateBlobRef({ document, scope: "user", generation }, sha256),
          digest: digest("a"),
        })),
      }),
      config: HostConfigDocumentSchema.parse({ schemaVersion: 4, generation, global: { application: "manual", cadence: "balanced" }, scope: {}, records: [record] }),
      installed: InstalledUserStateDocumentSchema.parse({ schemaVersion: 2, generation, marketplaces: [snapshot], plugins: [] }),
      trust: TrustStateDocumentSchema.parse({ schemaVersion: 1, generation, records: [] }),
      corruptions: [],
    };
  }
  const identity = { kind: "path-only" as const, canonicalRoot: "file:///project/", limitation: "identity-changes-with-canonical-root" as const };
  const currentProject = { kind: "project" as const, identity, projectKey: deriveProjectKey(identity, sha256) };
  const service = createMarketplaceCatalogService({
    state: { read: async () => ({ ok: true, snapshot: snapshotState() }), commit: async () => { throw new Error("read only"); } },
    content: { resolveMarketplace } as never,
    inspection: { inspect: async () => catalog },
    clock: { nowEpochMilliseconds: () => 1_000, monotonicMilliseconds: () => 1_000 },
    sha256,
    ...(options.currentProject === true ? { currentProject } : {}),
  });
  return { service, resolveMarketplace, advance: () => { generation = GenerationSchema.parse(generation + 1); } };
}

describe("marketplace catalog service", () => {
  it("searches selected snapshots offline in deterministic order and resolves exact candidates", async () => {
    const current = fixture();
    const page = await current.service.search({ scope: "all-current", query: "tools", limit: 10 }, new AbortController().signal);
    expect(page.candidates.map((candidate) => candidate.name)).toEqual(["alpha", "zeta"]);
    expect(page.observations).toMatchObject([{ status: "ready" }]);
    expect(current.resolveMarketplace).toHaveBeenCalled();

    const alpha = page.candidates[0]!;
    const detail = await current.service.detail({ candidateId: alpha.id, snapshot: alpha.snapshot }, new AbortController().signal);
    expect(detail).toMatchObject({ kind: "found", candidate: { id: alpha.id, marketplaceRevision: "a".repeat(40), trust: "untrusted-not-inspected" } });
    expect(JSON.stringify(detail)).not.toMatch(/rawDeclaration|declarations|authentication/);
    const resolved = await current.service.resolve({ candidateId: alpha.id, snapshot: alpha.snapshot }, new AbortController().signal);
    expect(resolved).toMatchObject({ kind: "resolved", candidate: { id: alpha.id, entry: { identity: { value: { key: "alpha@community" } } } } });
    if (resolved.kind === "resolved") expect(Object.isFrozen(resolved.candidate.entry)).toBe(true);
  });

  it("projects one global marketplace into independently scoped plugin candidates", async () => {
    const current = fixture({ currentProject: true });
    const page = await current.service.search({ scope: "all-current", query: "alpha", limit: 10 }, new AbortController().signal);
    expect(page.candidates).toHaveLength(2);
    expect(page.candidates.map((candidate) => candidate.scope.kind)).toEqual(["user", "project"]);
    expect(new Set(page.candidates.map((candidate) => candidate.id)).size).toBe(2);
    expect(page.candidates.every((candidate) => candidate.registrationId === page.candidates[0]!.registrationId)).toBe(true);
    expect(current.resolveMarketplace).toHaveBeenCalledTimes(2);
  });

  it("binds cursors to the exact generation and reports stale state", async () => {
    const current = fixture();
    const first = await current.service.search({ scope: "user", query: "", limit: 1 }, new AbortController().signal);
    expect(first.nextCursor).toBeDefined();
    current.advance();
    await expect(current.service.search({ scope: "user", query: "", limit: 1, cursor: first.nextCursor }, new AbortController().signal))
      .rejects.toEqual(expect.objectContaining<MarketplaceCatalogError>({ code: "CURSOR_STALE" }));
  });

  it("isolates missing selected content without network fallback", async () => {
    const current = fixture();
    current.resolveMarketplace.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const result = await current.service.search({ scope: "user", query: "", limit: 10 }, new AbortController().signal);
    expect(result.candidates).toEqual([]);
    expect(result.observations).toMatchObject([{ status: "unavailable", cache: { kind: "unavailable" } }]);
  });

  it("maps canonical content verification failures to corrupt without fallback", async () => {
    const current = fixture();
    current.resolveMarketplace.mockRejectedValue(Object.assign(new Error("tampered"), { code: "CONTENT_VERIFICATION_FAILED" }));
    const result = await current.service.search({ scope: "user", query: "", limit: 10 }, new AbortController().signal);
    expect(result.candidates).toEqual([]);
    expect(result.observations).toMatchObject([{ status: "corrupt", cache: { kind: "corrupt" } }]);
    expect(current.resolveMarketplace).toHaveBeenCalledTimes(1);
  });
});
