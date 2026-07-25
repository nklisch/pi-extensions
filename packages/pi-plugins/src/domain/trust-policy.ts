import { z } from "zod";
import {
  createExecutableSurface,
  digestExecutableSurface,
  ExecutableSurfaceSchema,
  type ExecutableSurface,
  type ExecutableSurfaceEntry,
} from "./executable-surface.js";
import {
  CompatibilityReportSchema,
  type CompatibilityReport,
} from "./compatibility.js";
import {
  createMaterializationBinding,
  verifyContentManifest,
  type ContentDigest,
  type ContentManifest,
} from "./content-manifest.js";
import {
  NormalizedPluginSchema,
  type NormalizedPlugin,
} from "./plugin.js";
import {
  verifyResolvedMarketplaceSource,
  verifyResolvedPluginSource,
  type ResolvedMarketplaceSource,
  type ResolvedPluginSource,
  type Sha256,
} from "./source.js";
import {
  TrustSubjectEvidenceSchema,
  TrustDecisionStatusSchema,
  createTrustStateRecord,
  deriveTrustSubject,
  verifyTrustStateRecord,
  type TrustSubjectEvidence,
  type TrustStateRecord,
} from "./state/trust-state.js";
import {
  TrustSubjectRefSchema,
  type TrustSubjectRef,
} from "./state/references.js";
import { ScopeReferenceSchema, type ScopeReference } from "./state/scope.js";
import { type PluginKey } from "./identity.js";

export const TrustCandidateSchema = z.object({
  subject: TrustSubjectRefSchema,
  evidence: TrustSubjectEvidenceSchema,
  surface: ExecutableSurfaceSchema,
}).strict().readonly();
export type TrustCandidate = z.infer<typeof TrustCandidateSchema>;

export const TrustDecisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("authorized"),
    subject: TrustSubjectRefSchema,
  }).strict().readonly(),
  z.object({
    kind: z.literal("denied"),
    reason: z.enum(["ABSENT", "REVOKED", "EVIDENCE_MISMATCH"]),
  }).strict().readonly(),
]);
export type TrustDecision = z.infer<typeof TrustDecisionSchema>;

const TrustSurfaceSummarySchema = z.object({
  kind: z.enum(["skill", "hook", "mcp-server", "configuration"]),
  identity: z.string().min(1),
}).strict().readonly();
export type TrustSurfaceSummary = z.infer<typeof TrustSurfaceSummarySchema>;

const TrustSurfaceChangeSchema = z.object({
  kind: z.enum(["skill", "hook", "mcp-server", "configuration"]),
  identity: z.string().min(1),
  changedFields: z.array(z.string().min(1)).nonempty().readonly(),
}).strict().readonly();
export type TrustSurfaceChange = z.infer<typeof TrustSurfaceChangeSchema>;

export const TrustChangeDescriptionSchema = z.object({
  marketplaceSourceChanged: z.boolean(),
  pluginSourceChanged: z.boolean(),
  sourceIdentityChanged: z.boolean(),
  revisionChanged: z.boolean(),
  executableSurfaceChanged: z.boolean(),
  added: z.array(TrustSurfaceSummarySchema).readonly(),
  removed: z.array(TrustSurfaceSummarySchema).readonly(),
  changed: z.array(TrustSurfaceChangeSchema).readonly(),
  configurationDescriptorChanges: z.array(TrustSurfaceChangeSchema).readonly(),
}).strict().readonly();
export type TrustChangeDescription = z.infer<typeof TrustChangeDescriptionSchema>;

function samePluginIdentity(plugin: NormalizedPlugin, report: CompatibilityReport): boolean {
  return plugin.identity.key === report.plugin.key &&
    plugin.identity.marketplaceName === report.plugin.marketplaceName &&
    plugin.identity.marketplaceEntryName === report.plugin.marketplaceEntryName &&
    plugin.identity.manifestName === report.plugin.manifestName;
}

function createEvidence(
  scope: ScopeReference,
  marketplaceSource: ResolvedMarketplaceSource,
  pluginSource: ResolvedPluginSource,
  plugin: NormalizedPlugin,
  surface: ExecutableSurface,
  materializationBinding: ContentDigest,
  sha256: Sha256,
): TrustSubjectEvidence {
  const evidence = TrustSubjectEvidenceSchema.parse({
    plugin: plugin.identity.key,
    scope,
    marketplaceSource: marketplaceSource.canonical,
    pluginSource: pluginSource.canonical,
    immutableRevision: materializationBinding,
    executableSurfaceDigest: digestExecutableSurface(surface, sha256),
  });
  return evidence;
}

