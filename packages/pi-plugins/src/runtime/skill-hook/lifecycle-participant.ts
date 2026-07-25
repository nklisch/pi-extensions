import {
  ComponentIdSchema,
  type ComponentId,
} from "../../domain/components.js";
import {
  ProjectionExpectationSchema,
  type ProjectionExpectation,
} from "../../application/ports/runtime-projection.js";
import type { Sha256 } from "../../domain/source.js";
import {
  createSkillHookRuntimeCatalog,
  hasSameCurrentProject,
  runtimeTargetKey,
  type SkillHookRuntimeCatalog,
  type SkillHookRuntimeSetRequest,
  type SkillHookReconcileResult,
} from "./runtime-catalog.js";
import {
  CurrentProjectRuntimeContextSchema,
  digestSkillHookContribution,
  type CurrentProjectRuntimeContext,
  type RuntimeProjectionSelection,
  type SkillHookRuntimeSnapshot,
  type SkillHookSnapshotResult,
} from "./runtime-snapshot.js";
import {
  SkillHookSnapshotObservationSchema,
  type SkillHookSnapshotObservation,
} from "../skills/contribution-observation.js";

export type SkillHookSnapshotObservationResult =
  | Readonly<{ kind: "ready"; observation: SkillHookSnapshotObservation }>
  | Readonly<{ kind: "failed"; code: "CATALOG_UNINITIALIZED" | "OBSERVATION_MISMATCH" | "PROJECT_UNTRUSTED" | "ADAPTER_FAILED" }>
  | Readonly<{ kind: "cancelled" }>;

/** The source participant is deliberately not final lifecycle evidence. */
export interface SkillHookSnapshotParticipant {
  reconcile(request: SkillHookRuntimeSetRequest, signal: AbortSignal): Promise<SkillHookReconcileResult>;
  observe(expectation: ProjectionExpectation, signal: AbortSignal): Promise<SkillHookSnapshotObservationResult>;
}

export type SkillHookLifecycleParticipant = SkillHookSnapshotParticipant;

function abortRequested(signal: AbortSignal): boolean {
  return signal.aborted;
}

function compareCodePoint(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]!.codePointAt(0)!;
    const rightPoint = rightPoints[index]!.codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return leftPoints.length - rightPoints.length;
}

function snapshotOrder(snapshot: SkillHookRuntimeSnapshot): string {
  return runtimeTargetKey(snapshot.scope, snapshot.plugin);
}

function componentIds(values: readonly { id: ComponentId }[]): readonly ComponentId[] {
  return Object.freeze(values.map((value) => ComponentIdSchema.parse(value.id)));
}

function snapshotCurrentProject(snapshot: SkillHookRuntimeSnapshot): CurrentProjectRuntimeContext {
  return CurrentProjectRuntimeContextSchema.parse(snapshot.currentProject);
}

function failure(code: "CATALOG_UNINITIALIZED" | "OBSERVATION_MISMATCH" | "PROJECT_UNTRUSTED" | "ADAPTER_FAILED"): SkillHookSnapshotObservationResult {
  return { kind: "failed", code };
}

function isProjectEvidenceUsable(snapshot: SkillHookRuntimeSnapshot, currentProject: CurrentProjectRuntimeContext): boolean {
  return snapshot.scope.kind !== "project" ||
    (snapshot.scope.projectKey === currentProject.projectKey && currentProject.trust.kind === "trusted");
}

function sameExpectation(snapshot: SkillHookRuntimeSnapshot, expectation: ProjectionExpectation): boolean {
  if (expectation.kind === "active") {
    return snapshot.scope.kind === expectation.projection.scope.kind &&
      (snapshot.scope.kind === "user" || expectation.projection.scope.kind === "user" || snapshot.scope.projectKey === expectation.projection.scope.projectKey) &&
      snapshot.plugin === expectation.projection.plugin &&
      snapshot.revision === expectation.projection.revision &&
      snapshot.projectionDigest === expectation.projection.digest &&
      snapshot.projectionRef === expectation.projectionRef;
  }
  return snapshot.scope.kind === expectation.scope.kind &&
    (snapshot.scope.kind === "user" || expectation.scope.kind === "user" || snapshot.scope.projectKey === expectation.scope.projectKey) &&
    snapshot.plugin === expectation.plugin;
}

