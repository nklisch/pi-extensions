import { z } from "zod";
import { ConfigurationKeySchema } from "../domain/configuration.js";
import { ContentDigestSchema } from "../domain/content-manifest.js";
import { PluginKeySchema } from "../domain/identity.js";
import {
  MarketplaceCandidateIdSchema,
  MarketplaceRegistrationIdSchema,
  MarketplaceSnapshotTokenSchema,
} from "../domain/marketplace-registration.js";
import { SourceHashSchema } from "../domain/source.js";
import { PluginConfigurationRefSchema, TrustSubjectRefSchema } from "../domain/state/references.js";
import { ScopeReferenceSchema } from "../domain/state/scope.js";
import { EpochMillisecondsSchema } from "./ports/lifecycle-clock.js";
import { SensitiveValue } from "./sensitive-value.js";
import {
  InspectionDetailIdSchema,
  InspectionSnapshotIdSchema,
  NativeComponentInventoryViewSchema,
  NativeDiagnosticSchema,
  NativeInspectionDetailSchema,
  NativeSourceViewSchema,
  NativeRuntimeRequirementViewSchema,
  SafeDisplayFieldSchema,
} from "./native-inspection-contract.js";

export const TrustedInstallSessionPolicy = Object.freeze({
  idleTtlMs: 15 * 60_000,
  absoluteTtlMs: 60 * 60_000,
  terminalRetentionMs: 5 * 60_000,
  maxProgressEvents: 32,
});

export const TrustedInstallSessionTokenSchema = z.string()
  .regex(/^trusted-install-session-v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}$/)
  .max(128)
  .brand<"TrustedInstallSessionToken">();
export const TrustedInstallSessionVersionSchema = z.number().int().nonnegative();
export const TrustedInstallConsentIdSchema = z.string()
  .regex(/^trusted-install-consent-v1:sha256:[0-9a-f]{64}$/)
  .brand<"TrustedInstallConsentId">();

export const PreparedLifecycleCandidateBindingSchema = z.object({
  scope: ScopeReferenceSchema,
  registrationId: MarketplaceRegistrationIdSchema,
  candidateId: MarketplaceCandidateIdSchema,
  catalogSnapshot: MarketplaceSnapshotTokenSchema,
  plugin: PluginKeySchema,
  sourceIdentity: SourceHashSchema,
  immutableRevision: ContentDigestSchema,
  contentDigest: ContentDigestSchema,
  compatibilityFingerprint: ContentDigestSchema,
  configurationDescriptorDigest: ContentDigestSchema,
  consentDisclosureDigest: ContentDigestSchema,
  configurationRef: PluginConfigurationRefSchema.optional(),
  trustSubject: TrustSubjectRefSchema,
  executableSurfaceDigest: ContentDigestSchema,
  capabilityDigest: ContentDigestSchema,
  projectEpoch: ContentDigestSchema.optional(),
}).strict().readonly();

/** Source-compatible trusted-install name for the shared prepared candidate contract. */
export const TrustedInstallCandidateBindingSchema = PreparedLifecycleCandidateBindingSchema;

export const TrustedInstallSessionStateRegistry = Object.freeze({
  awaitingInput: { tag: "awaiting-input" }, ready: { tag: "ready" }, activating: { tag: "activating" },
  succeeded: { tag: "succeeded" }, currentState: { tag: "current-state" }, cancelled: { tag: "cancelled" },
  rejected: { tag: "rejected" }, stale: { tag: "stale" }, conflict: { tag: "conflict" },
  rolledBack: { tag: "rolled-back" }, recoveryRequired: { tag: "recovery-required" }, failed: { tag: "failed" },
  expired: { tag: "expired" }, disposed: { tag: "disposed" },
} as const);
const sessionStates = Object.values(TrustedInstallSessionStateRegistry).map((entry) => entry.tag) as [string, ...string[]];
export const TrustedInstallSessionStateSchema = z.enum(sessionStates);

const DefaultValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("string"), value: SafeDisplayFieldSchema }).strict().readonly(),
  z.object({ kind: z.literal("number"), value: z.number().finite() }).strict().readonly(),
  z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict().readonly(),
  z.object({ kind: z.literal("strings"), values: z.array(SafeDisplayFieldSchema).readonly() }).strict().readonly(),
  z.object({ kind: z.enum(["directory", "file"]), value: SafeDisplayFieldSchema }).strict().readonly(),
]);
export const TrustedInstallConstraintViewSchema = z.object({
  pattern: SafeDisplayFieldSchema.optional(),
  min: z.number().finite().optional(), max: z.number().finite().optional(),
  minItems: z.number().int().nonnegative().optional(), maxItems: z.number().int().nonnegative().optional(),
  mustExist: z.boolean().optional(),
}).strict().readonly();
export const TrustedInstallConfigurationFieldSchema = z.object({
  key: ConfigurationKeySchema,
  label: SafeDisplayFieldSchema,
  description: SafeDisplayFieldSchema.optional(),
  kind: z.enum(["string", "number", "boolean", "directory", "file", "strings"]),
  required: z.boolean(), sensitive: z.boolean(), defaultPresent: z.boolean(),
  default: DefaultValueSchema.optional(),
  constraints: TrustedInstallConstraintViewSchema,
  state: z.enum(["missing", "defaulted", "configured", "unavailable", "invalid"]),
}).strict().readonly().superRefine((field, context) => {
  if (field.sensitive && (field.defaultPresent || field.default !== undefined)) context.addIssue({ code: "custom", path: ["default"], message: "sensitive fields cannot disclose defaults" });
  if (field.defaultPresent !== (field.default !== undefined)) context.addIssue({ code: "custom", path: ["defaultPresent"], message: "default presence does not match default view" });
  if (field.default !== undefined && field.default.kind !== field.kind) context.addIssue({ code: "custom", path: ["default"], message: "default kind does not match field" });
});

export const TrustedInstallConsentDisclosureSchema = z.object({
  consentId: TrustedInstallConsentIdSchema,
  source: NativeSourceViewSchema,
  immutableRevision: ContentDigestSchema,
  executableSurfaceDigest: ContentDigestSchema,
  components: NativeComponentInventoryViewSchema,
  requirements: z.array(NativeRuntimeRequirementViewSchema).readonly(),
  persistentData: z.literal(true),
  configurationEnvironmentNames: z.array(SafeDisplayFieldSchema).readonly(),
  subagentInterception: z.enum(["not-declared", "available", "unavailable"]),
  remoteMcpDiscovery: z.literal("not-performed"),
  statement: SafeDisplayFieldSchema,
}).strict().readonly();

export const TrustedInstallProgressPhaseRegistry = Object.freeze({
  candidateAcquisition: { tag: "candidate-acquisition" }, inputValidation: { tag: "input-validation" },
  configurationCustody: { tag: "configuration-custody" }, trustDecision: { tag: "trust-decision" },
  activationTransaction: { tag: "activation-transaction" }, activationObservation: { tag: "activation-observation" },
  completed: { tag: "completed" },
} as const);
const progressPhases = Object.values(TrustedInstallProgressPhaseRegistry).map((entry) => entry.tag) as [string, ...string[]];
export const TrustedInstallProgressEventSchema = z.object({
  sequence: z.number().int().nonnegative(), phase: z.enum(progressPhases),
  state: z.enum(["started", "completed", "retained", "failed"]),
  plugin: PluginKeySchema, scope: ScopeReferenceSchema, revision: ContentDigestSchema,
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
}).strict().readonly();

