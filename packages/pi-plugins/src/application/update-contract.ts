import { z } from "zod";
import { PluginKeySchema, type MarketplaceName, type PluginKey } from "../domain/identity.js";
import { MarketplaceReadResultSchema as DomainMarketplaceReadResultSchema, type MarketplaceReadResult } from "../domain/marketplace.js";
import { type ContentDigest } from "../domain/content-manifest.js";
import { ScopeReferenceSchema, type ScopeContext, type ScopeReference } from "../domain/state/scope.js";
import { type MarketplaceSnapshotRecord } from "../domain/state/installed-state.js";
import {
  MarketplaceRegistrationIdSchema,
  MarketplaceScopeSelectionSchema,
} from "../domain/marketplace-registration.js";
import {
  AvailableRevisionSchema,
  MarketplaceUpdateRecordSchema,
  UpdateCandidateKeySchema,
  type AvailableRevision,
  type UpdateCandidateKey,
} from "../domain/update-policy.js";
import { EpochMillisecondsSchema, type EpochMilliseconds } from "../domain/time.js";
import {
  MarketplaceCacheStatusSchema,
  MarketplaceRegistrationViewSchema,
} from "./marketplace-management-contract.js";

export const MarketplaceRefreshRequestSchema = z.object({
  trigger: z.enum(["explicit", "scheduled"]),
  scope: MarketplaceScopeSelectionSchema.default("all-current"),
  registrationIds: z.array(MarketplaceRegistrationIdSchema).nonempty().readonly().optional(),
}).strict().readonly();
export type MarketplaceRefreshRequest = z.infer<typeof MarketplaceRefreshRequestSchema>;

export const UpdateDispositionSchema = z.enum([
  "current", "discovered", "manual-required", "approval-required",
  "automatic-applied", "automatic-retryable", "recovery-required",
  "failed",
]);
export type UpdateDisposition = z.infer<typeof UpdateDispositionSchema>;

export const NotificationIntentSchema = z.object({
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
  candidate: UpdateCandidateKeySchema,
  installed: z.string().min(1),
  available: z.string().min(1),
  disposition: UpdateDispositionSchema,
}).strict().readonly();
export type NotificationIntent = z.infer<typeof NotificationIntentSchema>;

export const PluginUpdateOutcomeSchema = z.object({
  plugin: PluginKeySchema,
  disposition: UpdateDispositionSchema,
  candidate: UpdateCandidateKeySchema.optional(),
  available: AvailableRevisionSchema.optional(),
  notification: z.enum(["new", "already-emitted", "none"]).optional(),
}).strict().readonly();
export type PluginUpdateOutcome = z.infer<typeof PluginUpdateOutcomeSchema>;

export const MarketplaceRefreshOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("refreshed"),
    registrationId: MarketplaceRegistrationIdSchema,
    change: z.enum(["changed", "unchanged"]),
    registration: MarketplaceRegistrationViewSchema,
    plugins: z.array(PluginUpdateOutcomeSchema).readonly(),
  }).strict().readonly(),
  z.object({ kind: z.literal("coalesced"), registrationId: MarketplaceRegistrationIdSchema, claimExpiresAt: EpochMillisecondsSchema }).strict().readonly(),
  z.object({ kind: z.literal("rate-limited"), registrationId: MarketplaceRegistrationIdSchema, nextAt: EpochMillisecondsSchema }).strict().readonly(),
  z.object({ kind: z.literal("skipped-local"), registrationId: MarketplaceRegistrationIdSchema }).strict().readonly(),
  z.object({ kind: z.literal("cancelled"), registrationId: MarketplaceRegistrationIdSchema }).strict().readonly(),
  z.object({
    kind: z.literal("failed"),
    registrationId: MarketplaceRegistrationIdSchema,
    code: z.enum(["SOURCE_UNAVAILABLE", "CATALOG_INVALID", "CONTENT_INVALID", "PROMOTION_FAILED", "STATE_STALE", "REMOVED_DURING_REFRESH"]),
    retained: MarketplaceCacheStatusSchema,
  }).strict().readonly(),
  z.object({ kind: z.literal("not-configured"), registrationId: MarketplaceRegistrationIdSchema }).strict().readonly(),
]);
export type MarketplaceRefreshOutcome = z.infer<typeof MarketplaceRefreshOutcomeSchema>;

/** Compatibility export name for callers that imported the former loose schema. */
export const MarketplaceReadResultSchema = MarketplaceRefreshOutcomeSchema;

export const MarketplaceRefreshResultSchema = z.object({
  outcomes: z.array(MarketplaceRefreshOutcomeSchema).readonly(),
  notifications: z.array(NotificationIntentSchema).readonly(),
}).strict().readonly();
export type MarketplaceRefreshResult = z.infer<typeof MarketplaceRefreshResultSchema>;

export { AvailableRevisionSchema, MarketplaceUpdateRecordSchema, DomainMarketplaceReadResultSchema, MarketplaceRefreshRequestSchema as RefreshRequestSchema };
export type { AvailableRevision, ContentDigest, EpochMilliseconds, MarketplaceName, MarketplaceReadResult, MarketplaceSnapshotRecord, PluginKey, ScopeContext, ScopeReference, UpdateCandidateKey };
