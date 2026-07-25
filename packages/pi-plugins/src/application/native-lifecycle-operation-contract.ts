import { z } from "zod";
import { ContentDigestSchema } from "../domain/content-manifest.js";
import { ConfigurationKeySchema } from "../domain/configuration.js";
import { PluginKeySchema } from "../domain/identity.js";
import { GenerationSchema } from "../domain/state/config-state.js";
import { PendingTransitionRefSchema } from "../domain/state/references.js";
import { ProjectKeySchema, ScopeReferenceSchema } from "../domain/state/scope.js";
import { EpochMillisecondsSchema } from "./ports/lifecycle-clock.js";
import { SensitiveValue } from "./sensitive-value.js";
import {
  InspectionDetailIdSchema,
  InspectionSnapshotIdSchema,
  NativeDiagnosticSchema,
} from "./native-inspection-contract.js";
import {
  PreparedLifecycleCandidateBindingSchema,
  TrustedInstallConfigurationFieldSchema,
  TrustedInstallConsentDisclosureSchema,
  TrustedInstallConsentIdSchema,
} from "./trusted-install-contract.js";
import {
  ProjectSyncActionIdSchema,
  ProjectSyncConflictResolutionSchema,
  ProjectSyncPlanSchema,
  ProjectSyncRequiredActionSchema,
} from "./project-sync-contract.js";

export const NativeLifecycleOperationSessionPolicy = Object.freeze({
  idleTtlMs: 15 * 60_000,
  absoluteTtlMs: 60 * 60_000,
  terminalRetentionMs: 5 * 60_000,
  maxProgressEvents: 128,
  maxSyncActions: 512,
  maxProjectIntentBytes: 1_048_576,
  maxProjectDeclarations: 512,
});

export const NativeLifecycleOperationRegistry = Object.freeze({
  enable: { tag: "enable" },
  disable: { tag: "disable" },
  update: { tag: "update" },
  uninstall: { tag: "uninstall" },
  projectSync: { tag: "project-sync" },
} as const);
export const NativeLifecycleOperationKindSchema = z.enum(
  Object.values(NativeLifecycleOperationRegistry).map((entry) => entry.tag) as [
    "enable", "disable", "update", "uninstall", "project-sync",
  ],
);

export const NativeLifecycleProgressPhaseRegistry = Object.freeze({
  preflight: { tag: "preflight", order: 0 },
  authorityRevalidation: { tag: "authority-revalidation", order: 1 },
  candidatePreparation: { tag: "candidate-preparation", order: 2 },
  configurationCustody: { tag: "configuration-custody", order: 3 },
  trustDecision: { tag: "trust-decision", order: 4 },
  projectFileWrite: { tag: "project-file-write", order: 5 },
  lifecycleTransaction: { tag: "lifecycle-transaction", order: 6 },
  runtimeObservation: { tag: "runtime-observation", order: 7 },
  projectReconciliation: { tag: "project-reconciliation", order: 8 },
  uninstallCleanup: { tag: "uninstall-cleanup", order: 9 },
  finalization: { tag: "finalization", order: 10 },
  completed: { tag: "completed", order: 11 },
} as const);
export const NativeLifecycleProgressPhaseSchema = z.enum(
  Object.values(NativeLifecycleProgressPhaseRegistry).map((entry) => entry.tag) as [
    "preflight", "authority-revalidation", "candidate-preparation", "configuration-custody",
    "trust-decision", "project-file-write", "lifecycle-transaction", "runtime-observation",
    "project-reconciliation", "uninstall-cleanup", "finalization", "completed",
  ],
);