export const TrustedInstallSessionViewSchema = z.object({
  token: TrustedInstallSessionTokenSchema,
  version: TrustedInstallSessionVersionSchema,
  state: TrustedInstallSessionStateSchema,
  expiresAt: EpochMillisecondsSchema,
  binding: TrustedInstallCandidateBindingSchema,
  candidate: NativeInspectionDetailSchema,
  fields: z.array(TrustedInstallConfigurationFieldSchema).readonly(),
  consent: TrustedInstallConsentDisclosureSchema,
  progress: z.array(TrustedInstallProgressEventSchema).max(TrustedInstallSessionPolicy.maxProgressEvents).readonly(),
  retained: z.object({ configuration: z.boolean(), trust: z.boolean() }).strict().readonly(),
}).strict().readonly();

export const TrustedInstallOpenRequestSchema = z.object({
  inspectionSnapshotId: InspectionSnapshotIdSchema,
  detailId: InspectionDetailIdSchema,
}).strict().readonly();

const SensitiveInputSchema = z.custom<SensitiveValue>((value) => value instanceof SensitiveValue, { message: "sensitive input requires SensitiveValue" });
const KeyValueSchema = z.object({ key: ConfigurationKeySchema, value: z.unknown() }).strict().readonly();
const SecretValueSchema = z.object({ key: ConfigurationKeySchema, value: SensitiveInputSchema }).strict().readonly();
const ConsentSubmissionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("grant"), consentId: TrustedInstallConsentIdSchema }).strict().readonly(),
  z.object({ kind: z.literal("deny"), consentId: TrustedInstallConsentIdSchema }).strict().readonly(),
]);
export const TrustedInstallSubmissionSchema = z.object({
  expectedVersion: TrustedInstallSessionVersionSchema,
  nonSensitive: z.array(KeyValueSchema).readonly(),
  sensitive: z.array(SecretValueSchema).readonly(),
  consent: ConsentSubmissionSchema,
}).strict().readonly();

export const TrustedInstallInputIssueRegistry = Object.freeze({
  unknownKey: { tag: "CONFIG_UNKNOWN_KEY" }, duplicateInput: { tag: "CONFIG_DUPLICATE_INPUT" },
  required: { tag: "CONFIG_REQUIRED" }, type: { tag: "CONFIG_TYPE" }, pattern: { tag: "CONFIG_PATTERN" },
  bounds: { tag: "CONFIG_BOUNDS" }, pathInvalid: { tag: "CONFIG_PATH_INVALID" }, pathMissing: { tag: "CONFIG_PATH_MISSING" },
  pathWrongKind: { tag: "CONFIG_PATH_WRONG_KIND" }, pathAdapterFailed: { tag: "CONFIG_PATH_ADAPTER_FAILED" },
  sensitivityMismatch: { tag: "CONFIG_SENSITIVITY_MISMATCH" }, secretCustodyUnavailable: { tag: "SECRET_CUSTODY_UNAVAILABLE" },
  consentRequired: { tag: "CONSENT_REQUIRED" }, consentStale: { tag: "CONSENT_STALE" },
} as const);
const inputIssueCodes = Object.values(TrustedInstallInputIssueRegistry).map((entry) => entry.tag) as [string, ...string[]];
export const TrustedInstallInputIssueSchema = z.object({ code: z.enum(inputIssueCodes), key: ConfigurationKeySchema.optional() }).strict().readonly();

const RetainedSchema = z.object({ configuration: z.boolean(), trust: z.boolean() }).strict().readonly();
const SafeProgressSchema = z.array(TrustedInstallProgressEventSchema).max(TrustedInstallSessionPolicy.maxProgressEvents).readonly();
const ComponentCountsSchema = z.object({ skills: z.number().int().nonnegative(), hooks: z.number().int().nonnegative(), mcpServers: z.number().int().nonnegative() }).strict().readonly();
export const TrustedInstallStaleReasonSchema = z.enum(["session", "candidate", "configuration", "consent", "project", "capability"]);
export const TrustedInstallConflictReasonSchema = z.enum(["already-installed-different-revision", "operation-in-progress", "pending-transition", "concurrent-mutation"]);

