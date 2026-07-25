import type { LifecycleClock } from "./ports/lifecycle-clock.js";
import type { PersistentDataRemovalPort } from "./ports/persistent-data-removal.js";
import type { LifecycleTransitionJournalEntry, LifecycleTransitionStore } from "./ports/lifecycle-transition-store.js";
import type { PendingTransitionRef } from "../domain/state/references.js";
import type { ScopeReference } from "../domain/state/scope.js";

export type NativeUninstallCleanupResult =
  | Readonly<{ kind: "retained" }>
  | Readonly<{ kind: "deleted" }>
  | Readonly<{ kind: "recovery-required"; reference: PendingTransitionRef }>;

export interface NativeUninstallCleanupService {
  complete(request: Readonly<{ scope: ScopeReference; reference: PendingTransitionRef }>, signal: AbortSignal): Promise<NativeUninstallCleanupResult>;
  recover(entry: LifecycleTransitionJournalEntry, signal: AbortSignal): Promise<NativeUninstallCleanupResult>;
}

export function createNativeUninstallCleanupService(input: Readonly<{
  transitions(scope: ScopeReference): LifecycleTransitionStore;
  data: PersistentDataRemovalPort;
  clock: LifecycleClock;
}>): NativeUninstallCleanupService {
  if (input === null || typeof input !== "object") throw new TypeError("native uninstall cleanup dependencies are required");

  async function recover(entry: LifecycleTransitionJournalEntry, signal: AbortSignal): Promise<NativeUninstallCleanupResult> {
    const record = entry.record;
    if (record.operation !== "uninstall" || record.retainedData === "keep" || entry.cleanup === "not-required") return { kind: "retained" };
    if (entry.status.kind !== "completed") return { kind: "recovery-required", reference: record.reference };
    if (entry.cleanup === "completed") return { kind: "deleted" };
    const previous = record.previous;
    const selected = previous?.revisions.find((revision) => revision.revision === previous.selectedRevision);
    if (previous === null || selected === undefined) {
      await input.transitions(record.scope).markCleanup?.({ scope: record.scope, reference: record.reference, status: "recovery-required", at: input.clock.nowEpochMilliseconds() }, new AbortController().signal).catch(() => undefined);
      return { kind: "recovery-required", reference: record.reference };
    }
    try {
      await input.data.remove({ scope: record.scope, plugin: record.plugin, dataRef: selected.dataRef, confirmation: "delete-confirmed", capability: {} }, signal);
      const marked = await input.transitions(record.scope).markCleanup?.({ scope: record.scope, reference: record.reference, status: "completed", at: input.clock.nowEpochMilliseconds() }, new AbortController().signal);
      return marked === undefined || marked === "terminal" ? { kind: "recovery-required", reference: record.reference } : { kind: "deleted" };
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      await input.transitions(record.scope).markCleanup?.({ scope: record.scope, reference: record.reference, status: "recovery-required", at: input.clock.nowEpochMilliseconds() }, new AbortController().signal).catch(() => undefined);
      return { kind: "recovery-required", reference: record.reference };
    }
  }

  async function complete(request: Readonly<{ scope: ScopeReference; reference: PendingTransitionRef }>, signal: AbortSignal): Promise<NativeUninstallCleanupResult> {
    const store = input.transitions(request.scope);
    const read = await store.read?.(request, signal);
    if (read?.kind !== "found") return { kind: "recovery-required", reference: request.reference };
    return recover(read.entry, signal);
  }

  return Object.freeze({ complete, recover });
}
