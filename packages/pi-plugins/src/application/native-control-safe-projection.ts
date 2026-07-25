import { z } from "zod";
import { AdoptionCandidateIdSchema, AdoptionDocumentKindSchema } from "../domain/adoption.js";
import { ErrorCodeSchema } from "../domain/error-contract.js";
import { MarketplaceNameSchema, PluginKeySchema, PluginNameSchema } from "../domain/identity.js";
import {
  MarketplaceCandidateIdSchema,
  MarketplaceCursorSchema,
  MarketplaceRegistrationIdSchema,
  MarketplaceSnapshotTokenSchema,
} from "../domain/marketplace-registration.js";
import { MarketplaceAvailabilitySchema } from "../domain/marketplace.js";
import { SourceHashSchema } from "../domain/source.js";
import { ScopeReferenceSchema } from "../domain/state/scope.js";
import {
  MarketplaceRegistrationOriginSchema,
  MarketplaceRefreshAttemptSchema,
  MarketplaceRefreshMemorySchema,
  UpdateApplicationPreferenceSchema,
} from "../domain/update-policy.js";
import {
  MarketplaceCacheStatusSchema,
  MarketplaceSelectedSnapshotViewSchema,
  type MarketplaceRegistrationView,
} from "./marketplace-management-contract.js";
import { CatalogAvailableRevisionSchema, MarketplaceCatalogObservationSchema } from "./marketplace-catalog-contract.js";
import { NotificationIntentSchema, PluginUpdateOutcomeSchema } from "./update-contract.js";
import {
  NativeRedactedUrlSchema,
  NativeSourceViewSchema,
  SafeDisplayFieldSchema,
  type NativeSourceView,
} from "./native-inspection-contract.js";
import { projectSafeSource } from "./native-inspection-disclosure.js";
import { toSafeDisplayField } from "./native-inspection-display.js";

const StableCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);

export const NativeControlHelpAliasSchema = z.object({
  path: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).max(8).readonly(),
  deprecatedSince: z.literal("plugin-control/v1").optional(),
  replacement: z.string().max(256).optional(),
  removeInMajor: z.number().int().positive().optional(),
}).strict().readonly();

export const NativeControlHelpOptionViewSchema = z.object({
  name: z.string().regex(/^--[a-z][a-z0-9-]*$/),
  kind: z.enum(["flag", "string", "integer", "enum", "repeatable"]),
  values: z.array(z.string().max(256)).readonly().optional(),
  required: z.boolean(),
  deprecatedSince: z.literal("plugin-control/v1").optional(),
  replacement: z.string().max(256).optional(),
  removeInMajor: z.number().int().positive().optional(),
}).strict().readonly();

export const NativeControlHelpCommandViewSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9.-]*$/),
  path: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).max(8).readonly(),
  aliases: z.array(NativeControlHelpAliasSchema).readonly(),
  summary: SafeDisplayFieldSchema,
  safety: z.enum(["pure", "local-read", "remote-read", "mutation", "operation-control"]),
  input: z.enum(["none", "confirmation", "configuration", "decision"]),
  positionals: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    required: z.boolean(),
    repeatable: z.boolean(),
  }).strict().readonly()).readonly(),
  options: z.array(NativeControlHelpOptionViewSchema).readonly(),
}).strict().readonly();

export const NativeControlHelpResponseSchema = z.object({
  grammarVersion: z.literal("plugin-control/v1"),
  path: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).max(8).readonly(),
  commands: z.array(NativeControlHelpCommandViewSchema).max(128).readonly(),
}).strict().readonly();

export const NativeControlGrammarResponseSchema = z.object({
  grammarVersion: z.literal("plugin-control/v1"),
  envelopeVersion: z.literal(1),
  commands: z.array(NativeControlHelpCommandViewSchema).max(128).readonly(),
}).strict().readonly();

export const NativeControlPresentationResponseSchema = NativeControlGrammarResponseSchema;

/**
 * The existing inspection source view is the common source disclosure shape.
 * Control output further removes local paths and private remote host names,
 * because machine output is commonly retained in logs outside the Pi session.
 */
export function projectNativeControlSource(source: Parameters<typeof projectSafeSource>[0]): NativeSourceView {
  const safe = projectSafeSource(source);
  if (safe.kind === "local-git") {
    return NativeSourceViewSchema.parse({ kind: safe.kind, ...(safe.identity === undefined ? {} : { identity: safe.identity }), ...(safe.revision === undefined ? {} : { revision: safe.revision }) });
  }
  if (safe.endpoint === undefined) return safe;
  const host = safe.endpoint.host.text.toLowerCase();
  const privateHost = safe.endpoint.scheme === "ssh" && (
    host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") ||
    /^127\./u.test(host) || /^10\./u.test(host) || /^192\.168\./u.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host) || host === "::1" || !host.includes(".")
  );
  if (!privateHost) return safe;
  return NativeSourceViewSchema.parse({
    ...safe,
    endpoint: NativeRedactedUrlSchema.parse({
      ...safe.endpoint,
      host: toSafeDisplayField("[redacted-private-host]", { maxScalars: 256 }),
    }),
  });
}