export const NativeLifecycleStableCodeRegistry = Object.freeze({
  invalidRequest: { tag: "INVALID_REQUEST" },
  notInstalled: { tag: "NOT_INSTALLED" },
  wrongActivation: { tag: "WRONG_ACTIVATION" },
  pendingTransition: { tag: "PENDING_TRANSITION" },
  incompatible: { tag: "INCOMPATIBLE" },
  untrusted: { tag: "UNTRUSTED" },
  unconfigured: { tag: "UNCONFIGURED" },
  malformed: { tag: "MALFORMED" },
  projectionFailed: { tag: "PROJECTION_FAILED" },
  promotionFailed: { tag: "PROMOTION_FAILED" },
  aborted: { tag: "ABORTED" },
  availableRevisionChanged: { tag: "AVAILABLE_REVISION_CHANGED" },
  configurationStale: { tag: "CONFIGURATION_STALE" },
  stateCorrupt: { tag: "STATE_CORRUPT" },
  projectUntrusted: { tag: "PROJECT_UNTRUSTED" },
  projectRootStale: { tag: "PROJECT_ROOT_STALE" },
  projectIntentMissing: { tag: "PROJECT_INTENT_MISSING" },
  projectIntentWriteUnavailable: { tag: "PROJECT_INTENT_WRITE_UNAVAILABLE" },
  projectIntentWriteFailed: { tag: "PROJECT_INTENT_WRITE_FAILED" },
  fileUnsafe: { tag: "FILE_UNSAFE" },
  fileTooLarge: { tag: "FILE_TOO_LARGE" },
  fileInvalidUtf8: { tag: "FILE_INVALID_UTF8" },
  fileInvalid: { tag: "FILE_INVALID" },
  adapterFailed: { tag: "ADAPTER_FAILED" },
  progressDeliveryFailed: { tag: "PROGRESS_DELIVERY_FAILED" },
  cleanupFailed: { tag: "CLEANUP_FAILED" },
  disposed: { tag: "DISPOSED" },
} as const);
export const NativeLifecycleStableCodeSchema = z.enum(
  Object.values(NativeLifecycleStableCodeRegistry).map((entry) => entry.tag) as [
    (typeof NativeLifecycleStableCodeRegistry)[keyof typeof NativeLifecycleStableCodeRegistry]["tag"],
    ...(typeof NativeLifecycleStableCodeRegistry)[keyof typeof NativeLifecycleStableCodeRegistry]["tag"][],
  ],
);

export const NativeLifecycleOperationTokenSchema = z.string()
  .regex(/^native-operation-session-v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}$/)
  // The fixed prefix + UUID + separator + SHA-256 checksum is 129 bytes.
  .max(129)
  .brand<"NativeLifecycleOperationToken">();
export const NativeLifecyclePreviewIdSchema = z.string()
  .regex(/^native-operation-preview-v1:sha256:[0-9a-f]{64}$/)
  .brand<"NativeLifecyclePreviewId">();
export const NativeLifecycleSessionVersionSchema = z.number().int().nonnegative();

export const NativeInstalledOperationTargetRequestSchema = z.object({
  inspectionSnapshotId: InspectionSnapshotIdSchema,
  detailId: InspectionDetailIdSchema,
}).strict().readonly();

export const NativeLifecycleOperationRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("enable"), target: NativeInstalledOperationTargetRequestSchema }).strict().readonly(),
  z.object({ operation: z.literal("disable"), target: NativeInstalledOperationTargetRequestSchema }).strict().readonly(),
  z.object({ operation: z.literal("uninstall"), target: NativeInstalledOperationTargetRequestSchema }).strict().readonly(),
  z.object({ operation: z.literal("update"), target: NativeInstalledOperationTargetRequestSchema, candidate: NativeInstalledOperationTargetRequestSchema }).strict().readonly(),
  z.object({ operation: z.literal("project-sync"), mode: z.enum(["apply-intent", "publish-intent", "merge"]), projectKey: ProjectKeySchema }).strict().readonly(),
]);

export const LifecycleTargetExpectationSchema = z.object({
  generation: GenerationSchema,
  plugin: PluginKeySchema,
  selectedRevision: ContentDigestSchema,
  activation: z.enum(["enabled", "disabled"]),
  targetDigest: ContentDigestSchema,
  pendingTransition: z.literal("none"),
}).strict().readonly();

export const NativeLifecycleTargetBindingSchema = z.object({
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
  stateGeneration: GenerationSchema,
  selectedRevision: ContentDigestSchema,
  activation: z.enum(["enabled", "disabled"]),
  targetDigest: ContentDigestSchema,
  inspectionSnapshotId: InspectionSnapshotIdSchema,
  detailId: InspectionDetailIdSchema,
  projectEpoch: ContentDigestSchema.optional(),
  transition: z.literal("none"),
}).strict().readonly();

