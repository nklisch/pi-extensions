import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CompatibilityReportSchema } from "../../src/domain/compatibility.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { createPluginStoreIdentityFromEvidence } from "../../src/domain/content-store.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { createInstalledPluginRecord, createInstalledUserStateDocument, createMarketplaceSnapshotRecord } from "../../src/domain/state/installed-state.js";
import { createProjectLocalStateDocument } from "../../src/domain/state/project-state.js";
import { createScopeContext, deriveProjectKey, toScopeReference } from "../../src/domain/state/scope.js";
import { createResolvedMarketplaceSource, createResolvedPluginSource } from "../../src/domain/source.js";
import { createRevisionCollectionService } from "../../src/application/revision-collection-service.js";
import { createMarketplaceConfigurationRecord } from "../../src/domain/update-policy.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;
const pluginKey = "collector@community";
const artifact = (key: string) => Object.freeze({ kind: "plugin" as const, key, reference: { kind: "plugin" as const, key: key as never }, capability: {} });

function installedFixture() {
  const compatibility = CompatibilityReportSchema.parse({ plugin: { key: pluginKey, marketplaceName: "community", marketplaceEntryName: "collector" }, activatable: true, components: [], requirements: [], diagnostics: [] });
  const content = createContentManifest([], sha256);
  const plugin = (revision: string) => NormalizedPluginSchema.parse({
    identity: { key: pluginKey, marketplaceName: "community", marketplaceEntryName: "collector" },
    source: createResolvedPluginSource({ kind: "git", url: `https://example.invalid/collector-${revision}.git`, revision: revision.repeat(40) }, sha256),
    configuration: { options: [] }, components: { skills: [], hooks: [], mcpServers: [], foreign: [] }, metadata: [],
  });
  const old = createInstalledPluginRecord({ plugin: pluginKey, activation: "disabled", revisions: [{ plugin: plugin("a"), compatibility, content }], scope: { kind: "user" } }, sha256);
  const current = createInstalledPluginRecord({ plugin: pluginKey, activation: "disabled", revisions: [{ plugin: plugin("b"), compatibility: { ...compatibility, plugin: plugin("b").identity }, content }], scope: { kind: "user" } }, sha256);
  const record = createInstalledPluginRecord({ plugin: pluginKey, activation: "disabled", selectedRevision: current.selectedRevision, revisions: [old.revisions[0]!, current.revisions[0]!], scope: { kind: "user" } }, sha256);
  const marketplaceSource = createResolvedMarketplaceSource({ declared: { kind: "git", url: "https://example.invalid/community.git" }, revision: "c".repeat(40) }, sha256);
  const marketplace = createMarketplaceSnapshotRecord({ marketplace: "community", source: marketplaceSource, content }, sha256);
  const installed = createInstalledUserStateDocument({ generation: 0, marketplaces: [marketplace], plugins: [record] }, sha256);
  const oldRevision = record.revisions.find((revision) => revision.revision === old.selectedRevision)!;
  const oldKey = createPluginStoreIdentityFromEvidence({ sourceHash: oldRevision.evidence.source.sourceHash, binding: oldRevision.revision }, sha256).key;
  return { record, installed, oldKey };
}

