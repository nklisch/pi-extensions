import "zod";
import { ScopeContextSchema, toScopeReference, type ScopeContext, type ScopeReference } from "../domain/state/scope.js";
import { PluginKeySchema } from "../domain/identity.js";
import { PendingTransitionRefSchema, type PendingTransitionRef } from "../domain/state/references.js";
import { type LifecycleTransitionStore } from "./ports/lifecycle-transition-store.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type { LifecycleClock } from "./ports/lifecycle-clock.js";
import type { LifecycleStateInventoryPort } from "./ports/lifecycle-state-inventory.js";
import type { RecoveryArtifactsPort } from "./ports/recovery-artifacts.js";
import type { LifecycleTransitionReconciler } from "./lifecycle-transition-reconciler.js";
import { DefaultLifecycleRecoveryPolicy, LifecycleRecoveryResultSchema, RecoveryPolicySchema, TransitionRecoveryResultSchema, type LifecycleRecoveryResult, type RecoveryPolicy, type TransitionRecoveryResult } from "./recovery-contract.js";
import type { ActivationObservation, LifecycleReloadPort } from "./ports/lifecycle-reload.js";
import type { NativeUninstallCleanupService } from "./native-uninstall-cleanup.js";

export type LifecycleRecoveryServiceDependencies = Readonly<{
  state: LifecycleStateStore;
  inventory?: LifecycleStateInventoryPort;
  transitions: (scope: ScopeReference) => LifecycleTransitionStore;
  reconciler: LifecycleTransitionReconciler;
  reload: LifecycleReloadPort;
  artifacts?: RecoveryArtifactsPort;
  uninstallCleanup?: NativeUninstallCleanupService;
  clock?: LifecycleClock;
}>;

export type LifecycleRecoveryServiceRequest = Readonly<{
  requiredScopes: readonly ScopeContext[];
  /**
   * A live reload successor owns these exact transitions. Startup recovery
   * must not race that handoff even if predecessor journal ownership has
   * already been released during extension disposal.
   */
  reservedTransitions?: readonly PendingTransitionRef[];
  policy?: Partial<RecoveryPolicy>;
}>;

export interface LifecycleRecoveryService {
  recover(request: LifecycleRecoveryServiceRequest, signal: AbortSignal): Promise<LifecycleRecoveryResult>;
}