export const NativeLifecycleOperationPreviewSchema = z.object({
  previewId: NativeLifecyclePreviewIdSchema,
  operation: NativeLifecycleOperationKindSchema,
  admission: z.enum(["ready", "needs-input", "needs-action", "blocked"]),
  target: NativeLifecycleTargetBindingSchema.optional(),
  update: z.object({
    candidate: PreparedLifecycleCandidateBindingSchema,
    updateCandidate: z.string().regex(/^update-candidate-v1:sha256:[0-9a-f]{64}$/),
    fields: z.array(TrustedInstallConfigurationFieldSchema).readonly(),
    consent: TrustedInstallConsentDisclosureSchema,
    authority: z.object({
      configurationRevision: ContentDigestSchema.nullable(),
      trustFingerprint: ContentDigestSchema,
    }).strict().readonly(),
  }).strict().readonly().optional(),
  sync: ProjectSyncPlanSchema.optional(),
  diagnostics: z.array(NativeDiagnosticSchema).readonly(),
}).strict().readonly().superRefine((preview, context) => {
  if (preview.operation === "project-sync" && preview.sync === undefined) context.addIssue({ code: "custom", path: ["sync"], message: "sync preview requires a plan" });
  if (preview.operation !== "project-sync" && preview.target === undefined) context.addIssue({ code: "custom", path: ["target"], message: "installed operation requires a target" });
  if ((preview.operation === "update") !== (preview.update !== undefined)) context.addIssue({ code: "custom", path: ["update"], message: "update evidence does not match operation" });
});

export const NativeLifecycleProgressEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  operation: NativeLifecycleOperationKindSchema,
  phase: NativeLifecycleProgressPhaseSchema,
  state: z.enum(["started", "completed", "skipped", "retained", "failed"]),
  plugin: PluginKeySchema.optional(),
  actionId: ProjectSyncActionIdSchema.optional(),
  code: NativeLifecycleStableCodeSchema.optional(),
}).strict().readonly();

const ProgressSchema = z.array(NativeLifecycleProgressEventSchema)
  .max(NativeLifecycleOperationSessionPolicy.maxProgressEvents)
  .readonly()
  .superRefine((events, context) => {
    let sequence = -1;
    let phase = -1;
    for (const [index, event] of events.entries()) {
      const currentPhase = Object.values(NativeLifecycleProgressPhaseRegistry).find((entry) => entry.tag === event.phase)!.order;
      if (event.sequence <= sequence) context.addIssue({ code: "custom", path: [index, "sequence"], message: "progress sequence must increase" });
      if (currentPhase < phase) context.addIssue({ code: "custom", path: [index, "phase"], message: "progress phases cannot move backward" });
      sequence = event.sequence;
      phase = currentPhase;
    }
  });

export const NativeLifecycleEffectSchema = z.object({
  state: z.enum(["unchanged", "changed", "partially-changed", "unknown"]),
  projectFile: z.enum(["unchanged", "written", "unknown"]),
  completedActionIds: z.array(ProjectSyncActionIdSchema).max(NativeLifecycleOperationSessionPolicy.maxSyncActions).readonly(),
  pendingActionIds: z.array(ProjectSyncActionIdSchema).max(NativeLifecycleOperationSessionPolicy.maxSyncActions).readonly(),
  generation: GenerationSchema.optional(),
}).strict().readonly().superRefine((effects, context) => {
  const completed = new Set(effects.completedActionIds);
  const pending = new Set(effects.pendingActionIds);
  if (completed.size !== effects.completedActionIds.length) context.addIssue({ code: "custom", path: ["completedActionIds"], message: "completed actions must be unique" });
  if (pending.size !== effects.pendingActionIds.length) context.addIssue({ code: "custom", path: ["pendingActionIds"], message: "pending actions must be unique" });
  if ([...completed].some((id) => pending.has(id))) context.addIssue({ code: "custom", message: "completed and pending actions must be disjoint" });
  if (effects.state === "unchanged" && (completed.size > 0 || effects.projectFile === "written")) context.addIssue({ code: "custom", path: ["state"], message: "unchanged effects cannot report writes" });
  if (effects.state === "partially-changed" && completed.size === 0 && effects.projectFile !== "written") context.addIssue({ code: "custom", path: ["state"], message: "partial effects require a proven write" });
});

const ComponentCountsSchema = z.object({
  skills: z.number().int().nonnegative(),
  hooks: z.number().int().nonnegative(),
  mcpServers: z.number().int().nonnegative(),
}).strict().readonly();
const UninstallCleanupViewSchema = z.object({
  persistentData: z.enum(["retained", "deleted", "recovery-required"]),
  configuration: z.literal("retained"),
  trust: z.literal("retained"),
  revisions: z.literal("collection-deferred"),
}).strict().readonly();
export const NativeLifecycleRetainedPreflightEvidenceSchema = z.object({
  configuration: z.boolean(),
  trust: z.boolean(),
  configurationRevision: ContentDigestSchema.optional(),
  trustFingerprint: ContentDigestSchema.optional(),
}).strict().readonly().superRefine((value, context) => {
  if (value.configuration !== (value.configurationRevision !== undefined)) context.addIssue({ code: "custom", path: ["configurationRevision"], message: "retained configuration requires its safe exact revision" });
  if (value.trust !== (value.trustFingerprint !== undefined)) context.addIssue({ code: "custom", path: ["trustFingerprint"], message: "retained trust requires its safe exact fingerprint" });
});

