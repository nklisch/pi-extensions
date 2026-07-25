import { z } from "zod";
import { ContentDigestSchema } from "../domain/content-manifest.js";
import { MarketplaceNameSchema, PluginKeySchema } from "../domain/identity.js";
import { MarketplaceRegistrationIdSchema } from "../domain/marketplace-registration.js";
import {
  PortableMarketplaceSourceSchema,
  PortablePluginConstraintSchema,
  PortableProjectDeclarationSchema,
} from "../domain/state/portable-project-declaration.js";
import { GenerationSchema } from "../domain/state/config-state.js";
import { ProjectKeySchema } from "../domain/state/scope.js";
import { NativeDiagnosticActionSchema } from "./native-diagnostic-registry.js";

export const ProjectSyncModeRegistry = Object.freeze({
  applyIntent: { tag: "apply-intent" },
  publishIntent: { tag: "publish-intent" },
  merge: { tag: "merge" },
} as const);
export const ProjectSyncModeSchema = z.enum(
  Object.values(ProjectSyncModeRegistry).map((entry) => entry.tag) as [
    "apply-intent",
    "publish-intent",
    "merge",
  ],
);

export const ProjectSyncActionKindRegistry = Object.freeze({
  writeIntent: { tag: "write-intent", order: 0 },
  disablePlugin: { tag: "disable-plugin", order: 1 },
  uninstallPlugin: { tag: "uninstall-plugin", order: 2 },
  removeMarketplace: { tag: "remove-marketplace", order: 3 },
  enablePlugin: { tag: "enable-plugin", order: 4 },
  recordIntentDigest: { tag: "record-intent-digest", order: 5 },
} as const);
export const ProjectSyncActionKindSchema = z.enum(
  Object.values(ProjectSyncActionKindRegistry).map((entry) => entry.tag) as [
    "write-intent",
    "disable-plugin",
    "uninstall-plugin",
    "remove-marketplace",
    "enable-plugin",
    "record-intent-digest",
  ],
);

export const ProjectSyncRequiredActionKindRegistry = Object.freeze({
  registerMarketplace: { tag: "register-marketplace" },
  installPlugin: { tag: "install-plugin" },
  updatePlugin: { tag: "update-plugin" },
  reviewTrust: { tag: "review-trust" },
  provideConfiguration: { tag: "provide-configuration" },
  runRecovery: { tag: "run-recovery" },
  repreviewSync: { tag: "repreview-sync" },
} as const);
export const ProjectSyncRequiredActionKindSchema = z.enum(
  Object.values(ProjectSyncRequiredActionKindRegistry).map((entry) => entry.tag) as [
    "register-marketplace",
    "install-plugin",
    "update-plugin",
    "review-trust",
    "provide-configuration",
    "run-recovery",
    "repreview-sync",
  ],
);

export const ProjectIntentObservationIdSchema = z.string()
  .regex(/^project-intent-observation-v1:sha256:[0-9a-f]{64}$/)
  .brand<"ProjectIntentObservationId">();
export const ProjectSyncActionIdSchema = z.string()
  .regex(/^project-sync-action-v1:sha256:[0-9a-f]{64}$/)
  .brand<"ProjectSyncActionId">();
export const ProjectSyncConflictIdSchema = z.string()
  .regex(/^project-sync-conflict-v1:sha256:[0-9a-f]{64}$/)
  .brand<"ProjectSyncConflictId">();

export const ProjectSyncActionSchema = z.object({
  id: ProjectSyncActionIdSchema,
  kind: ProjectSyncActionKindSchema,
  plugin: PluginKeySchema.optional(),
  registrationId: MarketplaceRegistrationIdSchema.optional(),
}).strict().readonly().superRefine((action, context) => {
  const pluginAction = ["disable-plugin", "uninstall-plugin", "enable-plugin"].includes(action.kind);
  if (pluginAction !== (action.plugin !== undefined)) {
    context.addIssue({ code: "custom", path: ["plugin"], message: "plugin identity does not match action kind" });
  }
  if ((action.kind === "remove-marketplace") !== (action.registrationId !== undefined)) {
    context.addIssue({ code: "custom", path: ["registrationId"], message: "registration identity does not match action kind" });
  }
});

export const ProjectSyncRequiredActionSchema = z.object({
  id: ProjectSyncActionIdSchema,
  kind: ProjectSyncRequiredActionKindSchema,
  plugin: PluginKeySchema.optional(),
  marketplace: MarketplaceNameSchema.optional(),
  action: NativeDiagnosticActionSchema,
}).strict().readonly().superRefine((action, context) => {
  if (action.kind === "register-marketplace" && action.marketplace === undefined) {
    context.addIssue({ code: "custom", path: ["marketplace"], message: "marketplace registration action requires a marketplace" });
  }
  if (["install-plugin", "update-plugin", "review-trust", "provide-configuration", "run-recovery"].includes(action.kind) && action.plugin === undefined) {
    context.addIssue({ code: "custom", path: ["plugin"], message: "plugin action requires a plugin" });
  }
  if (action.kind === "repreview-sync" && (action.plugin !== undefined || action.marketplace !== undefined || action.action !== "retry-read")) {
    context.addIssue({ code: "custom", message: "sync re-preview action has no plugin or marketplace owner" });
  }
});

