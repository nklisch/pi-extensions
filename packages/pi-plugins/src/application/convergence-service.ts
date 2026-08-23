import { z } from "zod";
import { runScopedMutation } from "./state-transaction.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type { LifecycleStateInventory, LifecycleStateInventoryPort } from "./ports/lifecycle-state-inventory.js";
import type { PersistentDataRemovalPort } from "./ports/persistent-data-removal.js";
import type { LifecycleClock } from "./ports/lifecycle-clock.js";
import { PENDING_DELETE_GRACE_MS, type PendingDeleteMarker, type PendingDeleteMarkerStore } from "./ports/pending-data-deletion.js";
import { createInstalledUserStateDocument, type InstalledPluginRecord } from "../domain/state/installed-state.js";
import { createProjectLocalStateDocument } from "../domain/state/project-state.js";
import { parseStateMutation, type GenerationSnapshot } from "./state-contract.js";
import type { ScopeContext, ScopeReference } from "../domain/state/scope.js";
import type { Sha256 } from "../domain/source.js";
import type { ArtifactGc, ArtifactGcKind } from "./ports/artifact-gc.js";
import { contentStoreKeyDigest, createPluginStoreIdentityFromEvidence, createMarketplaceStoreIdentityFromEvidence } from "../domain/content-store.js";

export const ConvergenceDiagnosticCodeSchema = z.enum([
  "MARKER_REPLAY_FAILED",
  "MARKER_RETAINED",
  "MARKER_SCOPE_UNAVAILABLE",
  "INVENTORY_UNAVAILABLE",
  "STATE_CORRUPT",
  "BUDGET_EXHAUSTED",
  "ORPHAN_RETAINED",
  "PRUNE_FAILED",
]);
export type ConvergenceDiagnosticCode = z.infer<typeof ConvergenceDiagnosticCodeSchema>;
export const ConvergenceResultSchema = z.object({
  kind: z.enum(["completed", "deferred", "blocked"]),
  scope: z.union([z.object({ kind: z.literal("user") }).strict(), z.object({ kind: z.literal("project"), projectKey: z.string() }).strict()]).optional(),
  plugin: z.string().optional(),
  code: ConvergenceDiagnosticCodeSchema,
}).strict().readonly();
export type ConvergenceResult = z.infer<typeof ConvergenceResultSchema>;
export const ConvergenceReportSchema = z.object({ results: z.array(ConvergenceResultSchema).readonly(), deferred: z.boolean(), processed: z.number().int().nonnegative() }).strict().readonly();
export type ConvergenceReport = z.infer<typeof ConvergenceReportSchema>;
export const DefaultConvergencePolicy = Object.freeze({ requiredBudgetMs: 2_000, maxItems: 128, stagingGraceMs: 7 * 86_400_000, orphanGraceMs: 7 * 86_400_000 });

export type ConvergenceService = Readonly<{ sweep(request: Readonly<{ scopes: readonly ScopeContext[]; signal?: AbortSignal }>): Promise<ConvergenceReport> }>;
export type ConvergenceServiceDependencies = Readonly<{
  state: LifecycleStateStore;
  inventory: LifecycleStateInventoryPort;
  dataRemoval?: PersistentDataRemovalPort;
  pendingDeletes: PendingDeleteMarkerStore;
  sha256: Sha256;
  clock?: LifecycleClock;
  policy?: Partial<typeof DefaultConvergencePolicy>;
  artifacts?: ArtifactGc;
  projectionReferences?: () => ReadonlySet<string> | undefined;
}>;

function records(snapshot: GenerationSnapshot): readonly InstalledPluginRecord[] { return "installed" in snapshot ? snapshot.installed.plugins : snapshot.project.plugins; }
function replaceRecords(snapshot: GenerationSnapshot, next: readonly InstalledPluginRecord[], sha256: Sha256) {
  if ("installed" in snapshot) {
    const installed = createInstalledUserStateDocument({ ...snapshot.installed, generation: snapshot.generation, plugins: next }, sha256);
    return parseStateMutation({ scope: snapshot.scope, expectedGeneration: snapshot.generation, replace: { installed } }, sha256);
  }
  const project = createProjectLocalStateDocument({ ...snapshot.project, generation: snapshot.generation, plugins: next }, snapshot.scope, sha256);
  return parseStateMutation({ scope: snapshot.scope, expectedGeneration: snapshot.generation, replace: { project } }, sha256);
}
function scopeRef(scope: ScopeContext): ScopeReference { return scope.kind === "user" ? { kind: "user" } : { kind: "project", projectKey: scope.projectKey }; }
function sameScope(left: ScopeReference, right: ScopeReference): boolean {
  return left.kind === right.kind && (left.kind === "user" || (right.kind === "project" && left.projectKey === right.projectKey));
}
function contextForMarker(marker: PendingDeleteMarker, inventory: LifecycleStateInventory | undefined): ScopeContext | undefined {
  return inventory?.scopes.find((candidate) => sameScope(scopeRef(candidate), marker.scope));
}
function prunedRecords(snapshot: GenerationSnapshot): Readonly<{ records: readonly InstalledPluginRecord[]; changed: boolean }> {
  const current = records(snapshot);
  const next = current.map((record) => {
    const keep = new Set([record.selectedRevision, ...(record.previousRevision === undefined ? [] : [record.previousRevision])]);
    const revisions = record.revisions.filter((revision) => keep.has(revision.revision));
    return revisions.length === record.revisions.length ? record : { ...record, revisions };
  });
  return { records: next, changed: next.some((record, index) => JSON.stringify(record) !== JSON.stringify(current[index])) };
}

