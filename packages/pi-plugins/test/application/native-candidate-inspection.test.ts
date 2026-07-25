import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createNativeCandidateInspector } from "../../src/application/native-candidate-inspection.js";
import { createNativeInspectionService } from "../../src/application/native-inspection-service.js";
import { deriveInspectionDetailId, deriveInspectionEvidenceSnapshotId } from "../../src/application/native-inspection-identifiers.js";
import { createContentManifest, createMaterializationBinding } from "../../src/domain/content-manifest.js";
import { createResolvedMarketplaceSource } from "../../src/domain/source.js";
import { capabilities, directPlugin, fixtureProvenance, sha256 as fixtureSha } from "../fixtures/compatibility/common.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const registrationId = `marketplace-registration-v1:sha256:${"11".repeat(32)}` as never;
const candidateId = `marketplace-candidate-v1:sha256:${"22".repeat(32)}` as never;
const catalogSnapshot = `marketplace-snapshot-v1:sha256:${"33".repeat(32)}` as never;
const subject = { version: 1 as const, subject: "marketplace-candidate" as const, scope: { kind: "user" as const }, plugin: "fixture@compatibility" as never, registrationId, candidateId, catalogSnapshot };

function setup() {
  const plugin = directPlugin();
  const content = createContentManifest([], fixtureSha);
  const materialized = { root: "/scratch/secret", source: plugin.source, content, binding: createMaterializationBinding(plugin.source.hash, content.rootDigest, fixtureSha) };
  const marketplaceSource = createResolvedMarketplaceSource({ declared: { kind: "github", repository: "owner/market" }, revision: "a".repeat(40) }, fixtureSha);
  const candidate = {
    id: candidateId,
    scope: { kind: "user" as const },
    registrationId,
    snapshot: catalogSnapshot,
    marketplace: { root: "/market/private", source: marketplaceSource, content, binding: createMaterializationBinding(marketplaceSource.hash, content.rootDigest, fixtureSha) },
    entry: {
      identity: { value: plugin.identity, provenance: [fixtureProvenance()] },
      source: { value: { kind: "git", url: "https://example.invalid/plugin.git" }, provenance: [fixtureProvenance()] },
    },
  } as never;
  let acquisitionHook = () => {};
  const readiness = { trust: vi.fn(async () => "authorized" as const), configuration: vi.fn(async () => []), secretCustody: () => ({ status: "available" as const, explanation: "ready" }) };
  const inspector = createNativeCandidateInspector({
    catalog: { resolve: vi.fn(async () => ({ kind: "resolved" as const, candidate })) },
    content: { withMaterialized: vi.fn(async (_candidate, _signal, use) => { acquisitionHook(); return use(materialized); }) },
    inspector: { inspect: vi.fn(async () => ({ ok: true as const, value: plugin, diagnostics: [] })) },
    readiness,
    sha256,
  });
  const snapshot = {
    binding: {
      capturedAt: 1,
      scopes: [{ scope: { kind: "user" }, generation: 0, status: "ready", corruptionCodes: [] }],
      currentProject: { projectKey: `project-v1:sha256:${"44".repeat(32)}`, trust: { kind: "trusted" }, epoch: `sha256:${"55".repeat(32)}` },
      catalogs: [{ scope: { kind: "user" }, registrationId, snapshot: catalogSnapshot, cache: { kind: "ready", validator: { kind: "git-commit", revision: "a".repeat(40) }, etag: { kind: "not-applicable" } } }],
      capability: { status: "ready", digest: `sha256:${"66".repeat(32)}`, capturedBy: "fixture" },
      runtimeEpoch: `sha256:${"77".repeat(32)}`,
      recoveryDigest: `sha256:${"88".repeat(32)}`,
      updateDigest: `sha256:${"99".repeat(32)}`,
    },
    states: [],
    currentProject: { identity: { kind: "path-only", canonicalRoot: "file:///project/", limitation: "identity-changes-with-canonical-root" }, projectKey: `project-v1:sha256:${"44".repeat(32)}`, trust: { kind: "trusted" } },
    capabilities: capabilities(),
    runtime: [],
    recovery: { results: [], deferred: false, processed: 0 },
    startup: { status: "ready", blocked: [], capabilities: { mcp: { status: "unavailable", explanation: "none" }, subagents: { status: "unavailable", explanation: "none" }, piReload: { status: "available", explanation: "yes" }, secrets: { status: "available", explanation: "yes" } } },
  } as never;
  return { inspector, snapshot, readiness, materialized, onAcquisition: (hook: () => void) => { acquisitionHook = hook; } };
}

