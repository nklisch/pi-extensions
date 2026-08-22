import { z } from "zod";
import { runScopedMutation } from "./state-transaction.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type { LifecycleStateInventoryPort } from "./ports/lifecycle-state-inventory.js";
import type { PersistentDataRemovalPort } from "./ports/persistent-data-removal.js";
import type { LifecycleClock } from "./ports/lifecycle-clock.js";
import { PENDING_DELETE_GRACE_MS, type PendingDeleteMarker, type PendingDeleteMarkerStore } from "./ports/pending-data-deletion.js";
import { createInstalledUserStateDocument, type InstalledPluginRecord } from "../domain/state/installed-state.js";
import { createProjectLocalStateDocument } from "../domain/state/project-state.js";
import { parseStateMutation, type GenerationSnapshot } from "./state-contract.js";
import type { ScopeContext, ScopeReference } from "../domain/state/scope.js";
import type { Sha256 } from "../domain/source.js";
import type { ArtifactGc } from "./ports/artifact-gc.js";
import { createPluginStoreIdentityFromEvidence, createMarketplaceStoreIdentityFromEvidence } from "../domain/content-store.js";

export const ConvergenceDiagnosticCodeSchema = z.enum(["MARKER_REPLAY_FAILED", "STATE_CORRUPT", "BUDGET_EXHAUSTED", "ORPHAN_RETAINED", "PRUNE_FAILED"]);
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
  inventory?: LifecycleStateInventoryPort;
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
async function replayMarkers(input: Readonly<{ markers: PendingDeleteMarkerStore; isInstalled(scope: ScopeReference, plugin: string, signal: AbortSignal): Promise<boolean>; data: PersistentDataRemovalPort; signal: AbortSignal; now?: number; shouldStop: () => boolean; onProcessed?: () => void }>): Promise<Readonly<{ entries: readonly Readonly<{ marker: PendingDeleteMarker; outcome: "deleted" | "discarded-installed" | "retained" }>[]; exhausted: boolean }>> {
  const now = input.now ?? Date.now();
  const results: Array<Readonly<{ marker: PendingDeleteMarker; outcome: "deleted" | "discarded-installed" | "retained" }>> = [];
  const record = (entry: Readonly<{ marker: PendingDeleteMarker; outcome: "deleted" | "discarded-installed" | "retained" }>): void => { results.push(entry); input.onProcessed?.(); };
  for (const marker of await input.markers.list(input.signal)) {
    if (input.shouldStop()) return { entries: results, exhausted: true };
    input.signal.throwIfAborted();
    if (await input.isInstalled(marker.scope, marker.plugin, input.signal)) {
      if (now - marker.requestedAt < PENDING_DELETE_GRACE_MS) { record({ marker, outcome: "retained" }); continue; }
      await input.markers.remove(marker); record({ marker, outcome: "discarded-installed" }); continue;
    }
    try { await input.data.remove({ scope: marker.scope, plugin: marker.plugin, dataRef: marker.dataRef, confirmation: "delete-confirmed", capability: {} }, input.signal); await input.markers.remove(marker); record({ marker, outcome: "deleted" }); }
    catch { record({ marker, outcome: "retained" }); }
  }
  return { entries: results, exhausted: false };
}

