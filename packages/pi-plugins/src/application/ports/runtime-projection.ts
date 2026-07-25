import { z } from "zod";
import { canonicalJson, compareUtf8 } from "../../domain/canonical-json.js";
import {
  canonicalProvenance,
  canonicalizeJsonValue,
  compareProvenanceUtf8,
} from "../../domain/canonical-order.js";
import {
  ContentDigestSchema,
  hashContent,
  type ContentDigest,
} from "../../domain/content-manifest.js";
import {
  HookComponentSchema,
  McpServerComponentSchema,
  RetainedMetadataSchema,
  SkillComponentSchema,
  flattenComponents,
  type HookComponent,
  type McpServerComponent,
  type RetainedMetadata,
  type SkillComponent,
} from "../../domain/components.js";
import {
  CompatibilityReportSchema,
  type CompatibilityReport,
} from "../../domain/compatibility.js";
import { PluginIdentitySchema, PluginKeySchema, type PluginKey } from "../../domain/identity.js";
import {
  NormalizedPluginSchema,
  type NormalizedPlugin,
} from "../../domain/plugin.js";
import type { Provenance } from "../../domain/provenance.js";
import type { JsonValue } from "../../domain/schema.js";
import {
  InstalledRevisionRecordSchema,
  type InstalledRevisionRecord,
} from "../../domain/state/installed-state.js";
import {
  PluginConfigurationRefSchema,
  PluginContentRefSchema,
  PluginDataRefSchema,
  deriveProjectionRootRef,
  ProjectionRootRefSchema,
  type PluginConfigurationRef,
  type ProjectionRootRef,
} from "../../domain/state/references.js";
import {
  ScopeReferenceSchema,
  type ScopeReference,
} from "../../domain/state/scope.js";
import type { Sha256 } from "../../domain/source.js";

export const RuntimePluginComponentsSchema = z.object({
  skills: z.array(SkillComponentSchema).readonly(),
  hooks: z.array(HookComponentSchema).readonly(),
  mcpServers: z.array(McpServerComponentSchema).readonly(),
}).strict().readonly();
export type RuntimePluginComponents = z.infer<typeof RuntimePluginComponentsSchema>;

export const PluginRuntimeProjectionSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
  pluginIdentity: PluginIdentitySchema,
  compatibilityDigest: ContentDigestSchema,
  revision: ContentDigestSchema,
  contentRef: PluginContentRefSchema,
  dataRef: PluginDataRefSchema,
  configurationRef: PluginConfigurationRefSchema.optional(),
  components: RuntimePluginComponentsSchema,
  digest: ContentDigestSchema,
}).strict().readonly().superRefine((projection, context) => {
  if (projection.plugin !== projection.pluginIdentity.key) {
    context.addIssue({
      code: "custom",
      path: ["pluginIdentity", "key"],
      message: "projection plugin identity must match its source plugin key",
    });
  }
});
export type PluginRuntimeProjection = z.infer<typeof PluginRuntimeProjectionSchemaV1>;

const ActiveProjectionExpectationSchema = z.object({
  kind: z.literal("active"),
  projection: PluginRuntimeProjectionSchemaV1,
  projectionRef: ProjectionRootRefSchema,
}).strict().readonly();
const InactiveProjectionExpectationSchema = z.object({
  kind: z.literal("inactive"),
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
  digest: ContentDigestSchema,
}).strict().readonly();
export const ProjectionExpectationSchema = z.discriminatedUnion("kind", [
  ActiveProjectionExpectationSchema,
  InactiveProjectionExpectationSchema,
]);
export type ProjectionExpectation = z.infer<typeof ProjectionExpectationSchema>;

export interface RuntimeProjectionPort {
  /** Publish/verify one complete-plugin projection, without activating it. */
  prepare(expectation: ProjectionExpectation, signal: AbortSignal): Promise<ProjectionExpectation>;
}

const encoder = new TextEncoder();