describe("revision collection service", () => {
  it("defers before any deletion when scope discovery is incomplete", async () => {
    let removed = false;
    const service = createRevisionCollectionService({
      state: {} as never,
      inventory: { async discover() { return { scopes: [], complete: false }; } },
      transitions: (() => ({}) as never),
      leases: {} as never,
      artifacts: { async scan() { removed = true; return { complete: true, artifacts: [] }; }, async remove() { removed = true; return "removed"; } },
      retention: {} as never,
      mutations: {} as never,
      sha256: () => new Uint8Array(32),
      clock: { nowEpochMilliseconds: () => 100, monotonicMilliseconds: () => 0 },
    });
    await expect(service.collect({}, new AbortController().signal)).resolves.toMatchObject({ kind: "deferred", code: "COLLECTION_DEFERRED" });
    expect(removed).toBe(false);
  });

  it("uses the retained-artifact union with no persistent-data variant", async () => {
    let requestedKinds: string[] = [];
    const candidate = artifact("plugin-store-v1:sha256:" + "a".repeat(64));
    const service = createRevisionCollectionService({
      state: {} as never,
      inventory: { async discover() { return { scopes: [], complete: true }; } },
      transitions: (() => ({ list: async () => ({ entries: [], complete: true, diagnostics: [] }) }) as never),
      leases: { async list() { return { complete: true, leases: [], owners: [] }; } } as never,
      artifacts: { async scan() { return { complete: true, artifacts: [candidate] }; }, async remove(value) { requestedKinds.push(value.reference.kind); return "removed"; } },
      retention: { async reconcile({ observed }: { observed: readonly unknown[] }) { return { complete: true, marks: observed.map((reference) => ({ reference, firstUnreferencedAt: 0 })) }; }, async markRemoved() {} } as never,
      mutations: {} as never,
      sha256,
      clock: { nowEpochMilliseconds: () => 86_400_001, monotonicMilliseconds: () => 0 },
    });
    const result = await service.collect({ policy: { unreferencedGraceMs: 86_400_000 } }, signal);
    expect(result.kind).toBe("collected");
    expect(requestedKinds).toEqual(["plugin"]);
  });

  it("refreshes leases after pruning and retains a lease acquired in the deletion window", async () => {
    const candidate = artifact("plugin-store-v1:sha256:" + "c".repeat(64));
    const lease = { leaseId: "00000000-0000-4000-8000-000000000201", sessionId: "second-process", artifacts: [candidate.reference], acquiredAt: 1 };
    let leaseReads = 0;
    let removed = 0;
    const service = createRevisionCollectionService({
      state: {} as never,
      inventory: { async discover() { return { scopes: [], complete: true }; } },
      transitions: (() => ({}) as never),
      leases: { async list() { leaseReads += 1; return leaseReads === 1 ? { complete: true, leases: [], owners: [] } : { complete: true, leases: [lease], owners: [{ leaseId: lease.leaseId, status: "live" }] }; } } as never,
      artifacts: { async scan() { return { complete: true, artifacts: [candidate] }; }, async remove() { removed += 1; return "removed"; } },
      retention: { async reconcile({ observed }: { observed: readonly unknown[] }) { return { complete: true, marks: observed.map((reference) => ({ reference, firstUnreferencedAt: 0 })) }; }, async markRemoved() {} } as never,
      mutations: {} as never,
      sha256,
      clock: { nowEpochMilliseconds: () => 86_400_001, monotonicMilliseconds: () => 0 },
    });
    const result = await service.collect({ policy: { unreferencedGraceMs: 0 } }, signal);
    expect(result.kind).toBe("collected");
    expect(leaseReads).toBe(2);
    expect(removed).toBe(0);
  });

  it("defers deletion when refreshed lease evidence is incomplete", async () => {
    const candidate = artifact("plugin-store-v1:sha256:" + "d".repeat(64));
    let leaseReads = 0;
    let removed = 0;
    const service = createRevisionCollectionService({
      state: {} as never,
      inventory: { async discover() { return { scopes: [], complete: true }; } },
      transitions: (() => ({}) as never),
      leases: { async list() { leaseReads += 1; return leaseReads === 1 ? { complete: true, leases: [], owners: [] } : { complete: false, leases: [], owners: [] }; } } as never,
      artifacts: { async scan() { return { complete: true, artifacts: [candidate] }; }, async remove() { removed += 1; return "removed"; } },
      retention: { async reconcile({ observed }: { observed: readonly unknown[] }) { return { complete: true, marks: observed.map((reference) => ({ reference, firstUnreferencedAt: 0 })) }; }, async markRemoved() {} } as never,
      mutations: {} as never,
      sha256,
      clock: { nowEpochMilliseconds: () => 86_400_001, monotonicMilliseconds: () => 0 },
    });
    const result = await service.collect({ policy: { unreferencedGraceMs: 0 } }, signal);
    expect(result).toMatchObject({ kind: "deferred", code: "COLLECTION_DEFERRED" });
    expect(removed).toBe(0);
  });

  it("preserves project intent and update authorities while pruning a revision", async () => {
    const identity = { kind: "path-only" as const, canonicalRoot: "file:///collector-project/" as never, limitation: "identity-changes-with-canonical-root" as const };
    const scope = createScopeContext({ kind: "project", identity, projectKey: deriveProjectKey(identity, sha256) }, sha256);
    if (scope.kind !== "project") throw new Error("project fixture failed");
    const scopeReference = toScopeReference(scope);
    const compatibility = CompatibilityReportSchema.parse({ plugin: { key: pluginKey, marketplaceName: "community", marketplaceEntryName: "collector" }, activatable: true, components: [], requirements: [], diagnostics: [] });
    const content = createContentManifest([], sha256);
    const normalized = (suffix: string) => NormalizedPluginSchema.parse({
      identity: compatibility.plugin,
      source: createResolvedPluginSource({ kind: "git", url: `https://example.invalid/collector-${suffix}.git`, revision: suffix.repeat(40) }, sha256),
      configuration: { options: [] }, components: { skills: [], hooks: [], mcpServers: [], foreign: [] }, metadata: [],
    });
    const oldPlugin = normalized("a");
    const currentPlugin = normalized("b");
    const old = createInstalledPluginRecord({ plugin: pluginKey, activation: "disabled", revisions: [{ plugin: oldPlugin, compatibility, content }], scope: scopeReference }, sha256);
    const current = createInstalledPluginRecord({ plugin: pluginKey, activation: "disabled", revisions: [{ plugin: currentPlugin, compatibility: { ...compatibility, plugin: currentPlugin.identity }, content }], scope: scopeReference }, sha256);
    const record = createInstalledPluginRecord({ plugin: pluginKey, activation: "disabled", selectedRevision: current.selectedRevision, revisions: [old.revisions[0]!, current.revisions[0]!], scope: scopeReference }, sha256);
    const marketplaceSource = createResolvedMarketplaceSource({ declared: { kind: "github", repository: "example/community" }, revision: "c".repeat(40) }, sha256);
    const marketplace = createMarketplaceSnapshotRecord({ marketplace: "community", source: marketplaceSource, content }, sha256);
    const declarationDigest = `sha256:${"d".repeat(64)}` as never;
    const project = createProjectLocalStateDocument({
      schemaVersion: 4,
      generation: 0,
      projectKey: scope.projectKey,
      identity: scope.identity,
      declarationDigest,
      scope: { application: "automatic" },
      marketplaces: [marketplace],
      plugins: [record],
      marketplaceUpdates: [createMarketplaceConfigurationRecord({ marketplace: "community", source: marketplaceSource.declared, applicationOverride: "automatic" })],
    }, scope, sha256);
    const oldRevision = record.revisions.find((revision) => revision.revision === old.selectedRevision)!;
    const oldKey = createPluginStoreIdentityFromEvidence({ sourceHash: oldRevision.evidence.source.sourceHash, binding: oldRevision.revision }, sha256).key;
    let snapshot: any = { scope, generation: 0, project };
    const retained = JSON.stringify({ declarationDigest: project.declarationDigest, scope: project.scope, marketplaceUpdates: project.marketplaceUpdates });
    let removed = 0;
    const service = createRevisionCollectionService({
      state: { async read() { return { ok: true as const, snapshot }; }, async commit() { throw new Error("collection uses coordinator"); } },
      inventory: { async discover() { return { scopes: [scope], complete: true }; } },
      transitions: (() => ({ list: async () => ({ entries: [], complete: true, diagnostics: [] }) }) as never),
      leases: { async list() { return { complete: true, leases: [], owners: [] }; } } as never,
      artifacts: {
        async scan() { return { complete: true, artifacts: [artifact(oldKey)] }; },
        async remove() {
          expect(snapshot.project.plugins[0]?.revisions).toHaveLength(1);
          expect(JSON.stringify({ declarationDigest: snapshot.project.declarationDigest, scope: snapshot.project.scope, marketplaceUpdates: snapshot.project.marketplaceUpdates })).toBe(retained);
          removed += 1;
          return "removed";
        },
      },
      retention: { async reconcile({ observed }: { observed: readonly unknown[] }) { return { complete: true, marks: observed.map((reference) => ({ reference, firstUnreferencedAt: 0 })) }; }, async markRemoved() {} } as never,
      mutations: {
        async runPreparedMutation(_request: unknown, prepare: (context: { snapshot: any; assertOwned(): Promise<void> }) => Promise<{ mutation: any; value: undefined }>) {
          const prepared = await prepare({ snapshot, assertOwned: async () => {} });
          snapshot = { ...snapshot, generation: 1, project: { ...prepared.mutation.replace.project, generation: 1 } };
          return { kind: "committed", value: undefined, snapshot };
        },
      } as never,
      sha256,
      clock: { nowEpochMilliseconds: () => 86_400_001, monotonicMilliseconds: () => 0 },
    });
    await expect(service.collect({ policy: { unreferencedGraceMs: 86_400_000 } }, signal)).resolves.toMatchObject({ kind: "collected", prunedRevisions: 1, removedArtifacts: 1 });
    expect(removed).toBe(1);
  });

  it("prunes the authoritative revision record before removing its physical artifact", async () => {
    const fixture = installedFixture();
    let snapshot = { scope: { kind: "user" }, generation: 0, installed: fixture.installed } as never;
    let removed = 0;
    const state = {
      async read() { return { ok: true, snapshot }; },
      async commit() { throw new Error("collection uses the generation coordinator"); },
    };
    const service = createRevisionCollectionService({
      state,
      inventory: { async discover() { return { scopes: [{ kind: "user" }], complete: true }; } },
      transitions: (() => ({ list: async () => ({ entries: [], complete: true, diagnostics: [] }) }) as never),
      leases: { async list() { return { complete: true, leases: [], owners: [] }; } } as never,
      artifacts: {
        async scan() { return { complete: true, artifacts: [artifact(fixture.oldKey)] }; },
        async remove() {
          const installed = (snapshot as { installed: { plugins: readonly { revisions: readonly unknown[] }[] } }).installed;
          expect(installed.plugins[0]?.revisions).toHaveLength(1);
          removed += 1;
          return "removed";
        },
      },
      retention: { async reconcile({ observed }: { observed: readonly unknown[] }) { return { complete: true, marks: observed.map((reference) => ({ reference, firstUnreferencedAt: 0 })) }; }, async markRemoved() {} } as never,
      mutations: {
        async runPreparedMutation(_request: unknown, prepare: (context: { snapshot: never; assertOwned(): Promise<void> }) => Promise<{ mutation: unknown; value: undefined }>) {
          const prepared = await prepare({ snapshot, assertOwned: async () => {} });
          const replacement = (prepared.mutation as { replace: { installed: unknown } }).replace.installed;
          snapshot = { ...(snapshot as object), generation: 1, installed: replacement } as never;
          return { kind: "committed", value: undefined, snapshot };
        },
      } as never,
      sha256,
      clock: { nowEpochMilliseconds: () => 86_400_001, monotonicMilliseconds: () => 0 },
    });
    const result = await service.collect({ policy: { unreferencedGraceMs: 86_400_000 } }, signal);
    expect(result).toMatchObject({ kind: "collected", prunedRevisions: 1, removedArtifacts: 1 });
    expect(removed).toBe(1);
  });
});
