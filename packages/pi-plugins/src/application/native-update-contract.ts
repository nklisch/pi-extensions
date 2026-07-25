import { z } from "zod";
import { PluginKeySchema } from "../domain/identity.js";
import { ScopeReferenceSchema } from "../domain/state/scope.js";
import { EpochMillisecondsSchema } from "../domain/time.js";
import {
  UpdateApplicationModeSchema,
  UpdateApplicationOverrideSchema,
  UpdateCadenceSchema,
  UpdateNoticeDispositionSchema,
  UpdateNoticeIdSchema,
  UpdatePolicyChangeSchema,
  UpdatePolicyConsentIdSchema,
  UpdatePolicyPreviewIdSchema,
} from "../domain/update-policy.js";

export const UpdatePolicyWinningLevelSchema = z.enum(["plugin", "marketplace", "scope", "global", "guard"]);
export type UpdatePolicyWinningLevel = z.infer<typeof UpdatePolicyWinningLevelSchema>;

export const EffectiveUpdatePolicySchema = z.object({
  application: UpdateApplicationModeSchema,
  winningLevel: UpdatePolicyWinningLevelSchema,
  sourceGuard: z.enum(["none", "local", "marketplace-source-changed", "plugin-source-changed", "legacy-source"]).default("none"),
}).strict().readonly();
export type EffectiveUpdatePolicy = z.infer<typeof EffectiveUpdatePolicySchema>;

export const NativeUpdatePolicyPreviewSchema = z.object({
  previewId: UpdatePolicyPreviewIdSchema,
  change: UpdatePolicyChangeSchema,
  before: z.array(z.object({ plugin: PluginKeySchema, effective: EffectiveUpdatePolicySchema }).strict().readonly()).readonly(),
  after: z.array(z.object({ plugin: PluginKeySchema, effective: EffectiveUpdatePolicySchema }).strict().readonly()).readonly(),
  affectedCount: z.number().int().nonnegative(),
  inventoryComplete: z.boolean(),
  consent: z.object({
    required: z.boolean(),
    consentId: UpdatePolicyConsentIdSchema.optional(),
    disclosure: z.enum(["current-target", "scope-current-and-future", "global-current-and-future"]).optional(),
  }).strict().readonly(),
  authority: z.object({ userGeneration: z.number().int().nonnegative(), projectEpoch: z.string().optional() }).strict().readonly(),
}).strict().readonly();
export type NativeUpdatePolicyPreview = z.infer<typeof NativeUpdatePolicyPreviewSchema>;

export const NativeUpdatePolicyPreviewResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("previewed"), preview: NativeUpdatePolicyPreviewSchema }).strict().readonly(),
  z.object({ kind: z.literal("rejected"), code: z.enum(["TARGET_MISSING", "SOURCE_GUARDED", "PROJECT_UNTRUSTED", "STATE_UNAVAILABLE", "INVALID_CHANGE"]) }).strict().readonly(),
]);
export type NativeUpdatePolicyPreviewResult = z.infer<typeof NativeUpdatePolicyPreviewResultSchema>;

export const NativeUpdatePolicyApplyRequestSchema = z.object({
  change: UpdatePolicyChangeSchema,
  expectedPreviewId: UpdatePolicyPreviewIdSchema,
  consent: z.object({ kind: z.literal("grant"), consentId: UpdatePolicyConsentIdSchema }).strict().readonly().optional(),
}).strict().readonly();
export type NativeUpdatePolicyApplyRequest = z.infer<typeof NativeUpdatePolicyApplyRequestSchema>;

export const NativeUpdatePolicyApplyResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["changed", "unchanged"]), previewId: UpdatePolicyPreviewIdSchema }).strict().readonly(),
  z.object({ kind: z.literal("stale"), reason: z.enum(["preview", "generation", "source", "project", "trust", "target"]) }).strict().readonly(),
  z.object({ kind: z.literal("rejected"), code: z.enum(["CONSENT_REQUIRED", "CONSENT_INVALID", "SOURCE_GUARDED", "PROJECT_UNTRUSTED", "STATE_UNAVAILABLE"]) }).strict().readonly(),
]);
export type NativeUpdatePolicyApplyResult = z.infer<typeof NativeUpdatePolicyApplyResultSchema>;

export const NativeUpdateStatusRequestSchema = z.object({
  scope: z.enum(["user", "project", "all-current"]).default("all-current"),
  plugin: PluginKeySchema.optional(),
}).strict().readonly();
export type NativeUpdateStatusRequest = z.infer<typeof NativeUpdateStatusRequestSchema>;

