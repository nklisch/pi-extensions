import { canonicalJson } from "../domain/canonical-json.js";
import { hashContent, type ContentDigest } from "../domain/content-manifest.js";
import { toScopeReference, type ProjectKey } from "../domain/state/scope.js";
import type { Sha256 } from "../domain/source.js";
import type { GenerationMutationCoordinator } from "./generation-mutation-coordinator.js";
import {
  LifecycleTargetExpectationSchema,
  NativeLifecycleOperationResultSchema,
  type NativeLifecycleOperationResult,
  type NativeLifecyclePreviewId,
  type NativeLifecycleProgressSink,
} from "./native-lifecycle-operation-contract.js";
import { createNativeLifecycleProgressRecorder } from "./native-lifecycle-progress.js";
import { deriveProjectSyncActionId } from "./native-lifecycle-operation-identifiers.js";
import { deriveLifecycleTargetDigest } from "./native-lifecycle-target.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type { ProjectIntentFilePort, VerifiedProjectIntentObservation } from "./ports/project-intent-file.js";
import type { ProjectIntentWriteIdPort } from "./ports/project-intent-write-id.js";
import type { ProjectRootAuthorityPort, TrustedProjectRoot } from "./ports/project-root-authority.js";
import type { ProjectTrustPort } from "./ports/project-trust.js";
import type { PluginLifecycleService } from "./plugin-lifecycle-service.js";
import type { ConfigurationPathContext } from "./ports/configuration-path.js";
import type { MarketplaceRegistrationService } from "./marketplace-registration-service.js";
import {
  createProjectSyncPlanningContext,
  resolveProjectSyncConflicts,
  ProjectSyncPlanningError,
  type ProjectSyncPlannerContext,
} from "./project-sync-planner.js";
import {
  deriveProjectSyncReadinessDigest,
  projectProjectSyncMachineState,
  type ProjectSyncReadinessSnapshot,
} from "./project-sync-projection.js";
import { ProjectSyncRequiredActionSchema, type ProjectSyncConflictResolution, type ProjectSyncMode, type ProjectSyncPlan } from "./project-sync-contract.js";
import type { ProjectGenerationSnapshot } from "./state-contract.js";
import { commitProjectSyncDeclarationDigest } from "./project-sync-state.js";
import { encodeProjectIntentDeclaration } from "./project-intent-codec.js";

const verifiedContextBrand: unique symbol = Symbol("verified-project-sync-context");
export type VerifiedProjectSyncExecutionContext = Readonly<{
  readonly [verifiedContextBrand]: true;
  previewId: NativeLifecyclePreviewId;
  root: TrustedProjectRoot;
  observation: VerifiedProjectIntentObservation;
  planning: ProjectSyncPlannerContext;
}>;

export type ProjectSyncPreviewResult =
  | Readonly<{ kind: "ready"; plan: ProjectSyncPlan; context: VerifiedProjectSyncExecutionContext }>
  | Readonly<{ kind: "current-state"; digest: ContentDigest }>
  | Readonly<{ kind: "stale"; reason: "project" | "file" }>
  | Readonly<{ kind: "rejected"; code: "PROJECT_UNTRUSTED" | "PROJECT_INTENT_MISSING" | "STATE_CORRUPT" | "FILE_UNSAFE" | "FILE_INVALID" | "ADAPTER_FAILED" }>;

export interface ProjectSyncService {
  preview(request: Readonly<{ mode: ProjectSyncMode; projectKey: ProjectKey; previewId: NativeLifecyclePreviewId }>, signal: AbortSignal): Promise<ProjectSyncPreviewResult>;
  apply(request: Readonly<{ context: VerifiedProjectSyncExecutionContext; resolutions: readonly ProjectSyncConflictResolution[] }>, progress: NativeLifecycleProgressSink | undefined, signal: AbortSignal): Promise<NativeLifecycleOperationResult>;
}

export type ProjectSyncServiceDependencies = Readonly<{
  state: LifecycleStateStore;
  mutations: GenerationMutationCoordinator;
  projectRoots: ProjectRootAuthorityPort;
  projectTrust: ProjectTrustPort;
  files: ProjectIntentFilePort;
  writeIds: ProjectIntentWriteIdPort;
  lifecycle: PluginLifecycleService;
  registrations: Pick<MarketplaceRegistrationService, "remove">;
  configurationPathContext(root: TrustedProjectRoot, snapshot: ProjectGenerationSnapshot): ConfigurationPathContext;
  readiness(snapshot: ProjectGenerationSnapshot, signal: AbortSignal): Promise<ProjectSyncReadinessSnapshot>;
  sha256: Sha256;
}>;

