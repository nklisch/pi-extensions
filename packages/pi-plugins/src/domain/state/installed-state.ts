import { z } from "zod";
import { compareUtf8 } from "../canonical-json.js";
import {
  ContentDigestSchema,
  ContentManifestSchema,
  createMaterializationBinding,
  hashContent,
  verifyContentManifest,
  type ContentDigest,
  type ContentManifest,
} from "../content-manifest.js";
import {
  ComponentKindRegistry,
  ComponentIdSchema,
  flattenComponents,
} from "../components.js";
import {
  createExecutableSurface,
  digestExecutableSurface,
} from "../executable-surface.js";
import { CompatibilityReportSchema, type CompatibilityReport } from "../compatibility.js";
import {
  MarketplaceNameSchema,
  PluginKeySchema,
  type MarketplaceName,
  type PluginKey,
} from "../identity.js";
import type { JsonValue } from "../schema.js";
import { NormalizedPluginSchema, type NormalizedPlugin } from "../plugin.js";
import {
  MarketplaceContentRefSchema,
  PendingTransitionRefSchema,
  PluginConfigurationRefSchema,
  PluginContentRefSchema,
  PluginDataRefSchema,
  deriveMarketplaceContentRef,
  derivePluginConfigurationRef,
  derivePluginContentRef,
  derivePluginDataRef,
  verifyMarketplaceContentRef,
  verifyPluginConfigurationRef,
  verifyPluginContentRef,
  verifyPluginDataRef,
  type MarketplaceContentRef,
  type PendingTransitionRef,
  type PluginConfigurationRef,
  type PluginContentRef,
  type PluginDataRef,
} from "./references.js";
import { ScopeReferenceSchema, type ScopeReference } from "./scope.js";
import {
  GitRevisionSchema,
  ResolvedMarketplaceSourceSchema,
  SourceHashSchema,
  verifyResolvedMarketplaceSource,
  verifyResolvedPluginSource,
  type ResolvedMarketplaceSource,
  type ResolvedPluginSource,
  type Sha256,
} from "../source.js";
import {
  StableSourceIdentitySchema,
  type StableSourceIdentity,
} from "../update-policy.js";

// Generation is shared by every state family. It is defined with host config,
// rather than copied here, so compare-and-swap values cannot drift by scope.
export { GenerationSchema } from "./config-state.js";
export type { Generation } from "./config-state.js";
import { GenerationSchema } from "./config-state.js";

export const ActivationIntentSchema = z.enum(["enabled", "disabled"]);
export type ActivationIntent = z.infer<typeof ActivationIntentSchema>;

function addIssue(
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void {
  context.addIssue({ code: "custom", path: [...path], message });
}

function addDuplicateIssues<T extends string>(
  values: readonly T[],
  path: readonly (string | number)[],
  label: string,
  context: z.RefinementCtx,
): void {
  const firstByValue = new Map<T, number>();
  for (const [index, value] of values.entries()) {
    const firstIndex = firstByValue.get(value);
    if (firstIndex !== undefined) {
      addIssue(context, [...path, index], `duplicate ${label}; first declared at index ${firstIndex}`);
    } else {
      firstByValue.set(value, index);
    }
  }
}

const ComponentEvidenceKindSchema = z.enum([
  ComponentKindRegistry.skill.tag,
  ComponentKindRegistry.hook.tag,
  ComponentKindRegistry.mcpServer.tag,
  ComponentKindRegistry.foreign.tag,
]);
export type ComponentEvidenceKind = z.infer<typeof ComponentEvidenceKindSchema>;

/** The only source facts retained in an installed record. No URL, declaration, or path is stored. */
const InstalledSourceEvidenceMetadataSchema = {
  /** Optional evidence identity; older records may predate identity capture. */
  marketplaceSourceIdentity: StableSourceIdentitySchema.optional(),
  pluginSourceIdentity: StableSourceIdentitySchema.optional(),
  declaredVersion: z.string().min(1).optional(),
  sourceRevision: z.string().min(1).optional(),
} as const;

export const InstalledSourceEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("marketplace-path"), sourceHash: SourceHashSchema, marketplaceRevision: GitRevisionSchema, ...InstalledSourceEvidenceMetadataSchema }).strict().readonly(),
  z.object({ kind: z.literal("git"), sourceHash: SourceHashSchema, revision: GitRevisionSchema, ...InstalledSourceEvidenceMetadataSchema }).strict().readonly(),
  z.object({ kind: z.literal("git-subdir"), sourceHash: SourceHashSchema, revision: GitRevisionSchema, ...InstalledSourceEvidenceMetadataSchema }).strict().readonly(),
  z.object({ kind: z.literal("npm"), sourceHash: SourceHashSchema, ...InstalledSourceEvidenceMetadataSchema }).strict().readonly(),
]);
export type InstalledSourceEvidence = z.infer<typeof InstalledSourceEvidenceSchema>;

