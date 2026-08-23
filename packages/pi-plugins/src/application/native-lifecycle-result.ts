import { toScopeReference } from "../domain/state/scope.js";
import type { Sha256 } from "../domain/source.js";
import type { GenerationSnapshot } from "./state-contract.js";
import { NativeLifecycleOperationResultSchema, NativeLifecycleTargetBindingSchema, type NativeLifecycleOperationResult, type NativeLifecycleProgressEvent, type NativeLifecycleProgressPhase } from "./native-lifecycle-operation-contract.js";
import type { NativeDiagnostic } from "./native-inspection-contract.js";
import { deriveLifecycleTargetDigest, type VerifiedNativeLifecycleTarget } from "./native-lifecycle-target.js";
import type { PluginLifecycleResult } from "./plugin-lifecycle-service.js";

function targetRecord(snapshot: GenerationSnapshot, plugin: string) { return ("installed" in snapshot ? snapshot.installed.plugins : snapshot.project.plugins).find((record) => record.plugin === plugin); }
function hasLivePreviousRevision(snapshot: GenerationSnapshot, plugin: string): boolean {
  const record = targetRecord(snapshot, plugin);
  return record?.previousRevision !== undefined && record.revisions.some((revision) => revision.revision === record.previousRevision);
}
function observedTarget(before: VerifiedNativeLifecycleTarget, snapshot: GenerationSnapshot, sha256: Sha256) {
  const record = targetRecord(snapshot, before.binding.plugin);
  if (record === undefined) return undefined;
  const scope = toScopeReference(snapshot.scope);
  return NativeLifecycleTargetBindingSchema.parse({ ...before.binding, scope, stateGeneration: snapshot.generation, selectedRevision: record.selectedRevision, activation: record.activation, targetDigest: deriveLifecycleTargetDigest(scope, record, sha256) });
}
function effects(state: "unchanged" | "changed" | "unknown", generation?: number) { return { state, projectFile: "unchanged" as const, completedActionIds: [], pendingActionIds: [], ...(generation === undefined ? {} : { generation }) }; }

export function projectPluginLifecycleResult(input: Readonly<{
  result: PluginLifecycleResult;
  target: VerifiedNativeLifecycleTarget;
  previewId: import("./native-lifecycle-operation-contract.js").NativeLifecyclePreviewId;
  progress: readonly NativeLifecycleProgressEvent[];
  diagnostics?: readonly NativeDiagnostic[];
  cancellationPhase?: NativeLifecycleProgressPhase;
  persistentData?: "keep" | "delete-confirmed";
  cleanupPersistentData?: "retained" | "deleted" | "pending";
  components?: Readonly<{ skills: number; hooks: number; mcpServers: number }>;
  sha256: Sha256;
}>): NativeLifecycleOperationResult {
  const base = { operation: input.result.operation as "enable" | "disable" | "update" | "uninstall" | "repair" | "rollback", previewId: input.previewId, progress: input.progress, diagnostics: input.diagnostics ?? [] } as const;
  const result = input.result;
  if (result.kind === "applied" || result.kind === "live-next-start") {
    const after = observedTarget(input.target, result.snapshot, input.sha256);
    return NativeLifecycleOperationResultSchema.parse({ kind: "succeeded", ...base, before: input.target.binding, ...(after === undefined ? {} : { after }), ...(input.components === undefined ? {} : { components: input.components }), ...(result.operation === "uninstall" ? { cleanup: { persistentData: input.cleanupPersistentData ?? (input.persistentData === "delete-confirmed" ? "pending" : "retained"), configuration: "retained", trust: "retained", revisions: "collection-deferred" } } : {}), activation: result.kind === "applied" ? "applied" : "live-next-start", effects: effects("changed", result.snapshot.generation) });
  }
  if (result.kind === "current") {
    const reason = result.operation === "enable" ? "already-enabled" : result.operation === "disable" ? "already-disabled" : result.operation === "update" ? "revision-current" : result.operation === "uninstall" ? "already-uninstalled" : "revision-current";
    return NativeLifecycleOperationResultSchema.parse({ kind: "current-state", ...base, reason, target: observedTarget(input.target, result.snapshot, input.sha256) ?? input.target.binding, effects: effects("unchanged", result.snapshot.generation) });
  }
  if (result.kind === "degraded") {
    const repairHint = result.runningRevision !== undefined
      ? "both"
      : hasLivePreviousRevision(result.snapshot, result.failure.plugin) ? "rollback" : "repair";
    return NativeLifecycleOperationResultSchema.parse({ kind: "degraded", ...base, failure: result.failure, repairHint, effects: effects("changed", result.snapshot.generation) });
  }
  if (result.kind === "stale") return NativeLifecycleOperationResultSchema.parse({ kind: "conflict", ...base, reason: "target-changed", effects: effects("unchanged", result.actual) });
  if (result.code === "ABORTED") return NativeLifecycleOperationResultSchema.parse({ kind: "cancelled", ...base, phase: input.cancellationPhase ?? "lifecycle-transaction", effects: effects("unchanged") });
  if (result.code === "AVAILABLE_REVISION_CHANGED" || result.code === "CONFIGURATION_STALE") return NativeLifecycleOperationResultSchema.parse({ kind: "stale", ...base, reason: result.code === "CONFIGURATION_STALE" ? "configuration" : "candidate", effects: effects("unchanged") });
  return NativeLifecycleOperationResultSchema.parse({ kind: "rejected", ...base, code: result.code, effects: effects("unchanged") });
}
