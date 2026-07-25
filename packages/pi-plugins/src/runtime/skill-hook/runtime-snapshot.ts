import "zod";
import {
  ContentDigestSchema,
  hashContent,
  type ContentDigest,
} from "../../domain/content-manifest.js";
import {
  HookComponentSchema,
  SkillComponentSchema,
  type HookComponent,
  type SkillComponent,
} from "../../domain/components.js";
import { PluginKeySchema, type PluginKey } from "../../domain/identity.js";
import {
  InstalledRevisionRecordSchema,
  type InstalledRevisionRecord,
} from "../../domain/state/installed-state.js";
import {
  deriveProjectionRootRef,
  PluginConfigurationRefSchema,
  PluginContentRefSchema,
  PluginDataRefSchema,
  ProjectionRootRefSchema,
  type PluginConfigurationRef,
  type PluginContentRef,
  type PluginDataRef,
  type ProjectionRootRef,
} from "../../domain/state/references.js";
import {
  ProjectIdentitySchema,
  ProjectKeySchema,
  ScopeReferenceSchema,
  type ScopeReference,
} from "../../domain/state/scope.js";
import type { Sha256 } from "../../domain/source.js";
import type { PreparedRuntimeProjection } from "../../application/runtime-projection-cache.js";
import type { ContentStorePort, ResolvedContentRoot, WritableDataRoot } from "../../application/ports/content-store.js";
import type { ProjectRootAuthorityPort } from "../../application/ports/project-root-authority.js";
import {
  CurrentProjectRuntimeContextSchema,
  ProjectTrustAssessmentSchema,
  type CurrentProjectRuntimeContext,
  type ProjectTrustAssessment,
  type ProjectTrustPort,
} from "../../application/ports/project-trust.js";

export { CurrentProjectRuntimeContextSchema } from "../../application/ports/project-trust.js";
export type { CurrentProjectRuntimeContext } from "../../application/ports/project-trust.js";

export type RuntimeProjectionSelection = Readonly<{
  prepared: PreparedRuntimeProjection;
  revision: InstalledRevisionRecord;
}>;

export type SkillHookRuntimeSnapshot = Readonly<{
  schemaVersion: 1;
  scope: ScopeReference;
  plugin: PluginKey;
  revision: ContentDigest;
  projectionDigest: ContentDigest;
  projectionRef: ProjectionRootRef;
  currentProject: CurrentProjectRuntimeContext;
  content: ResolvedContentRoot;
  data: WritableDataRoot;
  skills: readonly SkillComponent[];
  hooks: readonly HookComponent[];
  contributionDigest: ContentDigest;
}>;

export type SkillHookSnapshotResult =
  | Readonly<{ kind: "ready"; snapshot: SkillHookRuntimeSnapshot }>
  | Readonly<{
      kind: "failed";
      code:
        | "REVISION_MISMATCH"
        | "CURRENT_PROJECT_UNAVAILABLE"
        | "PROJECT_IDENTITY_MISMATCH"
        | "PROJECT_UNTRUSTED"
        | "CONTENT_UNAVAILABLE"
        | "DATA_UNAVAILABLE"
        | "ADAPTER_FAILED";
    }>
  | Readonly<{ kind: "cancelled" }>;

class SnapshotContractFailure extends Error {
  constructor(readonly code: Exclude<SkillHookSnapshotResult, { kind: "ready" | "cancelled" }>["code"]) {
    super(code);
    this.name = "SnapshotContractFailure";
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  Object.freeze(value);
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function optionalEqual(left: unknown, right: unknown): boolean {
  return left === right;
}

function sortedComponents<T extends { id: string }>(values: readonly T[]): readonly T[] {
  const result = [...values];
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1]!.id >= result[index]!.id) throw new SnapshotContractFailure("REVISION_MISMATCH");
  }
  return result;
}

function logicalSkillComponents(values: readonly SkillComponent[]): readonly unknown[] {
  return values.map((component) => {
    // `root` is a normalized declaration and may later be resolved into a
    // machine path. It is intentionally excluded from evidence so hosts can
    // relocate immutable content without changing activation identity.
    const { root: _root, ...logical } = component;
    return logical;
  });
}

