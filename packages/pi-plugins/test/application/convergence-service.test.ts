import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createConvergenceService } from "../../src/application/convergence-service.js";
import type { LifecycleStateStore } from "../../src/application/ports/lifecycle-state-store.js";
import type { LifecycleStateInventoryPort } from "../../src/application/ports/lifecycle-state-inventory.js";
import type { PendingDeleteMarker, PendingDeleteMarkerStore } from "../../src/application/ports/pending-data-deletion.js";
import type { GenerationSnapshot, StateCommitResult, StateMutation } from "../../src/application/state-contract.js";
import { createInstalledPluginRecord, createInstalledRevisionRecord, createInstalledUserStateDocument, createMarketplaceSnapshotRecord } from "../../src/domain/state/installed-state.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { CompatibilityReportSchema } from "../../src/domain/compatibility.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { createResolvedMarketplaceSource, createResolvedPluginSource } from "../../src/domain/source.js";
import { contentStoreKeyDigest, createPluginStoreIdentityFromEvidence } from "../../src/domain/content-store.js";
import type { ScopeContext } from "../../src/domain/state/scope.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const scope = { kind: "user" as const };
const projectScope = { kind: "project" as const, projectKey: `project-v1:sha256:${"f".repeat(64)}` } as unknown as ScopeContext;
const signal = new AbortController().signal;

function inventoryFor(scopes: readonly ScopeContext[] = [scope], complete = true): LifecycleStateInventoryPort {
  return { async discover() { return { scopes, complete }; } };
}

function state(installed: readonly Readonly<{ plugin: string }>[] = []): LifecycleStateStore {
  const snapshot = {
    scope,
    generation: 0,
    installed: { marketplaces: [], plugins: installed.map((record) => ({ plugin: record.plugin, selectedRevision: "sha256:" + "0".repeat(64), revisions: [] })) },
    corruptions: [],
    project: undefined,
  } as unknown as GenerationSnapshot;
  return { async read() { return { ok: true as const, snapshot }; }, async commit() { return { kind: "committed" as const, snapshot }; } };
}

function markers(values: readonly PendingDeleteMarker[]): PendingDeleteMarkerStore & { removed: PendingDeleteMarker[] } {
  const removed: PendingDeleteMarker[] = [];
  return { root: "/markers", removed, path: () => "/marker", async create() {}, async remove(value) { removed.push(value); }, async list() { return values; } };
}

const marker = (plugin: string, requestedAt: number): PendingDeleteMarker => ({ scope, plugin: plugin as never, dataRef: "plugin-data-v1:sha256:" + "a".repeat(64) as never, requestedAt });

const content = createContentManifest([], sha256);
const compatibility = (plugin: ReturnType<typeof NormalizedPluginSchema.parse>) => CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
function pluginAt(revision: string) {
  return NormalizedPluginSchema.parse({
    identity: { key: "fixture@community", marketplaceName: "community", marketplaceEntryName: "fixture" },
    source: createResolvedPluginSource({ kind: "git", url: "https://example.invalid/fixture.git", revision }, sha256),
    configuration: { options: [] },
    components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
    metadata: [],
  });
}
function installedRecord(revisions: readonly string[], scopeRef: typeof scope | typeof projectScope = scope, selectedIndex = 0, previousIndex = 1) {
  const raw = revisions.map((revision) => {
    const plugin = pluginAt(revision);
    return createInstalledRevisionRecord({ plugin, compatibility: compatibility(plugin), content, scope: scopeRef }, sha256);
  });
  return createInstalledPluginRecord({
    plugin: "fixture@community",
    activation: "enabled",
    selectedRevision: raw[selectedIndex]!.revision,
    previousRevision: raw[previousIndex]?.revision,
    revisions: raw,
    scope: scopeRef,
  }, sha256);
}
function userSnapshot(generation: number, record: ReturnType<typeof installedRecord>): GenerationSnapshot {
  const marketplace = createMarketplaceSnapshotRecord({
    marketplace: "community",
    source: createResolvedMarketplaceSource({ declared: { kind: "github", repository: "example/community" }, revision: "b".repeat(40) }, sha256),
    content,
  }, sha256);
  return { scope, generation, installed: createInstalledUserStateDocument({ generation, marketplaces: [marketplace], plugins: [record] }, sha256), corruptions: [] } as unknown as GenerationSnapshot;
}