describe("native candidate inspection", () => {
  it("inspects one exact candidate with existing policy and no physical roots", async () => {
    const value = setup();
    const result = await value.inspector.inspect(subject, value.snapshot, new AbortController().signal);
    expect(result.kind).toBe("found");
    if (result.kind !== "found") return;
    expect(result.detail.compatibility.status).toBe("activatable");
    expect(result.detail.trust).toBe("authorized");
    expect(result.detail.lifecycle.installed).toBe(false);
    expect(JSON.stringify(result)).not.toContain("/scratch/secret");
    expect(JSON.stringify(result)).not.toContain("/market/private");
  });

  it("derives the installed configuration reference internally for candidate custody checks", async () => {
    const value = setup();
    const configurationRef = `plugin-configuration-v1:sha256:${"ab".repeat(32)}` as never;
    value.snapshot.states = [{
      ok: true,
      snapshot: {
        scope: { kind: "user" },
        installed: { plugins: [{ plugin: subject.plugin, selectedRevision: value.materialized.binding, revisions: [{ revision: value.materialized.binding, configurationRef }] }] },
      },
    }];
    await value.inspector.inspect(subject, value.snapshot, new AbortController().signal);
    expect(value.readiness.configuration).toHaveBeenCalledWith(expect.objectContaining({ configurationRef }), expect.any(AbortSignal));
  });

  it("distinguishes corrupt published catalog evidence from ordinary unavailability", async () => {
    const value = setup();
    value.snapshot.binding.catalogs[0].cache = { kind: "corrupt" };
    const result = await value.inspector.inspect(subject, value.snapshot, new AbortController().signal);
    expect(result.kind).toBe("found");
    if (result.kind !== "found") return;
    expect(result.detail.summary.condition).toBe("blocked");
    expect(result.detail.diagnostics.map((diagnostic) => diagnostic.code)).toContain("CATALOG_CORRUPT");
  });

  it("rejects a real candidate projection when authority changes during acquisition", async () => {
    const value = setup();
    let currentGeneration = 0;
    value.onAcquisition(() => { currentGeneration = 1; });
    const service = createNativeInspectionService({
      evidence: {
        capture: async () => value.snapshot,
        validate: async (binding) => binding.scopes[0]?.generation === currentGeneration ? "current" : "stale",
      },
      installed: { inspect: vi.fn() },
      candidates: value.inspector,
      catalog: { search: vi.fn(), detail: vi.fn() } as never,
      adoption: { preview: vi.fn() },
      clock: { nowEpochMilliseconds: () => 1 } as never,
      sha256,
    });
    const result = await service.detail({
      snapshotId: deriveInspectionEvidenceSnapshotId(value.snapshot.binding, sha256),
      detailId: deriveInspectionDetailId(subject, sha256),
    }, new AbortController().signal);
    expect(result).toEqual({ kind: "stale", action: "retry-read" });
    expect(currentGeneration).toBe(1);
  });

  it("maps acquisition failures to stable diagnostics without native leakage", async () => {
    const value = setup();
    const failing = createNativeCandidateInspector({
      catalog: { resolve: async () => { throw new Error("NATIVE_CAUSE_SECRET"); } },
      content: { withMaterialized: async () => { throw new Error("unused"); } },
      inspector: { inspect: async () => { throw new Error("unused"); } },
      readiness: { trust: async () => "authorized", configuration: async () => [], secretCustody: () => ({ status: "available", explanation: "ready" }) },
      sha256,
    } as never);
    const result = await failing.inspect(subject, value.snapshot, new AbortController().signal);
    expect(result.kind).toBe("unavailable");
    expect(JSON.stringify(result)).not.toContain("NATIVE_CAUSE_SECRET");
    expect(JSON.stringify(result)).toContain("CATALOG_UNAVAILABLE");
  });
});