function digestProjection(value: Omit<PluginRuntimeProjection, "digest">, sha256: Sha256): ContentDigest {
  return hashContent(
    encoder.encode(`plugin-runtime-projection-v1\0${canonicalJson(value)}`),
    sha256,
  );
}

function digestInactive(scope: ScopeReference, plugin: PluginKey, sha256: Sha256): ContentDigest {
  return hashContent(
    encoder.encode(`plugin-runtime-inactive-v1\0${canonicalJson({ scope, plugin })}`),
    sha256,
  );
}

function canonicalProvenanceOrEmpty(values: readonly Provenance[]): readonly Provenance[] {
  return values.length === 0 ? [] : canonicalProvenance(values);
}

function canonicalMetadata(metadata: RetainedMetadata): RetainedMetadata {
  const valid = RetainedMetadataSchema.parse(metadata);
  return RetainedMetadataSchema.parse({
    key: valid.key,
    claimed: {
      value: canonicalizeJsonValue(valid.claimed.value),
      provenance: canonicalProvenance(valid.claimed.provenance),
    },
  });
}

function compareMetadata(left: RetainedMetadata, right: RetainedMetadata): number {
  const firstProvenance = compareProvenanceUtf8(
    left.claimed.provenance[0]!,
    right.claimed.provenance[0]!,
  );
  return compareUtf8(left.key, right.key) ||
    compareUtf8(canonicalJson(left.claimed.value), canonicalJson(right.claimed.value)) ||
    firstProvenance ||
    compareUtf8(canonicalJson(left.claimed.provenance), canonicalJson(right.claimed.provenance));
}

function canonicalSkill(component: SkillComponent): SkillComponent {
  const valid = SkillComponentSchema.parse(component);
  return SkillComponentSchema.parse({
    kind: valid.kind,
    id: valid.id,
    name: { value: valid.name.value, provenance: canonicalProvenance(valid.name.provenance) },
    root: { value: valid.root.value, provenance: canonicalProvenance(valid.root.provenance) },
    metadata: valid.metadata.map(canonicalMetadata).sort(compareMetadata),
  });
}

function canonicalHook(component: HookComponent): HookComponent {
  const valid = HookComponentSchema.parse(component);
  return HookComponentSchema.parse({
    kind: valid.kind,
    id: valid.id,
    event: { value: valid.event.value, provenance: canonicalProvenance(valid.event.provenance) },
    ...(valid.matcher === undefined ? {} : {
      matcher: { value: valid.matcher.value, provenance: canonicalProvenance(valid.matcher.provenance) },
    }),
    handler: {
      value: canonicalizeJsonValue(valid.handler.value as JsonValue),
      provenance: canonicalProvenance(valid.handler.provenance),
    },
    metadata: valid.metadata.map(canonicalMetadata).sort(compareMetadata),
  });
}

function canonicalMcpServer(component: McpServerComponent): McpServerComponent {
  const valid = McpServerComponentSchema.parse(component);
  return McpServerComponentSchema.parse({
    kind: valid.kind,
    id: valid.id,
    nativeKey: {
      value: valid.nativeKey.value,
      provenance: canonicalProvenance(valid.nativeKey.provenance),
    },
    declaration: {
      value: canonicalizeJsonValue(valid.declaration.value),
      provenance: canonicalProvenance(valid.declaration.provenance),
    },
    metadata: valid.metadata.map(canonicalMetadata).sort(compareMetadata),
  });
}

function canonicalRuntimeComponents(components: RuntimePluginComponents): RuntimePluginComponents {
  const valid = RuntimePluginComponentsSchema.parse(components);
  return RuntimePluginComponentsSchema.parse({
    skills: valid.skills.map(canonicalSkill).sort((left, right) => compareUtf8(left.id, right.id)),
    hooks: valid.hooks.map(canonicalHook).sort((left, right) => compareUtf8(left.id, right.id)),
    mcpServers: valid.mcpServers.map(canonicalMcpServer).sort((left, right) => compareUtf8(left.id, right.id)),
  });
}

