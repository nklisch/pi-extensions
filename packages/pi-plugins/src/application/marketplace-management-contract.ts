import { z } from "zod";
import {
  MarketplaceRegistrationIdSchema,
  MarketplaceScopeSelectionSchema,
  MarketplaceSnapshotTokenSchema,
} from "../domain/marketplace-registration.js";
import {
  MarketplaceRegistrationOriginSchema,
  MarketplaceRefreshAttemptSchema,
  MarketplaceRefreshMemorySchema,
  UpdateApplicationPreferenceSchema,
} from "../domain/update-policy.js";
import { MarketplaceNameSchema, PluginKeySchema } from "../domain/identity.js";
import { MarketplaceSourceSchema, SourceHashSchema } from "../domain/source.js";
import { ScopeReferenceSchema } from "../domain/state/scope.js";
import { GitRevisionSchema } from "../domain/source.js";
import { ContentDigestSchema } from "../domain/content-manifest.js";
import { MarketplaceContentRefSchema } from "../domain/state/references.js";
import { EpochMillisecondsSchema } from "../domain/time.js";

/** One registry owns public management variants, codes, and safe labels. */
export const MarketplaceManagementContractRegistry = Object.freeze({
  cache: {
    ready: { tag: "ready", label: "Verified cache ready" },
    stale: { tag: "stale", label: "Verified cache stale" },
    unknownLocal: { tag: "unknown-local", label: "Local freshness unknown" },
    notMaterialized: { tag: "not-materialized", label: "Registration has no selected cache" },
    unavailable: { tag: "unavailable", label: "Selected cache unavailable" },
    corrupt: { tag: "corrupt", label: "Selected cache corrupt" },
  },
  addRejection: {
    invalidSource: "INVALID_SOURCE",
    projectUntrusted: "PROJECT_UNTRUSTED",
    notPortable: "NOT_PORTABLE",
    nameConflict: "NAME_CONFLICT",
    sourceNameChanged: "SOURCE_NAME_CHANGED",
    sourceUnavailable: "SOURCE_UNAVAILABLE",
    catalogInvalid: "CATALOG_INVALID",
    promotionFailed: "PROMOTION_FAILED",
    stateCorrupt: "STATE_CORRUPT",
    stateStale: "STATE_STALE",
  },
  removeRejection: {
    projectUntrusted: "PROJECT_UNTRUSTED",
    sourceChanged: "SOURCE_CHANGED",
    stateCorrupt: "STATE_CORRUPT",
    stateStale: "STATE_STALE",
  },
} as const);

export const MarketplaceCacheStatusSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["ready", "stale"]),
    validator: z.object({ kind: z.literal("git-commit"), revision: GitRevisionSchema }).strict().readonly(),
    etag: z.object({ kind: z.literal("not-applicable") }).strict().readonly(),
    checkedAt: EpochMillisecondsSchema.optional(),
  }).strict().readonly(),
  z.object({
    kind: z.literal("unknown-local"),
    validator: z.object({ kind: z.literal("git-commit"), revision: GitRevisionSchema }).strict().readonly(),
    etag: z.object({ kind: z.literal("not-applicable") }).strict().readonly(),
  }).strict().readonly(),
  z.object({ kind: z.enum(["not-materialized", "unavailable", "corrupt"]) }).strict().readonly(),
]);
export type MarketplaceCacheStatus = z.infer<typeof MarketplaceCacheStatusSchema>;

export const MarketplaceSelectedSnapshotViewSchema = z.object({
  token: MarketplaceSnapshotTokenSchema,
  resolvedSourceHash: SourceHashSchema,
  revision: GitRevisionSchema,
  contentDigest: ContentDigestSchema,
  binding: ContentDigestSchema,
  contentRef: MarketplaceContentRefSchema,
}).strict().readonly();
export type MarketplaceSelectedSnapshotView = z.infer<typeof MarketplaceSelectedSnapshotViewSchema>;