export function digestSkillHookContribution(input: Readonly<{
  scope: ScopeReference;
  plugin: PluginKey;
  revision?: ContentDigest;
  projectionDigest: ContentDigest;
  skills: readonly SkillComponent[];
  hooks: readonly HookComponent[];
}> , sha256: Sha256): ContentDigest {
  const scope = ScopeReferenceSchema.parse(input.scope);
  const plugin = PluginKeySchema.parse(input.plugin);
  const projectionDigest = ContentDigestSchema.parse(input.projectionDigest);
  const revision = input.revision === undefined ? undefined : ContentDigestSchema.parse(input.revision);
  const skills = input.skills.map((value) => SkillComponentSchema.parse(value));
  const hooks = input.hooks.map((value) => HookComponentSchema.parse(value));
  return hashContent(new TextEncoder().encode(`skills-hooks-contribution-v1\0${canonicalJson({
    scope,
    plugin,
    ...(revision === undefined ? {} : { revision }),
    projectionDigest,
    skills: logicalSkillComponents(skills),
    hooks,
  })}`), sha256);
}

function currentProjectContext(
  root: Awaited<ReturnType<ProjectRootAuthorityPort["acquire"]>>,
  trust: ProjectTrustAssessment,
): CurrentProjectRuntimeContext {
  return CurrentProjectRuntimeContextSchema.parse({
    identity: root.identity,
    projectKey: root.projectKey,
    trust,
  });
}

function verifyRevision(
  selection: RuntimeProjectionSelection,
  sha256: Sha256,
): Readonly<{
  scope: ScopeReference;
  plugin: PluginKey;
  revision: ContentDigest;
  projectionDigest: ContentDigest;
  projectionRef: ProjectionRootRef;
  contentRef: PluginContentRef;
  dataRef: PluginDataRef;
  configurationRef?: PluginConfigurationRef;
  skills: readonly SkillComponent[];
  hooks: readonly HookComponent[];
}> {
  const prepared = selection.prepared;
  const projection = prepared.projection;
  const expectation = prepared.expectation;
  const revision = InstalledRevisionRecordSchema.parse(selection.revision);
  if (expectation.kind !== "active" || !sameJson(expectation.projection, projection) ||
      expectation.projectionRef !== deriveProjectionRootRef({
        scope: projection.scope,
        plugin: projection.plugin,
        projectionDigest: projection.digest,
      }, sha256)) {
    throw new SnapshotContractFailure("REVISION_MISMATCH");
  }
  if (revision.revision !== projection.revision || revision.evidence.plugin.key !== projection.plugin ||
      revision.contentRef !== projection.contentRef || revision.dataRef !== projection.dataRef ||
      !optionalEqual(revision.configurationRef, projection.configurationRef)) {
    throw new SnapshotContractFailure("REVISION_MISMATCH");
  }
  return {
    scope: ScopeReferenceSchema.parse(projection.scope),
    plugin: PluginKeySchema.parse(projection.plugin),
    revision: ContentDigestSchema.parse(projection.revision),
    projectionDigest: ContentDigestSchema.parse(projection.digest),
    projectionRef: ProjectionRootRefSchema.parse(expectation.projectionRef),
    contentRef: PluginContentRefSchema.parse(projection.contentRef),
    dataRef: PluginDataRefSchema.parse(projection.dataRef),
    ...(projection.configurationRef === undefined ? {} : { configurationRef: PluginConfigurationRefSchema.parse(projection.configurationRef) }),
    skills: sortedComponents(projection.components.skills),
    hooks: sortedComponents(projection.components.hooks),
  };
}

