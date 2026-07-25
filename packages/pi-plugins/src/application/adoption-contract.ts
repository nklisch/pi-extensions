import { z } from "zod";
import {
  AdoptionCandidateIdSchema,
  AdoptionCandidateSchema,
  AdoptionDeclarationSchema,
  AdoptionDocumentKindSchema,
  type AdoptionCandidate,
  type AdoptionCandidateId,
  type AdoptionDeclaration,
  type AdoptionDocumentKind,
} from "../domain/adoption.js";
import { DiagnosticSchema } from "../domain/error-contract.js";
import { MarketplaceNameSchema } from "../domain/identity.js";
import { PortableMarketplaceSourceSchema } from "../domain/state/portable-project-declaration.js";
import { ScopeContextSchema, ScopeReferenceSchema } from "../domain/state/scope.js";
import {
  MarketplaceRegistrationIdSchema,
  MarketplaceScopeSelectionSchema,
} from "../domain/marketplace-registration.js";
import { MarketplaceAddResultSchema } from "./marketplace-management-contract.js";
import { MarketplaceSourceSchema, type MarketplaceSource } from "../domain/source.js";
import type { Diagnostic } from "../domain/error-contract.js";

export const ForeignStateFileObservationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("missing"),
    document: AdoptionDocumentKindSchema,
    host: z.enum(["claude", "codex"]),
    path: z.string().min(1),
  }).strict().readonly(),
  z.object({
    kind: z.literal("present"),
    document: AdoptionDocumentKindSchema,
    host: z.enum(["claude", "codex"]),
    path: z.string().min(1),
    source: z.string(),
  }).strict().readonly(),
  z.object({
    kind: z.literal("unreadable"),
    document: AdoptionDocumentKindSchema,
    host: z.enum(["claude", "codex"]),
    path: z.string().min(1),
    code: z.enum(["SYMLINK", "ESCAPES_ROOT", "NOT_REGULAR", "TOO_LARGE", "INVALID_UTF8", "IO_FAILED"]),
  }).strict().readonly(),
  z.object({
    kind: z.literal("changed-during-read"),
    document: AdoptionDocumentKindSchema,
    host: z.enum(["claude", "codex"]),
    path: z.string().min(1),
  }).strict().readonly(),
]);
export type ForeignStateFileObservation = z.infer<typeof ForeignStateFileObservationSchema>;

/** Discovery exposes status without exposing a foreign document's full text. */
export const AdoptionDocumentStatusSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("missing"),
    document: AdoptionDocumentKindSchema,
    host: z.enum(["claude", "codex"]),
    path: z.string().min(1),
  }).strict().readonly(),
  z.object({
    kind: z.literal("present"),
    document: AdoptionDocumentKindSchema,
    host: z.enum(["claude", "codex"]),
    path: z.string().min(1),
  }).strict().readonly(),
  z.object({
    kind: z.literal("unreadable"),
    document: AdoptionDocumentKindSchema,
    host: z.enum(["claude", "codex"]),
    path: z.string().min(1),
    code: z.enum(["SYMLINK", "ESCAPES_ROOT", "NOT_REGULAR", "TOO_LARGE", "INVALID_UTF8", "IO_FAILED"]),
  }).strict().readonly(),
  z.object({
    kind: z.literal("changed-during-read"),
    document: AdoptionDocumentKindSchema,
    host: z.enum(["claude", "codex"]),
    path: z.string().min(1),
  }).strict().readonly(),
]);
export type AdoptionDocumentStatus = z.infer<typeof AdoptionDocumentStatusSchema>;

export const AdoptionDiscoveryResultSchema = z.object({
  candidates: z.array(AdoptionCandidateSchema).readonly(),
  documents: z.array(AdoptionDocumentStatusSchema).readonly(),
  diagnostics: z.array(DiagnosticSchema).readonly(),
}).strict().readonly();
export type AdoptionDiscoveryResult = z.infer<typeof AdoptionDiscoveryResultSchema>;

export const AdoptionPreviewRequestSchema = z.object({
  compareScope: MarketplaceScopeSelectionSchema.default("all-current"),
}).strict().readonly();
export type AdoptionPreviewRequest = z.infer<typeof AdoptionPreviewRequestSchema>;

