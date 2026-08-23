import * as api from "@nklisch/pi-plugins";

const requiredExports = [
  "runScopedMutation",
  "createConvergenceService",
  "createPluginLifecycleService",
  "createPendingDeleteMarkerStore",
  "InstalledPluginRecordSchema",
  "StateReferenceKindRegistry",
  "NativeLifecycleOperationResultSchema",
];
for (const name of requiredExports) {
  if (!(name in api)) throw new Error(`compiled package is missing required export: ${name}`);
}
const forbiddenExports = [
  "createGenerationMutationCoordinator",
  "createLifecycleRecoveryService",
  "createLifecycleTransitionReconciler",
  "createRevisionCollectionService",
  "PendingTransitionRefSchema",
  "derivePendingTransitionRef",
];
for (const name of forbiddenExports) {
  if (name in api) throw new Error(`compiled package retains removed export: ${name}`);
}
console.log(`compiled package import passed (${Object.keys(api).length} exports)`);