type MarkerScopeEvidence = "installed" | "absent" | "unavailable";
type MarkerOutcome = "deleted" | "discarded-installed" | "retained-age" | "retained-scope" | "retained-failure";

async function replayMarkers(input: Readonly<{
  markers: PendingDeleteMarkerStore;
  scopeEvidence(marker: PendingDeleteMarker): Promise<MarkerScopeEvidence>;
  data: PersistentDataRemovalPort;
  signal: AbortSignal;
  now?: number;
  shouldStop: () => boolean;
  onProcessed?: () => void;
}>): Promise<Readonly<{ entries: readonly Readonly<{ marker: PendingDeleteMarker; outcome: MarkerOutcome }>[]; exhausted: boolean }>> {
  const now = input.now ?? Date.now();
  const results: Array<Readonly<{ marker: PendingDeleteMarker; outcome: MarkerOutcome }>> = [];
  const record = (entry: Readonly<{ marker: PendingDeleteMarker; outcome: MarkerOutcome }>): void => { results.push(entry); input.onProcessed?.(); };
  for (const marker of await input.markers.list(input.signal)) {
    if (input.shouldStop()) return { entries: results, exhausted: true };
    input.signal.throwIfAborted();
    const evidence = await input.scopeEvidence(marker);
    if (evidence === "unavailable") { record({ marker, outcome: "retained-scope" }); continue; }
    if (evidence === "installed") {
      if (now - marker.requestedAt < PENDING_DELETE_GRACE_MS) { record({ marker, outcome: "retained-age" }); continue; }
      try {
        await input.markers.remove(marker);
        record({ marker, outcome: "discarded-installed" });
      } catch {
        record({ marker, outcome: "retained-failure" });
      }
      continue;
    }
    try {
      await input.data.remove({ scope: marker.scope, plugin: marker.plugin, dataRef: marker.dataRef, confirmation: "delete-confirmed", capability: {} }, input.signal);
      await input.markers.remove(marker);
      record({ marker, outcome: "deleted" });
    } catch {
      record({ marker, outcome: "retained-failure" });
    }
  }
  return { entries: results, exhausted: false };
}

