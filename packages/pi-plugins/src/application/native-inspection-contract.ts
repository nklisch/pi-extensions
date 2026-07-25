import { z } from "zod";
import { EffectiveUpdatePolicySchema } from "./native-update-contract.js";
import { UpdateNoticeDispositionSchema } from "../domain/update-policy.js";
import { ComponentIdSchema } from "../domain/components.js";
import { ConfigurationKeySchema, ConfigurationValueKindRegistry } from "../domain/configuration.js";
import { ContentDigestSchema } from "../domain/content-manifest.js";
import { ErrorCodeSchema } from "../domain/errors.js";
import { PluginKeySchema } from "../domain/identity.js";
import { MarketplaceScopeSelectionSchema } from "../domain/marketplace-registration.js";
import { McpBridgeTransportSchema, McpRuntimeServerKeySchemaV1 } from "./ports/mcp-runtime.js";
import { RuntimeContributionParticipantSchema } from "./ports/lifecycle-reload.js";
import { RuntimeRequirementIdSchema } from "../domain/compatibility.js";
import { ScopeReferenceSchema } from "../domain/state/scope.js";
import {
  NativeDiagnosticActionSchema,
  NativeDiagnosticCategorySchema,
  NativeDiagnosticCodeSchema,
} from "./native-diagnostic-registry.js";
import { containsUnsafeDisplayScalar } from "./native-inspection-display-safety.js";

export const NativeInspectionSubjectKindSchema = z.enum(["installed", "marketplace-candidate"]);
export const NativeInspectionConditionSchema = z.enum(["ready", "degraded", "blocked", "unavailable"]);
export const NativeInspectionFreshnessSchema = z.enum(["current", "stale", "unknown", "unavailable", "not-applicable"]);

export const InspectionSnapshotIdSchema = z.string()
  .regex(/^inspection-snapshot-v1:sha256:[0-9a-f]{64}$/)
  .brand<"InspectionSnapshotId">();
export const InspectionDetailIdSchema = z.string()
  .regex(/^inspection-detail-v1:[A-Za-z0-9_-]+\.[0-9a-f]{64}$/)
  .max(4096)
  .brand<"InspectionDetailId">();
export const InspectionCursorSchema = z.string()
  .regex(/^inspection-cursor-v1:[A-Za-z0-9_-]+\.[0-9a-f]{64}$/)
  .max(4096)
  .brand<"InspectionCursor">();

export const SafeDisplayFieldSchema = z.object({
  text: z.string().max(8192).refine((value) => !containsUnsafeDisplayScalar(value), {
    message: "safe display text contains an unsafe scalar",
  }),
  escaped: z.boolean(),
  truncated: z.boolean(),
}).strict().readonly();

export const NativeProvenanceViewSchema = z.object({
  host: z.enum(["claude", "codex"]),
  documentKind: z.enum(["marketplace", "manifest", "hooks", "mcp", "skill", "convention", "foreign-state"]),
  path: SafeDisplayFieldSchema,
  pointer: SafeDisplayFieldSchema.optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
}).strict().readonly();

export const NativeRedactedUrlSchema = z.object({
  scheme: z.enum(["http", "https", "ssh", "git", "unknown"]),
  host: SafeDisplayFieldSchema,
  port: SafeDisplayFieldSchema.optional(),
  path: SafeDisplayFieldSchema,
  queryPresent: z.boolean(),
  fragmentPresent: z.boolean(),
}).strict().readonly();

export const NativeMcpEndpointSchema = z.object({
  scheme: z.enum(["http", "https"]),
  host: SafeDisplayFieldSchema,
  port: SafeDisplayFieldSchema,
  path: SafeDisplayFieldSchema,
  queryPresent: z.boolean(),
}).strict().readonly();