function same(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }

/** Update scheduling and notification evidence shares the project document but
 * is not portable intent. Rebase only those unrelated writes; installed plugin
 * or registered source changes still invalidate the sync plan. */
function projectSyncAuthority(snapshot: ProjectGenerationSnapshot): unknown {
  return {
    projectKey: snapshot.project.projectKey,
    identity: snapshot.project.identity,
    declarationDigest: snapshot.project.declarationDigest,
    registrations: snapshot.project.marketplaceUpdates.map((record) => ({
      marketplace: record.marketplace,
      source: record.source,
    })),
    plugins: snapshot.project.plugins,
  };
}

function effectState(completed: readonly string[], file: "unchanged" | "written" | "unknown") { return completed.length === 0 && file === "unchanged" ? "unchanged" as const : "partially-changed" as const; }
function repreviewAction(sha256: Sha256) {
  const evidence = { kind: "repreview-sync", action: "retry-read" } as const;
  return ProjectSyncRequiredActionSchema.parse({
    ...evidence,
    id: deriveProjectSyncActionId(evidence, sha256),
  });
}

export function createProjectSyncService(dependencies: ProjectSyncServiceDependencies): ProjectSyncService {
  if (dependencies === null || typeof dependencies !== "object" || typeof dependencies.sha256 !== "function") throw new TypeError("project sync dependencies are required");
  const issued = new WeakSet<object>();

  async function projectAuthority(projectKey: ProjectKey, signal: AbortSignal): Promise<Readonly<{ root: TrustedProjectRoot; snapshot: ProjectGenerationSnapshot; projectEpoch: ContentDigest }> | undefined> {
    const root = await dependencies.projectRoots.acquire(signal);
    const scope = dependencies.projectRoots.revalidate !== undefined
      ? await dependencies.projectRoots.revalidate(root, { kind: "project", identity: root.identity, projectKey: root.projectKey }, signal)
      : dependencies.projectRoots.verify(root, { kind: "project", identity: root.identity, projectKey: root.projectKey });
    if (scope.kind !== "project" || scope.projectKey !== projectKey || (await dependencies.projectTrust.assess(projectKey, signal)).kind !== "trusted") return undefined;
    const loaded = await dependencies.state.read(scope, signal);
    if (!loaded.ok || !("project" in loaded.snapshot)) return undefined;
    const projectEpoch = hashContent(new TextEncoder().encode(`project-sync-project-epoch-v1\0${canonicalJson({ projectKey: root.projectKey, identity: root.identity, trust: "trusted" })}`), dependencies.sha256);
    return { root, snapshot: loaded.snapshot, projectEpoch };
  }

  async function preview(request: Parameters<ProjectSyncService["preview"]>[0], signal: AbortSignal): Promise<ProjectSyncPreviewResult> {
    signal.throwIfAborted();
    let authority;
    try { authority = await projectAuthority(request.projectKey, signal); }
    catch (error) { if (signal.aborted) throw signal.reason ?? error; return { kind: "rejected", code: "ADAPTER_FAILED" }; }
    if (authority === undefined) return { kind: "rejected", code: "PROJECT_UNTRUSTED" };
    const read = await dependencies.files.read(authority.root, signal);
    if (read.kind === "unavailable") return { kind: "rejected", code: read.code === "FILE_UNSAFE" ? "FILE_UNSAFE" : read.code === "FILE_INVALID" || read.code === "FILE_INVALID_UTF8" || read.code === "FILE_TOO_LARGE" ? "FILE_INVALID" : "ADAPTER_FAILED" };
    let readiness: ProjectSyncReadinessSnapshot;
    try { readiness = await dependencies.readiness(authority.snapshot, signal); }
    catch (error) { if (signal.aborted) throw signal.reason ?? error; return { kind: "rejected", code: "ADAPTER_FAILED" }; }
    const file = read.kind === "missing"
      ? { status: "missing" as const, observationId: read.observation.publicId }
      : { status: "present" as const, observationId: read.observation.publicId, declaration: read.declaration, digest: read.digest };
    let planning;
    try { planning = createProjectSyncPlanningContext({ mode: request.mode, projectEpoch: authority.projectEpoch, snapshot: authority.snapshot, file, readiness, sha256: dependencies.sha256 }); }
    catch (error) {
      if (error instanceof ProjectSyncPlanningError && error.code === "PROJECT_INTENT_MISSING") return { kind: "rejected", code: "PROJECT_INTENT_MISSING" };
      return { kind: "rejected", code: "ADAPTER_FAILED" };
    }
    if (planning.desired !== undefined && planning.plan.actions.length === 0 && planning.plan.requiredActions.length === 0 && planning.plan.conflicts.length === 0 && authority.snapshot.project.declarationDigest === planning.plan.desiredDigest) {
      return { kind: "current-state", digest: planning.plan.desiredDigest! };
    }
    const context = Object.freeze({ [verifiedContextBrand]: true as const, previewId: request.previewId, root: authority.root, observation: read.observation, planning }) as VerifiedProjectSyncExecutionContext;
    issued.add(context);
    return { kind: "ready", plan: planning.plan, context };
  }

  function result(context: VerifiedProjectSyncExecutionContext, progress: ReturnType<typeof createNativeLifecycleProgressRecorder>, input: Readonly<Record<string, unknown> & { kind: string }>, completed: readonly any[], pending: readonly any[], projectFile: "unchanged" | "written" | "unknown", generation?: number): NativeLifecycleOperationResult {
    return NativeLifecycleOperationResultSchema.parse({ ...input, operation: "project-sync", previewId: context.previewId, progress: progress.events(), diagnostics: [], effects: { state: input.kind === "succeeded" ? (completed.length === 0 && projectFile === "unchanged" ? "unchanged" : "changed") : effectState(completed, projectFile), projectFile, completedActionIds: completed, pendingActionIds: pending, ...(generation === undefined ? {} : { generation }) } });
  }

  async function apply(request: Parameters<ProjectSyncService["apply"]>[0], sink: NativeLifecycleProgressSink | undefined, signal: AbortSignal): Promise<NativeLifecycleOperationResult> {
    const context = request.context;
    const progress = createNativeLifecycleProgressRecorder("project-sync", sink);
    if (!issued.has(context as object)) return result(context, progress, { kind: "stale", reason: "session" }, [], context.planning.plan.actions.map((action) => action.id), "unchanged");
    issued.delete(context as object);
    let planning = context.planning;
    if (planning.plan.conflicts.length > 0) {
      try { planning = resolveProjectSyncConflicts(planning, request.resolutions, dependencies.sha256); }
      catch { return result(context, progress, { kind: "conflict", reason: "unresolved-merge" }, [], [], "unchanged"); }
    } else if (request.resolutions.length > 0) return result(context, progress, { kind: "conflict", reason: "unresolved-merge" }, [], [], "unchanged");
    if (planning.plan.requiredActions.length > 0) return result(context, progress, { kind: "needs-action", actions: planning.plan.requiredActions }, [], [], "unchanged");
    if (planning.desired === undefined) return result(context, progress, { kind: "conflict", reason: "unresolved-merge" }, [], [], "unchanged");

    await progress.emit({ phase: "authority-revalidation", state: "started" });
    let authority;
    try { authority = await projectAuthority(planning.snapshot.scope.projectKey, signal); }
    catch (error) { if (signal.aborted) return result(context, progress, { kind: "cancelled", phase: "authority-revalidation" }, [], planning.plan.actions.map((action) => action.id), "unchanged"); throw error; }
    if (authority === undefined || authority.projectEpoch !== planning.plan.projectEpoch ||
        !same(projectSyncAuthority(authority.snapshot), projectSyncAuthority(planning.snapshot))) {
      return result(context, progress, { kind: "conflict", reason: "state-generation-changed" }, [], planning.plan.actions.map((action) => action.id), "unchanged");
    }
    const fileCurrent = await dependencies.files.read(context.root, signal);
    if (fileCurrent.kind === "unavailable" || fileCurrent.observation.publicId !== context.observation.publicId) return result(context, progress, { kind: "conflict", reason: "file-changed" }, [], planning.plan.actions.map((action) => action.id), "unchanged");
    let currentReadiness: ProjectSyncReadinessSnapshot;
    try { currentReadiness = await dependencies.readiness(authority.snapshot, signal); }
    catch (error) { if (signal.aborted) return result(context, progress, { kind: "cancelled", phase: "authority-revalidation" }, [], planning.plan.actions.map((action) => action.id), "unchanged"); throw error; }
    if (deriveProjectSyncReadinessDigest(currentReadiness, dependencies.sha256) !== planning.plan.readinessDigest) {
      return result(context, progress, { kind: "stale", reason: "capability" }, [], planning.plan.actions.map((action) => action.id), "unchanged");
    }
    await progress.emit({ phase: "authority-revalidation", state: "completed" });

    const completed: any[] = [];
    let projectFile: "unchanged" | "written" | "unknown" = "unchanged";
    let latest = authority.snapshot;
    const actions = planning.plan.actions;
    for (const [index, action] of actions.entries()) {
      if (signal.aborted) return result(context, progress, { kind: "cancelled", phase: "project-reconciliation" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, latest.generation);
      try {
        const currentAuthority = await projectAuthority(planning.snapshot.scope.projectKey, signal);
        if (currentAuthority === undefined) return result(context, progress, { kind: "stale", reason: "project" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, latest.generation);
        latest = currentAuthority.snapshot;
        if (action.kind === "write-intent") {
          await progress.emit({ phase: "project-file-write", state: "started", actionId: action.id });
          const writeId = await dependencies.writeIds.create(signal);
          const replaced = await dependencies.files.replace({ root: context.root, expected: context.observation, declaration: planning.desired, writeId }, signal);
          if (replaced.kind === "stale") return result(context, progress, { kind: "conflict", reason: "file-changed" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, latest.generation);
          if (replaced.kind === "unavailable") return result(context, progress, { kind: "rejected", code: replaced.code }, completed, actions.slice(index).map((entry) => entry.id), projectFile, latest.generation);
          if (replaced.kind === "ambiguous") return result(context, progress, { kind: "recovery-required", code: "PROJECT_INTENT_WRITE_FAILED", action: "run-recovery" }, completed, actions.slice(index).map((entry) => entry.id), "unknown", latest.generation);
          projectFile = replaced.kind === "written" ? "written" : projectFile;
          completed.push(action.id);
          await progress.emit({ phase: "project-file-write", state: "completed", actionId: action.id });
          continue;
        }
        if (action.kind === "record-intent-digest") {
          await progress.emit({ phase: "finalization", state: "started", actionId: action.id });
          const finalFile = await dependencies.files.read(context.root, signal);
          if (finalFile.kind !== "found" || finalFile.digest !== planning.plan.desiredDigest) return result(context, progress, { kind: "conflict", reason: "file-changed" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, latest.generation);
          const finalAuthority = await projectAuthority(planning.snapshot.scope.projectKey, signal);
          if (finalAuthority === undefined) return result(context, progress, { kind: "stale", reason: "project" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, latest.generation);
          latest = finalAuthority.snapshot;
          const readiness = await dependencies.readiness(latest, signal);
          const finalReadinessDigest = deriveProjectSyncReadinessDigest(readiness, dependencies.sha256);
          if (finalReadinessDigest !== planning.plan.convergenceReadinessDigest) {
            const fresh = createProjectSyncPlanningContext({
              mode: planning.plan.mode,
              projectEpoch: finalAuthority.projectEpoch,
              snapshot: latest,
              file: { status: "present", observationId: finalFile.observation.publicId, declaration: finalFile.declaration, digest: finalFile.digest },
              readiness,
              sha256: dependencies.sha256,
            });
            if (fresh.plan.requiredActions.length > 0) {
              return result(context, progress, { kind: "needs-action", actions: fresh.plan.requiredActions }, completed, actions.slice(index).map((entry) => entry.id), projectFile, latest.generation);
            }
            return result(context, progress, { kind: "stale", reason: "capability" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, latest.generation);
          }
          const machine = projectProjectSyncMachineState({ snapshot: latest, readiness: readiness.plugins, existingFile: planning.desired, sha256: dependencies.sha256 });
          if (encodeProjectIntentDeclaration(machine.declaration, dependencies.sha256).digest !== planning.plan.desiredDigest) return result(context, progress, { kind: "conflict", reason: "concurrent-mutation" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, latest.generation);
          // Trust/configuration/capability authority is independent of project
          // generation. Read it again at the declaration-CAS boundary.
          const commitReadiness = await dependencies.readiness(latest, signal);
          if (deriveProjectSyncReadinessDigest(commitReadiness, dependencies.sha256) !== finalReadinessDigest) {
            const fresh = createProjectSyncPlanningContext({
              mode: planning.plan.mode,
              projectEpoch: finalAuthority.projectEpoch,
              snapshot: latest,
              file: { status: "present", observationId: finalFile.observation.publicId, declaration: finalFile.declaration, digest: finalFile.digest },
              readiness: commitReadiness,
              sha256: dependencies.sha256,
            });
            if (fresh.plan.requiredActions.length > 0) return result(context, progress, { kind: "needs-action", actions: fresh.plan.requiredActions }, completed, actions.slice(index).map((entry) => entry.id), projectFile, latest.generation);
            return result(context, progress, { kind: "stale", reason: "capability" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, latest.generation);
          }
          const committed = await commitProjectSyncDeclarationDigest({ snapshot: latest, digest: planning.plan.desiredDigest!, mutations: dependencies.mutations, sha256: dependencies.sha256 }, signal);
          if (committed.kind === "stale") return result(context, progress, { kind: "conflict", reason: "state-generation-changed" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, committed.actual);
          if (committed.kind === "recovery-required") return result(context, progress, { kind: "recovery-required", code: "ADAPTER_FAILED", ...(committed.committed === undefined ? {} : { committed: committed.committed }), action: "run-recovery" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, committed.committed);
          latest = committed.snapshot;
          completed.push(action.id);
          await progress.emit({ phase: "finalization", state: "completed", actionId: action.id });
          continue;
        }
        await progress.emit({ phase: "project-reconciliation", state: "started", actionId: action.id, ...(action.plugin === undefined ? {} : { plugin: action.plugin }) });
        let lifecycleChanged = false;
        if (action.kind === "remove-marketplace") {
          const removed = await dependencies.registrations.remove({ scope: "project", registrationId: action.registrationId! }, signal);
          if (removed.kind !== "removed" && removed.kind !== "unchanged") return result(context, progress, { kind: "conflict", reason: "concurrent-mutation" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, latest.generation);
        } else {
          const record = latest.project.plugins.find((entry) => entry.plugin === action.plugin);
          if (record === undefined) {
            if (action.kind === "uninstall-plugin") { completed.push(action.id); continue; }
            return result(context, progress, { kind: "conflict", reason: "target-changed" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, latest.generation);
          }
          if (record.pendingTransition !== undefined) return result(context, progress, { kind: "conflict", reason: "pending-transition" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, latest.generation);
          const expectation = LifecycleTargetExpectationSchema.parse({ generation: latest.generation, plugin: record.plugin, selectedRevision: record.selectedRevision, activation: record.activation, targetDigest: deriveLifecycleTargetDigest(toScopeReference(latest.scope), record, dependencies.sha256), pendingTransition: "none" });
          const lifecycle = action.kind === "enable-plugin"
            ? await dependencies.lifecycle.enable({ scope: latest.scope, plugin: record.plugin, configurationPathContext: dependencies.configurationPathContext(context.root, latest), expectedTarget: expectation, origin: "sync" }, signal)
            : action.kind === "disable-plugin"
              ? await dependencies.lifecycle.disable({ scope: latest.scope, plugin: record.plugin, expectedTarget: expectation, origin: "sync" }, signal)
              : await dependencies.lifecycle.uninstall({ scope: latest.scope, plugin: record.plugin, expectedTarget: expectation, origin: "sync", retainedData: "keep" }, signal);
          if (lifecycle.kind === "changed" || lifecycle.kind === "unchanged") {
            latest = lifecycle.snapshot as ProjectGenerationSnapshot;
            lifecycleChanged = lifecycle.kind === "changed";
          } else if (lifecycle.kind === "recovery-required") return result(context, progress, { kind: "recovery-required", code: "PENDING_TRANSITION", transition: lifecycle.transition, ...(lifecycle.committed === undefined ? {} : { committed: lifecycle.committed }), action: "run-recovery" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, lifecycle.committed);
          else if (lifecycle.kind === "stale") return result(context, progress, { kind: "conflict", reason: "target-changed" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, lifecycle.actual);
          else return result(context, progress, { kind: "failed", code: "ADAPTER_FAILED" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, latest.generation);
        }
        completed.push(action.id);
        await progress.emit({ phase: "project-reconciliation", state: "completed", actionId: action.id, ...(action.plugin === undefined ? {} : { plugin: action.plugin }) });
        if (lifecycleChanged && index + 1 < actions.length) {
          return result(
            context,
            progress,
            { kind: "needs-action", actions: [repreviewAction(dependencies.sha256)] },
            completed,
            actions.slice(index + 1).map((candidate) => candidate.id),
            projectFile,
            latest.generation,
          );
        }
      } catch (error) {
        if (signal.aborted) return result(context, progress, { kind: "cancelled", phase: "project-reconciliation" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, latest.generation);
        return result(context, progress, { kind: "failed", code: "ADAPTER_FAILED" }, completed, actions.slice(index).map((entry) => entry.id), projectFile, latest.generation);
      }
    }
    return result(context, progress, { kind: "succeeded", syncDigest: planning.plan.desiredDigest }, completed, [], projectFile, latest.generation);
  }

  return Object.freeze({ preview, apply });
}
