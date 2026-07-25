import { z } from "zod";
import { createMarketplaceStoreIdentityFromEvidence, createPluginStoreIdentityFromEvidence, type ContentStoreKey } from "../domain/content-store.js";
import { type InstalledPluginRecord, type InstalledRevisionRecord, type MarketplaceSnapshotRecord, createInstalledUserStateDocument } from "../domain/state/installed-state.js";
import { createProjectLocalStateDocument } from "../domain/state/project-state.js";
import { ScopeContextSchema, toScopeReference, type ScopeContext, type ScopeReference } from "../domain/state/scope.js";
import { parseStateMutation, type GenerationSnapshot } from "./state-contract.js";
import type { GenerationMutationCoordinator } from "./generation-mutation-coordinator.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type { LifecycleStateInventoryPort } from "./ports/lifecycle-state-inventory.js";
import type { LifecycleTransitionStore } from "./ports/lifecycle-transition-store.js";
import type { LifecycleClock } from "./ports/lifecycle-clock.js";
import type { RevisionArtifactStore, RetainedArtifactRef } from "./ports/revision-artifact-store.js";
import type { RevisionLeaseStore } from "./ports/revision-lease-store.js";
import type { RevisionRetentionStore } from "./ports/revision-retention-store.js";
import "./recovery-contract.js";
import type { Sha256 } from "../domain/source.js";