function sortedCanonicalDiagnostics<T>(values: readonly T[]): readonly T[] {
  return [...values].sort((left, right) => compareUtf8(canonicalJson(left), canonicalJson(right)));
}

function canonicalCompatibilityEvidence(report: CompatibilityReport): unknown {
  const valid = CompatibilityReportSchema.parse(report);
  return {
    plugin: valid.plugin,
    activatable: valid.activatable,
    components: valid.components.map((component) => ({
      ...component,
      requirementIds: [...component.requirementIds].sort(compareUtf8),
      diagnostics: sortedCanonicalDiagnostics(component.diagnostics),
    })).sort((left, right) => compareUtf8(left.componentId, right.componentId)),
    requirements: valid.requirements.map((assessment) => ({
      ...assessment,
      requirement: {
        ...assessment.requirement,
        provenance: canonicalProvenanceOrEmpty(assessment.requirement.provenance),
      },
    })).sort((left, right) =>
      compareUtf8(left.requirement.id, right.requirement.id) ||
      compareUtf8(canonicalJson(left), canonicalJson(right))),
    diagnostics: sortedCanonicalDiagnostics(valid.diagnostics),
  };
}

/** Digest the complete report after canonical ordering of its set-like evidence. */
export function digestCompatibilityReport(
  report: CompatibilityReport,
  sha256: Sha256,
): ContentDigest {
  return hashContent(
    encoder.encode(`compatibility-report-evidence-v1\0${canonicalJson(canonicalCompatibilityEvidence(report))}`),
    sha256,
  );
}

function exactComponentInventory(plugin: NormalizedPlugin, report: CompatibilityReport): void {
  const expected = flattenComponents(plugin.components).map((component) => component.id).sort(compareUtf8);
  const actual = report.components.map((component) => component.componentId).sort(compareUtf8);
  if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
    throw new Error("runtime projection component inventory differs from compatibility evidence");
  }
}

function runtimeComponents(plugin: NormalizedPlugin, report: CompatibilityReport): RuntimePluginComponents {
  exactComponentInventory(plugin, report);
  const verdicts = new Map(report.components.map((assessment) => [assessment.componentId, assessment.verdict.kind]));
  const skills: SkillComponent[] = [];
  const hooks: HookComponent[] = [];
  const mcpServers: McpServerComponent[] = [];
  for (const component of [
    ...plugin.components.skills,
    ...plugin.components.hooks,
    ...plugin.components.mcpServers,
  ]) {
    const verdict = verdicts.get(component.id);
    if (verdict === undefined || verdict === "incompatible") {
      throw new Error("runtime projection component inventory is not activatable");
    }
    if (verdict === "metadata-only") continue;
    if (component.kind === "skill") skills.push(component);
    else if (component.kind === "hook") hooks.push(component);
    else mcpServers.push(component);
  }
  return canonicalRuntimeComponents({ skills, hooks, mcpServers });
}

function samePluginIdentity(plugin: NormalizedPlugin, report: CompatibilityReport): boolean {
  return plugin.identity.key === report.plugin.key &&
    plugin.identity.marketplaceName === report.plugin.marketplaceName &&
    plugin.identity.marketplaceEntryName === report.plugin.marketplaceEntryName &&
    plugin.identity.manifestName === report.plugin.manifestName;
}

/**
 * Build the one logical runtime descriptor from normalized, compatibility-checked
 * evidence. The digest is derived from this exact schema projection, not from
 * adapter paths or expanded configuration values.
 */