const ResultBase = {
  operation: NativeLifecycleOperationKindSchema,
  previewId: NativeLifecyclePreviewIdSchema,
  progress: ProgressSchema,
  diagnostics: z.array(NativeDiagnosticSchema).readonly(),
  effects: NativeLifecycleEffectSchema,
  retainedPreflight: NativeLifecycleRetainedPreflightEvidenceSchema.optional(),
} as const;

export const NativeLifecycleOperationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("succeeded"), ...ResultBase, before: NativeLifecycleTargetBindingSchema.optional(), after: NativeLifecycleTargetBindingSchema.optional(), syncDigest: ContentDigestSchema.optional(), components: ComponentCountsSchema.optional(), cleanup: UninstallCleanupViewSchema.optional() }).strict().readonly(),
  z.object({ kind: z.literal("current-state"), ...ResultBase, reason: z.enum(["already-enabled", "already-disabled", "revision-current", "already-uninstalled", "project-converged"]), target: NativeLifecycleTargetBindingSchema.optional(), syncDigest: ContentDigestSchema.optional() }).strict().readonly(),
  z.object({ kind: z.literal("needs-action"), ...ResultBase, operation: z.literal("project-sync"), actions: z.array(ProjectSyncRequiredActionSchema).nonempty().max(NativeLifecycleOperationSessionPolicy.maxSyncActions).readonly() }).strict().readonly(),
  z.object({ kind: z.literal("cancelled"), ...ResultBase, phase: NativeLifecycleProgressPhaseSchema }).strict().readonly(),
  z.object({ kind: z.literal("stale"), ...ResultBase, reason: z.enum(["session", "inspection", "target", "candidate", "configuration", "consent", "project", "file", "capability"]) }).strict().readonly(),
  z.object({ kind: z.literal("conflict"), ...ResultBase, reason: z.enum(["operation-in-progress", "pending-transition", "target-changed", "state-generation-changed", "file-changed", "unresolved-merge", "concurrent-mutation"]) }).strict().readonly(),
  z.object({ kind: z.literal("rejected"), ...ResultBase, code: NativeLifecycleStableCodeSchema }).strict().readonly(),
  z.object({ kind: z.literal("rolled-back"), ...ResultBase, operation: z.enum(["enable", "disable", "update", "uninstall"]), failure: z.enum(["reload-rejected", "observation-mismatch", "adapter-error"]), restored: NativeLifecycleTargetBindingSchema }).strict().readonly(),
  z.object({ kind: z.literal("recovery-required"), ...ResultBase, code: NativeLifecycleStableCodeSchema, transition: PendingTransitionRefSchema.optional(), committed: GenerationSchema.optional(), action: z.literal("run-recovery") }).strict().readonly(),
  z.object({ kind: z.literal("failed"), ...ResultBase, code: z.enum(["ADAPTER_FAILED", "PROGRESS_DELIVERY_FAILED", "PROJECT_INTENT_WRITE_FAILED", "CLEANUP_FAILED", "DISPOSED"]) }).strict().readonly(),
  z.object({ kind: z.literal("expired") }).strict().readonly(),
  z.object({ kind: z.literal("disposed") }).strict().readonly(),
]).superRefine((result, context) => {
  if (!("operation" in result)) return;
  if (result.kind === "succeeded") {
    const sync = result.operation === "project-sync";
    if (sync !== (result.syncDigest !== undefined)) context.addIssue({ code: "custom", path: ["syncDigest"], message: "sync success requires only a sync digest" });
    if (!sync && result.before === undefined) context.addIssue({ code: "custom", path: ["before"], message: "lifecycle success requires before evidence" });
    if (!sync && result.operation !== "uninstall" && result.after === undefined) context.addIssue({ code: "custom", path: ["after"], message: "activation success requires after evidence" });
    if (result.operation === "uninstall" && result.after !== undefined) context.addIssue({ code: "custom", path: ["after"], message: "uninstall success must prove target absence" });
    if ((result.operation === "uninstall") !== (result.cleanup !== undefined)) context.addIssue({ code: "custom", path: ["cleanup"], message: "cleanup belongs only to uninstall success" });
  }
  if (result.kind === "current-state") {
    const sync = result.operation === "project-sync";
    if (sync !== (result.syncDigest !== undefined)) context.addIssue({ code: "custom", path: ["syncDigest"], message: "sync current state requires a sync digest" });
  }
});

