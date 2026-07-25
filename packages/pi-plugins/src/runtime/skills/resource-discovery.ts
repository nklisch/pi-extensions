import {
  createContentIndex,
  type ContentIndex,
} from "../../application/content-index.js";
import type {
  SkillResourcePathFailureCode,
  SkillResourcePathPort,
  VerifiedSkillResourcePath,
} from "../../application/ports/skill-resource-path.js";
import {
  ComponentIdSchema,
  SkillComponentSchema,
  type ComponentId,
  type SkillComponent,
} from "../../domain/components.js";
import {
  normalizeContentPath,
  type ContentManifestEntry,
} from "../../domain/content-manifest.js";
import type { Sha256 } from "../../domain/source.js";
import {
  composeSkillHookContributionObservation,
  digestSkillResourceContribution,
  SkillResourceContributionObservationSchema,
  type SkillResourceContributionObservation,
} from "./contribution-observation.js";
import {
  type SkillHookSnapshotObservationResult,
  type SkillHookSnapshotParticipant,
} from "../skill-hook/lifecycle-participant.js";
import {
  hasSameCurrentProject,
  runtimeTargetKey,
  type SkillHookRuntimeCatalog,
  type SkillHookRuntimeSetRequest,
  type SkillHookReconcileResult,
} from "../skill-hook/runtime-catalog.js";
import type { SkillHookRuntimeSnapshot } from "../skill-hook/runtime-snapshot.js";
import type { ProjectionExpectation } from "../../application/ports/runtime-projection.js";

export type SkillResourceDiscoveryRequest = Readonly<{
  reason: "startup" | "reload";
  projectTrusted: boolean;
}>;

export type SkillResourceTargetFailure = Readonly<{
  scope: SkillHookRuntimeSnapshot["scope"];
  plugin: SkillHookRuntimeSnapshot["plugin"];
  code: SkillResourcePathFailureCode | "PROJECT_IDENTITY_MISMATCH" | "PROJECT_UNTRUSTED";
}>;

export type SkillResourceDiscoveryResult =
  | Readonly<{ kind: "ready"; skillPaths: readonly string[]; failedTargets: readonly SkillResourceTargetFailure[] }>
  | Readonly<{ kind: "failed"; code: "CATALOG_UNINITIALIZED" | "CURRENT_PROJECT_MISMATCH" | "ADAPTER_FAILED" }>
  | Readonly<{ kind: "cancelled" }>;

export interface SkillResourceDiscoveryPort {
  discover(request: SkillResourceDiscoveryRequest, signal: AbortSignal): Promise<SkillResourceDiscoveryResult>;
}

export type SkillResourceContributionObservationResult =
  | Readonly<{ kind: "ready"; observation: SkillResourceContributionObservation }>
  | Readonly<{ kind: "failed"; code: "CATALOG_UNINITIALIZED" | "RESOURCE_UNAVAILABLE" | "OBSERVATION_MISMATCH" | "PROJECT_UNTRUSTED" | "ADAPTER_FAILED" }>
  | Readonly<{ kind: "cancelled" }>;

export type SkillHookContributionObservationResult =
  | Readonly<{ kind: "ready"; observation: import("../../application/ports/lifecycle-reload.js").SkillHookContributionObservation }>
  | Readonly<{ kind: "failed"; code: "CATALOG_UNINITIALIZED" | "RESOURCE_UNAVAILABLE" | "OBSERVATION_MISMATCH" | "PROJECT_UNTRUSTED" | "ADAPTER_FAILED" }>
  | Readonly<{ kind: "cancelled" }>;

type TargetEvidence = Readonly<{
  scope: SkillHookRuntimeSnapshot["scope"];
  plugin: SkillHookRuntimeSnapshot["plugin"];
  observation: SkillResourceContributionObservation;
}>;

type DiscoveryRegistry = Readonly<{
  initialized: boolean;
  catalogSnapshot?: readonly SkillHookRuntimeSnapshot[];
  targets: ReadonlyMap<string, TargetEvidence>;
  failures: ReadonlyMap<string, SkillResourceTargetFailure>;
}>;

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

function compareScope(left: SkillHookRuntimeSnapshot["scope"], right: SkillHookRuntimeSnapshot["scope"]): number {
  if (left.kind !== right.kind) return left.kind === "user" ? -1 : 1;
  if (left.kind === "project" && right.kind === "project") return compareCodePoint(left.projectKey, right.projectKey);
  return 0;
}

function compareSnapshots(left: SkillHookRuntimeSnapshot, right: SkillHookRuntimeSnapshot): number {
  return compareScope(left.scope, right.scope) || compareCodePoint(left.plugin, right.plugin);
}

function compareSkills(left: SkillComponent, right: SkillComponent): number {
  return compareCodePoint(left.id, right.id) || compareCodePoint(left.root.value, right.root.value);
}

function mapTargetFailure(scope: SkillHookRuntimeSnapshot["scope"], plugin: SkillHookRuntimeSnapshot["plugin"], code: SkillResourceTargetFailure["code"]): SkillResourceTargetFailure {
  return Object.freeze({ scope, plugin, code });
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error !== null && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");
}

