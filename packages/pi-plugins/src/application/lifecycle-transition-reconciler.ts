import "zod";
import type { Sha256 } from "../domain/source.js";
import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import { ScopeContextSchema, toScopeReference, type ScopeContext } from "../domain/state/scope.js";
import { type Generation } from "../domain/state/config-state.js";
import { InstalledPluginRecordSchema, type InstalledPluginRecord } from "../domain/state/installed-state.js";
import { createInstalledUserStateDocument } from "../domain/state/installed-state.js";
import { createProjectLocalStateDocument } from "../domain/state/project-state.js";
import { parseStateMutation, type GenerationSnapshot, type StateMutation } from "./state-contract.js";
import type { GenerationMutationCoordinator } from "./generation-mutation-coordinator.js";
import {
  ActivationObservationSchema,
  LifecycleReloadResultSchema,
  type ActivationObservation,
  type LifecycleReloadPort,
} from "./ports/lifecycle-reload.js";
import {
  LifecycleTransitionRecordSchemaV1,
  type LifecycleTransitionRecord,
  type LifecycleTransitionStore,
} from "./ports/lifecycle-transition-store.js";
import {
  ProjectionExpectationSchema,
  type ProjectionExpectation,
} from "./ports/runtime-projection.js";
import { classifyInterruptedTransition, projectionMatchesObservation, stateWithoutPending, type RecoveryClassification } from "./recovery-contract.js";
import type { LifecycleOperation } from "./plugin-lifecycle-contract.js";

export type LifecycleActivationFailure =
  | Readonly<{ kind: "reload-rejected"; code: "RELOAD_REJECTED" }>
  | Readonly<{ kind: "observation-mismatch"; code: "OBSERVATION_MISMATCH" }>
  | Readonly<{ kind: "adapter-error"; code: "ADAPTER_FAILED" | "ABORTED" }>;

export type TransitionReconciliationResult =
  | Readonly<{ kind: "completed"; snapshot: GenerationSnapshot; observation: ActivationObservation }>
  | Readonly<{ kind: "rolled-back"; snapshot: GenerationSnapshot; observation: ActivationObservation; failure: LifecycleActivationFailure }>
  | Readonly<{ kind: "recovery-required"; committed?: Generation }>;

export type LifecycleTransitionReconcilerDependencies = Readonly<{
  mutations: GenerationMutationCoordinator;
  state: { read(scope: ScopeContext, signal: AbortSignal): Promise<import("./state-contract.js").StateLoadResult> };
  reload: LifecycleReloadPort;
  transitions: LifecycleTransitionStore;
  sha256: Sha256;
}>;

export type CompleteCommittedTransitionRequest = Readonly<{
  operation: LifecycleOperation;
  scope: ScopeContext;
  plugin: PluginKey;
  previous: InstalledPluginRecord | undefined;
  candidate: InstalledPluginRecord;
  final: InstalledPluginRecord | null;
  reference: import("../domain/state/references.js").PendingTransitionRef;
  committed: GenerationSnapshot;
  candidateProjection: ProjectionExpectation;
  previousProjection: ProjectionExpectation;
  activation: Readonly<{ ok: true; observation: ActivationObservation } | { ok: false; failure: LifecycleActivationFailure }>;
}>;

export type RecoverInterruptedTransitionRequest = Readonly<{
  scope: ScopeContext;
  plugin: PluginKey;
  record: LifecycleTransitionRecord;
  current: InstalledPluginRecord | null;
  observation?: ActivationObservation;
}>;

// A lifecycle handoff spans foreground reload plus detached scheduler/notice
// maintenance. Those unrelated writers may advance the shared scope several
// times; each retry is still fenced by the exact pending target and reference.
const MAX_REBASE_ATTEMPTS = 8;

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameJson(a[key], b[key]));
}

function target(snapshot: GenerationSnapshot, plugin: PluginKey): InstalledPluginRecord | undefined {
  return "installed" in snapshot ? snapshot.installed.plugins.find((entry) => entry.plugin === plugin) : snapshot.project.plugins.find((entry) => entry.plugin === plugin);
}

function records(snapshot: GenerationSnapshot): readonly InstalledPluginRecord[] {
  return "installed" in snapshot ? snapshot.installed.plugins : snapshot.project.plugins;
}