export const NativeSourceViewSchema = z.object({
  kind: z.enum(["github", "git", "local-git", "marketplace-path", "git-subdir", "npm"]),
  identity: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  location: SafeDisplayFieldSchema.optional(),
  endpoint: NativeRedactedUrlSchema.optional(),
  revision: SafeDisplayFieldSchema.optional(),
  package: SafeDisplayFieldSchema.optional(),
}).strict().readonly();

const NativeComponentBaseSchema = z.object({
  componentId: ComponentIdSchema,
  verdict: z.enum(["supported", "metadata-only", "incompatible", "unavailable"]),
  requirementIds: z.array(RuntimeRequirementIdSchema).readonly(),
  provenance: z.array(NativeProvenanceViewSchema).readonly(),
}).strict();

export const NativeSkillComponentViewSchema = NativeComponentBaseSchema.extend({
  kind: z.literal("skill"),
  name: SafeDisplayFieldSchema,
  root: SafeDisplayFieldSchema,
}).strict().readonly();

export const NativeHookComponentViewSchema = NativeComponentBaseSchema.extend({
  kind: z.literal("hook"),
  event: SafeDisplayFieldSchema,
  matcher: SafeDisplayFieldSchema.optional(),
  handler: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shell"), command: SafeDisplayFieldSchema, shell: z.enum(["bash", "powershell"]).optional(), timeoutMs: z.number().int().positive().optional() }).strict().readonly(),
    z.object({ kind: z.literal("exec"), command: SafeDisplayFieldSchema, args: z.array(SafeDisplayFieldSchema).max(256).readonly(), timeoutMs: z.number().int().positive().optional() }).strict().readonly(),
  ]),
}).strict().readonly();

export const NativeMcpComponentViewSchema = NativeComponentBaseSchema.extend({
  kind: z.literal("mcp-server"),
  nativeKey: SafeDisplayFieldSchema,
  transport: McpBridgeTransportSchema.optional(),
  command: SafeDisplayFieldSchema.optional(),
  args: z.array(SafeDisplayFieldSchema).max(256).readonly(),
  url: NativeMcpEndpointSchema.optional(),
  environmentNames: z.array(SafeDisplayFieldSchema).max(256).readonly(),
  headerNames: z.array(SafeDisplayFieldSchema).max(256).readonly(),
  authentication: z.enum(["none", "bearer-environment", "oauth-authorization-code", "oauth-client-credentials", "unavailable"]),
  toolPolicy: z.object({
    allowed: z.array(SafeDisplayFieldSchema).readonly(),
    denied: z.array(SafeDisplayFieldSchema).readonly(),
    approval: z.enum(["default", "required", "not-applicable"]),
  }).strict().readonly(),
  startupTimeoutMs: z.number().positive().optional(),
  toolTimeoutMs: z.number().positive().optional(),
}).strict().readonly();

export const NativeForeignComponentViewSchema = NativeComponentBaseSchema.extend({
  kind: z.literal("foreign"),
  nativeHost: z.enum(["claude", "codex"]),
  nativeKind: SafeDisplayFieldSchema,
}).strict().readonly();

export const NativeComponentInventoryViewSchema = z.object({
  counts: z.object({
    skills: z.number().int().nonnegative(),
    hooks: z.number().int().nonnegative(),
    mcpServers: z.number().int().nonnegative(),
    foreign: z.number().int().nonnegative(),
  }).strict().readonly(),
  skills: z.array(NativeSkillComponentViewSchema).readonly(),
  hooks: z.array(NativeHookComponentViewSchema).readonly(),
  mcpServers: z.array(NativeMcpComponentViewSchema).readonly(),
  foreign: z.array(NativeForeignComponentViewSchema).readonly(),
}).strict().readonly();