export const DefaultRevisionCollectionPolicy = Object.freeze({
  unreferencedGraceMs: 86_400_000,
  terminalJournalRetentionMs: 604_800_000,
  maxArtifactsPerRun: 256,
});
export const RevisionCollectionPolicySchema = z.object({
  unreferencedGraceMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  terminalJournalRetentionMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  maxArtifactsPerRun: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict().readonly();
export type RevisionCollectionPolicy = z.infer<typeof RevisionCollectionPolicySchema>;
export const RevisionCollectionResultSchema = z.object({
  kind: z.enum(["collected", "deferred"]),
  removedArtifacts: z.number().int().nonnegative(),
  prunedRevisions: z.number().int().nonnegative(),
  code: z.literal("COLLECTION_DEFERRED").optional(),
}).strict().readonly();
export type RevisionCollectionResult = z.infer<typeof RevisionCollectionResultSchema>;

export type RevisionCollectionDependencies = Readonly<{
  state: LifecycleStateStore;
  inventory: LifecycleStateInventoryPort;
  transitions: (scope: ScopeReference) => LifecycleTransitionStore;
  leases: RevisionLeaseStore;
  artifacts: RevisionArtifactStore;
  retention: RevisionRetentionStore;
  mutations: GenerationMutationCoordinator;
  sha256: Sha256;
  clock?: LifecycleClock;
}>;

function refKey(ref: RetainedArtifactRef): string { return JSON.stringify(ref); }
function revisionRef(revision: InstalledRevisionRecord, sha256: Sha256): RetainedArtifactRef { return { kind: "plugin", key: createPluginStoreIdentityFromEvidence({ sourceHash: revision.evidence.source.sourceHash, binding: revision.revision }, sha256).key }; }
function marketplaceRef(snapshot: MarketplaceSnapshotRecord, sha256: Sha256): RetainedArtifactRef { return { kind: "marketplace", key: createMarketplaceStoreIdentityFromEvidence({ sourceHash: snapshot.source.sourceHash, revision: snapshot.source.revision, binding: snapshot.binding }, sha256).key }; }
function projectionRefs(entry: import("./ports/lifecycle-transition-store.js").LifecycleTransitionJournalEntry): RetainedArtifactRef[] { return [entry.record.previousProjection, entry.record.candidateProjection].flatMap((projection) => projection.kind === "active" ? [{ kind: "projection" as const, reference: projection.projectionRef }] : []); }
function records(snapshot: GenerationSnapshot): readonly InstalledPluginRecord[] { return "installed" in snapshot ? snapshot.installed.plugins : snapshot.project.plugins; }

function stateWithPlugins(snapshot: GenerationSnapshot, plugins: readonly InstalledPluginRecord[], sha256: Sha256) {
  if ("installed" in snapshot) {
    const installed = createInstalledUserStateDocument({ ...snapshot.installed, generation: snapshot.generation, plugins }, sha256);
    return parseStateMutation({ scope: snapshot.scope, expectedGeneration: snapshot.generation, replace: { installed } }, sha256);
  }
  const project = createProjectLocalStateDocument({ ...snapshot.project, generation: snapshot.generation, plugins }, snapshot.scope, sha256);
  return parseStateMutation({ scope: snapshot.scope, expectedGeneration: snapshot.generation, replace: { project } }, sha256);
}

/** Closed-world mark/sweep. Physical deletion is deliberately the last action. */
export function createRevisionCollectionService(dependencies: RevisionCollectionDependencies) {
  if (dependencies === null || typeof dependencies !== "object") throw new TypeError("collection dependencies are required");
  const clock: LifecycleClock = dependencies.clock ?? { nowEpochMilliseconds: () => Date.now(), monotonicMilliseconds: () => globalThis.performance?.now() ?? Date.now() };

  async function collect(input: Readonly<{ policy?: Partial<RevisionCollectionPolicy> }>, signal: AbortSignal): Promise<RevisionCollectionResult> {
    const policy = RevisionCollectionPolicySchema.parse({ ...DefaultRevisionCollectionPolicy, ...(input.policy ?? {}) });
    const at = clock.nowEpochMilliseconds();
    const inventory = await dependencies.inventory.discover(signal).catch(() => ({ scopes: [], complete: false }));
    if (!inventory.complete) return { kind: "deferred", code: "COLLECTION_DEFERRED", removedArtifacts: 0, prunedRevisions: 0 };
    const scopes = [...inventory.scopes].map((scope) => ScopeContextSchema.parse(scope)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const snapshots: Array<{ scope: ScopeContext; snapshot: GenerationSnapshot }> = [];
    const journals: Array<{ scope: ScopeReference; journal: LifecycleTransitionStore; entries: readonly import("./ports/lifecycle-transition-store.js").LifecycleTransitionJournalEntry[] }> = [];
    const referenced = new Map<string, RetainedArtifactRef>();
    const retirementRefs = new Map<string, Readonly<{ scope: ScopeContext; plugin: InstalledPluginRecord; revision: InstalledRevisionRecord }>>();
    const refreshAuthoritativeReferences = async (): Promise<Map<string, RetainedArtifactRef> | undefined> => {
      const refreshedInventory = await dependencies.inventory.discover(signal).catch(() => ({ scopes: [], complete: false }));
      if (!refreshedInventory.complete) return undefined;
      let refreshedScopes: ScopeContext[];
      try {
        refreshedScopes = [...refreshedInventory.scopes].map((scope) => ScopeContextSchema.parse(scope));
      } catch {
        return undefined;
      }
      const refreshed = new Map<string, RetainedArtifactRef>();
      const retain = (reference: RetainedArtifactRef): void => { refreshed.set(refKey(reference), reference); };
      for (const scope of refreshedScopes) {
        const loaded = await dependencies.state.read(scope, signal).catch(() => undefined);
        if (loaded === undefined || !loaded.ok) return undefined;
        if ("installed" in loaded.snapshot) {
          for (const marketplace of loaded.snapshot.installed.marketplaces) retain(marketplaceRef(marketplace, dependencies.sha256));
        }
        for (const plugin of records(loaded.snapshot)) {
          // Include every revision still present in authoritative state. A
          // failed or raced prune must retain the state root rather than
          // allowing the earlier retirement scan to authorize deletion.
          for (const revision of plugin.revisions) retain(revisionRef(revision, dependencies.sha256));
        }
        const scopeReference = toScopeReference(scope);
        let journal: LifecycleTransitionStore;
        try {
          journal = dependencies.transitions(scopeReference);
        } catch {
          return undefined;
        }
        const listed = journal.list === undefined ? undefined : await journal.list(scopeReference, signal).catch(() => undefined);
        if (listed === undefined || !listed.complete || listed.diagnostics.length > 0) return undefined;
        for (const entry of listed.entries) if (entry.status.kind === "prepared" || entry.status.kind === "recovery-required") {
          for (const projection of projectionRefs(entry)) retain(projection);
          for (const state of [entry.record.previous, entry.record.candidate, entry.record.final]) {
            if (state !== null) for (const revision of state.revisions) retain(revisionRef(revision, dependencies.sha256));
          }
        }
      }
      const leases = await dependencies.leases.list(signal).catch(() => undefined);
      if (leases === undefined || !leases.complete) return undefined;
      for (const lease of leases.leases) {
        const owner = leases.owners.find((entry) => entry.leaseId === lease.leaseId)?.status;
        if (owner === undefined) return undefined;
        if (owner === "live" || owner === "unknown") for (const reference of lease.artifacts) retain(reference);
      }
      return refreshed;
    };
    for (const scope of scopes) {
      const loaded = await dependencies.state.read(scope, signal).catch(() => undefined);
      if (loaded === undefined || !loaded.ok) return { kind: "deferred", code: "COLLECTION_DEFERRED", removedArtifacts: 0, prunedRevisions: 0 };
      snapshots.push({ scope, snapshot: loaded.snapshot });
      if ("installed" in loaded.snapshot) for (const marketplace of loaded.snapshot.installed.marketplaces) referenced.set(refKey(marketplaceRef(marketplace, dependencies.sha256)), marketplaceRef(marketplace, dependencies.sha256));
      for (const plugin of records(loaded.snapshot)) {
        const selected = plugin.revisions.find((revision) => revision.revision === plugin.selectedRevision);
        if (selected === undefined) return { kind: "deferred", code: "COLLECTION_DEFERRED", removedArtifacts: 0, prunedRevisions: 0 };
        const selectedRef = revisionRef(selected, dependencies.sha256);
        referenced.set(refKey(selectedRef), selectedRef);
        for (const revision of plugin.revisions) if (revision.revision !== plugin.selectedRevision) {
          const retiring = revisionRef(revision, dependencies.sha256);
          retirementRefs.set(refKey(retiring), { scope, plugin, revision });
        }
      }
      const journal = dependencies.transitions(toScopeReference(scope));
      const listed = journal.list === undefined ? undefined : await journal.list(toScopeReference(scope), signal).catch(() => undefined);
      if (listed === undefined || !listed.complete || listed.diagnostics.length > 0) return { kind: "deferred", code: "COLLECTION_DEFERRED", removedArtifacts: 0, prunedRevisions: 0 };
      journals.push({ scope: toScopeReference(scope), journal, entries: listed.entries });
      for (const entry of listed.entries) if (entry.status.kind === "prepared" || entry.status.kind === "recovery-required") {
        for (const projection of projectionRefs(entry)) referenced.set(refKey(projection), projection);
        for (const state of [entry.record.previous, entry.record.candidate, entry.record.final]) if (state !== null) for (const revision of state.revisions) {
          const root = revisionRef(revision, dependencies.sha256);
          referenced.set(refKey(root), root);
        }
      }
    }
    const leases = await dependencies.leases.list(signal).catch(() => undefined);
    if (leases === undefined || !leases.complete) return { kind: "deferred", code: "COLLECTION_DEFERRED", removedArtifacts: 0, prunedRevisions: 0 };
    for (const lease of leases.leases) {
      const owner = leases.owners.find((entry) => entry.leaseId === lease.leaseId)?.status;
      if (owner === undefined) return { kind: "deferred", code: "COLLECTION_DEFERRED", removedArtifacts: 0, prunedRevisions: 0 };
      if (owner === "live" || owner === "unknown") for (const ref of lease.artifacts) referenced.set(refKey(ref), ref);
    }
    const scan = await dependencies.artifacts.scan(signal).catch(() => undefined);
    if (scan === undefined || !scan.complete) return { kind: "deferred", code: "COLLECTION_DEFERRED", removedArtifacts: 0, prunedRevisions: 0 };
    const observed = scan.artifacts.map((candidate) => candidate.reference);
    const ledger = await dependencies.retention.reconcile({ completeScanAt: at, referenced: [...referenced.values()], observed }, signal).catch(() => undefined);
    if (ledger === undefined || !ledger.complete) return { kind: "deferred", code: "COLLECTION_DEFERRED", removedArtifacts: 0, prunedRevisions: 0 };

    let prunedRevisions = 0;
    for (const mark of ledger.marks) {
      if (mark.firstUnreferencedAt + policy.unreferencedGraceMs > at) continue;
      const retire = retirementRefs.get(refKey(mark.reference));
      if (retire === undefined) continue;
      const current = await dependencies.state.read(retire.scope, signal).catch(() => undefined);
      if (current === undefined || !current.ok) continue;
      const currentPlugin = records(current.snapshot).find((entry) => entry.plugin === retire.plugin.plugin);
      if (currentPlugin === undefined || currentPlugin.selectedRevision === retire.revision.revision || !currentPlugin.revisions.some((entry) => entry.revision === retire.revision.revision)) continue;
      const result = await dependencies.mutations.runPreparedMutation({ scope: retire.scope, plugins: [retire.plugin.plugin], expectedGeneration: current.snapshot.generation }, async (context) => {
        const latest = records(context.snapshot).find((entry) => entry.plugin === retire.plugin.plugin);
        if (latest === undefined || latest.selectedRevision === retire.revision.revision || !latest.revisions.some((entry) => entry.revision === retire.revision.revision)) throw new Error("revision target changed");
        const replacement = { ...latest, revisions: latest.revisions.filter((entry) => entry.revision !== retire.revision.revision) };
        return { mutation: stateWithPlugins(context.snapshot, records(context.snapshot).map((entry) => entry.plugin === latest.plugin ? replacement : entry), dependencies.sha256), value: undefined };
      }, signal).catch(() => undefined);
      if (result?.kind === "committed") prunedRevisions += 1;
    }

    const fresh = await dependencies.artifacts.scan(signal).catch(() => undefined);
    if (fresh === undefined || !fresh.complete) return { kind: "deferred", code: "COLLECTION_DEFERRED", removedArtifacts: 0, prunedRevisions };
    // State pruning and physical deletion are separate operations. Refresh
    // every authoritative scope and lease after pruning so a new session can
    // pin content in the deletion window; incomplete evidence retains all
    // candidates for a later complete pass.
    const refreshed = await refreshAuthoritativeReferences();
    if (refreshed === undefined) return { kind: "deferred", code: "COLLECTION_DEFERRED", removedArtifacts: 0, prunedRevisions };
    const retainedAfterPrune = new Set([...referenced.keys(), ...refreshed.keys()]);
    let removedArtifacts = 0;
    for (const candidate of fresh.artifacts.slice(0, policy.maxArtifactsPerRun)) {
      const key = refKey(candidate.reference);
      const mark = ledger.marks.find((entry) => refKey(entry.reference) === key);
      if (mark === undefined || mark.firstUnreferencedAt + policy.unreferencedGraceMs > at || retainedAfterPrune.has(key)) continue;
      try { await dependencies.artifacts.remove(candidate, signal); await dependencies.retention.markRemoved(candidate.reference, at, signal); removedArtifacts += 1; } catch { /* retain and retry on the next complete pass */ }
    }
    for (const { scope, journal, entries } of journals) for (const entry of entries) if (entry.status.kind !== "prepared" && entry.status.kind !== "recovery-required") await journal.markCollectionComplete?.({ scope, reference: entry.record.reference, at }, signal).catch(() => undefined);
    for (const { journal } of journals) await journal.pruneTerminal?.({ before: at - policy.terminalJournalRetentionMs }, signal).catch(() => undefined);
    return { kind: "collected", removedArtifacts, prunedRevisions };
  }
  return Object.freeze({ collect });
}

export type { RetainedArtifactRef, ScopeContext, ScopeReference, ContentStoreKey };