class ConcurrentPruneState implements LifecycleStateStore {
  commits = 0;
  constructor(public current: GenerationSnapshot, private readonly concurrent: GenerationSnapshot) {}
  async read(): Promise<{ ok: true; snapshot: GenerationSnapshot }> { return { ok: true, snapshot: this.current }; }
  async commit(mutation: StateMutation): Promise<StateCommitResult> {
    this.commits += 1;
    if (this.commits === 1) {
      this.current = this.concurrent;
      return { kind: "stale-generation", expected: mutation.expectedGeneration, actual: this.concurrent.generation };
    }
    if (mutation.replace.installed === undefined) throw new Error("fixture expected installed replacement");
    const generation = this.current.generation + 1;
    const installed = createInstalledUserStateDocument({ ...mutation.replace.installed, generation }, sha256);
    this.current = { ...this.current, generation, installed } as GenerationSnapshot;
    return { kind: "committed", snapshot: this.current };
  }
}

describe("convergence service", () => {
  it("replays absent-plugin deletion and age-gates installed residue without calling it a replay failure", async () => {
    const store = markers([
      marker("absent@catalog", Date.now()),
      marker("demo@catalog", Date.now()),
      marker("demo@catalog", Date.now() - 61 * 60_000),
    ]);
    const removed: string[] = [];
    const service = createConvergenceService({
      state: state([{ plugin: "demo@catalog" }]),
      inventory: inventoryFor(),
      pendingDeletes: store,
      dataRemoval: { async remove() { removed.push("deleted"); return "removed"; } },
      sha256,
    });
    const report = await service.sweep({ scopes: [scope] });
    expect(removed).toEqual(["deleted"]);
    expect(store.removed.map((value) => value.plugin)).toEqual(["absent@catalog", "demo@catalog"]);
    expect(report.processed).toBe(4);
    expect(report.results).toContainEqual(expect.objectContaining({ plugin: "demo@catalog", code: "MARKER_RETAINED" }));
    expect(report.results).not.toContainEqual(expect.objectContaining({ plugin: "demo@catalog", code: "MARKER_REPLAY_FAILED" }));
  });

  it("retains a marker when inventory does not discover its scope", async () => {
    const store = markers([marker("absent@catalog", Date.now() - 2 * 60 * 60_000)]);
    let removals = 0;
    const service = createConvergenceService({
      state: state(),
      inventory: inventoryFor([], true),
      pendingDeletes: store,
      dataRemoval: { async remove() { removals += 1; return "removed"; } },
      sha256,
    });
    const report = await service.sweep({ scopes: [scope] });
    expect(removals).toBe(0);
    expect(store.removed).toHaveLength(0);
    expect(report.results).toContainEqual(expect.objectContaining({ code: "MARKER_SCOPE_UNAVAILABLE", kind: "deferred" }));
  });

  it("bounds marker replay and reports remaining work for a later pass", async () => {
    const store = markers([marker("one@catalog", Date.now()), marker("two@catalog", Date.now())]);
    const removed: string[] = [];
    const service = createConvergenceService({
      state: state(),
      inventory: inventoryFor(),
      pendingDeletes: store,
      dataRemoval: { async remove(input) { removed.push(input.plugin); return "removed"; } },
      sha256,
      policy: { maxItems: 1 },
    });
    const report = await service.sweep({ scopes: [scope] });
    expect(removed).toEqual(["one@catalog"]);
    expect(store.removed).toHaveLength(1);
    expect(report.processed).toBe(1);
    expect(report.deferred).toBe(true);
    expect(report.results).toContainEqual(expect.objectContaining({ code: "BUDGET_EXHAUSTED" }));
  });

  it("re-plans revision pruning from the fresh snapshot after a concurrent commit", async () => {
    const baseRecord = installedRecord(["a".repeat(40), "b".repeat(40), "c".repeat(40)]);
    const concurrentRecord = installedRecord(["d".repeat(40), "b".repeat(40), "a".repeat(40), "c".repeat(40)]);
    const stateStore = new ConcurrentPruneState(userSnapshot(0, baseRecord), userSnapshot(1, concurrentRecord));
    const service = createConvergenceService({ state: stateStore, inventory: inventoryFor(), pendingDeletes: markers([]), sha256 });
    await service.sweep({ scopes: [scope] });
    const final = (stateStore.current as Extract<GenerationSnapshot, { installed: unknown }>).installed.plugins[0]!;
    expect(stateStore.commits).toBe(2);
    expect(final.selectedRevision).toBe(final.revisions.find((revision) => revision.evidence.source.revision === "d".repeat(40))?.revision);
    expect(final.revisions.map((revision) => revision.evidence.source.revision)).toEqual(expect.arrayContaining(["d".repeat(40), "b".repeat(40)]));
    expect(final.revisions.map((revision) => revision.evidence.source.revision)).not.toContain("c".repeat(40));
  });

  it("does not create a state commit when there is nothing to prune", async () => {
    let commits = 0;
    const base = state();
    const wrapped: LifecycleStateStore = { ...base, async commit(...args) { commits += 1; return base.commit(...args); } };
    const service = createConvergenceService({ state: wrapped, inventory: inventoryFor(), pendingDeletes: markers([]), sha256 });
    await service.sweep({ scopes: [scope] });
    expect(commits).toBe(0);
  });

  it("retains orphan categories when a scope read fails during reference collection", async () => {
    const calls: Array<Readonly<{ referenced: ReadonlySet<string>; retainKinds?: readonly string[] }>> = [];
    const service = createConvergenceService({
      state: { async read() { throw new Error("scope read failed"); }, async commit() { throw new Error("unused"); } },
      inventory: inventoryFor([scope], true),
      pendingDeletes: markers([]),
      artifacts: { async sweep(input) { calls.push(input); return { removed: 0, retained: 0, deferred: false, incompleteEvidence: false }; } },
      sha256,
    });
    const report = await service.sweep({ scopes: [scope] });
    expect(report.deferred).toBe(true);
    expect(calls[0]?.retainKinds).toEqual(expect.arrayContaining(["revision", "marketplace", "projection"]));
  });

  it("includes every discovered scope in the referenced revision set", async () => {
    const userRecord = installedRecord(["a".repeat(40)], scope);
    const projectRecord = installedRecord(["d".repeat(40)], projectScope);
    const snapshots = new Map<string, GenerationSnapshot>([
      ["user", userSnapshot(0, userRecord)],
      [projectScope.projectKey, { scope: projectScope, generation: 0, project: { marketplaces: [], plugins: [projectRecord] }, corruptions: [] } as unknown as GenerationSnapshot],
    ]);
    let referenced: ReadonlySet<string> | undefined;
    const service = createConvergenceService({
      state: {
        async read(input) { return { ok: true as const, snapshot: snapshots.get(input.kind === "user" ? "user" : input.projectKey)! }; },
        async commit() { throw new Error("unused"); },
      },
      inventory: inventoryFor([scope, projectScope], true),
      pendingDeletes: markers([]),
      artifacts: { async sweep(input) { referenced = input.referenced; return { removed: 0, retained: 0, deferred: false, incompleteEvidence: false }; } },
      projectionReferences: () => new Set(),
      sha256,
    });
    await service.sweep({ scopes: [scope] });
    const projectRevision = projectRecord.revisions[0]!;
    const expected = createPluginStoreIdentityFromEvidence({ sourceHash: projectRevision.evidence.source.sourceHash, binding: projectRevision.revision }, sha256);
    expect(referenced).toContain(`revision:${contentStoreKeyDigest(expected)}`);
  });
});