export const NativeConfigurationOptionViewSchema = z.object({
  key: ConfigurationKeySchema,
  label: SafeDisplayFieldSchema,
  valueKind: z.enum(Object.values(ConfigurationValueKindRegistry).map((entry) => entry.tag) as [keyof typeof ConfigurationValueKindRegistry, ...(keyof typeof ConfigurationValueKindRegistry)[]]),
  required: z.boolean(),
  sensitive: z.boolean(),
  defaultPresent: z.boolean(),
  state: z.enum(["configured", "defaulted", "missing", "unavailable", "invalid"]),
}).strict().readonly();

export const NativeTrustReadinessSchema = z.enum([
  "authorized", "required", "revoked", "invalid-evidence", "project-untrusted", "unavailable", "not-applicable",
]);

export const NativeRuntimeRequirementViewSchema = z.object({
  id: RuntimeRequirementIdSchema,
  capability: SafeDisplayFieldSchema,
  status: z.enum(["available", "unavailable"]),
  explanation: SafeDisplayFieldSchema,
  provenance: z.array(NativeProvenanceViewSchema).readonly(),
}).strict().readonly();

export const NativeCompatibilityViewSchema = z.object({
  status: z.enum(["activatable", "incompatible", "unavailable"]),
  reportFingerprint: ContentDigestSchema.optional(),
  components: NativeComponentInventoryViewSchema,
  requirements: z.array(NativeRuntimeRequirementViewSchema).readonly(),
}).strict().readonly();

export const NativeLifecycleViewSchema = z.object({
  installed: z.boolean(),
  activationIntent: z.enum(["enabled", "disabled"]).optional(),
  transition: z.enum(["none", "pending", "recovery-required", "deferred", "blocked"]),
  update: z.enum([
    "current", "available", "manual-required", "approval-required", "automatic-pending",
    "automatic-applied", "automatic-retryable", "configuration-blocked", "capability-blocked",
    "recovery-required", "failed", "unknown", "not-applicable",
  ]),
  policy: EffectiveUpdatePolicySchema.optional(),
  notice: z.object({
    disposition: UpdateNoticeDispositionSchema,
    unread: z.boolean(),
    unresolved: z.boolean(),
  }).strict().readonly().optional(),
  schedule: z.object({
    state: z.enum(["current", "due", "clock-regressed", "unavailable"]),
    nextAt: z.number().int().nonnegative().optional(),
  }).strict().readonly().optional(),
  updateSubsystem: z.enum(["disabled", "standby", "running", "clock-regressed", "degraded", "stopped"]).optional(),
}).strict().readonly();

export const NativeActivationViewSchema = z.object({
  intent: z.enum(["enabled", "disabled"]),
  state: z.enum(["active", "inactive", "pending", "recovery-required", "blocked", "unavailable"]),
  selectedRevision: ContentDigestSchema,
  projectionDigest: ContentDigestSchema.optional(),
  participants: z.array(z.object({
    participant: RuntimeContributionParticipantSchema,
    status: z.enum(["matching", "missing", "mismatched", "unavailable"]),
    contributionDigest: ContentDigestSchema.optional(),
  }).strict().readonly()).readonly(),
}).strict().readonly();

export const NativeMcpHealthViewSchema = z.object({
  localRegistration: z.enum(["matching", "absent", "mismatched", "unavailable"]),
  servers: z.array(z.object({
    componentId: ComponentIdSchema,
    serverKey: McpRuntimeServerKeySchemaV1,
    nativeKey: SafeDisplayFieldSchema,
    authority: z.enum(["current", "stale", "unavailable"]),
    transport: McpBridgeTransportSchema.optional(),
    state: z.enum(["registered", "idle", "connecting", "connected", "needs-auth", "failed"]),
    toolCount: z.number().int().nonnegative().optional(),
    errorCode: ErrorCodeSchema.optional(),
  }).strict().readonly()).readonly(),
}).strict().readonly();

export const NativeDiagnosticFactSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  value: SafeDisplayFieldSchema,
}).strict().readonly();