function sortScopes(scopes: readonly ScopeContext[]): ScopeContext[] { return [...scopes].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))); }
function sortResult(left: TransitionRecoveryResult, right: TransitionRecoveryResult): number {
  return JSON.stringify([left.scope, left.plugin ?? "", left.reference ?? "", left.kind]).localeCompare(JSON.stringify([right.scope, right.plugin ?? "", right.reference ?? "", right.kind]));
}
/** Startup reconciliation is deliberately local and bounded; collection is separate best-effort work. */
export function createLifecycleRecoveryService(dependencies: LifecycleRecoveryServiceDependencies): LifecycleRecoveryService {
  if (dependencies === null || typeof dependencies !== "object") throw new TypeError("recovery service dependencies are required");
  const clock: LifecycleClock = dependencies.clock ?? {
    nowEpochMilliseconds: () => Date.now(),
    monotonicMilliseconds: () => globalThis.performance?.now() ?? Date.now(),
  };

  async function recover(request: LifecycleRecoveryServiceRequest, signal: AbortSignal): Promise<LifecycleRecoveryResult> {
    const policy = RecoveryPolicySchema.parse({ ...DefaultLifecycleRecoveryPolicy, ...(request.policy ?? {}) });
    const started = clock.monotonicMilliseconds();
    const deadline = started + policy.requiredBudgetMs;
    let processed = 0;
    let deferred = false;
    const results: TransitionRecoveryResult[] = [];
    const reservedTransitions = new Set((request.reservedTransitions ?? []).map((reference) => PendingTransitionRefSchema.parse(reference)));
    let scopes = sortScopes(request.requiredScopes.map((scope) => ScopeContextSchema.parse(scope)));
    if (scopes.length === 0 && dependencies.inventory !== undefined) {
      const inventory = await dependencies.inventory.discover(signal);
      scopes = sortScopes(inventory.scopes);
      if (!inventory.complete) deferred = true;
    }

    for (const scope of scopes) {
      if (signal.aborted) throw signal.reason;
      if (clock.monotonicMilliseconds() >= deadline || processed >= policy.maxTransitions) {
        deferred = true;
        results.push({ kind: "deferred", scope: toScopeReference(scope), code: "BUDGET_EXHAUSTED" });
        continue;
      }
      const scopeReference = toScopeReference(scope);
      const loaded = await dependencies.state.read(scope, signal);
      if (!loaded.ok) {
        deferred = true;
        results.push({ kind: "blocked", scope: scopeReference, code: "STATE_CORRUPT" });
        continue;
      }
      const journal = dependencies.transitions(scopeReference);
      const collection = journal.list === undefined ? undefined : await journal.list(scopeReference, signal).catch(() => undefined);
      if (collection === undefined || !collection.complete) {
        deferred = true;
        results.push({ kind: "blocked", scope: scopeReference, code: "JOURNAL_CORRUPT" });
        continue;
      }
      const byReference = new Map(collection.entries.map((entry) => [entry.record.reference, entry]));
      const pending = ("installed" in loaded.snapshot ? loaded.snapshot.installed.plugins : loaded.snapshot.project.plugins)
        .filter((record) => record.pendingTransition !== undefined)
        .sort((left, right) => left.plugin.localeCompare(right.plugin));
      for (const pluginRecord of pending) {
        const reference = PendingTransitionRefSchema.parse(pluginRecord.pendingTransition);
        if (reservedTransitions.has(reference)) continue;
        if (processed >= policy.maxTransitions || clock.monotonicMilliseconds() >= deadline) {
          deferred = true;
          results.push({ kind: "deferred", scope: scopeReference, plugin: pluginRecord.plugin, reference, code: "BUDGET_EXHAUSTED" });
          continue;
        }
        processed += 1;
        const entry = byReference.get(reference);
        if (entry === undefined) {
          deferred = true;
          results.push({ kind: "blocked", scope: scopeReference, plugin: pluginRecord.plugin, reference, code: "JOURNAL_MISSING" });
          continue;
        }
        if (entry.status.kind === "quarantined") {
          deferred = true;
          results.push({ kind: "blocked", scope: scopeReference, plugin: pluginRecord.plugin, reference, code: "JOURNAL_CORRUPT" });
          continue;
        }
        const owner = journal.ownerStatus === undefined ? "released" : await journal.ownerStatus(scopeReference, reference, signal).catch(() => "unknown" as const);
        if (owner === "live" || owner === "unknown") {
          deferred = true;
          results.push({ kind: "deferred", scope: scopeReference, plugin: pluginRecord.plugin, reference, code: owner === "live" ? "OWNER_LIVE" : "OWNER_UNKNOWN" });
          continue;
        }
        let observation: ActivationObservation | undefined;
        if (entry.record.candidateProjection.kind === "active" && pluginRecord.activation === "enabled") {
          observation = await dependencies.reload.observe({ scope: scopeReference, plugin: pluginRecord.plugin }, signal).catch(() => undefined);
        }
        const reconciled = await dependencies.reconciler.recoverInterruptedTransition({
          scope,
          plugin: PluginKeySchema.parse(pluginRecord.plugin),
          record: entry.record,
          current: pluginRecord,
          ...(observation === undefined ? {} : { observation }),
        }, signal);
        if (reconciled.kind === "completed") results.push({ kind: "finalized", scope: scopeReference, plugin: pluginRecord.plugin, reference, generation: reconciled.snapshot.generation });
        else if (reconciled.kind === "rolled-back") results.push({ kind: "rolled-back", scope: scopeReference, plugin: pluginRecord.plugin, reference, generation: reconciled.snapshot.generation });
        else {
          deferred = true;
          results.push({ kind: "blocked", scope: scopeReference, plugin: pluginRecord.plugin, reference, code: "RECOVERY_CONFLICT" });
          await journal.markRecoveryRequired?.({ scope: scopeReference, reference, ...(reconciled.committed === undefined ? {} : { generation: reconciled.committed }), at: clock.nowEpochMilliseconds() }, signal).catch(() => undefined);
        }
      }

      // Terminal uninstall deletion is durable journal work, independent of
      // the now-absent installed record. Failure never blocks another plugin.
      if (dependencies.uninstallCleanup !== undefined) {
        for (const entry of collection.entries.filter((candidate) => candidate.status.kind === "completed" && (candidate.cleanup === "pending-data-delete" || candidate.cleanup === "recovery-required")).sort((left, right) => left.record.reference.localeCompare(right.record.reference))) {
          if (processed >= policy.maxTransitions || clock.monotonicMilliseconds() >= deadline) { deferred = true; results.push({ kind: "deferred", scope: scopeReference, plugin: entry.record.plugin, reference: entry.record.reference, code: "BUDGET_EXHAUSTED" }); continue; }
          processed += 1;
          const cleanup = await dependencies.uninstallCleanup.recover(entry, signal);
          if (cleanup.kind === "deleted") results.push({ kind: "cleanup-completed", scope: scopeReference, plugin: entry.record.plugin, reference: entry.record.reference });
          else if (cleanup.kind === "recovery-required") { deferred = true; results.push({ kind: "blocked", scope: scopeReference, plugin: entry.record.plugin, reference: entry.record.reference, code: "CLEANUP_FAILED" }); }
        }
      }

      // Unreferenced prepared rows are inert. They are abandoned only after
      // owner death and a durable wall-clock grace, never by lease expiry.
      for (const entry of collection.entries.filter((candidate) => candidate.status.kind === "prepared").sort((left, right) => left.record.reference.localeCompare(right.record.reference))) {
        if (pending.some((record) => record.pendingTransition === entry.record.reference)) continue;
        if (processed >= policy.maxTransitions || clock.monotonicMilliseconds() >= deadline) { deferred = true; results.push({ kind: "deferred", scope: scopeReference, plugin: entry.record.plugin, reference: entry.record.reference, code: "BUDGET_EXHAUSTED" }); continue; }
        processed += 1;
        const owner = journal.ownerStatus === undefined ? "released" : await journal.ownerStatus(scopeReference, entry.record.reference, signal).catch(() => "unknown" as const);
        if (owner === "live" || owner === "unknown") { deferred = true; results.push({ kind: "deferred", scope: scopeReference, plugin: entry.record.plugin, reference: entry.record.reference, code: owner === "live" ? "OWNER_LIVE" : "OWNER_UNKNOWN" }); continue; }
        if (entry.preparedAt + policy.abandonedGraceMs > clock.nowEpochMilliseconds()) continue;
        await journal.settle({ reference: entry.record.reference, outcome: "abandoned", at: clock.nowEpochMilliseconds() }, signal).catch(() => undefined);
        results.push({ kind: "abandoned", scope: scopeReference, plugin: entry.record.plugin, reference: entry.record.reference });
      }
    }

    if (!deferred && dependencies.artifacts !== undefined && clock.monotonicMilliseconds() < deadline) {
      const scan = await dependencies.artifacts.scan(signal).catch(() => ({ complete: false, candidates: [] }));
      if (!scan.complete) deferred = true;
      else for (const candidate of [...scan.candidates].sort((left, right) => left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key))) {
        if (candidate.owner !== "dead" || candidate.createdAt + policy.abandonedGraceMs > clock.nowEpochMilliseconds()) continue;
        if (clock.monotonicMilliseconds() >= deadline) { deferred = true; break; }
        await dependencies.artifacts.remove(candidate, signal).catch(() => undefined);
      }
    }
    return LifecycleRecoveryResultSchema.parse({ results: results.sort(sortResult), deferred, processed });
  }
  return Object.freeze({ recover });
}

export { TransitionRecoveryResultSchema };
export type { LifecycleRecoveryResult, ScopeContext, ScopeReference };