export const MarketplaceRegistrationViewSchema = z.object({
  id: MarketplaceRegistrationIdSchema,
  scope: ScopeReferenceSchema,
  marketplace: MarketplaceNameSchema,
  source: MarketplaceSourceSchema,
  sourceIdentity: SourceHashSchema,
  origin: MarketplaceRegistrationOriginSchema,
  updateApplication: UpdateApplicationPreferenceSchema,
  refresh: MarketplaceRefreshMemorySchema,
  lastAttempt: MarketplaceRefreshAttemptSchema.optional(),
  selected: MarketplaceSelectedSnapshotViewSchema.optional(),
  cache: MarketplaceCacheStatusSchema,
}).strict().readonly();
export type MarketplaceRegistrationView = z.infer<typeof MarketplaceRegistrationViewSchema>;

export const MarketplaceAddRequestSchema = z.object({
  source: MarketplaceSourceSchema,
  scope: z.enum(["user", "project"]),
  origin: MarketplaceRegistrationOriginSchema.default({ kind: "native" }),
}).strict().readonly();
export type MarketplaceAddRequest = z.infer<typeof MarketplaceAddRequestSchema>;

const AddRejectionCodeSchema = z.enum(Object.values(MarketplaceManagementContractRegistry.addRejection) as [
  (typeof MarketplaceManagementContractRegistry.addRejection)[keyof typeof MarketplaceManagementContractRegistry.addRejection],
  ...(typeof MarketplaceManagementContractRegistry.addRejection)[keyof typeof MarketplaceManagementContractRegistry.addRejection][],
]);
export const MarketplaceAddResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("added"), registration: MarketplaceRegistrationViewSchema }).strict().readonly(),
  z.object({ kind: z.literal("unchanged"), registration: MarketplaceRegistrationViewSchema }).strict().readonly(),
  z.object({ kind: z.literal("rejected"), code: AddRejectionCodeSchema }).strict().readonly(),
  z.object({ kind: z.literal("indeterminate"), code: z.literal("COMMIT_AMBIGUOUS"), registrationId: MarketplaceRegistrationIdSchema }).strict().readonly(),
]);
export type MarketplaceAddResult = z.infer<typeof MarketplaceAddResultSchema>;

export const MarketplaceRemoveRequestSchema = z.object({
  registrationId: MarketplaceRegistrationIdSchema,
  scope: z.enum(["user", "project"]),
}).strict().readonly();
export type MarketplaceRemoveRequest = z.infer<typeof MarketplaceRemoveRequestSchema>;

const RemoveRejectionCodeSchema = z.enum(Object.values(MarketplaceManagementContractRegistry.removeRejection) as [
  (typeof MarketplaceManagementContractRegistry.removeRejection)[keyof typeof MarketplaceManagementContractRegistry.removeRejection],
  ...(typeof MarketplaceManagementContractRegistry.removeRejection)[keyof typeof MarketplaceManagementContractRegistry.removeRejection][],
]);
export const MarketplaceRemoveResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("removed"), registrationId: MarketplaceRegistrationIdSchema }).strict().readonly(),
  z.object({ kind: z.literal("unchanged"), reason: z.literal("not-configured") }).strict().readonly(),
  z.object({ kind: z.literal("blocked"), code: z.literal("INSTALLED_PLUGINS_DEPEND"), plugins: z.array(PluginKeySchema).readonly() }).strict().readonly(),
  z.object({ kind: z.literal("rejected"), code: RemoveRejectionCodeSchema }).strict().readonly(),
  z.object({ kind: z.literal("indeterminate"), code: z.literal("COMMIT_AMBIGUOUS"), registrationId: MarketplaceRegistrationIdSchema }).strict().readonly(),
]);
export type MarketplaceRemoveResult = z.infer<typeof MarketplaceRemoveResultSchema>;

export const MarketplaceRegistrationListRequestSchema = z.object({
  scope: MarketplaceScopeSelectionSchema.default("all-current"),
  limit: z.number().int().min(1).max(100).default(50),
}).strict().readonly();
export type MarketplaceRegistrationListRequest = z.infer<typeof MarketplaceRegistrationListRequestSchema>;

export const MarketplaceRegistrationPageSchema = z.object({
  registrations: z.array(MarketplaceRegistrationViewSchema).readonly(),
}).strict().readonly();
export type MarketplaceRegistrationPage = z.infer<typeof MarketplaceRegistrationPageSchema>;