export const NativeDiagnosticSchema = z.object({
  id: z.string().regex(/^native-diagnostic-v1:sha256:[0-9a-f]{64}$/),
  code: NativeDiagnosticCodeSchema,
  category: NativeDiagnosticCategorySchema,
  severity: z.enum(["error", "warning", "info"]),
  subjectId: InspectionDetailIdSchema.optional(),
  componentId: ComponentIdSchema.optional(),
  summary: SafeDisplayFieldSchema,
  facts: z.array(NativeDiagnosticFactSchema).readonly(),
  provenance: z.array(NativeProvenanceViewSchema).readonly(),
  action: NativeDiagnosticActionSchema,
}).strict().readonly();

export const NativeInspectionListRequestSchema = z.object({
  subjects: z.array(NativeInspectionSubjectKindSchema).nonempty().default(["installed", "marketplace-candidate"]),
  scope: MarketplaceScopeSelectionSchema.default("all-current"),
  query: z.string().max(256).default(""),
  conditions: z.array(NativeInspectionConditionSchema).readonly().optional(),
  cursor: InspectionCursorSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict().readonly();

export const NativeInspectionSummarySchema = z.object({
  detailId: InspectionDetailIdSchema,
  subject: NativeInspectionSubjectKindSchema,
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
  name: SafeDisplayFieldSchema,
  marketplace: SafeDisplayFieldSchema,
  revision: z.object({
    installed: SafeDisplayFieldSchema.optional(),
    available: SafeDisplayFieldSchema.optional(),
    immutable: ContentDigestSchema.optional(),
    resolution: z.enum(["exact", "declared-selector", "unresolved"]),
  }).strict().readonly(),
  condition: NativeInspectionConditionSchema,
  freshness: z.object({ status: NativeInspectionFreshnessSchema, basis: z.enum(["state", "marketplace", "runtime", "update", "none"]) }).strict().readonly(),
  diagnosticCounts: z.object({ error: z.number().int().nonnegative(), warning: z.number().int().nonnegative(), info: z.number().int().nonnegative() }).strict().readonly(),
}).strict().readonly();

export const NativeScopeObservationSchema = z.object({
  scope: ScopeReferenceSchema,
  status: z.enum(["ready", "corrupt", "unavailable"]),
  generation: z.number().int().nonnegative().optional(),
  corruptionCodes: z.array(SafeDisplayFieldSchema).readonly(),
}).strict().readonly();

export const NativeInspectionPageSchema = z.object({
  snapshotId: InspectionSnapshotIdSchema,
  condition: NativeInspectionConditionSchema,
  items: z.array(NativeInspectionSummarySchema).readonly(),
  observations: z.array(NativeScopeObservationSchema).readonly(),
  nextCursor: InspectionCursorSchema.optional(),
}).strict().readonly();

export const NativeInspectionDetailRequestSchema = z.object({ snapshotId: InspectionSnapshotIdSchema, detailId: InspectionDetailIdSchema }).strict().readonly();

export const NativeInspectionDetailSchema = z.object({
  snapshotId: InspectionSnapshotIdSchema,
  summary: NativeInspectionSummarySchema,
  source: NativeSourceViewSchema,
  provenance: z.array(NativeProvenanceViewSchema).readonly(),
  compatibility: NativeCompatibilityViewSchema,
  trust: NativeTrustReadinessSchema,
  configuration: z.array(NativeConfigurationOptionViewSchema).readonly(),
  lifecycle: NativeLifecycleViewSchema,
  activation: NativeActivationViewSchema.optional(),
  mcpHealth: NativeMcpHealthViewSchema.optional(),
  diagnostics: z.array(NativeDiagnosticSchema).readonly(),
}).strict().readonly();

export const NativeInspectionDetailResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("found"), detail: NativeInspectionDetailSchema }).strict().readonly(),
  z.object({ kind: z.literal("stale"), action: z.literal("retry-read") }).strict().readonly(),
  z.object({ kind: z.literal("invalid-id") }).strict().readonly(),
  z.object({ kind: z.literal("missing") }).strict().readonly(),
  z.object({ kind: z.literal("unavailable"), summary: NativeInspectionSummarySchema.optional(), diagnostics: z.array(NativeDiagnosticSchema).nonempty().readonly() }).strict().readonly(),
]);