export const NativeControlMarketplaceRegistrationSchema = z.object({
  id: MarketplaceRegistrationIdSchema,
  scope: ScopeReferenceSchema,
  marketplace: MarketplaceNameSchema,
  source: NativeSourceViewSchema,
  sourceIdentity: SourceHashSchema,
  origin: MarketplaceRegistrationOriginSchema,
  updateApplication: UpdateApplicationPreferenceSchema,
  refresh: MarketplaceRefreshMemorySchema,
  lastAttempt: MarketplaceRefreshAttemptSchema.optional(),
  selected: MarketplaceSelectedSnapshotViewSchema.optional(),
  cache: MarketplaceCacheStatusSchema,
}).strict().readonly();

function projectRegistration(registration: MarketplaceRegistrationView) {
  return NativeControlMarketplaceRegistrationSchema.parse({
    ...registration,
    source: projectNativeControlSource(registration.source),
  });
}

export const NativeControlMarketplaceAddResponseSchema = z.union([
  z.object({ kind: z.enum(["added", "unchanged"]), registration: NativeControlMarketplaceRegistrationSchema }).strict().readonly(),
  z.object({ kind: z.literal("rejected"), code: StableCodeSchema }).strict().readonly(),
  z.object({ kind: z.literal("indeterminate"), code: z.literal("COMMIT_AMBIGUOUS"), registrationId: MarketplaceRegistrationIdSchema }).strict().readonly(),
]);

export function projectMarketplaceAddResponse(input: any): unknown {
  return input.kind === "added" || input.kind === "unchanged"
    ? { kind: input.kind, registration: projectRegistration(input.registration) }
    : input;
}

export const NativeControlMarketplaceListResponseSchema = z.object({
  registrations: z.array(NativeControlMarketplaceRegistrationSchema).readonly(),
}).strict().readonly();

export function projectMarketplaceListResponse(input: any): unknown {
  return { registrations: input.registrations.map(projectRegistration) };
}

const NativeControlRefreshOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("refreshed"),
    registrationId: MarketplaceRegistrationIdSchema,
    change: z.enum(["changed", "unchanged"]),
    registration: NativeControlMarketplaceRegistrationSchema,
    plugins: z.array(PluginUpdateOutcomeSchema).readonly(),
  }).strict().readonly(),
  z.object({ kind: z.literal("coalesced"), registrationId: MarketplaceRegistrationIdSchema, claimExpiresAt: z.number().int().nonnegative() }).strict().readonly(),
  z.object({ kind: z.literal("rate-limited"), registrationId: MarketplaceRegistrationIdSchema, nextAt: z.number().int().nonnegative() }).strict().readonly(),
  z.object({ kind: z.literal("skipped-local"), registrationId: MarketplaceRegistrationIdSchema }).strict().readonly(),
  z.object({ kind: z.literal("cancelled"), registrationId: MarketplaceRegistrationIdSchema }).strict().readonly(),
  z.object({ kind: z.literal("failed"), registrationId: MarketplaceRegistrationIdSchema, code: StableCodeSchema, retained: MarketplaceCacheStatusSchema }).strict().readonly(),
  z.object({ kind: z.literal("not-configured"), registrationId: MarketplaceRegistrationIdSchema }).strict().readonly(),
]);

export const NativeControlMarketplaceRefreshResponseSchema = z.object({
  outcomes: z.array(NativeControlRefreshOutcomeSchema).readonly(),
  notifications: z.array(NotificationIntentSchema).readonly(),
}).strict().readonly();

export function projectMarketplaceRefreshResponse(input: any): unknown {
  return {
    ...input,
    outcomes: input.outcomes.map((outcome: any) => outcome.kind === "refreshed"
      ? { ...outcome, registration: projectRegistration(outcome.registration) }
      : outcome),
  };
}

const SafeAdoptionDocumentSchema = z.object({
  kind: z.enum(["missing", "present", "unreadable", "changed-during-read"]),
  document: AdoptionDocumentKindSchema,
  host: z.enum(["claude", "codex"]),
  code: StableCodeSchema.optional(),
}).strict().readonly();

const SafeBoundaryDiagnosticSchema = z.object({
  code: ErrorCodeSchema,
  severity: z.enum(["warning", "error"]),
  plugin: PluginKeySchema.optional(),
}).strict().readonly();

const SafeAdoptionCandidateSchema = z.object({
  id: AdoptionCandidateIdSchema,
  source: NativeSourceViewSchema,
  suggestedMarketplaces: z.array(SafeDisplayFieldSchema).nonempty().readonly(),
  nativeHosts: z.array(z.enum(["claude", "codex"])).nonempty().readonly(),
  comparison: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("not-registered") }).strict().readonly(),
    z.object({ kind: z.literal("already-registered"), registrations: z.array(MarketplaceRegistrationIdSchema).nonempty().readonly(), scopes: z.array(ScopeReferenceSchema).nonempty().readonly() }).strict().readonly(),
  ]),
}).strict().readonly();