function replaceTarget(snapshot: GenerationSnapshot, plugin: PluginKey, replacement: InstalledPluginRecord | null, sha256: Sha256): StateMutation {
  const next = records(snapshot).filter((entry) => entry.plugin !== plugin);
  if (replacement !== null) next.push(replacement);
  if ("installed" in snapshot) {
    const installed = createInstalledUserStateDocument({ ...snapshot.installed, generation: snapshot.generation, plugins: next }, sha256);
    return parseStateMutation({ scope: snapshot.scope, expectedGeneration: snapshot.generation, replace: { installed } }, sha256);
  }
  const project = createProjectLocalStateDocument({ ...snapshot.project, generation: snapshot.generation, plugins: next }, snapshot.scope, sha256);
  return parseStateMutation({ scope: snapshot.scope, expectedGeneration: snapshot.generation, replace: { project } }, sha256);
}

function withPending(record: InstalledPluginRecord, reference: import("../domain/state/references.js").PendingTransitionRef): InstalledPluginRecord {
  return InstalledPluginRecordSchema.parse({ ...stateWithoutPending(record), pendingTransition: reference });
}

function matches(snapshot: GenerationSnapshot, plugin: PluginKey, candidate: InstalledPluginRecord, reference: import("../domain/state/references.js").PendingTransitionRef, allowAbsent: boolean, final: InstalledPluginRecord | null): boolean {
  const current = target(snapshot, plugin);
  if (current === undefined) return allowAbsent && final === null;
  return current.pendingTransition === reference && sameJson(stateWithoutPending(current), candidate);
}

