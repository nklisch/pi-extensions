import { toScopeReference } from "../domain/state/scope.js";
import type { Sha256 } from "../domain/source.js";
import type { GenerationSnapshot } from "./state-contract.js";
import {
  NativeLifecycleOperationResultSchema,
  NativeLifecycleTargetBindingSchema,
  type NativeLifecycleOperationResult,
  type NativeLifecycleProgressEvent,
  type NativeLifecycleProgressPhase,
} from "./native-lifecycle-operation-contract.js";
import type { NativeDiagnostic } from "./native-inspection-contract.js";
import { deriveLifecycleTargetDigest, type VerifiedNativeLifecycleTarget } from "./native-lifecycle-target.js";
import type { PluginLifecycleResult } from "./plugin-lifecycle-service.js";

function targetRecord(snapshot: GenerationSnapshot, plugin: string) {
  const records = "installed" in snapshot ? snapshot.installed.plugins : snapshot.project.plugins;
  return records.find((record) => record.plugin === plugin);
}

function observedTarget(before: VerifiedNativeLifecycleTarget, snapshot: GenerationSnapshot, sha256: Sha256) {
  const record = targetRecord(snapshot, before.binding.plugin);
  if (record === undefined || record.pendingTransition !== undefined) return undefined;
  const scope = toScopeReference(snapshot.scope);
  return NativeLifecycleTargetBindingSchema.parse({
    ...before.binding,
    scope,
    stateGeneration: snapshot.generation,
    selectedRevision: record.selectedRevision,
    activation: record.activation,
    targetDigest: deriveLifecycleTargetDigest(scope, record, sha256),
    transition: "none",
  });
}

function effects(state: "unchanged" | "changed" | "unknown", generation?: number) {
  return { state, projectFile: "unchanged" as const, completedActionIds: [], pendingActionIds: [], ...(generation === undefined ? {} : { generation }) };
}

export function projectPluginLifecycleResult(input: Readonly<{
  result: PluginLifecycleResult;
  target: VerifiedNativeLifecycleTarget;
  previewId: import("./native-lifecycle-operation-contract.js").NativeLifecyclePreviewId;
  progress: readonly NativeLifecycleProgressEvent[];
  diagnostics?: readonly NativeDiagnostic[];
  cancellationPhase?: NativeLifecycleProgressPhase;
  persistentData?: "keep" | "delete-confirmed";
  cleanupPersistentData?: "retained" | "deleted" | "recovery-required";
  components?: Readonly<{ skills: number; hooks: number; mcpServers: number }>;
  sha256: Sha256;
}>): NativeLifecycleOperationResult {
  const base = {
    operation: input.result.operation as "enable" | "disable" | "update" | "uninstall",
    previewId: input.previewId,
    progress: input.progress,
    diagnostics: input.diagnostics ?? [],
  } as const;
  const result = input.result;
  if (result.kind === "changed") {
    const after = observedTarget(input.target, result.snapshot, input.sha256);
    if (result.operation !== "uninstall" && after === undefined) {
      return NativeLifecycleOperationResultSchema.parse({ kind: "recovery-required", ...base, code: "ADAPTER_FAILED", action: "run-recovery", effects: effects("changed", result.snapshot.generation) });
    }
    return NativeLifecycleOperationResultSchema.parse({
      kind: "succeeded",
      ...base,
      before: input.target.binding,
      ...(after === undefined ? {} : { after }),
      ...(input.components === undefined ? {} : { components: input.components }),
      ...(result.operation === "uninstall" ? { cleanup: {
        persistentData: input.cleanupPersistentData ?? (input.persistentData === "delete-confirmed" ? "recovery-required" : "retained"),
        configuration: "retained",
        trust: "retained",
        revisions: "collection-deferred",
      } } : {}),
      effects: effects("changed", result.snapshot.generation),
    });
  }
  if (result.kind === "unchanged") {
    const reason = result.operation === "enable" ? "already-enabled"
      : result.operation === "disable" ? "already-disabled"
      : result.operation === "update" ? "revision-current"
      : "already-uninstalled";
    return NativeLifecycleOperationResultSchema.parse({ kind: "current-state", ...base, reason, target: observedTarget(input.target, result.snapshot, input.sha256) ?? input.target.binding, effects: effects("unchanged", result.snapshot.generation) });
  }
  if (result.kind === "stale") {
    return NativeLifecycleOperationResultSchema.parse({ kind: "conflict", ...base, reason: "target-changed", effects: effects("unchanged", result.actual) });
  }
  if (result.kind === "rolled-back") {
    const restored = observedTarget(input.target, result.snapshot, input.sha256);
    if (restored === undefined) return NativeLifecycleOperationResultSchema.parse({ kind: "recovery-required", ...base, code: "ADAPTER_FAILED", action: "run-recovery", effects: effects("unknown", result.snapshot.generation) });
    return NativeLifecycleOperationResultSchema.parse({ kind: "rolled-back", ...base, failure: result.failure.kind, restored, effects: effects("unchanged", result.snapshot.generation) });
  }
  if (result.kind === "recovery-required") {
    return NativeLifecycleOperationResultSchema.parse({ kind: "recovery-required", ...base, code: "PENDING_TRANSITION", transition: result.transition, ...(result.committed === undefined ? {} : { committed: result.committed }), action: "run-recovery", effects: effects(result.committed === undefined ? "unknown" : "changed", result.committed) });
  }
  if (result.code === "ABORTED") {
    return NativeLifecycleOperationResultSchema.parse({ kind: "cancelled", ...base, phase: input.cancellationPhase ?? "lifecycle-transaction", effects: effects("unchanged") });
  }
  if (result.code === "PENDING_TRANSITION") return NativeLifecycleOperationResultSchema.parse({ kind: "conflict", ...base, reason: "pending-transition", effects: effects("unchanged") });
  if (result.code === "AVAILABLE_REVISION_CHANGED") return NativeLifecycleOperationResultSchema.parse({ kind: "stale", ...base, reason: "candidate", effects: effects("unchanged") });
  if (result.code === "CONFIGURATION_STALE") return NativeLifecycleOperationResultSchema.parse({ kind: "stale", ...base, reason: "configuration", effects: effects("unchanged") });
  return NativeLifecycleOperationResultSchema.parse({ kind: "rejected", ...base, code: result.code, effects: effects("unchanged") });
}
