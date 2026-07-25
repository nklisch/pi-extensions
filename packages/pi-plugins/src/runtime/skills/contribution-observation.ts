import { z } from "zod";
import {
  ContentDigestSchema,
  hashContent,
  type ContentDigest,
} from "../../domain/content-manifest.js";
import { ComponentIdSchema, type ComponentId } from "../../domain/components.js";
import { PluginKeySchema, type PluginKey } from "../../domain/identity.js";
import {
  CurrentProjectRuntimeContextSchema,
  type CurrentProjectRuntimeContext,
} from "../../application/ports/project-trust.js";
import {
  ProjectionExpectationSchema,
  type ProjectionExpectation,
} from "../../application/ports/runtime-projection.js";
import {
  SkillHookContributionObservationSchema,
  type SkillHookContributionObservation,
} from "../../application/ports/lifecycle-reload.js";
import {
  ScopeReferenceSchema,
  type ScopeReference,
} from "../../domain/state/scope.js";

const skillHookSnapshotParticipant = z.literal("skills-hooks-snapshot");
const skillResourceParticipant = z.literal("skill-resources");

export const SkillHookSnapshotObservationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("active"),
    participant: skillHookSnapshotParticipant,
    scope: ScopeReferenceSchema,
    plugin: PluginKeySchema,
    revision: ContentDigestSchema,
    projectionDigest: ContentDigestSchema,
    currentProject: CurrentProjectRuntimeContextSchema,
    contributionDigest: ContentDigestSchema,
    skillComponentIds: z.array(ComponentIdSchema).readonly(),
    hookComponentIds: z.array(ComponentIdSchema).readonly(),
  }).strict().readonly(),
  z.object({
    kind: z.literal("inactive"),
    participant: skillHookSnapshotParticipant,
    scope: ScopeReferenceSchema,
    plugin: PluginKeySchema,
    projectionDigest: ContentDigestSchema,
    currentProject: CurrentProjectRuntimeContextSchema,
    contributionDigest: ContentDigestSchema,
    skillComponentIds: z.tuple([]),
    hookComponentIds: z.tuple([]),
  }).strict().readonly(),
]);
export type SkillHookSnapshotObservation = z.infer<typeof SkillHookSnapshotObservationSchema>;

export const SkillResourceContributionObservationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("active"),
    participant: skillResourceParticipant,
    scope: ScopeReferenceSchema,
    plugin: PluginKeySchema,
    revision: ContentDigestSchema,
    projectionDigest: ContentDigestSchema,
    currentProject: CurrentProjectRuntimeContextSchema,
    contributionDigest: ContentDigestSchema,
    skillComponentIds: z.array(ComponentIdSchema).readonly(),
  }).strict().readonly(),
  z.object({
    kind: z.literal("inactive"),
    participant: skillResourceParticipant,
    scope: ScopeReferenceSchema,
    plugin: PluginKeySchema,
    projectionDigest: ContentDigestSchema,
    currentProject: CurrentProjectRuntimeContextSchema,
    contributionDigest: ContentDigestSchema,
    skillComponentIds: z.tuple([]),
  }).strict().readonly(),
]);
export type SkillResourceContributionObservation = z.infer<typeof SkillResourceContributionObservationSchema>;

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

function sortedUniqueIds(ids: readonly ComponentId[]): boolean {
  for (let index = 1; index < ids.length; index += 1) {
    if (ids[index - 1]! >= ids[index]!) return false;
  }
  return true;
}

function usableProjectEvidence(scope: ScopeReference, project: CurrentProjectRuntimeContext): boolean {
  return scope.kind === "user" || (scope.projectKey === project.projectKey && project.trust.kind === "trusted");
}

function expectedActiveMatches(
  value: SkillHookSnapshotObservation | SkillResourceContributionObservation,
  expectation: Extract<ProjectionExpectation, { kind: "active" }>,
): boolean {
  return value.kind === "active" &&
    sameJson(value.scope, expectation.projection.scope) &&
    value.plugin === expectation.projection.plugin &&
    value.revision === expectation.projection.revision &&
    value.projectionDigest === expectation.projection.digest;
}

function expectedInactiveMatches(
  value: SkillHookSnapshotObservation | SkillResourceContributionObservation,
  expectation: Extract<ProjectionExpectation, { kind: "inactive" }>,
): boolean {
  return value.kind === "inactive" &&
    sameJson(value.scope, expectation.scope) &&
    value.plugin === expectation.plugin &&
    value.projectionDigest === expectation.digest;
}