function safeFailure(error: unknown): LifecycleActivationFailure {
  if (error !== null && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError") return { kind: "adapter-error", code: "ABORTED" };
  return { kind: "adapter-error", code: "ADAPTER_FAILED" };
}

function assertSignal(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export function createLifecycleTransitionReconciler(dependencies: LifecycleTransitionReconcilerDependencies): LifecycleTransitionReconciler {
  if (dependencies === null || typeof dependencies !== "object") throw new TypeError("transition reconciler dependencies are required");

  async function load(scope: ScopeContext, signal: AbortSignal): Promise<GenerationSnapshot | undefined> {
    const result = await dependencies.state.read(scope, signal);
    return result.ok ? result.snapshot : undefined;
  }

  async function mutatePending(
    scope: ScopeContext,
    plugin: PluginKey,
    candidate: InstalledPluginRecord,
    final: InstalledPluginRecord | null,
    reference: import("../domain/state/references.js").PendingTransitionRef,
    committed: GenerationSnapshot,
    mutation: (snapshot: GenerationSnapshot) => StateMutation,
    signal: AbortSignal,
    allowAbsent = false,
  ): Promise<GenerationSnapshot | undefined> {
    let expected = committed.generation;
    for (let attempt = 0; attempt < MAX_REBASE_ATTEMPTS; attempt += 1) {
      assertSignal(signal);
      const result = await dependencies.mutations.runPreparedMutation(
        { scope, plugins: [plugin], expectedGeneration: expected },
        async (context) => {
          await context.assertOwned();
          if (!matches(context.snapshot, plugin, candidate, reference, allowAbsent, final)) throw new Error("transition target changed");
          return { mutation: mutation(context.snapshot), value: undefined };
        },
        signal,
      );
      if (result.kind === "committed") return result.snapshot;
      if (result.kind !== "stale-generation" || attempt + 1 >= MAX_REBASE_ATTEMPTS) return undefined;
      const fresh = await load(scope, signal);
      if (fresh === undefined || fresh.generation <= expected || !matches(fresh, plugin, candidate, reference, allowAbsent, final)) return undefined;
      expected = fresh.generation;
    }
    return undefined;
  }

  async function reloadAndObserve(scope: ScopeContext, plugin: PluginKey, reference: import("../domain/state/references.js").PendingTransitionRef, expectation: ProjectionExpectation, signal: AbortSignal): Promise<Readonly<{ ok: true; observation: ActivationObservation } | { ok: false; failure: LifecycleActivationFailure }>> {
    try {
      const reload = LifecycleReloadResultSchema.parse(await dependencies.reload.reload({ scope: toScopeReference(scope), transition: reference }, signal));
      if (reload.kind === "failed") return { ok: false, failure: { kind: "reload-rejected", code: "RELOAD_REJECTED" } };
      const observation = ActivationObservationSchema.parse(await dependencies.reload.observe({ scope: toScopeReference(scope), plugin }, signal));
      if (!projectionMatchesObservation(observation, expectation, plugin)) return { ok: false, failure: { kind: "observation-mismatch", code: "OBSERVATION_MISMATCH" } };
      return { ok: true, observation };
    } catch (error) {
      return { ok: false, failure: safeFailure(error) };
    }
  }

  async function settle(scope: ScopeContext, reference: import("../domain/state/references.js").PendingTransitionRef, outcome: "completed" | "rolled-back", generation: Generation, signal: AbortSignal): Promise<boolean> {
    try {
      await dependencies.transitions.settle({ scope: toScopeReference(scope), reference, outcome, generation }, signal);
      return true;
    } catch {
      return false;
    }
  }

  async function markRecovery(scope: ScopeContext, reference: import("../domain/state/references.js").PendingTransitionRef, generation: Generation, signal: AbortSignal): Promise<void> {
    try { await dependencies.transitions.settle({ scope: toScopeReference(scope), reference, outcome: "recovery-required", generation }, signal); } catch { /* startup will retain the pending state */ }
  }

  async function restoreAndVerify(
    request: Readonly<{ operation: LifecycleOperation; scope: ScopeContext; plugin: PluginKey; previous: InstalledPluginRecord | undefined; candidate: InstalledPluginRecord; reference: import("../domain/state/references.js").PendingTransitionRef; committed: GenerationSnapshot; previousProjection: ProjectionExpectation; failure: LifecycleActivationFailure }>,
    signal: AbortSignal,
  ): Promise<TransitionReconciliationResult> {
    const restored = await mutatePending(request.scope, request.plugin, request.candidate, request.previous ?? null, request.reference, request.committed, (snapshot) => replaceTarget(snapshot, request.plugin, request.previous === undefined ? null : withPending(request.previous, request.reference), dependencies.sha256), signal, request.previous === undefined).catch(() => undefined);
    if (restored === undefined) {
      await markRecovery(request.scope, request.reference, request.committed.generation, signal);
      return { kind: "recovery-required", committed: request.committed.generation };
    }
    const observed = await reloadAndObserve(request.scope, request.plugin, request.reference, request.previousProjection, signal);
    if (!observed.ok) {
      await markRecovery(request.scope, request.reference, restored.generation, signal);
      return { kind: "recovery-required", committed: restored.generation };
    }
    const restoredRecord = request.previous === undefined ? request.candidate : request.previous;
    const final = await mutatePending(request.scope, request.plugin, restoredRecord, request.previous ?? null, request.reference, restored, (snapshot) => replaceTarget(snapshot, request.plugin, request.previous ?? null, dependencies.sha256), signal, request.previous === undefined).catch(() => undefined);
    if (final === undefined || !(await settle(request.scope, request.reference, "rolled-back", final.generation, signal))) {
      await markRecovery(request.scope, request.reference, final?.generation ?? restored.generation, signal);
      return { kind: "recovery-required", committed: final?.generation ?? restored.generation };
    }
    return { kind: "rolled-back", snapshot: final, observation: observed.observation, failure: request.failure };
  }

  async function completeCommittedTransition(request: CompleteCommittedTransitionRequest, signal: AbortSignal): Promise<TransitionReconciliationResult> {
    const scope = ScopeContextSchema.parse(request.scope);
    const plugin = PluginKeySchema.parse(request.plugin);
    const candidate = InstalledPluginRecordSchema.parse(request.candidate);
    const final = request.final === null ? null : InstalledPluginRecordSchema.parse(request.final);
    const candidateProjection = ProjectionExpectationSchema.parse(request.candidateProjection);
    const previousProjection = ProjectionExpectationSchema.parse(request.previousProjection);
    if (!request.activation.ok) return restoreAndVerify({ ...request, scope, plugin, candidate, previousProjection, failure: request.activation.failure }, signal);
    const settled = await mutatePending(scope, plugin, candidate, final, request.reference, request.committed, (snapshot) => replaceTarget(snapshot, plugin, final, dependencies.sha256), signal);
    const journalSettled = settled === undefined ? false : await settle(scope, request.reference, "completed", settled.generation, signal);
    if (settled === undefined || !journalSettled) {
      await markRecovery(scope, request.reference, settled?.generation ?? request.committed.generation, signal);
      return { kind: "recovery-required", committed: settled?.generation ?? request.committed.generation };
    }
    return { kind: "completed", snapshot: settled, observation: request.activation.observation };
  }

  async function recoverInterruptedTransition(request: RecoverInterruptedTransitionRequest, signal: AbortSignal): Promise<TransitionReconciliationResult> {
    assertSignal(signal);
    const record = LifecycleTransitionRecordSchemaV1.parse(request.record);
    const scope = ScopeContextSchema.parse(request.scope);
    const plugin = PluginKeySchema.parse(request.plugin);
    const classification: RecoveryClassification = classifyInterruptedTransition({ record, current: request.current, ...(request.observation === undefined ? {} : { observation: request.observation }) });
    const currentSnapshot = await load(scope, signal);
    if (currentSnapshot === undefined) return { kind: "recovery-required" };
    const current = target(currentSnapshot, plugin);
    if (classification.kind === "conflict") return { kind: "recovery-required", committed: currentSnapshot.generation };
    if (classification.kind === "finalize") {
      const currentWithoutPending = current === undefined ? null : stateWithoutPending(current);
      const candidate = InstalledPluginRecordSchema.parse(record.candidate);
      const final = record.final === null ? null : InstalledPluginRecordSchema.parse(record.final);
      // A terminal final state is already settled; only the journal status is
      // missing. No state rewrite is needed, and no arbitrary replay is possible.
      if (current?.pendingTransition === undefined && (final === null ? currentWithoutPending === null : sameJson(currentWithoutPending, final))) {
        if (request.observation === undefined || !projectionMatchesObservation(request.observation, record.candidateProjection, plugin)) {
          await markRecovery(scope, record.reference, currentSnapshot.generation, signal);
          return { kind: "recovery-required", committed: currentSnapshot.generation };
        }
        if (await settle(scope, record.reference, "completed", currentSnapshot.generation, signal)) return { kind: "completed", snapshot: currentSnapshot, observation: request.observation };
        await markRecovery(scope, record.reference, currentSnapshot.generation, signal);
        return { kind: "recovery-required", committed: currentSnapshot.generation };
      }
      const settled = await mutatePending(scope, plugin, candidate, final, record.reference, currentSnapshot, (snapshot) => replaceTarget(snapshot, plugin, final, dependencies.sha256), signal, final === null).catch(() => undefined);
      if (settled === undefined || request.observation === undefined || !projectionMatchesObservation(request.observation, record.candidateProjection, plugin) || !(await settle(scope, record.reference, "completed", settled.generation, signal))) {
        await markRecovery(scope, record.reference, settled?.generation ?? currentSnapshot.generation, signal);
        return { kind: "recovery-required", committed: settled?.generation ?? currentSnapshot.generation };
      }
      return { kind: "completed", snapshot: settled, observation: request.observation };
    }
    const candidate = InstalledPluginRecordSchema.parse(record.candidate);
    const previous = record.previous === null ? null : InstalledPluginRecordSchema.parse(record.previous);
    if (dependencies.reload.reconcileLocal === undefined || current === undefined) {
      await markRecovery(scope, record.reference, currentSnapshot.generation, signal);
      return { kind: "recovery-required", committed: currentSnapshot.generation };
    }
    let observation: ActivationObservation;
    try {
      // A fresh process has no successor evidence. Reconcile the conservative
      // previous target locally while the pending record remains durable, then
      // publish authority only after exact participant observation.
      observation = await dependencies.reload.reconcileLocal({
        scope,
        plugin,
        target: previous,
        expectation: record.previousProjection,
      }, signal);
      if (!projectionMatchesObservation(observation, record.previousProjection, plugin)) throw new Error("local recovery observation mismatched");
    } catch {
      await markRecovery(scope, record.reference, currentSnapshot.generation, signal);
      return { kind: "recovery-required", committed: currentSnapshot.generation };
    }
    const pendingValue = stateWithoutPending(current);
    const expectedPending = sameJson(pendingValue, candidate)
      ? candidate
      : previous !== null && sameJson(pendingValue, previous)
        ? previous
        : undefined;
    if (expectedPending === undefined) {
      await markRecovery(scope, record.reference, currentSnapshot.generation, signal);
      return { kind: "recovery-required", committed: currentSnapshot.generation };
    }
    const final = await mutatePending(
      scope,
      plugin,
      expectedPending,
      previous,
      record.reference,
      currentSnapshot,
      (snapshot) => replaceTarget(snapshot, plugin, previous, dependencies.sha256),
      signal,
      previous === null,
    ).catch(() => undefined);
    const settlement = final === undefined ? false : await settle(scope, record.reference, "rolled-back", final.generation, signal);
    if (final === undefined || !settlement) {
      await markRecovery(scope, record.reference, final?.generation ?? currentSnapshot.generation, signal);
      return { kind: "recovery-required", committed: final?.generation ?? currentSnapshot.generation };
    }
    return { kind: "rolled-back", snapshot: final, observation, failure: { kind: "observation-mismatch", code: "OBSERVATION_MISMATCH" } };
  }

  return Object.freeze({ completeCommittedTransition, recoverInterruptedTransition });
}

export interface LifecycleTransitionReconciler {
  completeCommittedTransition(request: CompleteCommittedTransitionRequest, signal: AbortSignal): Promise<TransitionReconciliationResult>;
  recoverInterruptedTransition(request: RecoverInterruptedTransitionRequest, signal: AbortSignal): Promise<TransitionReconciliationResult>;
}

export type { ActivationObservation, Generation, InstalledPluginRecord, LifecycleTransitionRecord, PluginKey, ProjectionExpectation };