export function createSkillHookSnapshotLoader(dependencies: Readonly<{
  content: Pick<ContentStorePort, "resolvePlugin" | "ensureDataRoot">;
  projectRoots: ProjectRootAuthorityPort;
  projectTrust: ProjectTrustPort;
  sha256: Sha256;
}>): Readonly<{
  load(selection: RuntimeProjectionSelection, signal: AbortSignal): Promise<SkillHookSnapshotResult>;
}> {
  if (dependencies === null || typeof dependencies !== "object") throw new TypeError("skill/hook snapshot dependencies are required");
  if (typeof dependencies.sha256 !== "function") throw new TypeError("skill/hook snapshot requires SHA-256");

  async function load(selectionInput: RuntimeProjectionSelection, signal: AbortSignal): Promise<SkillHookSnapshotResult> {
    try {
      throwIfAborted(signal);
      const selection = {
        prepared: selectionInput.prepared,
        revision: InstalledRevisionRecordSchema.parse(selectionInput.revision),
      } satisfies RuntimeProjectionSelection;
      const verified = verifyRevision(selection, dependencies.sha256);
      throwIfAborted(signal);

      let root: Awaited<ReturnType<ProjectRootAuthorityPort["acquire"]>>;
      try {
        root = await dependencies.projectRoots.acquire(signal);
        ProjectIdentitySchema.parse(root.identity);
        ProjectKeySchema.parse(root.projectKey);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new SnapshotContractFailure("CURRENT_PROJECT_UNAVAILABLE");
      }
      let trust: ProjectTrustAssessment;
      try {
        trust = ProjectTrustAssessmentSchema.parse(await dependencies.projectTrust.assess(root.projectKey, signal));
      } catch (error) {
        if (signal.aborted) throw error;
        throw new SnapshotContractFailure("CURRENT_PROJECT_UNAVAILABLE");
      }
      const currentProject = currentProjectContext(root, trust);
      if (verified.scope.kind === "project") {
        if (verified.scope.projectKey !== currentProject.projectKey) throw new SnapshotContractFailure("PROJECT_IDENTITY_MISMATCH");
        if (currentProject.trust.kind !== "trusted") throw new SnapshotContractFailure("PROJECT_UNTRUSTED");
      }
      throwIfAborted(signal);

      let content: ResolvedContentRoot;
      try {
        content = await dependencies.content.resolvePlugin(selection.revision, signal, verified.scope);
        if (content.kind !== "plugin" || content.contentRef !== verified.contentRef) throw new Error("content evidence mismatch");
      } catch (error) {
        if (signal.aborted) throw error;
        throw new SnapshotContractFailure("CONTENT_UNAVAILABLE");
      }
      throwIfAborted(signal);
      let data: WritableDataRoot;
      try {
        data = await dependencies.content.ensureDataRoot({ scope: verified.scope, plugin: verified.plugin, dataRef: verified.dataRef }, signal);
        if (data.scope.kind !== verified.scope.kind ||
            (data.scope.kind === "project" && verified.scope.kind === "project" && data.scope.projectKey !== verified.scope.projectKey) ||
            data.plugin !== verified.plugin || data.dataRef !== verified.dataRef) throw new Error("data evidence mismatch");
      } catch (error) {
        if (signal.aborted) throw error;
        throw new SnapshotContractFailure("DATA_UNAVAILABLE");
      }
      throwIfAborted(signal);
      const snapshot = deepFreeze({
        schemaVersion: 1 as const,
        scope: verified.scope,
        plugin: verified.plugin,
        revision: verified.revision,
        projectionDigest: verified.projectionDigest,
        projectionRef: verified.projectionRef,
        currentProject,
        content,
        data,
        skills: [...verified.skills],
        hooks: [...verified.hooks],
        contributionDigest: digestSkillHookContribution({
          scope: verified.scope,
          plugin: verified.plugin,
          revision: verified.revision,
          projectionDigest: verified.projectionDigest,
          skills: verified.skills,
          hooks: verified.hooks,
        }, dependencies.sha256),
      });
      return { kind: "ready", snapshot };
    } catch (error) {
      if (signal.aborted || (error !== null && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError")) return { kind: "cancelled" };
      if (error instanceof SnapshotContractFailure) return { kind: "failed", code: error.code };
      return { kind: "failed", code: "ADAPTER_FAILED" };
    }
  }

  return Object.freeze({ load });
}