/**
 * Bind the source snapshot and exact physical contribution without claiming
 * anything about Pi's later frontmatter validation or collision diagnostics.
 */
export function composeSkillHookContributionObservation(input: Readonly<{
  expectation: ProjectionExpectation;
  snapshot: SkillHookSnapshotObservation;
  resources: SkillResourceContributionObservation;
  sha256: (bytes: Uint8Array) => Uint8Array;
}>): SkillHookContributionObservation {
  const expectation = ProjectionExpectationSchema.parse(input.expectation);
  const snapshot = SkillHookSnapshotObservationSchema.parse(input.snapshot);
  const resources = SkillResourceContributionObservationSchema.parse(input.resources);
  if (snapshot.kind !== resources.kind ||
      snapshot.participant !== "skills-hooks-snapshot" ||
      resources.participant !== "skill-resources") {
    throw new Error("skill resource evidence participants disagree");
  }
  const expectationMatches = expectation.kind === "active"
    ? expectedActiveMatches(snapshot, expectation) && expectedActiveMatches(resources, expectation)
    : expectedInactiveMatches(snapshot, expectation) && expectedInactiveMatches(resources, expectation);
  if (!expectationMatches || !sameJson(snapshot.currentProject, resources.currentProject) ||
      !usableProjectEvidence(snapshot.scope, snapshot.currentProject) ||
      !usableProjectEvidence(resources.scope, resources.currentProject)) {
    throw new Error("skill resource evidence does not match the expected projection");
  }
  if (!sortedUniqueIds(snapshot.skillComponentIds) ||
      !sortedUniqueIds(resources.skillComponentIds) ||
      !sameJson(snapshot.skillComponentIds, resources.skillComponentIds)) {
    throw new Error("skill resource component evidence does not match the source projection");
  }
  if (expectation.kind === "active") {
    if (snapshot.kind !== "active" || resources.kind !== "active") throw new Error("active skill resource evidence is incomplete");
    return SkillHookContributionObservationSchema.parse({
      kind: "active",
      participant: "skills-hooks",
      scope: snapshot.scope,
      plugin: snapshot.plugin,
      revision: snapshot.revision,
      projectionDigest: snapshot.projectionDigest,
      currentProject: snapshot.currentProject,
      contributionDigest: hashContent(new TextEncoder().encode(`skills-hooks-resource-contribution-v1\0${canonicalJson({
        source: snapshot.contributionDigest,
        resources: resources.contributionDigest,
      })}`), input.sha256),
      skillComponentIds: snapshot.skillComponentIds,
      hookComponentIds: snapshot.hookComponentIds,
    });
  }
  if (snapshot.kind !== "inactive" || resources.kind !== "inactive") throw new Error("inactive skill resource evidence is incomplete");
  return SkillHookContributionObservationSchema.parse({
    kind: "inactive",
    participant: "skills-hooks",
    scope: snapshot.scope,
    plugin: snapshot.plugin,
    projectionDigest: snapshot.projectionDigest,
    currentProject: snapshot.currentProject,
    contributionDigest: hashContent(new TextEncoder().encode(`skills-hooks-resource-inactive-v1\0${canonicalJson({
      source: snapshot.contributionDigest,
      resources: resources.contributionDigest,
    })}`), input.sha256),
    skillComponentIds: [],
    hookComponentIds: [],
  });
}

export function digestSkillResourceContribution(input: Readonly<{
  scope: ScopeReference;
  plugin: PluginKey;
  revision?: ContentDigest;
  projectionDigest: ContentDigest;
  sourceContributionDigest: ContentDigest;
  skills: readonly Readonly<{ id: ComponentId; root: string }>[];
}>, sha256: (bytes: Uint8Array) => Uint8Array): ContentDigest {
  const scope = ScopeReferenceSchema.parse(input.scope);
  const plugin = PluginKeySchema.parse(input.plugin);
  const projectionDigest = ContentDigestSchema.parse(input.projectionDigest);
  const sourceContributionDigest = ContentDigestSchema.parse(input.sourceContributionDigest);
  const skills = input.skills.map((skill) => ({
    id: ComponentIdSchema.parse(skill.id),
    root: skill.root,
  }));
  return hashContent(new TextEncoder().encode(`skill-resources-v1\0${canonicalJson({
    scope,
    plugin,
    ...(input.revision === undefined ? {} : { revision: ContentDigestSchema.parse(input.revision) }),
    projectionDigest,
    sourceContributionDigest,
    skills,
  })}`), sha256);
}

export type { ComponentId, ContentDigest, CurrentProjectRuntimeContext, PluginKey, ProjectionExpectation, ScopeReference };