export function createSkillHookRuntimeParticipant(dependencies: Readonly<{
  loader: Readonly<{ load(selection: RuntimeProjectionSelection, signal: AbortSignal): Promise<SkillHookSnapshotResult> }>;
  sha256: Sha256;
}>): Readonly<{
  participant: SkillHookLifecycleParticipant;
  catalog: SkillHookRuntimeCatalog;
}> {
  if (dependencies === null || typeof dependencies !== "object") throw new TypeError("skill/hook participant dependencies are required");
  const owned = createSkillHookRuntimeCatalog();

  async function reconcile(request: SkillHookRuntimeSetRequest, signal: AbortSignal): Promise<SkillHookReconcileResult> {
    try {
      if (abortRequested(signal)) return { kind: "cancelled" };
      const currentProject = CurrentProjectRuntimeContextSchema.parse(request.currentProject);
      const seen = new Set<string>();
      for (const selection of request.active) {
        const projection = selection.prepared.projection;
        const key = runtimeTargetKey(projection.scope, projection.plugin);
        if (seen.has(key)) return { kind: "failed", code: "TARGET_COLLISION" };
        seen.add(key);
      }
      const loaded: SkillHookRuntimeSnapshot[] = [];
      for (const selection of request.active) {
        if (abortRequested(signal)) return { kind: "cancelled" };
        const result = await dependencies.loader.load(selection, signal);
        if (result.kind === "cancelled") return { kind: "cancelled" };
        if (result.kind !== "ready") return { kind: "failed", code: "SNAPSHOT_FAILED" };
        const expected = selection.prepared.projection;
        if (result.snapshot.scope.kind !== expected.scope.kind ||
            (result.snapshot.scope.kind === "project" && expected.scope.kind === "project" && result.snapshot.scope.projectKey !== expected.scope.projectKey) ||
            result.snapshot.plugin !== expected.plugin ||
            result.snapshot.revision !== expected.revision ||
            result.snapshot.projectionDigest !== expected.digest ||
            result.snapshot.projectionRef !== selection.prepared.expectation.projectionRef ||
            !hasSameCurrentProject(result.snapshot.currentProject, currentProject)) {
          return { kind: "failed", code: "SNAPSHOT_FAILED" };
        }
        loaded.push(result.snapshot);
      }
      if (abortRequested(signal)) return { kind: "cancelled" };
      for (const snapshot of loaded) {
        if (!isProjectEvidenceUsable(snapshot, currentProject)) return { kind: "failed", code: "SNAPSHOT_FAILED" };
      }
      loaded.sort((left, right) => compareCodePoint(snapshotOrder(left), snapshotOrder(right)));
      // No await occurs after this check. A successful result identifies the
      // exact context and target set installed by the synchronous publication.
      if (abortRequested(signal)) return { kind: "cancelled" };
      owned.publish(loaded, currentProject);
      return { kind: "applied", count: loaded.length };
    } catch (error) {
      if (abortRequested(signal) || (error !== null && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError")) return { kind: "cancelled" };
      return { kind: "failed", code: "ADAPTER_FAILED" };
    }
  }

  async function observe(expectationInput: ProjectionExpectation, signal: AbortSignal): Promise<SkillHookSnapshotObservationResult> {
    try {
      if (abortRequested(signal)) return { kind: "cancelled" };
      const expectation = ProjectionExpectationSchema.parse(expectationInput);
      const state = owned.state();
      const currentProject = state.currentProject;
      if (!state.initialized || currentProject === undefined) return failure("CATALOG_UNINITIALIZED");
      if (expectation.kind === "active") {
        const snapshot = owned.lookup(expectation.projection.scope, expectation.projection.plugin);
        if (snapshot === undefined || !sameExpectation(snapshot, expectation) ||
            !hasSameCurrentProject(snapshotCurrentProject(snapshot), currentProject) ||
            !isProjectEvidenceUsable(snapshot, currentProject)) {
          return failure(snapshot?.scope.kind === "project" && currentProject.trust.kind !== "trusted" ? "PROJECT_UNTRUSTED" : "OBSERVATION_MISMATCH");
        }
        return {
          kind: "ready",
          observation: SkillHookSnapshotObservationSchema.parse({
            kind: "active",
            participant: "skills-hooks-snapshot",
            scope: snapshot.scope,
            plugin: snapshot.plugin,
            revision: snapshot.revision,
            projectionDigest: snapshot.projectionDigest,
            currentProject,
            contributionDigest: snapshot.contributionDigest,
            skillComponentIds: componentIds(snapshot.skills),
            hookComponentIds: componentIds(snapshot.hooks),
          }),
        };
      }
      if (expectation.scope.kind === "project" &&
          (currentProject.projectKey !== expectation.scope.projectKey || currentProject.trust.kind !== "trusted")) {
        return failure(currentProject.trust.kind === "trusted" ? "OBSERVATION_MISMATCH" : "PROJECT_UNTRUSTED");
      }
      const target = owned.lookup(expectation.scope, expectation.plugin);
      if (target !== undefined) return failure("OBSERVATION_MISMATCH");
      const contributionDigest = digestSkillHookContribution({
        scope: expectation.scope,
        plugin: expectation.plugin,
        projectionDigest: expectation.digest,
        skills: [],
        hooks: [],
      }, dependencies.sha256);
      return {
        kind: "ready",
        observation: SkillHookSnapshotObservationSchema.parse({
          kind: "inactive",
          participant: "skills-hooks-snapshot",
          scope: expectation.scope,
          plugin: expectation.plugin,
          projectionDigest: expectation.digest,
          currentProject,
          contributionDigest,
          skillComponentIds: [],
          hookComponentIds: [],
        }),
      };
    } catch (error) {
      if (abortRequested(signal) || (error !== null && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError")) return { kind: "cancelled" };
      if (error instanceof Error && error.name === "ZodError") return failure("OBSERVATION_MISMATCH");
      return failure("ADAPTER_FAILED");
    }
  }

  const participant: SkillHookLifecycleParticipant = Object.freeze({ reconcile, observe });
  return Object.freeze({ participant, catalog: owned.catalog });
}

export type {
  SkillHookRuntimeCatalog,
  SkillHookRuntimeSetRequest,
  SkillHookReconcileResult,
};