export const ProjectSyncConflictValueSchema = z.object({
  present: z.boolean(),
  source: PortableMarketplaceSourceSchema.optional(),
  enabled: z.boolean().optional(),
  constraint: PortablePluginConstraintSchema.nullable().optional(),
}).strict().readonly().superRefine((value, context) => {
  const fields = Number(value.source !== undefined) + Number(value.enabled !== undefined) + Number(value.constraint !== undefined);
  if (value.present && fields !== 1) context.addIssue({ code: "custom", message: "present conflict values carry exactly one value" });
  if (!value.present && fields !== 0) context.addIssue({ code: "custom", message: "absent conflict values carry no value" });
});

export const ProjectSyncConflictSchema = z.object({
  id: ProjectSyncConflictIdSchema,
  kind: z.enum(["marketplace-source", "plugin-enabled", "plugin-constraint"]),
  marketplace: MarketplaceNameSchema.optional(),
  plugin: PluginKeySchema.optional(),
  file: ProjectSyncConflictValueSchema,
  machine: ProjectSyncConflictValueSchema,
}).strict().readonly().superRefine((conflict, context) => {
  if (conflict.kind === "marketplace-source" && conflict.marketplace === undefined) {
    context.addIssue({ code: "custom", path: ["marketplace"], message: "marketplace conflict requires identity" });
  }
  if (conflict.kind !== "marketplace-source" && conflict.plugin === undefined) {
    context.addIssue({ code: "custom", path: ["plugin"], message: "plugin conflict requires identity" });
  }
});

export const ProjectSyncConflictResolutionSchema = z.object({
  conflictId: ProjectSyncConflictIdSchema,
  choose: z.enum(["file", "machine", "omit"]),
}).strict().readonly();

export const ProjectSyncPlanSchema = z.object({
  mode: ProjectSyncModeSchema,
  projectKey: ProjectKeySchema,
  projectEpoch: ContentDigestSchema,
  stateGeneration: GenerationSchema,
  baselineDigest: ContentDigestSchema,
  file: z.object({
    status: z.enum(["missing", "present"]),
    observationId: ProjectIntentObservationIdSchema,
    digest: ContentDigestSchema.optional(),
  }).strict().readonly(),
  machineDigest: ContentDigestSchema,
  readinessDigest: ContentDigestSchema,
  convergenceReadinessDigest: ContentDigestSchema.optional(),
  desiredDigest: ContentDigestSchema.optional(),
  planDigest: ContentDigestSchema,
  actions: z.array(ProjectSyncActionSchema).max(512).readonly(),
  requiredActions: z.array(ProjectSyncRequiredActionSchema).max(512).readonly(),
  conflicts: z.array(ProjectSyncConflictSchema).max(512).readonly(),
}).strict().readonly().superRefine((plan, context) => {
  if (plan.file.status === "present" && plan.file.digest === undefined) {
    context.addIssue({ code: "custom", path: ["file", "digest"], message: "present file requires a digest" });
  }
  if (plan.file.status === "missing" && plan.file.digest !== undefined) {
    context.addIssue({ code: "custom", path: ["file", "digest"], message: "missing file cannot carry a digest" });
  }
  if ((plan.desiredDigest !== undefined) !== (plan.convergenceReadinessDigest !== undefined)) {
    context.addIssue({ code: "custom", path: ["convergenceReadinessDigest"], message: "resolved desired intent requires a convergence readiness digest" });
  }
  for (const [path, values] of [["actions", plan.actions], ["requiredActions", plan.requiredActions], ["conflicts", plan.conflicts]] as const) {
    const ids = values.map((value) => value.id);
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: [path], message: "duplicate identifiers" });
  }
});

export const VerifiedProjectSyncContextSchema = z.object({
  plan: ProjectSyncPlanSchema,
  desired: PortableProjectDeclarationSchema.optional(),
}).strict().readonly();

export type ProjectSyncMode = z.infer<typeof ProjectSyncModeSchema>;
export type ProjectIntentObservationId = z.infer<typeof ProjectIntentObservationIdSchema>;
export type ProjectSyncActionId = z.infer<typeof ProjectSyncActionIdSchema>;
export type ProjectSyncConflictId = z.infer<typeof ProjectSyncConflictIdSchema>;
export type ProjectSyncAction = z.infer<typeof ProjectSyncActionSchema>;
export type ProjectSyncRequiredAction = z.infer<typeof ProjectSyncRequiredActionSchema>;
export type ProjectSyncConflictValue = z.infer<typeof ProjectSyncConflictValueSchema>;
export type ProjectSyncConflict = z.infer<typeof ProjectSyncConflictSchema>;
export type ProjectSyncConflictResolution = z.infer<typeof ProjectSyncConflictResolutionSchema>;
export type ProjectSyncPlan = z.infer<typeof ProjectSyncPlanSchema>;
export type VerifiedProjectSyncContext = z.infer<typeof VerifiedProjectSyncContextSchema>;