export const NativeControlAdoptionPreviewResponseSchema = z.object({
  candidates: z.array(SafeAdoptionCandidateSchema).readonly(),
  documents: z.array(SafeAdoptionDocumentSchema).readonly(),
  diagnostics: z.array(SafeBoundaryDiagnosticSchema).readonly(),
}).strict().readonly();

function projectBoundaryDiagnostics(values: readonly any[]) {
  return values.map((diagnostic) => ({ code: diagnostic.code, severity: diagnostic.severity, ...(diagnostic.plugin === undefined ? {} : { plugin: diagnostic.plugin }) }));
}

export function projectAdoptionPreviewResponse(input: any): unknown {
  return {
    candidates: input.candidates.map((entry: any) => ({
      id: entry.candidate.id,
      source: projectNativeControlSource(entry.candidate.source.value),
      suggestedMarketplaces: entry.candidate.suggestedMarketplaces.map((name: any) => toSafeDisplayField(name.value, { maxScalars: 256 })),
      nativeHosts: entry.candidate.nativeHosts,
      comparison: entry.comparison,
    })),
    documents: input.documents.map((document: any) => ({ kind: document.kind, document: document.document, host: document.host, ...(document.code === undefined ? {} : { code: document.code }) })),
    diagnostics: projectBoundaryDiagnostics(input.diagnostics),
  };
}

const SafeAdoptionImportOutcomeSchema = z.union([
  z.object({ kind: z.enum(["added", "unchanged"]), registration: NativeControlMarketplaceRegistrationSchema }).strict().readonly(),
  z.object({ kind: z.enum(["registered", "unchanged"]), marketplace: MarketplaceNameSchema }).strict().readonly(),
  z.object({ kind: z.literal("rejected"), code: StableCodeSchema }).strict().readonly(),
  z.object({ kind: z.literal("indeterminate"), code: z.literal("COMMIT_AMBIGUOUS"), registrationId: MarketplaceRegistrationIdSchema }).strict().readonly(),
  z.object({ kind: z.enum(["candidate-unavailable", "not-portable", "cancelled-before-start"]) }).strict().readonly(),
]);

export const NativeControlAdoptionImportResponseSchema = z.object({
  outcomes: z.array(z.object({ candidateId: AdoptionCandidateIdSchema, outcome: SafeAdoptionImportOutcomeSchema }).strict().readonly()).readonly(),
  diagnostics: z.array(SafeBoundaryDiagnosticSchema).readonly(),
}).strict().readonly();

export function projectAdoptionImportResponse(input: any): unknown {
  return {
    outcomes: input.outcomes.map((entry: any) => ({
      candidateId: entry.candidateId,
      outcome: entry.outcome.registration === undefined ? entry.outcome : { ...entry.outcome, registration: projectRegistration(entry.outcome.registration) },
    })),
    diagnostics: projectBoundaryDiagnostics(input.diagnostics),
  };
}

const SafeCatalogCandidateSchema = z.object({
  id: MarketplaceCandidateIdSchema,
  snapshot: MarketplaceSnapshotTokenSchema,
  scope: ScopeReferenceSchema,
  registrationId: MarketplaceRegistrationIdSchema,
  plugin: PluginKeySchema,
  marketplace: MarketplaceNameSchema,
  name: PluginNameSchema,
  description: SafeDisplayFieldSchema.optional(),
  available: CatalogAvailableRevisionSchema,
  availability: MarketplaceAvailabilitySchema,
  source: NativeSourceViewSchema,
  sourceIdentity: SourceHashSchema,
  trust: z.literal("untrusted-not-inspected"),
}).strict().readonly();

export const NativeControlMarketplaceCatalogResponseSchema = z.object({
  candidates: z.array(SafeCatalogCandidateSchema).readonly(),
  observations: z.array(MarketplaceCatalogObservationSchema).readonly(),
  nextCursor: MarketplaceCursorSchema.optional(),
}).strict().readonly();

export function projectMarketplaceCatalogResponse(input: any): unknown {
  return {
    candidates: input.candidates.map((candidate: any) => ({
      id: candidate.id,
      snapshot: candidate.snapshot,
      scope: candidate.scope,
      registrationId: candidate.registrationId,
      plugin: candidate.plugin,
      marketplace: candidate.marketplace,
      name: candidate.name,
      ...(candidate.description === undefined ? {} : { description: toSafeDisplayField(candidate.description, { maxScalars: 2048 }) }),
      available: candidate.available,
      availability: candidate.availability,
      source: projectNativeControlSource(candidate.source),
      sourceIdentity: candidate.sourceIdentity,
      trust: candidate.trust,
    })),
    observations: input.observations,
    ...(input.nextCursor === undefined ? {} : { nextCursor: input.nextCursor }),
  };
}