function skillFilePath(component: SkillComponent): string {
  if (component.root.value === ".") return "SKILL.md";
  const root = normalizeContentPath(component.root.value);
  return `${root}/SKILL.md`;
}

function manifestEntry(index: ContentIndex, component: SkillComponent): Extract<ContentManifestEntry, { kind: "file" }> {
  let path: string;
  try {
    path = skillFilePath(component);
  } catch (error) {
    throw Object.assign(new Error("skill root is unsafe"), { code: "ROOT_ESCAPE", cause: error });
  }
  const entry = index.get(path);
  if (entry === undefined) throw Object.assign(new Error("skill document is absent from the content manifest"), { code: "ROOT_MISSING" });
  if (entry.kind === "symlink") throw Object.assign(new Error("skill document is a manifest symlink"), { code: "ROOT_ESCAPE" });
  if (entry.kind !== "file") throw Object.assign(new Error("skill document is not a regular manifest file"), { code: "ROOT_MUTATED" });
  return entry;
}

function pathFailure(error: unknown): SkillResourcePathFailureCode {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ROOT_MISSING" || code === "ROOT_ESCAPE" || code === "ROOT_MUTATED" || code === "ROOT_UNREADABLE" || code === "ADAPTER_FAILED") return code;
  }
  return "ADAPTER_FAILED";
}

function makeResourceObservation(snapshot: SkillHookRuntimeSnapshot, ids: readonly ComponentId[], digest: ReturnType<typeof digestSkillResourceContribution>): SkillResourceContributionObservation {
  return SkillResourceContributionObservationSchema.parse({
    kind: "active",
    participant: "skill-resources",
    scope: snapshot.scope,
    plugin: snapshot.plugin,
    revision: snapshot.revision,
    projectionDigest: snapshot.projectionDigest,
    currentProject: snapshot.currentProject,
    contributionDigest: digest,
    skillComponentIds: ids,
  });
}