export function createPluginRuntimeProjection(
  input: Readonly<{
    scope: ScopeReference;
    plugin: NormalizedPlugin;
    compatibility: CompatibilityReport;
    revision: InstalledRevisionRecord;
    sha256: Sha256;
    digest?: ContentDigest;
  }>,
): PluginRuntimeProjection {
  const scope = ScopeReferenceSchema.parse(input.scope);
  const plugin = NormalizedPluginSchema.parse(input.plugin);
  const compatibility = CompatibilityReportSchema.parse(input.compatibility);
  const revision = InstalledRevisionRecordSchema.parse(input.revision);
  if (!samePluginIdentity(plugin, compatibility)) throw new Error("projection plugin and compatibility identity differ");
  if (!compatibility.activatable) throw new Error("incompatible plugin cannot receive an active projection");
  if (revision.evidence.plugin.key !== plugin.identity.key) throw new Error("projection revision belongs to another plugin");
  const components = runtimeComponents(plugin, compatibility);
  const withoutDigest = {
    schemaVersion: 1 as const,
    scope,
    plugin: plugin.identity.key,
    pluginIdentity: plugin.identity,
    compatibilityDigest: digestCompatibilityReport(compatibility, input.sha256),
    revision: revision.revision,
    contentRef: revision.contentRef,
    dataRef: revision.dataRef,
    ...(revision.configurationRef === undefined ? {} : { configurationRef: revision.configurationRef }),
    components,
  };
  const digest = digestProjection(withoutDigest, input.sha256);
  if (input.digest !== undefined && ContentDigestSchema.parse(input.digest) !== digest) {
    throw new Error("runtime projection digest does not match its contents");
  }
  return PluginRuntimeProjectionSchemaV1.parse({ ...withoutDigest, digest });
}

export function createActiveProjectionExpectation(
  projection: PluginRuntimeProjection,
  sha256: Sha256,
): Extract<ProjectionExpectation, { kind: "active" }> {
  const value = PluginRuntimeProjectionSchemaV1.parse(projection);
  const canonicalComponents = canonicalRuntimeComponents(value.components);
  if (canonicalJson(value.components) !== canonicalJson(canonicalComponents)) {
    throw new Error("runtime projection components are not canonical");
  }
  const { digest: claimedDigest, ...withoutDigest } = value;
  const digest = digestProjection(withoutDigest, sha256);
  if (digest !== claimedDigest) throw new Error("runtime projection digest does not match its contents");
  const projectionRef = deriveProjectionRootRef({
    scope: value.scope,
    plugin: value.plugin,
    projectionDigest: value.digest,
  }, sha256);
  return ActiveProjectionExpectationSchema.parse({ kind: "active", projection: value, projectionRef });
}

/** A canonical, scope-qualified tombstone used for all deactivation operations. */
export function createInactiveProjectionExpectation(
  input: Readonly<{ scope: ScopeReference; plugin: PluginKey; sha256: Sha256; digest?: ContentDigest }>,
): Extract<ProjectionExpectation, { kind: "inactive" }> {
  const scope = ScopeReferenceSchema.parse(input.scope);
  const plugin = PluginKeySchema.parse(input.plugin);
  const digest = digestInactive(scope, plugin, input.sha256);
  if (input.digest !== undefined && ContentDigestSchema.parse(input.digest) !== digest) {
    throw new Error("inactive projection digest does not match its scope and plugin");
  }
  return InactiveProjectionExpectationSchema.parse({ kind: "inactive", scope, plugin, digest });
}

/** Validate adapter evidence and recompute its canonical digest/reference. */
export function verifyProjectionExpectation(input: unknown, sha256: Sha256): ProjectionExpectation {
  const value = ProjectionExpectationSchema.parse(input);
  const expected = value.kind === "active"
    ? createActiveProjectionExpectation(value.projection, sha256)
    : createInactiveProjectionExpectation({
      scope: value.scope,
      plugin: value.plugin,
      digest: value.digest,
      sha256,
    });
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error("projection expectation evidence does not match its canonical digest or reference");
  }
  return expected;
}

export type {
  ContentDigest,
  PluginConfigurationRef,
  PluginKey,
  ProjectionRootRef,
  ScopeReference,
};