/** Stable plugin identity only; manifest presentation names are not authoritative state. */
export const InstalledPluginIdentitySchema = z.object({
  key: PluginKeySchema,
  marketplaceName: MarketplaceNameSchema,
  marketplaceEntryName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
}).strict().readonly();
export type InstalledPluginIdentity = z.infer<typeof InstalledPluginIdentitySchema>;

/** Safe structural inventory; executable declarations are represented only by immutable ids and kinds. */
export const InstalledComponentEvidenceSchema = z.object({
  id: ComponentIdSchema,
  kind: ComponentEvidenceKindSchema,
}).strict().readonly();
export type InstalledComponentEvidence = z.infer<typeof InstalledComponentEvidenceSchema>;

export const InstalledCompatibilityEvidenceSchema = z.object({
  activatable: z.boolean(),
  fingerprint: ContentDigestSchema,
}).strict().readonly();
export type InstalledCompatibilityEvidence = z.infer<typeof InstalledCompatibilityEvidenceSchema>;

export const InstalledTrustEvidenceSchema = z.object({
  executableSurfaceDigest: ContentDigestSchema,
}).strict().readonly();
export type InstalledTrustEvidence = z.infer<typeof InstalledTrustEvidenceSchema>;

/**
 * Persisted installed evidence is intentionally a lossy, strict projection of
 * the normalized bundle. The immutable content ref is the authority for later
 * projection generation; this summary cannot become a declaration store.
 */
export const InstalledEvidenceSummarySchema = z.object({
  plugin: InstalledPluginIdentitySchema,
  source: InstalledSourceEvidenceSchema,
  components: z.array(InstalledComponentEvidenceSchema).readonly(),
  compatibility: InstalledCompatibilityEvidenceSchema,
  trust: InstalledTrustEvidenceSchema,
}).strict().readonly();
export type InstalledEvidenceSummary = z.infer<typeof InstalledEvidenceSummarySchema>;

/** A verified, immutable marketplace catalog snapshot used by installed state. */
export const MarketplaceSourceEvidenceSchema = z.object({
  kind: z.enum(["github", "git", "local-git"]),
  sourceHash: SourceHashSchema,
  revision: GitRevisionSchema,
}).strict().readonly();
export type MarketplaceSourceEvidence = z.infer<typeof MarketplaceSourceEvidenceSchema>;

export const MarketplaceSnapshotRecordSchema = z.object({
  marketplace: MarketplaceNameSchema,
  source: MarketplaceSourceEvidenceSchema,
  contentDigest: ContentDigestSchema,
  binding: ContentDigestSchema,
  contentRef: MarketplaceContentRefSchema,
}).strict().readonly();
export type MarketplaceSnapshotRecord = z.infer<typeof MarketplaceSnapshotRecordSchema>;

export const InstalledRevisionRecordSchema = z.object({
  revision: ContentDigestSchema,
  evidence: InstalledEvidenceSummarySchema,
  contentDigest: ContentDigestSchema,
  contentRef: PluginContentRefSchema,
  dataRef: PluginDataRefSchema,
  configurationRef: PluginConfigurationRefSchema.optional(),
}).strict().readonly();
export type InstalledRevisionRecord = z.infer<typeof InstalledRevisionRecordSchema>;