export function createSkillResourceDiscoveryRuntime(dependencies: Readonly<{
  snapshots: SkillHookSnapshotParticipant;
  catalog: SkillHookRuntimeCatalog;
  paths: SkillResourcePathPort;
  sha256: Sha256;
}>): Readonly<{
  participant: Readonly<{
    reconcile(request: SkillHookRuntimeSetRequest, signal: AbortSignal): Promise<SkillHookReconcileResult>;
    observe(expectation: ProjectionExpectation, signal: AbortSignal): Promise<SkillHookContributionObservationResult>;
  }>;
  resources: SkillResourceDiscoveryPort;
}> {
  if (dependencies === null || typeof dependencies !== "object") throw new TypeError("skill resource discovery dependencies are required");
  let registry: DiscoveryRegistry = Object.freeze({ initialized: false, targets: new Map(), failures: new Map() });

  function invalidate(): void {
    registry = Object.freeze({ initialized: false, targets: new Map(), failures: new Map() });
  }

  async function discover(request: SkillResourceDiscoveryRequest, signal: AbortSignal): Promise<SkillResourceDiscoveryResult> {
    try {
      if (signal.aborted) return { kind: "cancelled" };
      const snapshots = dependencies.catalog.list();
      const currentProject = dependencies.catalog.currentProject();
      if (currentProject === undefined) return { kind: "failed", code: "CATALOG_UNINITIALIZED" };
      for (const snapshot of snapshots) {
        if (!hasSameCurrentProject(snapshot.currentProject, currentProject)) return { kind: "failed", code: "CURRENT_PROJECT_MISMATCH" };
      }
      const ordered = [...snapshots].sort(compareSnapshots);
      const targets = new Map<string, TargetEvidence>();
      const failures = new Map<string, SkillResourceTargetFailure>();
      const verified: Array<Readonly<{ snapshot: SkillHookRuntimeSnapshot; paths: readonly VerifiedSkillResourcePath[] }>> = [];
      for (const snapshot of ordered) {
        if (signal.aborted) return { kind: "cancelled" };
        const key = runtimeTargetKey(snapshot.scope, snapshot.plugin);
        if (snapshot.scope.kind === "project") {
          if (snapshot.scope.projectKey !== currentProject.projectKey) {
            failures.set(key, mapTargetFailure(snapshot.scope, snapshot.plugin, "PROJECT_IDENTITY_MISMATCH"));
            continue;
          }
          if (!request.projectTrusted || currentProject.trust.kind !== "trusted") {
            failures.set(key, mapTargetFailure(snapshot.scope, snapshot.plugin, "PROJECT_UNTRUSTED"));
            continue;
          }
        }
        const index = createContentIndex(snapshot.content.manifest);
        const skillPaths: VerifiedSkillResourcePath[] = [];
        let targetFailure: SkillResourceTargetFailure["code"] | undefined;
        const skills = [...snapshot.skills].map((value) => SkillComponentSchema.parse(value)).sort(compareSkills);
        for (const skill of skills) {
          if (signal.aborted) return { kind: "cancelled" };
          try {
            const entry = manifestEntry(index, skill);
            const result = await dependencies.paths.verify({ root: snapshot.content.root, entry }, signal);
            if (result.kind === "cancelled") return { kind: "cancelled" };
            if (result.kind !== "ready") {
              targetFailure = result.code;
              break;
            }
            skillPaths.push(result.value);
          } catch (error) {
            if (isAbort(error, signal)) return { kind: "cancelled" };
            targetFailure = pathFailure(error);
            break;
          }
        }
        if (targetFailure !== undefined) {
          failures.set(key, mapTargetFailure(snapshot.scope, snapshot.plugin, targetFailure));
        } else {
          verified.push({ snapshot, paths: Object.freeze(skillPaths) });
        }
      }
      if (signal.aborted) return { kind: "cancelled" };

      const emitted: string[] = [];
      const emittedCanonical = new Set<string>();
      for (const item of verified) {
        const skills = [...item.snapshot.skills].sort(compareSkills);
        const ids = skills.map((skill) => ComponentIdSchema.parse(skill.id));
        const logicalRoots = skills.map((skill) => ({ id: ComponentIdSchema.parse(skill.id), root: skill.root.value }));
        const digest = digestSkillResourceContribution({
          scope: item.snapshot.scope,
          plugin: item.snapshot.plugin,
          revision: item.snapshot.revision,
          projectionDigest: item.snapshot.projectionDigest,
          sourceContributionDigest: item.snapshot.contributionDigest,
          skills: logicalRoots,
        }, dependencies.sha256);
        const observation = makeResourceObservation(item.snapshot, ids, digest);
        for (const path of item.paths) {
          if (!emittedCanonical.has(path.canonicalPath)) {
            emittedCanonical.add(path.canonicalPath);
            emitted.push(path.path);
          }
        }
        targets.set(runtimeTargetKey(item.snapshot.scope, item.snapshot.plugin), Object.freeze({
          scope: item.snapshot.scope,
          plugin: item.snapshot.plugin,
          observation,
        }));
      }
      // Registry replacement is one synchronous assignment after every target
      // has been verified. Cancellation cannot expose a partial path set.
      if (signal.aborted) return { kind: "cancelled" };
      registry = Object.freeze({
        initialized: true,
        catalogSnapshot: snapshots,
        targets,
        failures,
      });
      return Object.freeze({ kind: "ready", skillPaths: Object.freeze(emitted), failedTargets: Object.freeze([...failures.values()]) });
    } catch (error) {
      if (isAbort(error, signal)) return { kind: "cancelled" };
      return { kind: "failed", code: "ADAPTER_FAILED" };
    }
  }

  async function observe(expectation: ProjectionExpectation, signal: AbortSignal): Promise<SkillHookContributionObservationResult> {
    try {
      if (signal.aborted) return { kind: "cancelled" };
      const sourceResult: SkillHookSnapshotObservationResult = await dependencies.snapshots.observe(expectation, signal);
      if (sourceResult.kind !== "ready") return sourceResult as SkillHookContributionObservationResult;
      if (!registry.initialized || registry.catalogSnapshot !== dependencies.catalog.list()) return { kind: "failed", code: "CATALOG_UNINITIALIZED" };
      const source = sourceResult.observation;
      const key = runtimeTargetKey(source.scope, source.plugin);
      if (registry.failures.has(key)) return { kind: "failed", code: "RESOURCE_UNAVAILABLE" };
      const target = registry.targets.get(key);
      if (source.kind === "active") {
        if (target === undefined || target.observation.kind !== "active") return { kind: "failed", code: "OBSERVATION_MISMATCH" };
        return {
          kind: "ready",
          observation: composeSkillHookContributionObservation({
            expectation,
            snapshot: source,
            resources: target.observation,
            sha256: dependencies.sha256,
          }),
        };
      }
      if (target !== undefined) return { kind: "failed", code: "OBSERVATION_MISMATCH" };
      const inactive = SkillResourceContributionObservationSchema.parse({
        kind: "inactive",
        participant: "skill-resources",
        scope: source.scope,
        plugin: source.plugin,
        projectionDigest: source.projectionDigest,
        currentProject: source.currentProject,
        contributionDigest: digestSkillResourceContribution({
          scope: source.scope,
          plugin: source.plugin,
          projectionDigest: source.projectionDigest,
          sourceContributionDigest: source.contributionDigest,
          skills: [],
        }, dependencies.sha256),
        skillComponentIds: [],
      });
      return {
        kind: "ready",
        observation: composeSkillHookContributionObservation({ expectation, snapshot: source, resources: inactive, sha256: dependencies.sha256 }),
      };
    } catch (error) {
      if (isAbort(error, signal)) return { kind: "cancelled" };
      return { kind: "failed", code: "ADAPTER_FAILED" };
    }
  }

  async function reconcile(request: SkillHookRuntimeSetRequest, signal: AbortSignal): Promise<SkillHookReconcileResult> {
    const result = await dependencies.snapshots.reconcile(request, signal);
    if (result.kind === "applied") invalidate();
    return result;
  }

  const participant = Object.freeze({ reconcile, observe });
  return Object.freeze({ participant, resources: Object.freeze({ discover }) });
}