export const NativeLifecycleOperationSessionStateSchema = z.enum(["previewed", "applying", "succeeded", "current-state", "needs-action", "cancelled", "stale", "conflict", "rejected", "rolled-back", "recovery-required", "failed", "expired", "disposed"]);

export const NativeLifecycleOperationSessionViewSchema = z.object({
  token: NativeLifecycleOperationTokenSchema,
  version: NativeLifecycleSessionVersionSchema,
  state: NativeLifecycleOperationSessionStateSchema,
  expiresAt: EpochMillisecondsSchema,
  preview: NativeLifecycleOperationPreviewSchema,
  progress: ProgressSchema,
}).strict().readonly();

export const NativeLifecycleOperationPreviewResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("opened"), session: NativeLifecycleOperationSessionViewSchema }).strict().readonly(),
  z.object({ kind: z.literal("current-state"), operation: NativeLifecycleOperationKindSchema, diagnostics: z.array(NativeDiagnosticSchema).readonly() }).strict().readonly(),
  z.object({ kind: z.literal("stale"), reason: z.enum(["inspection", "target", "candidate", "configuration", "project", "file", "capability"]) }).strict().readonly(),
  z.object({ kind: z.literal("unavailable"), code: NativeLifecycleStableCodeSchema, diagnostics: z.array(NativeDiagnosticSchema).readonly() }).strict().readonly(),
  z.object({ kind: z.literal("rejected"), code: NativeLifecycleStableCodeSchema, diagnostics: z.array(NativeDiagnosticSchema).readonly() }).strict().readonly(),
]);

const SensitiveInputSchema = z.custom<SensitiveValue>((value) => value instanceof SensitiveValue, { message: "sensitive input requires SensitiveValue" });
export const NativeUpdateConfirmationInputSchema = z.object({
  nonSensitive: z.array(z.object({ key: ConfigurationKeySchema, value: z.unknown() }).strict().readonly()).readonly(),
  sensitive: z.array(z.object({ key: ConfigurationKeySchema, value: SensitiveInputSchema }).strict().readonly()).readonly(),
  consent: z.object({ kind: z.literal("grant"), consentId: TrustedInstallConsentIdSchema }).strict().readonly(),
  authority: z.object({
    configurationRevision: ContentDigestSchema.nullable(),
    trustFingerprint: ContentDigestSchema,
  }).strict().readonly(),
}).strict().readonly();

export const NativeLifecycleOperationConfirmationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deny"), previewId: NativeLifecyclePreviewIdSchema, expectedVersion: NativeLifecycleSessionVersionSchema }).strict().readonly(),
  z.object({ kind: z.literal("confirm"), previewId: NativeLifecyclePreviewIdSchema, expectedVersion: NativeLifecycleSessionVersionSchema, operation: z.enum(["enable", "disable"]) }).strict().readonly(),
  z.object({ kind: z.literal("confirm-update"), previewId: NativeLifecyclePreviewIdSchema, expectedVersion: NativeLifecycleSessionVersionSchema, input: NativeUpdateConfirmationInputSchema }).strict().readonly(),
  z.object({ kind: z.literal("confirm-uninstall"), previewId: NativeLifecyclePreviewIdSchema, expectedVersion: NativeLifecycleSessionVersionSchema, persistentData: z.enum(["keep", "delete-confirmed"]) }).strict().readonly(),
  z.object({ kind: z.literal("confirm-project-sync"), previewId: NativeLifecyclePreviewIdSchema, expectedVersion: NativeLifecycleSessionVersionSchema, resolutions: z.array(ProjectSyncConflictResolutionSchema).max(NativeLifecycleOperationSessionPolicy.maxSyncActions).readonly() }).strict().readonly().superRefine((confirmation, context) => {
    const ids = confirmation.resolutions.map((resolution) => resolution.conflictId);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["resolutions"], message: "duplicate conflict resolutions" });
  }),
]);

export const NativeLifecycleOperationStatusResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("found"), session: NativeLifecycleOperationSessionViewSchema, result: NativeLifecycleOperationResultSchema.optional() }).strict().readonly(),
  z.object({ kind: z.enum(["missing", "expired", "disposed"]) }).strict().readonly(),
]);
export const NativeLifecycleOperationCancellationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accepted"), state: NativeLifecycleOperationSessionStateSchema }).strict().readonly(),
  z.object({ kind: z.enum(["missing", "expired", "disposed"]) }).strict().readonly(),
]);

export type NativeLifecycleOperationKind = z.infer<typeof NativeLifecycleOperationKindSchema>;
export type NativeLifecycleStableCode = z.infer<typeof NativeLifecycleStableCodeSchema>;
export type NativeLifecycleOperationToken = z.infer<typeof NativeLifecycleOperationTokenSchema>;
export type NativeLifecyclePreviewId = z.infer<typeof NativeLifecyclePreviewIdSchema>;
export type NativeLifecycleSessionVersion = z.infer<typeof NativeLifecycleSessionVersionSchema>;
export type NativeInstalledOperationTargetRequest = z.infer<typeof NativeInstalledOperationTargetRequestSchema>;
export type NativeLifecycleOperationRequest = z.infer<typeof NativeLifecycleOperationRequestSchema>;
export type LifecycleTargetExpectation = z.infer<typeof LifecycleTargetExpectationSchema>;
export type NativeLifecycleTargetBinding = z.infer<typeof NativeLifecycleTargetBindingSchema>;
export type NativeLifecycleOperationPreview = z.infer<typeof NativeLifecycleOperationPreviewSchema>;
export type NativeLifecycleProgressPhase = z.infer<typeof NativeLifecycleProgressPhaseSchema>;
export type NativeLifecycleProgressEvent = z.infer<typeof NativeLifecycleProgressEventSchema>;
export type NativeLifecycleEffect = z.infer<typeof NativeLifecycleEffectSchema>;
export type NativeLifecycleRetainedPreflightEvidence = z.infer<typeof NativeLifecycleRetainedPreflightEvidenceSchema>;
export type NativeLifecycleOperationResult = z.infer<typeof NativeLifecycleOperationResultSchema>;
export type NativeLifecycleOperationSessionState = z.infer<typeof NativeLifecycleOperationSessionStateSchema>;
export type NativeLifecycleOperationSessionView = z.infer<typeof NativeLifecycleOperationSessionViewSchema>;
export type NativeLifecycleOperationPreviewResult = z.infer<typeof NativeLifecycleOperationPreviewResultSchema>;
export type NativeUpdateConfirmationInput = z.infer<typeof NativeUpdateConfirmationInputSchema>;
export type NativeLifecycleOperationConfirmation = z.infer<typeof NativeLifecycleOperationConfirmationSchema>;
export type NativeLifecycleOperationStatusResult = z.infer<typeof NativeLifecycleOperationStatusResultSchema>;
export type NativeLifecycleOperationCancellationResult = z.infer<typeof NativeLifecycleOperationCancellationResultSchema>;

export type NativeLifecycleProgressSink = (event: NativeLifecycleProgressEvent) => void | Promise<void>;
export type NativeLifecycleDecisionProvider = (
  preview: NativeLifecycleOperationSessionView,
  signal: AbortSignal,
) => Promise<NativeLifecycleOperationConfirmation | Readonly<{ kind: "cancelled" }>>;
export type NativeLifecycleExecutionOptions = Readonly<{ onProgress?: NativeLifecycleProgressSink }>;
export type NativeLifecycleRunOptions = NativeLifecycleExecutionOptions & Readonly<{ decisionProvider: NativeLifecycleDecisionProvider }>;

export interface NativeLifecycleOperationService {
  preview(request: NativeLifecycleOperationRequest, signal: AbortSignal): Promise<NativeLifecycleOperationPreviewResult>;
  apply(request: Readonly<{ token: NativeLifecycleOperationToken; confirmation: NativeLifecycleOperationConfirmation }>, options: NativeLifecycleExecutionOptions, signal: AbortSignal): Promise<NativeLifecycleOperationResult>;
  run(request: NativeLifecycleOperationRequest, options: NativeLifecycleRunOptions, signal: AbortSignal): Promise<NativeLifecycleOperationResult>;
  status(request: Readonly<{ token: NativeLifecycleOperationToken }>, signal: AbortSignal): Promise<NativeLifecycleOperationStatusResult>;
  cancel(request: Readonly<{ token: NativeLifecycleOperationToken }>, signal: AbortSignal): Promise<NativeLifecycleOperationCancellationResult>;
}