export const AdoptionPreviewCandidateSchema = z.object({
  candidate: AdoptionCandidateSchema,
  comparison: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("not-registered") }).strict().readonly(),
    z.object({
      kind: z.literal("already-registered"),
      registrations: z.array(MarketplaceRegistrationIdSchema).nonempty().readonly(),
      scopes: z.array(ScopeReferenceSchema).nonempty().readonly(),
    }).strict().readonly(),
  ]),
}).strict().readonly();
export type AdoptionPreviewCandidate = z.infer<typeof AdoptionPreviewCandidateSchema>;

export const AdoptionPreviewResultSchema = z.object({
  candidates: z.array(AdoptionPreviewCandidateSchema).readonly(),
  documents: z.array(AdoptionDocumentStatusSchema).readonly(),
  diagnostics: z.array(DiagnosticSchema).readonly(),
}).strict().readonly();
export type AdoptionPreviewResult = z.infer<typeof AdoptionPreviewResultSchema>;

export const MarketplaceRegistrationRequestSchema = z.object({
  source: MarketplaceSourceSchema,
  scope: ScopeContextSchema,
  origin: z.literal("adoption"),
}).strict().readonly();
export type MarketplaceRegistrationRequest = z.infer<typeof MarketplaceRegistrationRequestSchema>;

export const MarketplaceRegistrationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("registered"), marketplace: MarketplaceNameSchema }).strict().readonly(),
  z.object({ kind: z.literal("unchanged"), marketplace: MarketplaceNameSchema }).strict().readonly(),
  z.object({
    kind: z.literal("rejected"),
    code: z.enum(["INVALID_SOURCE", "NAME_CONFLICT", "PROJECT_UNTRUSTED", "NOT_PORTABLE", "STALE", "ABORTED", "ADAPTER_FAILED"]),
  }).strict().readonly(),
]);
export type MarketplaceRegistrationResult = z.infer<typeof MarketplaceRegistrationResultSchema>;

function uniqueIds(
  values: readonly AdoptionCandidateId[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      context.addIssue({ code: "custom", path: [index], message: "candidate IDs must be unique" });
    }
    seen.add(value);
  }
}

export const AdoptionSelectionRequestSchema = z.object({
  candidateIds: z.array(AdoptionCandidateIdSchema).min(1).superRefine(uniqueIds).readonly(),
  scope: ScopeContextSchema.default({ kind: "user" }),
}).strict().readonly();
export type AdoptionSelectionRequest = z.infer<typeof AdoptionSelectionRequestSchema>;

export const AdoptionImportRequestSchema = z.object({
  candidateIds: z.array(AdoptionCandidateIdSchema).min(1).superRefine(uniqueIds).readonly(),
  scope: z.enum(["user", "project"]),
}).strict().readonly();
export type AdoptionImportRequest = z.infer<typeof AdoptionImportRequestSchema>;

export const AdoptionImportOutcomeSchema = z.union([
  MarketplaceRegistrationResultSchema,
  MarketplaceAddResultSchema,
  z.object({ kind: z.literal("candidate-unavailable") }).strict().readonly(),
  z.object({ kind: z.literal("not-portable") }).strict().readonly(),
  z.object({ kind: z.literal("cancelled-before-start") }).strict().readonly(),
]);
export type AdoptionImportOutcome = z.infer<typeof AdoptionImportOutcomeSchema>;

export const AdoptionImportResultSchema = z.object({
  outcomes: z.array(z.object({
    candidateId: AdoptionCandidateIdSchema,
    outcome: AdoptionImportOutcomeSchema,
  }).strict().readonly()).readonly(),
  diagnostics: z.array(DiagnosticSchema).readonly(),
}).strict().readonly();
export type AdoptionImportResult = z.infer<typeof AdoptionImportResultSchema>;

export type AdoptionReader = (
  source: string,
  context: Readonly<{ path: string }>,
) => Readonly<{
  items: readonly AdoptionDeclaration[];
  diagnostics: readonly Diagnostic[];
}>;
export type AdoptionReaderRegistry = Readonly<Record<AdoptionDocumentKind, AdoptionReader>>;

export type { AdoptionCandidate, AdoptionCandidateId, AdoptionDeclaration, AdoptionDocumentKind, Diagnostic, MarketplaceSource };
export { AdoptionCandidateIdSchema, AdoptionCandidateSchema, AdoptionDeclarationSchema, AdoptionDocumentKindSchema, PortableMarketplaceSourceSchema };