/**
 * Verify every input that can affect an exact trust subject before deriving the
 * subject. The optional binding is a caller assertion, never an authority.
 */
export function createTrustCandidate(
  input: Readonly<{
    scope: ScopeReference;
    marketplaceSource: ResolvedMarketplaceSource;
    plugin: NormalizedPlugin;
    compatibility: CompatibilityReport;
    content: ContentManifest;
    materializationBinding?: ContentDigest;
  }>,
  sha256: Sha256,
): TrustCandidate {
  const scope = ScopeReferenceSchema.parse(input.scope);
  const marketplaceSource = verifyResolvedMarketplaceSource(input.marketplaceSource, sha256);
  const plugin = NormalizedPluginSchema.parse(input.plugin);
  const pluginSource = verifyResolvedPluginSource(plugin.source, sha256);
  const compatibility = CompatibilityReportSchema.parse(input.compatibility);
  if (!samePluginIdentity(plugin, compatibility)) {
    throw new Error("compatibility report identity does not match plugin");
  }
  const content = verifyContentManifest(input.content, sha256);
  const binding = createMaterializationBinding(pluginSource.hash, content.rootDigest, sha256);
  if (input.materializationBinding !== undefined && input.materializationBinding !== binding) {
    throw new Error("materialization binding does not match source and content");
  }
  if (
    pluginSource.kind === "marketplace-path" &&
    pluginSource.marketplaceRevision !== marketplaceSource.revision
  ) {
    throw new Error("marketplace-relative plugin source does not match marketplace revision");
  }
  const surface = createExecutableSurface(plugin, compatibility);
  const evidence = createEvidence(
    scope,
    marketplaceSource,
    pluginSource,
    plugin,
    surface,
    binding,
    sha256,
  );
  const subject = deriveTrustSubject(evidence, sha256);
  return TrustCandidateSchema.parse({ subject, evidence, surface });
}

/** Verify all derived evidence in a candidate, including persisted digests. */
export function verifyTrustCandidate(
  input: unknown,
  sha256: Sha256,
): TrustCandidate {
  const candidate = TrustCandidateSchema.parse(input);
  const evidence = TrustSubjectEvidenceSchema.parse(candidate.evidence);
  const surface = ExecutableSurfaceSchema.parse(candidate.surface);
  if (digestExecutableSurface(surface, sha256) !== evidence.executableSurfaceDigest) {
    throw new Error("trust candidate executable surface digest does not match evidence");
  }
  if (deriveTrustSubject(evidence, sha256) !== candidate.subject) {
    throw new Error("trust candidate subject does not match evidence");
  }
  return candidate;
}

function sameEvidence(left: TrustSubjectEvidence, right: TrustSubjectEvidence): boolean {
  return left.plugin === right.plugin &&
    left.scope.kind === right.scope.kind &&
    (left.scope.kind === "user" ||
      (right.scope.kind === "project" && left.scope.projectKey === right.scope.projectKey)) &&
    left.marketplaceSource === right.marketplaceSource &&
    left.pluginSource === right.pluginSource &&
    left.immutableRevision === right.immutableRevision &&
    left.executableSurfaceDigest === right.executableSurfaceDigest;
}

/** Evaluate only an exact, verified subject; no name/source/revision fallback exists. */
export function evaluateTrust(
  candidateInput: TrustCandidate,
  records: readonly TrustStateRecord[],
  sha256: Sha256,
): TrustDecision {
  let candidate: TrustCandidate;
  try {
    candidate = verifyTrustCandidate(candidateInput, sha256);
  } catch {
    return { kind: "denied", reason: "EVIDENCE_MISMATCH" };
  }

  const validRecords: TrustStateRecord[] = [];
  const subjects = new Set<string>();
  try {
    for (const raw of records) {
      const record = verifyTrustStateRecord(raw, sha256);
      if (subjects.has(record.subject)) {
        return { kind: "denied", reason: "EVIDENCE_MISMATCH" };
      }
      subjects.add(record.subject);
      validRecords.push(record);
    }
  } catch {
    return { kind: "denied", reason: "EVIDENCE_MISMATCH" };
  }

  const record = validRecords.find((entry) => entry.subject === candidate.subject);
  if (record === undefined) return { kind: "denied", reason: "ABSENT" };
  if (!sameEvidence(record.evidence, candidate.evidence)) {
    return { kind: "denied", reason: "EVIDENCE_MISMATCH" };
  }
  if (record.status === "revoked") return { kind: "denied", reason: "REVOKED" };
  return { kind: "authorized", subject: candidate.subject };
}