export const InstalledPluginRecordSchema = z.object({
  plugin: PluginKeySchema,
  activation: ActivationIntentSchema,
  selectedRevision: ContentDigestSchema,
  revisions: z.array(InstalledRevisionRecordSchema).min(1).readonly(),
  // This is intentionally only an opaque reference. Operation and recovery
  // payloads belong to their own later state families.
  pendingTransition: PendingTransitionRefSchema.optional(),
}).strict().readonly().superRefine((record, context) => {
  addDuplicateIssues(
    record.revisions.map((revision) => revision.revision),
    ["revisions"],
    "revision",
    context,
  );

  const revisionKeys = new Set(record.revisions.map((revision) => revision.evidence.plugin.key));
  if (revisionKeys.size !== 1 || !revisionKeys.has(record.plugin)) {
    addIssue(context, ["plugin"], "installed revisions must all belong to the installed plugin key");
  }
  if (!record.revisions.some((revision) => revision.revision === record.selectedRevision)) {
    addIssue(context, ["selectedRevision"], "selected revision must refer to an installed revision");
  }
});
export type InstalledPluginRecord = z.infer<typeof InstalledPluginRecordSchema>;

function addDuplicateMarketplaceIssues(
  records: readonly MarketplaceSnapshotRecord[],
  context: z.RefinementCtx,
): void {
  addDuplicateIssues(records.map((record) => record.marketplace), ["marketplaces"], "marketplace snapshot", context);
}

function addDuplicatePluginIssues(
  records: readonly InstalledPluginRecord[],
  context: z.RefinementCtx,
): void {
  addDuplicateIssues(records.map((record) => record.plugin), ["plugins"], "installed plugin", context);
}

/**
 * The only installed-user schema. The literal version remains so a future
 * clean cut-over can recognize stale documents; stale versions are
 * reinitialized by the state codec, never migrated.
 */
export const InstalledUserStateDocumentSchema = z.object({
  schemaVersion: z.literal(2),
  generation: GenerationSchema,
  marketplaces: z.array(MarketplaceSnapshotRecordSchema).readonly(),
  plugins: z.array(InstalledPluginRecordSchema).readonly(),
}).strict().readonly().superRefine((document, context) => {
  addDuplicateMarketplaceIssues(document.marketplaces, context);
  addDuplicatePluginIssues(document.plugins, context);
  // Historical marketplace-relative revisions are intentionally independent of
  // the newest selected catalog snapshot; coverage by marketplace name remains.
  const snapshots = new Set(document.marketplaces.map((record) => record.marketplace));
  for (const [index, plugin] of document.plugins.entries()) {
    const marketplace = plugin.plugin.slice(plugin.plugin.lastIndexOf("@") + 1);
    if (!snapshots.has(MarketplaceNameSchema.parse(marketplace))) addIssue(context, ["plugins", index, "plugin"], "installed plugin must have a corresponding marketplace snapshot");
  }
});
export type InstalledUserStateDocument = z.infer<typeof InstalledUserStateDocumentSchema>;

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input);
}

function parseScope(input: unknown): ScopeReference {
  return ScopeReferenceSchema.parse(input ?? { kind: "user" });
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, JsonValue>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key]!) ]));
  }
  return value;
}

function evidenceFingerprint(tag: string, value: JsonValue, sha256: Sha256): ContentDigest {
  return hashContent(new TextEncoder().encode(`${tag}\0${JSON.stringify(canonicalize(value))}`), sha256);
}

function sourceEvidence(source: ResolvedPluginSource, input: Readonly<{
  marketplaceSourceIdentity?: StableSourceIdentity;
  pluginSourceIdentity?: StableSourceIdentity;
  declaredVersion?: string;
}> = {}): InstalledSourceEvidence {
  const metadata = {
    ...(input.marketplaceSourceIdentity === undefined ? {} : { marketplaceSourceIdentity: input.marketplaceSourceIdentity }),
    ...(input.pluginSourceIdentity === undefined ? {} : { pluginSourceIdentity: input.pluginSourceIdentity }),
    ...(input.declaredVersion === undefined ? {} : { declaredVersion: input.declaredVersion }),
    ...((input.marketplaceSourceIdentity === undefined && input.pluginSourceIdentity === undefined && input.declaredVersion === undefined) ? {} : {
      sourceRevision: source.kind === "marketplace-path" ? source.marketplaceRevision : source.kind === "npm" ? source.version : source.revision,
    }),
  };
  switch (source.kind) {
    case "marketplace-path": return { kind: source.kind, sourceHash: source.hash, marketplaceRevision: source.marketplaceRevision, ...metadata };
    case "git":
    case "git-subdir": return { kind: source.kind, sourceHash: source.hash, revision: source.revision, ...metadata };
    case "npm": return { kind: source.kind, sourceHash: source.hash, ...metadata };
  }
}

