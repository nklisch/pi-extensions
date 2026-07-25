import { z } from "zod";
import {
  MarketplaceCandidateIdSchema,
  MarketplaceCursorSchema,
  MarketplaceRegistrationIdSchema,
  MarketplaceScopeSelectionSchema,
  MarketplaceSnapshotTokenSchema,
} from "../domain/marketplace-registration.js";
import {
  MarketplaceAvailabilitySchema,
} from "../domain/marketplace.js";
import { MarketplaceNameSchema, PluginKeySchema, PluginNameSchema } from "../domain/identity.js";
import { PluginSourceSchema, SourceHashSchema, GitRevisionSchema } from "../domain/source.js";
import { ScopeReferenceSchema } from "../domain/state/scope.js";
import { NativeHostSchema, SourceDocumentKindSchema } from "../domain/provenance.js";
import { ContentDigestSchema } from "../domain/content-manifest.js";
import { MarketplaceCacheStatusSchema } from "./marketplace-management-contract.js";

export const MarketplaceCatalogSearchRequestSchema = z.object({
  scope: MarketplaceScopeSelectionSchema.default("all-current"),
  marketplaceIds: z.array(MarketplaceRegistrationIdSchema).readonly().optional(),
  query: z.string().default(""),
  availability: z.array(MarketplaceAvailabilitySchema).readonly().optional(),
  cursor: MarketplaceCursorSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict().readonly();
export type MarketplaceCatalogSearchRequest = z.infer<typeof MarketplaceCatalogSearchRequestSchema>;

export const CatalogClaimOriginSchema = z.object({
  host: NativeHostSchema,
  documentKind: SourceDocumentKindSchema,
  path: z.string().min(1),
  pointer: z.string().optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
}).strict().readonly();
export type CatalogClaimOrigin = z.infer<typeof CatalogClaimOriginSchema>;

export const CatalogAvailableRevisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("marketplace-snapshot"),
    marketplaceRevision: GitRevisionSchema,
    snapshot: MarketplaceSnapshotTokenSchema,
    declaredVersion: z.string().min(1).optional(),
  }).strict().readonly(),
  z.object({
    kind: z.literal("declared-selector"),
    sourceIdentity: SourceHashSchema,
    selector: z.string().min(1).optional(),
    declaredVersion: z.string().min(1).optional(),
  }).strict().readonly(),
]);
export type CatalogAvailableRevision = z.infer<typeof CatalogAvailableRevisionSchema>;

const MarketplaceCandidateSummaryObjectSchema = z.object({
  id: MarketplaceCandidateIdSchema,
  snapshot: MarketplaceSnapshotTokenSchema,
  scope: ScopeReferenceSchema,
  registrationId: MarketplaceRegistrationIdSchema,
  plugin: PluginKeySchema,
  marketplace: MarketplaceNameSchema,
  name: PluginNameSchema,
  description: z.string().optional(),
  available: CatalogAvailableRevisionSchema,
  availability: MarketplaceAvailabilitySchema,
  source: PluginSourceSchema,
  sourceIdentity: SourceHashSchema,
  provenance: z.array(CatalogClaimOriginSchema).nonempty().readonly(),
  trust: z.literal("untrusted-not-inspected"),
}).strict();
export const MarketplaceCandidateSummarySchema = MarketplaceCandidateSummaryObjectSchema.readonly();
export type MarketplaceCandidateSummary = z.infer<typeof MarketplaceCandidateSummarySchema>;

export const MarketplaceCatalogObservationSchema = z.object({
  registrationId: MarketplaceRegistrationIdSchema,
  marketplace: MarketplaceNameSchema,
  status: z.enum(["ready", "stale", "unavailable", "corrupt"]),
  cache: MarketplaceCacheStatusSchema,
}).strict().readonly();
export type MarketplaceCatalogObservation = z.infer<typeof MarketplaceCatalogObservationSchema>;

export const MarketplaceCatalogPageSchema = z.object({
  candidates: z.array(MarketplaceCandidateSummarySchema).readonly(),
  observations: z.array(MarketplaceCatalogObservationSchema).readonly(),
  nextCursor: MarketplaceCursorSchema.optional(),
}).strict().readonly();
export type MarketplaceCatalogPage = z.infer<typeof MarketplaceCatalogPageSchema>;

export const MarketplaceCandidateDetailSchema = z.object({
  ...MarketplaceCandidateSummaryObjectSchema.shape,
  marketplaceRevision: GitRevisionSchema,
  marketplaceContentDigest: ContentDigestSchema,
  marketplaceBinding: ContentDigestSchema,
  marketplaceProvenance: z.array(CatalogClaimOriginSchema).nonempty().readonly(),
  metadata: z.array(z.object({ key: z.string().min(1), values: z.array(z.string()).readonly() }).strict().readonly()).readonly(),
}).strict().readonly();
export type MarketplaceCandidateDetail = z.infer<typeof MarketplaceCandidateDetailSchema>;

export const MarketplaceCandidateDetailResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("found"), candidate: MarketplaceCandidateDetailSchema }).strict().readonly(),
  z.object({ kind: z.enum(["candidate-stale", "candidate-missing", "catalog-unavailable"]) }).strict().readonly(),
]);
export type MarketplaceCandidateDetailResult = z.infer<typeof MarketplaceCandidateDetailResultSchema>;

export class MarketplaceCatalogError extends Error {
  readonly code: "CURSOR_INVALID" | "CURSOR_STALE" | "QUERY_INVALID";

  constructor(code: "CURSOR_INVALID" | "CURSOR_STALE" | "QUERY_INVALID") {
    super(code === "CURSOR_INVALID" ? "marketplace cursor is invalid" : code === "CURSOR_STALE" ? "marketplace cursor is stale" : "marketplace query is invalid");
    this.name = "MarketplaceCatalogError";
    this.code = code;
  }

  toJSON(): Readonly<{ code: MarketplaceCatalogError["code"] }> {
    return Object.freeze({ code: this.code });
  }
}