function createTrustRecord(
  candidateInput: TrustCandidate,
  status: z.infer<typeof TrustDecisionStatusSchema>,
  sha256: Sha256,
): TrustStateRecord {
  const candidate = verifyTrustCandidate(candidateInput, sha256);
  return createTrustStateRecord({
    subject: candidate.subject,
    evidence: candidate.evidence,
    status,
  }, sha256);
}

/** Return a proposed exact grant record; persistence is owned by state services. */
export function grantTrust(candidate: TrustCandidate, sha256: Sha256): TrustStateRecord {
  return createTrustRecord(candidate, "granted", sha256);
}

/** Return a proposed exact revocation record; sibling subjects remain untouched. */
export function revokeTrust(candidate: TrustCandidate, sha256: Sha256): TrustStateRecord {
  return createTrustRecord(candidate, "revoked", sha256);
}

function entryIdentity(entry: ExecutableSurfaceEntry): string {
  switch (entry.kind) {
    case "skill":
    case "hook":
    case "mcp-server":
      return entry.id;
    case "configuration":
      return entry.key;
    default:
      return assertNever(entry);
  }
}

function changedFields(left: ExecutableSurfaceEntry, right: ExecutableSurfaceEntry): string[] {
  const fields = new Set([...Object.keys(left), ...Object.keys(right)]);
  fields.delete("kind");
  fields.delete("id");
  fields.delete("key");
  return [...fields].filter((field) =>
    JSON.stringify((left as Record<string, unknown>)[field]) !==
    JSON.stringify((right as Record<string, unknown>)[field]),
  ).sort();
}

function summary(entry: ExecutableSurfaceEntry): TrustSurfaceSummary {
  return { kind: entry.kind, identity: entryIdentity(entry) };
}

/**
 * Produce presentation metadata from safe canonical fields only. This function
 * intentionally accepts candidates, never configured values or secret locators.
 */
export function describeTrustChange(
  previous: TrustCandidate | undefined,
  candidateInput: TrustCandidate,
  sha256: Sha256,
): TrustChangeDescription {
  const candidate = verifyTrustCandidate(candidateInput, sha256);
  const prior = previous === undefined ? undefined : verifyTrustCandidate(previous, sha256);
  const marketplaceSourceChanged = prior !== undefined &&
    prior.evidence.marketplaceSource !== candidate.evidence.marketplaceSource;
  const pluginSourceChanged = prior !== undefined &&
    prior.evidence.pluginSource !== candidate.evidence.pluginSource;
  const revisionChanged = prior !== undefined &&
    prior.evidence.immutableRevision !== candidate.evidence.immutableRevision;
  const executableSurfaceChanged = prior === undefined
    ? candidate.evidence.executableSurfaceDigest !== ""
    : prior.evidence.executableSurfaceDigest !== candidate.evidence.executableSurfaceDigest;

  const previousByIdentity = new Map(
    (prior?.surface.entries ?? []).map((entry) => [entryIdentity(entry), entry]),
  );
  const currentByIdentity = new Map(candidate.surface.entries.map((entry) => [entryIdentity(entry), entry]));
  const added: TrustSurfaceSummary[] = [];
  const removed: TrustSurfaceSummary[] = [];
  const changed: TrustSurfaceChange[] = [];
  for (const entry of candidate.surface.entries) {
    const priorEntry = previousByIdentity.get(entryIdentity(entry));
    if (priorEntry === undefined) {
      added.push(summary(entry));
      continue;
    }
    const fields = changedFields(priorEntry, entry);
    if (fields.length > 0) changed.push({ ...summary(entry), changedFields: fields });
  }
  for (const entry of prior?.surface.entries ?? []) {
    if (!currentByIdentity.has(entryIdentity(entry))) removed.push(summary(entry));
  }

  const configurationDescriptorChanges = changed.filter((entry) => entry.kind === "configuration");
  return TrustChangeDescriptionSchema.parse({
    marketplaceSourceChanged,
    pluginSourceChanged,
    sourceIdentityChanged: marketplaceSourceChanged || pluginSourceChanged,
    revisionChanged,
    executableSurfaceChanged,
    added,
    removed,
    changed,
    configurationDescriptorChanges,
  });
}

export type {
  ContentDigest,
  PluginKey,
  ScopeReference,
  TrustSubjectEvidence,
  TrustSubjectRef,
  TrustStateRecord,
};

function assertNever(value: never): never {
  throw new Error(`unhandled trust surface variant: ${String(value)}`);
}