export const NativeUpdatePolicyStatusSchema = z.object({
  global: z.object({ application: UpdateApplicationModeSchema, cadence: UpdateCadenceSchema }).strict().readonly(),
  scopes: z.array(z.object({
    scope: ScopeReferenceSchema,
    override: UpdateApplicationModeSchema.optional(),
    ownership: z.enum(["self", "other", "none"]),
    clock: z.enum(["current", "regressed"]),
    nextAt: EpochMillisecondsSchema.optional(),
  }).strict().readonly()).readonly(),
  policies: z.array(z.object({
    scope: ScopeReferenceSchema,
    plugin: PluginKeySchema,
    marketplaceOverride: UpdateApplicationOverrideSchema.optional(),
    pluginOverride: UpdateApplicationOverrideSchema.optional(),
    effective: EffectiveUpdatePolicySchema,
  }).strict().readonly()).readonly(),
  inventoryComplete: z.boolean(),
}).strict().readonly();
export type NativeUpdatePolicyStatus = z.infer<typeof NativeUpdatePolicyStatusSchema>;

export const NativeUpdateStatusSchema = z.object({
  policy: NativeUpdatePolicyStatusSchema,
  scheduler: z.object({
    state: z.enum(["disabled", "standby", "running", "clock-regressed", "degraded", "stopped"]),
    scopes: z.array(z.object({ scope: ScopeReferenceSchema, ownership: z.enum(["self", "other", "none"]), nextAt: EpochMillisecondsSchema.optional() }).strict().readonly()).readonly(),
  }).strict().readonly(),
  unreadCount: z.number().int().nonnegative(),
  unresolvedCount: z.number().int().nonnegative(),
}).strict().readonly();
export type NativeUpdateStatus = z.infer<typeof NativeUpdateStatusSchema>;

export const NativeUpdateNotificationListRequestSchema = z.object({
  scope: z.enum(["user", "project", "all-current"]).default("all-current"),
  plugin: PluginKeySchema.optional(),
  after: UpdateNoticeIdSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
}).strict().readonly();
export type NativeUpdateNotificationListRequest = z.infer<typeof NativeUpdateNotificationListRequestSchema>;

export const NativeUpdateNotificationViewSchema = z.object({
  id: UpdateNoticeIdSchema,
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
  installed: z.string().min(1),
  available: z.string().min(1),
  disposition: UpdateNoticeDispositionSchema,
  unread: z.boolean(),
  unresolved: z.boolean(),
  discoveredAt: EpochMillisecondsSchema,
}).strict().readonly();
export type NativeUpdateNotificationView = z.infer<typeof NativeUpdateNotificationViewSchema>;

export const NativeUpdateNotificationPageSchema = z.object({
  notices: z.array(NativeUpdateNotificationViewSchema).readonly(),
  unreadCount: z.number().int().nonnegative(),
  unresolvedCount: z.number().int().nonnegative(),
  next: UpdateNoticeIdSchema.optional(),
}).strict().readonly();
export type NativeUpdateNotificationPage = z.infer<typeof NativeUpdateNotificationPageSchema>;

export const NativeUpdateAcknowledgmentRequestSchema = z.object({ ids: z.array(UpdateNoticeIdSchema).max(200).readonly() }).strict().readonly().superRefine((request, context) => {
  if (new Set(request.ids).size !== request.ids.length) context.addIssue({ code: "custom", path: ["ids"], message: "notice IDs must be unique" });
});
export type NativeUpdateAcknowledgmentRequest = z.infer<typeof NativeUpdateAcknowledgmentRequestSchema>;

export const NativeUpdateAcknowledgmentResultSchema = z.object({
  acknowledged: z.array(UpdateNoticeIdSchema).readonly(),
  alreadyRead: z.array(UpdateNoticeIdSchema).readonly(),
  missing: z.array(UpdateNoticeIdSchema).readonly(),
  unreadCount: z.number().int().nonnegative(),
  unresolvedCount: z.number().int().nonnegative(),
}).strict().readonly();
export type NativeUpdateAcknowledgmentResult = z.infer<typeof NativeUpdateAcknowledgmentResultSchema>;

export const NativeAutomaticUpdateRunRequestSchema = z.object({
  noticeIds: z.array(UpdateNoticeIdSchema).readonly().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  /** Explicit foreground user intent bypasses automatic-policy eligibility, not safety checks. */
  explicit: z.boolean().optional(),
}).strict().readonly();
export type NativeAutomaticUpdateRunRequest = z.infer<typeof NativeAutomaticUpdateRunRequestSchema>;

export const NativeAutomaticUpdateRunResultSchema = z.object({
  outcomes: z.array(z.object({
    noticeId: UpdateNoticeIdSchema,
    kind: z.enum(["applied", "current", "pending", "blocked", "retryable", "recovery-required", "stale"]),
    reason: z.string().optional(),
  }).strict().readonly()).readonly(),
}).strict().readonly();
export type NativeAutomaticUpdateRunResult = z.infer<typeof NativeAutomaticUpdateRunResultSchema>;