export const TrustedInstallOpenResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("opened"), session: TrustedInstallSessionViewSchema }).strict().readonly(),
  z.object({ kind: z.literal("stale"), reason: z.enum(["candidate", "project", "capability"]) }).strict().readonly(),
  z.object({ kind: z.literal("unavailable"), code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), diagnostics: z.array(NativeDiagnosticSchema).readonly() }).strict().readonly(),
  z.object({ kind: z.literal("rejected"), code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), diagnostics: z.array(NativeDiagnosticSchema).readonly() }).strict().readonly(),
]);

export const TrustedInstallActivationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("needs-input"), issues: z.array(TrustedInstallInputIssueSchema).nonempty().readonly(), session: TrustedInstallSessionViewSchema }).strict().readonly(),
  z.object({ kind: z.literal("succeeded"), plugin: PluginKeySchema, scope: ScopeReferenceSchema, revision: ContentDigestSchema, projectionDigest: ContentDigestSchema, components: ComponentCountsSchema, progress: SafeProgressSchema, diagnostics: z.array(NativeDiagnosticSchema).readonly(), retained: RetainedSchema }).strict().readonly(),
  z.object({ kind: z.literal("current-state"), plugin: PluginKeySchema, scope: ScopeReferenceSchema, revision: ContentDigestSchema, activation: z.enum(["enabled", "disabled"]), reason: z.enum(["already-active", "enabled-existing"]), progress: SafeProgressSchema, retained: RetainedSchema }).strict().readonly(),
  z.object({ kind: z.literal("cancelled"), phase: z.enum(progressPhases), progress: SafeProgressSchema, retained: RetainedSchema }).strict().readonly(),
  z.object({ kind: z.literal("stale"), reason: TrustedInstallStaleReasonSchema, progress: SafeProgressSchema, retained: RetainedSchema }).strict().readonly(),
  z.object({ kind: z.literal("conflict"), reason: TrustedInstallConflictReasonSchema, progress: SafeProgressSchema, retained: RetainedSchema }).strict().readonly(),
  z.object({ kind: z.literal("rejected"), code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), diagnostics: z.array(NativeDiagnosticSchema).readonly(), progress: SafeProgressSchema, retained: RetainedSchema }).strict().readonly(),
  z.object({ kind: z.literal("rolled-back"), failure: z.enum(["reload-rejected", "observation-mismatch", "adapter-error"]), restored: z.boolean(), progress: SafeProgressSchema, retained: RetainedSchema }).strict().readonly(),
  z.object({
    kind: z.literal("recovery-required"),
    transition: z.string().regex(/^pending-transition-v1:sha256:[0-9a-f]{64}$/).optional(),
    committed: z.number().int().nonnegative().optional(),
    action: z.enum(["run-recovery", "retry-configuration-recovery", "retry-trust-recovery"]),
    session: TrustedInstallSessionViewSchema.optional(),
    progress: SafeProgressSchema,
    retained: RetainedSchema,
  }).strict().readonly().superRefine((result, context) => {
    if (result.action !== "run-recovery") {
      if (result.session === undefined) context.addIssue({ code: "custom", path: ["session"], message: "workflow recovery requires the owning session" });
      if (result.transition !== undefined || result.committed !== undefined) context.addIssue({ code: "custom", path: ["transition"], message: "workflow recovery cannot cite lifecycle evidence" });
    } else if (result.session !== undefined) {
      context.addIssue({ code: "custom", path: ["session"], message: "lifecycle recovery cannot cite a workflow session action" });
    }
  }),
  z.object({ kind: z.literal("failed"), code: z.enum(["ADAPTER_FAILED", "INTERACTION_FAILED", "CLEANUP_FAILED", "DISPOSED"]), progress: SafeProgressSchema, retained: RetainedSchema }).strict().readonly(),
  z.object({ kind: z.literal("expired") }).strict().readonly(),
  z.object({ kind: z.literal("disposed") }).strict().readonly(),
]);