function marketplaceSourceEvidence(source: ResolvedMarketplaceSource): MarketplaceSourceEvidence {
  return { kind: source.declared.kind, sourceHash: source.hash, revision: source.revision };
}

function sourceIdentity(source: InstalledSourceEvidence): JsonValue {
  return JSON.parse(JSON.stringify(source)) as JsonValue;
}

function componentEvidence(plugin: NormalizedPlugin): InstalledComponentEvidence[] {
  return flattenComponents(plugin.components)
    .map((component) => ({ id: component.id, kind: component.kind }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function compatibilitySurface(report: CompatibilityReport): JsonValue {
  return {
    activatable: report.activatable,
    components: report.components.map((component) => ({
      componentId: component.componentId,
      verdict: component.verdict,
      requirementIds: [...component.requirementIds].sort(),
    })).sort((left, right) => left.componentId.localeCompare(right.componentId)),
    requirements: report.requirements.map((requirement) => ({
      id: requirement.requirement.id,
      status: requirement.status,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function samePluginIdentity(
  left: NormalizedPlugin["identity"],
  right: CompatibilityReport["plugin"],
): boolean {
  return left.key === right.key &&
    left.marketplaceName === right.marketplaceName &&
    left.marketplaceEntryName === right.marketplaceEntryName &&
    left.manifestName === right.manifestName;
}

function pluginRevisionIdentity(
  scope: ScopeReference,
  evidence: InstalledEvidenceSummary,
  contentDigest: ContentDigest,
  binding: ContentDigest,
): Record<string, JsonValue> {
  return {
    scope,
    plugin: evidence.plugin.key,
    source: sourceIdentity(evidence.source),
    content: contentDigest,
    binding,
  };
}

/**
 * Persistent data belongs to the scope and plugin, not to an immutable
 * revision. Updates therefore reuse the same logical data root while content
 * references continue to identify one exact revision.
 */
export function deriveStablePluginDataRef(
  input: Readonly<{ scope: ScopeReference; plugin: PluginKey }>,
  sha256: Sha256,
): PluginDataRef {
  const scope = ScopeReferenceSchema.parse(input.scope);
  const plugin = PluginKeySchema.parse(input.plugin);
  return derivePluginDataRef({ scope, plugin, purpose: "persistent-plugin-data" }, sha256);
}

function pluginDataIdentity(
  scope: ScopeReference,
  evidence: InstalledEvidenceSummary,
  _contentDigest: ContentDigest,
  _binding: ContentDigest,
): Record<string, JsonValue> {
  return {
    scope,
    plugin: evidence.plugin.key,
    purpose: "persistent-plugin-data",
  };
}

function pluginConfigurationIdentity(
  scope: ScopeReference,
  evidence: InstalledEvidenceSummary,
  contentDigest: ContentDigest,
  binding: ContentDigest,
): Record<string, JsonValue> {
  return { ...pluginRevisionIdentity(scope, evidence, contentDigest, binding), purpose: "plugin-configuration" };
}

const MarketplaceSnapshotInputSchema = z.object({
  marketplace: MarketplaceNameSchema,
  source: ResolvedMarketplaceSourceSchema,
  content: z.unknown(),
  binding: ContentDigestSchema.optional(),
  contentRef: MarketplaceContentRefSchema.optional(),
}).strict();

const PersistedMarketplaceSnapshotInputSchema = MarketplaceSnapshotRecordSchema;

/** Verify raw marketplace evidence, then retain only safe fingerprints and refs. */
export function createMarketplaceSnapshotRecord(input: unknown, sha256: Sha256): MarketplaceSnapshotRecord {
  if (isRecord(input) && isRecord(input.source) && "sourceHash" in input.source) {
    const value = PersistedMarketplaceSnapshotInputSchema.parse(input);
    const identity = { marketplace: value.marketplace, source: value.source, content: value.contentDigest, binding: value.binding } satisfies Record<string, JsonValue>;
    const contentRef = deriveMarketplaceContentRef(identity, sha256);
    if (value.contentRef !== contentRef) throw new Error("marketplace content reference does not match its evidence");
    return value;
  }

  const value = MarketplaceSnapshotInputSchema.parse(input);
  const source = verifyResolvedMarketplaceSource(value.source, sha256);
  const content = verifyContentManifest(ContentManifestSchema.parse(value.content), sha256);
  const binding = createMaterializationBinding(source.hash, content.rootDigest, sha256);
  if (value.binding !== undefined && value.binding !== binding) throw new Error("marketplace materialization binding does not match source and content");
  const identity = { marketplace: value.marketplace, source: marketplaceSourceEvidence(source), content: content.rootDigest, binding } satisfies Record<string, JsonValue>;
  const contentRef = deriveMarketplaceContentRef(identity, sha256);
  if (value.contentRef !== undefined) verifyMarketplaceContentRef(value.contentRef, identity, sha256);
  return MarketplaceSnapshotRecordSchema.parse({
    marketplace: value.marketplace,
    source: marketplaceSourceEvidence(source),
    contentDigest: content.rootDigest,
    binding,
    contentRef,
  });
}

const InstalledRevisionRawInputSchema = z.object({
  revision: ContentDigestSchema.optional(),
  plugin: NormalizedPluginSchema,
  compatibility: CompatibilityReportSchema,
  content: ContentManifestSchema,
  contentRef: PluginContentRefSchema.optional(),
  dataRef: PluginDataRefSchema.optional(),
  configurationRef: PluginConfigurationRefSchema.optional(),
  scope: ScopeReferenceSchema.optional(),
  marketplaceSourceIdentity: StableSourceIdentitySchema.optional(),
  pluginSourceIdentity: StableSourceIdentitySchema.optional(),
  declaredVersion: z.string().min(1).optional(),
}).strict();

function createEvidenceSummary(plugin: NormalizedPlugin, compatibility: CompatibilityReport, sha256: Sha256, input: Readonly<{
  marketplaceSourceIdentity?: StableSourceIdentity;
  pluginSourceIdentity?: StableSourceIdentity;
  declaredVersion?: string;
}> = {}): InstalledEvidenceSummary {
  const components = componentEvidence(plugin);
  const componentIds = new Set(components.map((component) => component.id));
  const assessedIds = new Set(compatibility.components.map((component) => component.componentId));
  if (componentIds.size !== assessedIds.size || [...componentIds].some((id) => !assessedIds.has(id))) {
    throw new Error("compatibility report component inventory does not match normalized plugin evidence");
  }
  return InstalledEvidenceSummarySchema.parse({
    plugin: {
      key: plugin.identity.key,
      marketplaceName: plugin.identity.marketplaceName,
      marketplaceEntryName: plugin.identity.marketplaceEntryName,
    },
    source: sourceEvidence(plugin.source, input),
    components,
    compatibility: {
      activatable: compatibility.activatable,
      fingerprint: evidenceFingerprint("compatibility-evidence-v1", compatibilitySurface(compatibility), sha256),
    },
    trust: {
      executableSurfaceDigest: digestExecutableSurface(
        createExecutableSurface(plugin, compatibility),
        sha256,
      ),
    },
  });
}

function persistedRevisionValue(input: Record<string, unknown>): Record<string, unknown> {
  const { scope: _scope, ...value } = input;
  return value;
}

function verifyPersistedRevision(input: unknown, scope: ScopeReference, sha256: Sha256): InstalledRevisionRecord {
  const record = InstalledRevisionRecordSchema.parse(input);
  const revisionIdentity = pluginRevisionIdentity(scope, record.evidence, record.contentDigest, record.revision);
  const dataIdentity = pluginDataIdentity(scope, record.evidence, record.contentDigest, record.revision);
  verifyPluginContentRef(record.contentRef, revisionIdentity, sha256);
  verifyPluginDataRef(record.dataRef, dataIdentity, sha256);
  if (record.configurationRef !== undefined) {
    verifyPluginConfigurationRef(record.configurationRef, pluginConfigurationIdentity(scope, record.evidence, record.contentDigest, record.revision), sha256);
  }
  return record;
}

/** Verify a persisted safe record and all scope-bound immutable references. */
export function verifyInstalledRevisionRecord(input: unknown, sha256: Sha256): InstalledRevisionRecord {
  const value = isRecord(input) ? input : {};
  return verifyPersistedRevision(persistedRevisionValue(value), parseScope(value.scope), sha256);
}

/** Verify an installed record without accepting runtime declarations as state. */
export function verifyInstalledPluginRecord(input: unknown, sha256: Sha256): InstalledPluginRecord {
  const value = isRecord(input) ? input : {};
  const scope = parseScope(value.scope);
  const record = z.object({
    plugin: PluginKeySchema,
    activation: ActivationIntentSchema,
    selectedRevision: ContentDigestSchema,
    revisions: z.array(z.unknown()).min(1),
    pendingTransition: PendingTransitionRefSchema.optional(),
  }).strict().parse(persistedRevisionValue(value));
  const revisions = record.revisions.map((revision) => verifyPersistedRevision(revision, scope, sha256));
  return InstalledPluginRecordSchema.parse({ ...record, revisions });
}

/** Verify canonical plugin evidence and derive all safe persisted evidence. */
export function createInstalledRevisionRecord(input: unknown, sha256: Sha256): InstalledRevisionRecord {
  if (isRecord(input) && "evidence" in input) {
    return verifyInstalledRevisionRecord(input, sha256);
  }
  const value = InstalledRevisionRawInputSchema.parse(input);
  const plugin = NormalizedPluginSchema.parse(value.plugin);
  const source = verifyResolvedPluginSource(plugin.source, sha256);
  const compatibility = CompatibilityReportSchema.parse(value.compatibility);
  if (!samePluginIdentity(plugin.identity, compatibility.plugin)) throw new Error("compatibility report identity does not match normalized plugin identity");
  const content = verifyContentManifest(value.content, sha256);
  const revision = createMaterializationBinding(source.hash, content.rootDigest, sha256);
  if (value.revision !== undefined && value.revision !== revision) throw new Error("installed revision does not match the source/content materialization binding");
  const scope = parseScope(value.scope);
  const evidence = createEvidenceSummary({ ...plugin, source }, compatibility, sha256, {
    ...(value.marketplaceSourceIdentity === undefined ? {} : { marketplaceSourceIdentity: value.marketplaceSourceIdentity }),
    ...(value.pluginSourceIdentity === undefined ? {} : { pluginSourceIdentity: value.pluginSourceIdentity }),
    ...(value.declaredVersion === undefined ? {} : { declaredVersion: value.declaredVersion }),
  });
  const revisionIdentity = pluginRevisionIdentity(scope, evidence, content.rootDigest, revision);
  const dataIdentity = {
    scope,
    plugin: evidence.plugin.key,
    purpose: "persistent-plugin-data",
  } satisfies Record<string, JsonValue>;
  const configurationIdentity = pluginConfigurationIdentity(scope, evidence, content.rootDigest, revision);
  const contentRef = derivePluginContentRef(revisionIdentity, sha256);
  const dataRef = derivePluginDataRef(dataIdentity, sha256);
  const configurationRef = value.configurationRef !== undefined || plugin.configuration.options.length > 0
    ? derivePluginConfigurationRef(configurationIdentity, sha256)
    : undefined;
  if (value.contentRef !== undefined) verifyPluginContentRef(value.contentRef, revisionIdentity, sha256);
  if (value.dataRef !== undefined) verifyPluginDataRef(value.dataRef, dataIdentity, sha256);
  if (value.configurationRef !== undefined) verifyPluginConfigurationRef(value.configurationRef, configurationIdentity, sha256);
  return InstalledRevisionRecordSchema.parse({
    revision,
    evidence,
    contentDigest: content.rootDigest,
    contentRef,
    dataRef,
    ...(configurationRef === undefined ? {} : { configurationRef }),
  });
}

const InstalledPluginInputSchema = z.object({
  plugin: PluginKeySchema,
  activation: ActivationIntentSchema,
  selectedRevision: ContentDigestSchema.optional(),
  revisions: z.array(z.unknown()).min(1),
  pendingTransition: PendingTransitionRefSchema.optional(),
  scope: ScopeReferenceSchema.optional(),
}).strict();

/** Construct one plugin record while isolating scope-only constructor input. */
export function createInstalledPluginRecord(input: unknown, sha256: Sha256): InstalledPluginRecord {
  const value = InstalledPluginInputSchema.parse(input);
  const scope = parseScope(value.scope);
  // Match the state codec's canonical set ordering before a record enters a
  // transition. Otherwise a successful commit can appear ambiguous solely
  // because the durable decoder sorts the same revisions by digest.
  const revisions = value.revisions.map((revision) =>
    createInstalledRevisionRecord({ ...(revision as Record<string, unknown>), scope }, sha256),
  ).sort((left, right) => compareUtf8(left.revision, right.revision));
  const selectedRevision = value.selectedRevision ?? revisions[0]!.revision;
  return InstalledPluginRecordSchema.parse({
    plugin: value.plugin,
    activation: value.activation,
    selectedRevision,
    revisions,
    ...(value.pendingTransition === undefined ? {} : { pendingTransition: value.pendingTransition }),
  });
}

const InstalledUserStateInputSchema = z.object({
  schemaVersion: z.literal(2).optional(),
  generation: GenerationSchema,
  marketplaces: z.array(z.unknown()),
  plugins: z.array(z.unknown()),
}).strict();

/** Build a complete user document; malformed known records fail the write. */
export function createInstalledUserStateDocument(input: unknown, sha256: Sha256): InstalledUserStateDocument {
  const value = InstalledUserStateInputSchema.parse(input);
  const marketplaces = value.marketplaces.map((marketplace) => createMarketplaceSnapshotRecord(marketplace, sha256));
  const plugins = value.plugins.map((plugin) =>
    createInstalledPluginRecord({ ...(plugin as Record<string, unknown>), scope: { kind: "user" } }, sha256),
  );
  return InstalledUserStateDocumentSchema.parse({ schemaVersion: 2, generation: value.generation, marketplaces, plugins });
}

export type InstalledRecordQuarantine = Readonly<{
  index: number;
  recordKey?: string;
  code: "RECORD_INVALID" | "RECORD_DUPLICATE";
}>;
export type InstalledRecordCollectionDecode = Readonly<{
  records: readonly InstalledPluginRecord[];
  quarantined: readonly InstalledRecordQuarantine[];
}>;

function candidatePluginKey(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const candidate = input.plugin;
  return typeof candidate === "string" && PluginKeySchema.safeParse(candidate).success ? candidate : undefined;
}

/** Decode plugin records independently; an unidentified record is document-fatal. */
export function decodeInstalledPluginRecords(input: unknown, sha256: Sha256): InstalledRecordCollectionDecode {
  if (!Array.isArray(input)) throw new Error("installed plugin collection must be an array");
  const parsed: Array<{ readonly index: number; readonly key: string; readonly record: InstalledPluginRecord }> = [];
  const quarantined: InstalledRecordQuarantine[] = [];
  const occurrences = new Map<string, number>();
  for (const candidate of input) {
    const key = candidatePluginKey(candidate);
    if (key === undefined) throw new Error("installed plugin record identity is missing or invalid");
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }
  for (const [index, candidate] of input.entries()) {
    const key = candidatePluginKey(candidate)!;
    try {
      const record = createInstalledPluginRecord(candidate, sha256);
      parsed.push({ index, key, record });
    } catch {
      quarantined.push({ index, recordKey: key, code: "RECORD_INVALID" });
    }
  }
  const records: InstalledPluginRecord[] = [];
  for (const candidate of parsed) {
    if (occurrences.get(candidate.key)! > 1) {
      quarantined.push({ index: candidate.index, recordKey: candidate.key, code: "RECORD_DUPLICATE" });
    } else {
      records.push(candidate.record);
    }
  }
  return { records, quarantined: quarantined.sort((left, right) => left.index - right.index) };
}

/** Decode a user plugin collection with the same duplicate-quarantine policy. */
export function decodeInstalledUserPlugins(input: unknown, sha256: Sha256): InstalledRecordCollectionDecode {
  if (!Array.isArray(input)) throw new Error("installed plugin collection must be an array");
  const withUserScope = input.map((value) =>
    isRecord(value) ? { ...value, scope: { kind: "user" } } : value,
  );
  return decodeInstalledPluginRecords(withUserScope, sha256);
}

export type { MarketplaceName, ResolvedMarketplaceSource, ResolvedPluginSource };
export type {
  MarketplaceContentRef,
  PendingTransitionRef,
  PluginConfigurationRef,
  PluginContentRef,
  PluginDataRef,
  ContentDigest,
  ContentManifest,
};