export function createConvergenceService(dependencies: ConvergenceServiceDependencies): ConvergenceService {
  if (dependencies === null || typeof dependencies !== "object" || typeof dependencies.state?.read !== "function" || typeof dependencies.state?.commit !== "function" || typeof dependencies.sha256 !== "function") throw new TypeError("convergence dependencies are required");
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
    if (dependencies.dataRemoval !== undefined) {
      let replayed = 0;
      const markerResults = await replayMarkers({
        markers: dependencies.pendingDeletes,
        isInstalled: async (scope, plugin, markerSignal) => {
          const context = scope.kind === "user" ? { kind: "user" as const } : request.scopes.find((candidate) => candidate.kind === "project" && candidate.projectKey === scope.projectKey);
          if (context === undefined) return false;
          const loaded = await dependencies.state.read(context, markerSignal);
          return loaded.ok && records(loaded.snapshot).some((record) => record.plugin === plugin);
        },
        data: dependencies.dataRemoval,
        signal,
        now,
        shouldStop: () => processed + replayed >= policy.maxItems || monotonicNow() - started >= policy.requiredBudgetMs,
        onProcessed: () => { replayed += 1; },
      });
      for (const entry of markerResults.entries) {
        processed += 1;
        if (entry.outcome === "retained") { deferred = true; results.push({ kind: "deferred", scope: entry.marker.scope, plugin: entry.marker.plugin, code: "MARKER_REPLAY_FAILED" }); }
      }
      if (markerResults.exhausted) {
        deferred = true;
        results.push({ kind: "deferred", code: "BUDGET_EXHAUSTED" });
      }
    }
    for (const scope of request.scopes) {
      signal.throwIfAborted();
      if (shouldStop()) { deferred = true; results.push({ kind: "deferred", scope: scopeRef(scope), code: "BUDGET_EXHAUSTED" }); break; }
      const loaded = await dependencies.state.read(scope, signal);
      if (!loaded.ok) { results.push({ kind: "blocked", scope: scopeRef(scope), code: "STATE_CORRUPT" }); continue; }
      const current = records(loaded.snapshot);
      const next = current.map((record) => {
        const keep = new Set([record.selectedRevision, ...(record.previousRevision === undefined ? [] : [record.previousRevision])]);
        const revisions = record.revisions.filter((revision) => keep.has(revision.revision));
        return revisions.length === record.revisions.length ? record : { ...record, revisions };
      });
      const changed = next.some((record, index) => JSON.stringify(record) !== JSON.stringify(current[index]));
      if (changed) {
        const committed = await runScopedMutation(dependencies.state, scope, (snapshot: GenerationSnapshot) => ({ kind: "commit" as const, mutation: replaceRecords(snapshot, next, dependencies.sha256), value: undefined }), signal);
        if (committed.kind !== "committed") { deferred = true; results.push({ kind: "deferred", scope: scopeRef(scope), code: "PRUNE_FAILED" }); }
      }
      processed += 1;
    }
    if (dependencies.artifacts !== undefined && !shouldStop()) {
      const referenced = new Set<string>();
      for (const scope of request.scopes) {
        const loaded = await dependencies.state.read(scope, signal);
        if (!loaded.ok) { deferred = true; continue; }
        for (const record of records(loaded.snapshot)) {
          for (const revision of record.revisions) {
            referenced.add(`revision:${createPluginStoreIdentityFromEvidence({ sourceHash: revision.evidence.source.sourceHash, binding: revision.revision }, dependencies.sha256).key}`);
          }
        }
        if ("installed" in loaded.snapshot) for (const marketplace of loaded.snapshot.installed.marketplaces) referenced.add(`marketplace:${createMarketplaceStoreIdentityFromEvidence({ sourceHash: marketplace.source.sourceHash, revision: marketplace.source.revision, binding: marketplace.binding }, dependencies.sha256).key}`);
      }
      const projectionReferences = dependencies.projectionReferences?.();
      if (projectionReferences === undefined) {
        const gc = await dependencies.artifacts.sweep({ referenced, retainKinds: ["projection"], signal });
        deferred ||= gc.deferred || gc.incompleteEvidence;
      } else {
        for (const key of projectionReferences) referenced.add(`projection:${key}`);
        const gc = await dependencies.artifacts.sweep({ referenced, signal });
        deferred ||= gc.deferred || gc.incompleteEvidence;
      }
    }
    if (shouldStop()) deferred = true;
    return ConvergenceReportSchema.parse({ results, deferred, processed });
  }
  return Object.freeze({ sweep });
}