export const TrustedInstallStatusResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("found"), session: TrustedInstallSessionViewSchema, result: TrustedInstallActivationResultSchema.optional() }).strict().readonly(),
  z.object({ kind: z.enum(["missing", "expired", "disposed"]) }).strict().readonly(),
]);
export const TrustedInstallCancellationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), state: TrustedInstallSessionStateSchema }).strict().readonly(),
  z.object({ kind: z.enum(["missing", "expired", "disposed"]) }).strict().readonly(),
]);

export type TrustedInstallSessionState = z.infer<typeof TrustedInstallSessionStateSchema>;
export type TrustedInstallSessionToken = z.infer<typeof TrustedInstallSessionTokenSchema>;
export type TrustedInstallConsentId = z.infer<typeof TrustedInstallConsentIdSchema>;
export type PreparedLifecycleCandidateBinding = z.infer<typeof PreparedLifecycleCandidateBindingSchema>;
export type TrustedInstallCandidateBinding = PreparedLifecycleCandidateBinding;
export type TrustedInstallConfigurationField = z.infer<typeof TrustedInstallConfigurationFieldSchema>;
export type TrustedInstallConsentDisclosure = z.infer<typeof TrustedInstallConsentDisclosureSchema>;
export type TrustedInstallProgressEvent = z.infer<typeof TrustedInstallProgressEventSchema>;
export type TrustedInstallSessionView = z.infer<typeof TrustedInstallSessionViewSchema>;
export type TrustedInstallOpenRequest = z.infer<typeof TrustedInstallOpenRequestSchema>;
export type TrustedInstallSubmission = z.infer<typeof TrustedInstallSubmissionSchema>;
export type TrustedInstallInputIssue = z.infer<typeof TrustedInstallInputIssueSchema>;
export type TrustedInstallOpenResult = z.infer<typeof TrustedInstallOpenResultSchema>;
export type TrustedInstallActivationResult = z.infer<typeof TrustedInstallActivationResultSchema>;
export type TrustedInstallStatusResult = z.infer<typeof TrustedInstallStatusResultSchema>;
export type TrustedInstallCancellationResult = z.infer<typeof TrustedInstallCancellationResultSchema>;

export type TrustedInstallDecisionProvider = (request: Readonly<{ session: TrustedInstallSessionView }>, signal: AbortSignal) => Promise<TrustedInstallSubmission | Readonly<{ kind: "cancelled" }>>;
export type TrustedInstallExecutionOptions = Readonly<{ onProgress?: (event: TrustedInstallProgressEvent) => void | Promise<void> }>;
export type TrustedInstallRunOptions = TrustedInstallExecutionOptions & Readonly<{ submission?: TrustedInstallSubmission; decisionProvider?: TrustedInstallDecisionProvider }>;
export interface TrustedInstallationService {
  open(request: TrustedInstallOpenRequest, signal: AbortSignal): Promise<TrustedInstallOpenResult>;
  activate(request: Readonly<{ token: TrustedInstallSessionToken; submission: TrustedInstallSubmission }>, options: TrustedInstallExecutionOptions, signal: AbortSignal): Promise<TrustedInstallActivationResult>;
  recover(request: Readonly<{ token: TrustedInstallSessionToken; submission: TrustedInstallSubmission }>, options: TrustedInstallExecutionOptions, signal: AbortSignal): Promise<TrustedInstallActivationResult>;
  run(request: TrustedInstallOpenRequest, options: TrustedInstallRunOptions, signal: AbortSignal): Promise<TrustedInstallActivationResult>;
  status(request: Readonly<{ token: TrustedInstallSessionToken }>, signal: AbortSignal): Promise<TrustedInstallStatusResult>;
  cancel(request: Readonly<{ token: TrustedInstallSessionToken }>, signal: AbortSignal): Promise<TrustedInstallCancellationResult>;
}