export function createConvergenceService(dependencies: ConvergenceServiceDependencies): ConvergenceService {
  if (dependencies === null || typeof dependencies !== "object" || typeof dependencies.state?.read !== "function" || typeof dependencies.state?.commit !== "function" || typeof dependencies.inventory?.discover !== "function" || typeof dependencies.sha256 !== "function") throw new TypeError("convergence dependencies are required");
  const policy = { ...DefaultConvergencePolicy, ...(dependencies.policy ?? {}) };
  async function sweep(request: Readonly<{ scopes: readonly ScopeContext[]; signal?: AbortSignal }>): Promise<ConvergenceReport> {
    const signal = request.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const monotonicNow = () => dependencies.clock?.monotonicMilliseconds() ?? Date.now();
    const started = monotonicNow();
    const now = dependencies.clock?.nowEpochMilliseconds() ?? Date.now();
    let processed = 0;
    let deferred = false;
    const results: ConvergenceResult[] = [];
    const shouldStop = () => processed >= policy.maxItems || monotonicNow() - started >= policy.requiredBudgetMs;

    let inventory: LifecycleStateInventory | undefined;
    try {
      inventory = await dependencies.inventory.discover(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      deferred = true;
      results.push({ kind: "deferred", code: "INVENTORY_UNAVAILABLE" });
    }
    const discoveredScopes = inventory?.scopes ?? request.scopes;

    if (dependencies.dataRemoval !== undefined) {
      let replayed = 0;
      try {
        const markerResults = await replayMarkers({
          markers: dependencies.pendingDeletes,
          scopeEvidence: async (marker) => {
            const context = contextForMarker(marker, inventory);
            if (context === undefined) return "unavailable";
            try {
              const loaded = await dependencies.state.read(context, signal);
              if (!loaded.ok || (loaded.snapshot.corruptions?.length ?? 0) > 0) return "unavailable";
              return records(loaded.snapshot).some((record) => record.plugin === marker.plugin) ? "installed" : "absent";
            } catch (error) {
              if (signal.aborted) throw error;
              return "unavailable";
            }
          },
          data: dependencies.dataRemoval,
          signal,
          now,
          shouldStop: () => processed + replayed >= policy.maxItems || monotonicNow() - started >= policy.requiredBudgetMs,
          onProcessed: () => { replayed += 1; },
        });
        for (const entry of markerResults.entries) {
          processed += 1;
          if (entry.outcome === "retained-age") {
            deferred = true;
            results.push({ kind: "deferred", scope: entry.marker.scope, plugin: entry.marker.plugin, code: "MARKER_RETAINED" });
          } else if (entry.outcome === "retained-scope") {
            deferred = true;
            results.push({ kind: "deferred", scope: entry.marker.scope, plugin: entry.marker.plugin, code: "MARKER_SCOPE_UNAVAILABLE" });
          } else if (entry.outcome === "retained-failure") {
            deferred = true;
            results.push({ kind: "deferred", scope: entry.marker.scope, plugin: entry.marker.plugin, code: "MARKER_REPLAY_FAILED" });
          }
        }
        if (markerResults.exhausted) {
          deferred = true;
          results.push({ kind: "deferred", code: "BUDGET_EXHAUSTED" });
        }
      } catch (error) {
        if (signal.aborted) throw error;
        deferred = true;
        results.push({ kind: "deferred", code: "MARKER_REPLAY_FAILED" });
      }
    }

    for (const scope of request.scopes) {
      signal.throwIfAborted();
      if (shouldStop()) { deferred = true; results.push({ kind: "deferred", scope: scopeRef(scope), code: "BUDGET_EXHAUSTED" }); break; }
      try {
        const mutation = await runScopedMutation(dependencies.state, scope, (snapshot: GenerationSnapshot) => {
          const pruned = prunedRecords(snapshot);
          if (!pruned.changed) return { kind: "no-op" as const, value: undefined };
          return { kind: "commit" as const, mutation: replaceRecords(snapshot, pruned.records, dependencies.sha256), value: undefined };
        }, signal);
        if (mutation.kind !== "committed" && mutation.kind !== "no-op") {
          deferred = true;
          results.push({ kind: "deferred", scope: scopeRef(scope), code: "PRUNE_FAILED" });
        }
      } catch (error) {
        if (signal.aborted) throw error;
        deferred = true;
        results.push({ kind: "deferred", scope: scopeRef(scope), code: "PRUNE_FAILED" });
      }
      processed += 1;
    }

    if (dependencies.artifacts !== undefined && !shouldStop()) {
      const referenced = new Set<string>();
      let referenceEvidenceComplete = inventory !== undefined && inventory.complete;
      for (const scope of discoveredScopes) {
        try {
          const loaded = await dependencies.state.read(scope, signal);
          if (!loaded.ok) { referenceEvidenceComplete = false; continue; }
          if ((loaded.snapshot.corruptions?.length ?? 0) > 0) referenceEvidenceComplete = false;
          for (const record of records(loaded.snapshot)) {
            for (const revision of record.revisions) {
              const identity = createPluginStoreIdentityFromEvidence({ sourceHash: revision.evidence.source.sourceHash, binding: revision.revision }, dependencies.sha256);
              referenced.add(`revision:${contentStoreKeyDigest(identity)}`);
            }
          }
          const marketplaces = "installed" in loaded.snapshot ? loaded.snapshot.installed.marketplaces : loaded.snapshot.project.marketplaces;
          for (const marketplace of marketplaces) {
            const identity = createMarketplaceStoreIdentityFromEvidence({ sourceHash: marketplace.source.sourceHash, revision: marketplace.source.revision, binding: marketplace.binding }, dependencies.sha256);
            referenced.add(`marketplace:${contentStoreKeyDigest(identity)}`);
          }
        } catch (error) {
          if (signal.aborted) throw error;
          referenceEvidenceComplete = false;
        }
      }
      const retainKinds = new Set<ArtifactGcKind>();
      if (!referenceEvidenceComplete) {
        // Missing a scope or an unreadable scope can hide a live reference in
        // each state-backed category. Staging remains independently safe to
        // collect because it is protected by its own grace period.
        retainKinds.add("revision");
        retainKinds.add("marketplace");
        retainKinds.add("projection");
        deferred = true;
        results.push({ kind: "deferred", code: "ORPHAN_RETAINED" });
      }
      let projectionReferences: ReadonlySet<string> | undefined;
      try {
        projectionReferences = dependencies.projectionReferences?.();
      } catch {
        projectionReferences = undefined;
        deferred = true;
        results.push({ kind: "deferred", code: "ORPHAN_RETAINED" });
      }
      if (projectionReferences === undefined) retainKinds.add("projection");
      else for (const key of projectionReferences) referenced.add(`projection:${key}`);
      try {
        const gc = await dependencies.artifacts.sweep({ referenced, ...(retainKinds.size === 0 ? {} : { retainKinds: [...retainKinds] }), signal });
        if (gc.deferred || gc.incompleteEvidence) deferred = true;
        if (gc.incompleteEvidence && referenceEvidenceComplete) results.push({ kind: "deferred", code: "ORPHAN_RETAINED" });
      } catch (error) {
        if (signal.aborted) throw error;
        deferred = true;
        results.push({ kind: "deferred", code: "ORPHAN_RETAINED" });
      }
    }
    if (shouldStop()) deferred = true;
    return ConvergenceReportSchema.parse({ results, deferred, processed });
  }
  return Object.freeze({ sweep });
}