export const NativeDiagnosisRequestSchema = z.object({
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("host") }).strict().readonly(),
    z.object({ kind: z.literal("detail"), snapshotId: InspectionSnapshotIdSchema, detailId: InspectionDetailIdSchema }).strict().readonly(),
  ]).default({ kind: "host" }),
  includeAdoption: z.boolean().default(false),
}).strict().readonly();

export const NativeDiagnosticReportSchema = z.object({
  snapshotId: InspectionSnapshotIdSchema,
  condition: NativeInspectionConditionSchema,
  observations: z.array(NativeScopeObservationSchema).readonly(),
  diagnostics: z.array(NativeDiagnosticSchema).readonly(),
}).strict().readonly();

export type NativeInspectionSubjectKind = z.infer<typeof NativeInspectionSubjectKindSchema>;
export type NativeInspectionCondition = z.infer<typeof NativeInspectionConditionSchema>;
export type NativeInspectionFreshness = z.infer<typeof NativeInspectionFreshnessSchema>;
export type InspectionSnapshotId = z.infer<typeof InspectionSnapshotIdSchema>;
export type InspectionDetailId = z.infer<typeof InspectionDetailIdSchema>;
export type InspectionCursor = z.infer<typeof InspectionCursorSchema>;
export type SafeDisplayField = z.infer<typeof SafeDisplayFieldSchema>;
export type NativeProvenanceView = z.infer<typeof NativeProvenanceViewSchema>;
export type NativeMcpEndpoint = z.infer<typeof NativeMcpEndpointSchema>;
export type NativeSourceView = z.infer<typeof NativeSourceViewSchema>;
export type NativeComponentInventoryView = z.infer<typeof NativeComponentInventoryViewSchema>;
export type NativeConfigurationOptionView = z.infer<typeof NativeConfigurationOptionViewSchema>;
export type NativeTrustReadiness = z.infer<typeof NativeTrustReadinessSchema>;
export type NativeCompatibilityView = z.infer<typeof NativeCompatibilityViewSchema>;
export type NativeLifecycleView = z.infer<typeof NativeLifecycleViewSchema>;
export type NativeActivationView = z.infer<typeof NativeActivationViewSchema>;
export type NativeMcpHealthView = z.infer<typeof NativeMcpHealthViewSchema>;
export type NativeDiagnostic = z.infer<typeof NativeDiagnosticSchema>;
export type NativeInspectionListRequest = z.infer<typeof NativeInspectionListRequestSchema>;
export type NativeInspectionSummary = z.infer<typeof NativeInspectionSummarySchema>;
export type NativeScopeObservation = z.infer<typeof NativeScopeObservationSchema>;
export type NativeInspectionPage = z.infer<typeof NativeInspectionPageSchema>;
export type NativeInspectionDetailRequest = z.infer<typeof NativeInspectionDetailRequestSchema>;
export type NativeInspectionDetail = z.infer<typeof NativeInspectionDetailSchema>;
export type NativeInspectionDetailResult = z.infer<typeof NativeInspectionDetailResultSchema>;
export type NativeDiagnosisRequest = z.infer<typeof NativeDiagnosisRequestSchema>;
export type NativeDiagnosticReport = z.infer<typeof NativeDiagnosticReportSchema>;

export interface NativeInspectionService {
  list(request: NativeInspectionListRequest, signal: AbortSignal): Promise<NativeInspectionPage>;
  detail(request: NativeInspectionDetailRequest, signal: AbortSignal): Promise<NativeInspectionDetailResult>;
  diagnose(request: NativeDiagnosisRequest, signal: AbortSignal): Promise<NativeDiagnosticReport>;
}
