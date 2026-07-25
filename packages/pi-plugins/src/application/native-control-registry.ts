import { z } from "zod";
import { AdoptionCandidateIdSchema } from "../domain/adoption.js";
import "../domain/content-manifest.js";
import { PluginKeySchema } from "../domain/identity.js";
import {
  MarketplaceCursorSchema,
  MarketplaceRegistrationIdSchema,
} from "../domain/marketplace-registration.js";
import { MarketplaceAvailabilitySchema } from "../domain/marketplace.js";
import { MarketplaceSourceSchema } from "../domain/source.js";
import {
  UpdateNoticeIdSchema,
  UpdateApplicationOverrideSchema,
  UpdateCadenceSchema,
  UpdatePolicyConsentIdSchema,
  UpdatePolicyPreviewIdSchema,
} from "../domain/update-policy.js";
import { AdoptionImportResultSchema, AdoptionPreviewResultSchema } from "./adoption-contract.js";
import {
  InspectionCursorSchema,
  InspectionDetailIdSchema,
  InspectionSnapshotIdSchema,
  NativeDiagnosticReportSchema,
  NativeInspectionDetailResultSchema,
  NativeInspectionPageSchema,
  SafeDisplayFieldSchema,
} from "./native-inspection-contract.js";
import {
  NativeLifecycleOperationCancellationResultSchema,
  NativeLifecycleOperationPreviewResultSchema,
  NativeLifecycleOperationResultSchema,
  NativeLifecycleOperationStatusResultSchema,
  NativeLifecycleOperationTokenSchema,
} from "./native-lifecycle-operation-contract.js";
import {
  MarketplaceAddResultSchema,
  MarketplaceRegistrationPageSchema,
  MarketplaceRemoveResultSchema,
} from "./marketplace-management-contract.js";
import { MarketplaceCatalogPageSchema } from "./marketplace-catalog-contract.js";
import { MarketplaceRefreshResultSchema } from "./update-contract.js";
import {
  NativeAutomaticUpdateRunResultSchema,
  NativeUpdateAcknowledgmentResultSchema,
  NativeUpdateNotificationPageSchema,
  NativeUpdatePolicyApplyResultSchema,
  NativeUpdatePolicyPreviewResultSchema,
  NativeUpdateStatusSchema,
} from "./native-update-contract.js";
import {
  TrustedInstallActivationResultSchema,
  TrustedInstallCancellationResultSchema,
  TrustedInstallOpenResultSchema,
  TrustedInstallSessionTokenSchema,
  TrustedInstallStatusResultSchema,
} from "./trusted-install-contract.js";
import {
  NativeHostPrecedenceRequestSchema,
  NativeHostPrecedenceResultSchema,
} from "./host-precedence-contract.js";
import { HostStatusSnapshotSchema } from "./host-observation-contract.js";
import {
  NativeControlAdoptionImportResponseSchema,
  NativeControlAdoptionPreviewResponseSchema,
  NativeControlGrammarResponseSchema,
  NativeControlHelpResponseSchema,
  NativeControlMarketplaceAddResponseSchema,
  NativeControlMarketplaceCatalogResponseSchema,
  NativeControlMarketplaceListResponseSchema,
  NativeControlMarketplaceRefreshResponseSchema,
  NativeControlPresentationResponseSchema,
  projectAdoptionImportResponse,
  projectAdoptionPreviewResponse,
  projectMarketplaceAddResponse,
  projectMarketplaceCatalogResponse,
  projectMarketplaceListResponse,
  projectMarketplaceRefreshResponse,
} from "./native-control-safe-projection.js";

export const NativeControlGrammarVersionSchema = z.literal("plugin-control/v1");
export type NativeControlGrammarVersion = z.infer<typeof NativeControlGrammarVersionSchema>;

export const NativeControlInputChannelSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict().readonly(),
  z.object({ kind: z.literal("provided") }).strict().readonly(),
  z.object({ kind: z.literal("stdin-json") }).strict().readonly(),
  z.object({ kind: z.literal("file-json"), locator: z.string().min(1).max(4096) }).strict().readonly(),
  z.object({ kind: z.literal("environment"), prefix: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/) }).strict().readonly(),
]);
export type NativeControlInputChannel = z.infer<typeof NativeControlInputChannelSchema>;

export const NativeControlInvocationSchema = z.object({
  grammarVersion: NativeControlGrammarVersionSchema.default("plugin-control/v1"),
  output: z.enum(["json", "human"]).default("human"),
  timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
  nonInteractive: z.boolean().default(false),
  input: NativeControlInputChannelSchema.default({ kind: "none" }),
}).strict().readonly();
export type NativeControlInvocation = z.infer<typeof NativeControlInvocationSchema>;

const ScopeSchema = z.enum(["user", "project"]);
const ReadScopeSchema = z.enum(["user", "project", "all-current"]);
const LimitSchema = z.number().int().min(1).max(200);
const ExactPair = {
  snapshotId: InspectionSnapshotIdSchema.optional(),
  detailId: InspectionDetailIdSchema.optional(),
} as const;

function exactPair(schema: z.ZodObject<any>): z.ZodTypeAny {
  return schema.superRefine((value: { snapshotId?: string; detailId?: string }, context) => {
    if ((value.snapshotId === undefined) !== (value.detailId === undefined)) {
      context.addIssue({ code: "custom", path: [value.snapshotId === undefined ? "snapshotId" : "detailId"], message: "snapshot and detail identifiers must be supplied together" });
    }
  }).readonly();
}

const EmptyRequestSchema = z.object({}).strict().readonly();
const PresentationRequestSchema = z.object({}).strict().readonly();
const HelpRequestSchema = z.object({ path: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).max(8).readonly().default([]) }).strict().readonly();
const GrammarRequestSchema = z.object({ version: NativeControlGrammarVersionSchema.optional() }).strict().readonly();
const MarketplaceAddControlSchema = z.object({ source: MarketplaceSourceSchema }).strict().readonly();
const MarketplaceRemoveControlSchema = z.object({ registrationId: MarketplaceRegistrationIdSchema, confirmed: z.literal(true) }).strict().readonly();
const MarketplaceListControlSchema = z.object({ limit: LimitSchema.default(50) }).strict().readonly();
const MarketplaceRefreshControlSchema = z.object({ registrationIds: z.array(MarketplaceRegistrationIdSchema).readonly().optional() }).strict().readonly();
const AdoptionPreviewControlSchema = z.object({}).strict().readonly();
const AdoptionImportControlSchema = z.object({ candidateIds: z.array(AdoptionCandidateIdSchema).min(1).readonly(), confirmed: z.literal(true) }).strict().readonly();
const BrowseControlSchema = z.object({
  query: z.string().max(256).default(""),
  scope: ReadScopeSchema.default("all-current"),
  marketplaceIds: z.array(MarketplaceRegistrationIdSchema).readonly().optional(),
  availability: z.array(MarketplaceAvailabilitySchema).readonly().optional(),
  cursor: MarketplaceCursorSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict().readonly();
const InstalledListControlSchema = z.object({
  scope: ReadScopeSchema.default("all-current"),
  query: z.string().max(256).default(""),
  conditions: z.array(z.enum(["ready", "attention", "blocked", "unavailable"])).readonly().optional(),
  cursor: InspectionCursorSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict().readonly();
const PluginTargetControlSchema = exactPair(z.object({ plugin: PluginKeySchema, scope: ScopeSchema, ...ExactPair }).strict());
const DiagnoseControlSchema = exactPair(z.object({ plugin: PluginKeySchema.optional(), scope: ScopeSchema.optional(), includeAdoption: z.boolean().default(false), ...ExactPair }).strict()).superRefine((value: any, context) => {
  if ((value.plugin === undefined) !== (value.scope === undefined)) context.addIssue({ code: "custom", path: ["scope"], message: "plugin diagnosis requires an exact scope" });
});
const InstallTokenControlSchema = z.object({ token: TrustedInstallSessionTokenSchema }).strict().readonly();
const LifecycleControlSchema = exactPair(z.object({ plugin: PluginKeySchema, scope: ScopeSchema, previewOnly: z.boolean().default(false), confirmed: z.boolean().default(false), ...ExactPair }).strict());
const UpdateLifecycleControlSchema = exactPair(z.object({
  plugin: PluginKeySchema,
  scope: ScopeSchema,
  previewOnly: z.boolean().default(false),
  confirmed: z.boolean().default(false),
  candidateSnapshotId: InspectionSnapshotIdSchema.optional(),
  candidateDetailId: InspectionDetailIdSchema.optional(),
  ...ExactPair,
}).strict()).superRefine((value: any, context) => {
  if ((value.candidateSnapshotId === undefined) !== (value.candidateDetailId === undefined)) context.addIssue({ code: "custom", path: ["candidateDetailId"], message: "candidate snapshot and detail identifiers must be supplied together" });
});
const UninstallControlSchema = exactPair(z.object({
  plugin: PluginKeySchema,
  scope: ScopeSchema,
  previewOnly: z.boolean().default(false),
  confirmed: z.boolean().default(false),
  persistentData: z.enum(["keep", "delete-confirmed"]),
  ...ExactPair,
}).strict());
const ProjectSyncControlSchema = z.object({ mode: z.enum(["apply-intent", "publish-intent", "merge"]), previewOnly: z.boolean().default(false), confirmed: z.boolean().default(false) }).strict().readonly();
const UpdatesStatusControlSchema = z.object({ scope: ReadScopeSchema.default("all-current"), plugin: PluginKeySchema.optional() }).strict().readonly();
export const NativeControlPolicyChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("application"),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("global") }).strict().readonly(),
      z.object({ kind: z.literal("scope"), scope: ScopeSchema }).strict().readonly(),
      z.object({ kind: z.literal("marketplace"), scope: ScopeSchema, registrationId: MarketplaceRegistrationIdSchema }).strict().readonly(),
      z.object({ kind: z.literal("plugin"), scope: ScopeSchema, plugin: PluginKeySchema }).strict().readonly(),
    ]),
    mode: UpdateApplicationOverrideSchema,
  }).strict().readonly(),
  z.object({ kind: z.literal("cadence"), target: z.object({ kind: z.literal("global") }).strict().readonly(), cadence: UpdateCadenceSchema }).strict().readonly(),
]);
export type NativeControlPolicyChange = z.infer<typeof NativeControlPolicyChangeSchema>;
const PolicyPreviewControlSchema = z.object({ change: NativeControlPolicyChangeSchema }).strict().readonly();
const PolicyApplyControlSchema = z.object({ change: NativeControlPolicyChangeSchema, previewId: UpdatePolicyPreviewIdSchema, consentId: UpdatePolicyConsentIdSchema.optional() }).strict().readonly();
const PolicySetControlSchema = z.object({ change: NativeControlPolicyChangeSchema, previewId: UpdatePolicyPreviewIdSchema.optional(), consentId: UpdatePolicyConsentIdSchema.optional() }).strict().readonly();
const NoticesListControlSchema = z.object({ scope: ReadScopeSchema.default("all-current"), plugin: PluginKeySchema.optional(), after: UpdateNoticeIdSchema.optional(), limit: z.number().int().min(1).max(200).default(50) }).strict().readonly();
const NoticesAckControlSchema = z.object({ ids: z.array(UpdateNoticeIdSchema).min(1).max(200).readonly() }).strict().readonly();
const AutomaticRunControlSchema = z.object({ noticeIds: z.array(UpdateNoticeIdSchema).readonly().optional(), limit: z.number().int().min(1).max(100).default(20) }).strict().readonly();
const OperationControlSchema = z.object({ token: z.union([TrustedInstallSessionTokenSchema, NativeLifecycleOperationTokenSchema]) }).strict().readonly();

export type NativeControlOptionKind = "flag" | "string" | "integer" | "enum" | "repeatable";
export type NativeControlOptionDefinition = Readonly<{
  name: `--${string}`;
  key: string;
  kind: NativeControlOptionKind;
  values?: readonly string[];
  required?: boolean;
  equals?: boolean;
  conflicts?: readonly string[];
  deprecatedSince?: NativeControlGrammarVersion;
  replacement?: string;
  removeInMajor?: number;
}>;
export type NativeControlPositionalDefinition = Readonly<{ name: string; required?: boolean; repeatable?: boolean }>;
export type NativeControlCommandVisibility = "primary" | "advanced" | "protocol";

export type NativeControlCommandDefinition = Readonly<{
  path: readonly string[];
  /** Controls default human help/completion only; every route remains available to automation. */
  visibility: NativeControlCommandVisibility;
  aliases: readonly Readonly<{ path: readonly string[]; deprecatedSince?: NativeControlGrammarVersion; replacement?: string; removeInMajor?: number }>[];
  summary: z.infer<typeof SafeDisplayFieldSchema>;
  safety: "pure" | "local-read" | "remote-read" | "mutation" | "operation-control";
  input: "none" | "confirmation" | "configuration" | "decision";
  request: z.ZodTypeAny;
  /** Strict owner DTO accepted from the underlying application service. */
  response: z.ZodTypeAny;
  /** Strict command-specific machine DTO emitted after safe projection. */
  projectedResponse: z.ZodTypeAny;
  projectResponse?: (owner: unknown) => unknown;
  positionals: readonly NativeControlPositionalDefinition[];
  options: readonly NativeControlOptionDefinition[];
}>;

const safe = (text: string) => SafeDisplayFieldSchema.parse({ text, escaped: false, truncated: false });
const option = (name: `--${string}`, key: string, kind: NativeControlOptionKind, extra: Omit<NativeControlOptionDefinition, "name" | "key" | "kind"> = {}): NativeControlOptionDefinition => Object.freeze({ name, key, kind, equals: kind !== "flag", ...extra });
const positional = (name: string, required = true, repeatable = false): NativeControlPositionalDefinition => Object.freeze({ name, required, repeatable });
const scopeOption = option("--scope", "scope", "enum", { required: true, values: ["user", "project"] });
const optionalScopeOption = option("--scope", "scope", "enum", { values: ["user", "project"] });
const readScopeOption = option("--scope", "scope", "enum", { values: ["user", "project", "all-current"] });
const exactOptions = [option("--snapshot-id", "snapshotId", "string"), option("--detail-id", "detailId", "string")] as const;
const lifecycleOptions = [scopeOption, ...exactOptions, option("--preview-only", "previewOnly", "flag"), option("--yes", "confirmed", "flag")] as const;

type NativeControlCommandInput = Omit<NativeControlCommandDefinition, "projectedResponse" | "visibility"> & Readonly<{
  projectedResponse?: z.ZodTypeAny;
  visibility?: NativeControlCommandVisibility;
}>;

function command(definition: NativeControlCommandInput): NativeControlCommandDefinition {
  return Object.freeze({
    ...definition,
    visibility: definition.visibility ?? "advanced",
    projectedResponse: definition.projectedResponse ?? definition.response,
    path: Object.freeze([...definition.path]),
    aliases: Object.freeze(definition.aliases.map((alias) => Object.freeze({ ...alias, path: Object.freeze([...alias.path]) }))),
    positionals: Object.freeze([...definition.positionals]),
    options: Object.freeze([...definition.options]),
  });
}

const OperationStatusResponseSchema = z.union([
  TrustedInstallStatusResultSchema,
  NativeLifecycleOperationStatusResultSchema,
]);
const OperationCancellationResponseSchema = z.union([
  TrustedInstallCancellationResultSchema,
  NativeLifecycleOperationCancellationResultSchema,
]);

const registry = {
  presentation: command({ path: [], visibility: "primary", aliases: [], summary: safe("Open plugin management"), safety: "pure", input: "decision", request: PresentationRequestSchema, response: NativeControlPresentationResponseSchema, positionals: [], options: [] }),
  help: command({ path: ["help"], visibility: "primary", aliases: [], summary: safe("Show command help"), safety: "pure", input: "none", request: HelpRequestSchema, response: NativeControlHelpResponseSchema, positionals: [positional("path", false, true)], options: [] }),
  grammar: command({ path: ["grammar"], aliases: [], summary: safe("Show grammar metadata"), safety: "pure", input: "none", request: GrammarRequestSchema, response: NativeControlGrammarResponseSchema, positionals: [], options: [option("--version", "version", "string")] }),
  "marketplace.add": command({ path: ["marketplace", "add"], visibility: "primary", aliases: [], summary: safe("Add a plugin source"), safety: "mutation", input: "none", request: MarketplaceAddControlSchema, response: MarketplaceAddResultSchema, projectedResponse: NativeControlMarketplaceAddResponseSchema, projectResponse: projectMarketplaceAddResponse, positionals: [positional("source")], options: [option("--source-kind", "sourceKind", "enum", { values: ["github", "git", "local-git"] }), option("--ref", "ref", "string")] }),
  "marketplace.remove": command({ path: ["marketplace", "remove"], visibility: "primary", aliases: [], summary: safe("Remove a plugin source"), safety: "mutation", input: "confirmation", request: MarketplaceRemoveControlSchema, response: MarketplaceRemoveResultSchema, positionals: [positional("registration-id")], options: [option("--yes", "confirmed", "flag", { required: true })] }),
  "marketplace.list": command({ path: ["marketplace", "list"], visibility: "primary", aliases: [], summary: safe("List plugin sources"), safety: "local-read", input: "none", request: MarketplaceListControlSchema, response: MarketplaceRegistrationPageSchema, projectedResponse: NativeControlMarketplaceListResponseSchema, projectResponse: projectMarketplaceListResponse, positionals: [], options: [option("--limit", "limit", "integer")] }),
  "marketplace.refresh": command({ path: ["marketplace", "refresh"], visibility: "primary", aliases: [{ path: ["marketplace", "update"] }], summary: safe("Refresh plugin sources"), safety: "mutation", input: "none", request: MarketplaceRefreshControlSchema, response: MarketplaceRefreshResultSchema, projectedResponse: NativeControlMarketplaceRefreshResponseSchema, projectResponse: projectMarketplaceRefreshResponse, positionals: [positional("registration-id", false, true)], options: [] }),
  "marketplace.adopt.preview": command({ path: ["marketplace", "adopt", "preview"], aliases: [{ path: ["adopt", "preview"] }], summary: safe("Preview foreign marketplace adoption"), safety: "local-read", input: "none", request: AdoptionPreviewControlSchema, response: AdoptionPreviewResultSchema, projectedResponse: NativeControlAdoptionPreviewResponseSchema, projectResponse: projectAdoptionPreviewResponse, positionals: [], options: [] }),
  "marketplace.adopt.import": command({ path: ["marketplace", "adopt", "import"], aliases: [{ path: ["adopt", "import"] }], summary: safe("Import selected foreign marketplaces globally"), safety: "mutation", input: "confirmation", request: AdoptionImportControlSchema, response: AdoptionImportResultSchema, projectedResponse: NativeControlAdoptionImportResponseSchema, projectResponse: projectAdoptionImportResponse, positionals: [positional("candidate-id", true, true)], options: [option("--yes", "confirmed", "flag", { required: true })] }),
  browse: command({ path: ["browse"], aliases: [], summary: safe("Browse marketplace candidates"), safety: "local-read", input: "none", request: BrowseControlSchema, response: MarketplaceCatalogPageSchema, projectedResponse: NativeControlMarketplaceCatalogResponseSchema, projectResponse: projectMarketplaceCatalogResponse, positionals: [positional("query", false)], options: [readScopeOption, option("--marketplace-id", "marketplaceIds", "repeatable"), option("--availability", "availability", "repeatable", { values: ["available", "installed-by-default", "not-available"] }), option("--cursor", "cursor", "string"), option("--limit", "limit", "integer")] }),
  "inspection.list": command({ path: ["list"], visibility: "primary", aliases: [], summary: safe("List my plugins"), safety: "local-read", input: "none", request: InstalledListControlSchema, response: NativeInspectionPageSchema, positionals: [], options: [readScopeOption, option("--query", "query", "string"), option("--condition", "conditions", "repeatable", { values: ["ready", "attention", "blocked", "unavailable"] }), option("--cursor", "cursor", "string"), option("--limit", "limit", "integer")] }),
  "inspection.show": command({ path: ["show"], aliases: [{ path: ["inspect"] }], summary: safe("Show exact plugin detail"), safety: "local-read", input: "none", request: PluginTargetControlSchema, response: NativeInspectionDetailResultSchema, positionals: [positional("plugin-key")], options: [scopeOption, ...exactOptions] }),
  "inspection.diagnose": command({ path: ["doctor"], visibility: "primary", aliases: [{ path: ["diagnose"] }], summary: safe("Check plugin host or plugin health"), safety: "local-read", input: "none", request: DiagnoseControlSchema, response: NativeDiagnosticReportSchema, positionals: [positional("plugin-key", false)], options: [optionalScopeOption, ...exactOptions, option("--include-adoption", "includeAdoption", "flag")] }),
  "install.open": command({ path: ["install", "open"], visibility: "protocol", aliases: [], summary: safe("Open a trusted installation"), safety: "mutation", input: "none", request: PluginTargetControlSchema, response: TrustedInstallOpenResultSchema, positionals: [positional("plugin-key")], options: [scopeOption, ...exactOptions] }),
  "install.apply": command({ path: ["install", "apply"], visibility: "protocol", aliases: [], summary: safe("Apply a trusted installation"), safety: "mutation", input: "configuration", request: InstallTokenControlSchema, response: TrustedInstallActivationResultSchema, positionals: [positional("install-token")], options: [] }),
  "install.recover": command({ path: ["install", "recover"], visibility: "protocol", aliases: [], summary: safe("Recover a trusted installation"), safety: "mutation", input: "configuration", request: InstallTokenControlSchema, response: TrustedInstallActivationResultSchema, positionals: [positional("install-token")], options: [] }),
  "install.run": command({ path: ["add"], visibility: "primary", aliases: [{ path: ["install"] }, { path: ["install", "run"] }], summary: safe("Add a plugin"), safety: "mutation", input: "configuration", request: PluginTargetControlSchema, response: TrustedInstallActivationResultSchema, positionals: [positional("plugin-key")], options: [scopeOption, ...exactOptions] }),
  "lifecycle.enable": command({ path: ["enable"], visibility: "primary", aliases: [], summary: safe("Enable a plugin"), safety: "mutation", input: "confirmation", request: LifecycleControlSchema, response: z.union([NativeLifecycleOperationPreviewResultSchema, NativeLifecycleOperationResultSchema]), positionals: [positional("plugin-key")], options: lifecycleOptions }),
  "lifecycle.disable": command({ path: ["disable"], visibility: "primary", aliases: [], summary: safe("Disable a plugin"), safety: "mutation", input: "confirmation", request: LifecycleControlSchema, response: z.union([NativeLifecycleOperationPreviewResultSchema, NativeLifecycleOperationResultSchema]), positionals: [positional("plugin-key")], options: lifecycleOptions }),
  "lifecycle.update": command({ path: ["update"], visibility: "primary", aliases: [], summary: safe("Update a plugin"), safety: "mutation", input: "configuration", request: UpdateLifecycleControlSchema, response: z.union([NativeLifecycleOperationPreviewResultSchema, NativeLifecycleOperationResultSchema]), positionals: [positional("plugin-key")], options: [...lifecycleOptions, option("--candidate-snapshot-id", "candidateSnapshotId", "string"), option("--candidate-detail-id", "candidateDetailId", "string")] }),
  "lifecycle.uninstall": command({ path: ["remove"], visibility: "primary", aliases: [{ path: ["uninstall"] }], summary: safe("Remove a plugin"), safety: "mutation", input: "confirmation", request: UninstallControlSchema, response: z.union([NativeLifecycleOperationPreviewResultSchema, NativeLifecycleOperationResultSchema]), positionals: [positional("plugin-key")], options: [...lifecycleOptions, option("--keep-data", "keepData", "flag", { conflicts: ["deleteData"] }), option("--delete-data", "deleteData", "flag", { conflicts: ["keepData"] })] }),
  "project.sync": command({ path: ["project", "sync"], aliases: [{ path: ["project-sync"] }], summary: safe("Synchronize current project intent"), safety: "mutation", input: "decision", request: ProjectSyncControlSchema, response: z.union([NativeLifecycleOperationPreviewResultSchema, NativeLifecycleOperationResultSchema]), positionals: [], options: [option("--mode", "mode", "enum", { required: true, values: ["apply-intent", "publish-intent", "merge"] }), option("--preview-only", "previewOnly", "flag"), option("--yes", "confirmed", "flag")] }),
  "updates.status": command({ path: ["updates", "status"], aliases: [], summary: safe("Show update status"), safety: "local-read", input: "none", request: UpdatesStatusControlSchema, response: NativeUpdateStatusSchema, positionals: [], options: [readScopeOption, option("--plugin", "plugin", "string")] }),
  "updates.policy.preview": command({ path: ["updates", "policy", "preview"], aliases: [], summary: safe("Preview an update policy change"), safety: "local-read", input: "none", request: PolicyPreviewControlSchema, response: NativeUpdatePolicyPreviewResultSchema, positionals: [], options: policyOptions(false) }),
  "updates.policy.apply": command({ path: ["updates", "policy", "apply"], aliases: [], summary: safe("Apply an exact update policy preview"), safety: "mutation", input: "decision", request: PolicyApplyControlSchema, response: NativeUpdatePolicyApplyResultSchema, positionals: [], options: [...policyOptions(false), option("--preview-id", "previewId", "string", { required: true }), option("--consent-id", "consentId", "string")] }),
  "updates.policy.set": command({ path: ["updates", "policy", "set"], aliases: [], summary: safe("Set update policy through preview"), safety: "mutation", input: "decision", request: PolicySetControlSchema, response: z.union([NativeUpdatePolicyPreviewResultSchema, NativeUpdatePolicyApplyResultSchema]), positionals: [], options: [...policyOptions(false), option("--preview-id", "previewId", "string"), option("--consent-id", "consentId", "string")] }),
  "updates.notices.list": command({ path: ["updates", "notices", "list"], aliases: [], summary: safe("List update notices"), safety: "local-read", input: "none", request: NoticesListControlSchema, response: NativeUpdateNotificationPageSchema, positionals: [], options: [readScopeOption, option("--plugin", "plugin", "string"), option("--after", "after", "string"), option("--limit", "limit", "integer")] }),
  "updates.notices.acknowledge": command({ path: ["updates", "notices", "acknowledge"], aliases: [{ path: ["updates", "notices", "ack"] }], summary: safe("Acknowledge update notices"), safety: "mutation", input: "none", request: NoticesAckControlSchema, response: NativeUpdateAcknowledgmentResultSchema, positionals: [positional("notice-id", true, true)], options: [] }),
  "updates.automatic.run": command({ path: ["updates", "automatic", "run"], aliases: [], summary: safe("Run admitted plugin updates"), safety: "mutation", input: "none", request: AutomaticRunControlSchema, response: NativeAutomaticUpdateRunResultSchema, positionals: [], options: [option("--notice-id", "noticeIds", "repeatable"), option("--limit", "limit", "integer"), option("--explicit", "explicit", "flag")] }),
  "config.host-precedence": command({ path: ["config", "host-precedence"], visibility: "primary", aliases: [], summary: safe("Set dual-host declaration precedence"), safety: "mutation", input: "none", request: NativeHostPrecedenceRequestSchema, response: NativeHostPrecedenceResultSchema, positionals: [positional("order")], options: [] }),
  status: command({ path: ["status"], visibility: "primary", aliases: [], summary: safe("Show plugin host status"), safety: "local-read", input: "none", request: EmptyRequestSchema, response: HostStatusSnapshotSchema, positionals: [], options: [] }),
  "operation.status": command({ path: ["operation", "status"], visibility: "protocol", aliases: [], summary: safe("Poll an existing operation"), safety: "operation-control", input: "none", request: OperationControlSchema, response: OperationStatusResponseSchema, positionals: [positional("token")], options: [] }),
  "operation.cancel": command({ path: ["operation", "cancel"], visibility: "protocol", aliases: [], summary: safe("Cancel an existing operation"), safety: "operation-control", input: "none", request: OperationControlSchema, response: OperationCancellationResponseSchema, positionals: [positional("token")], options: [] }),
} as const satisfies Record<string, NativeControlCommandDefinition>;

function policyOptions(includeConfirmation: boolean): readonly NativeControlOptionDefinition[] {
  return Object.freeze([
    option("--kind", "policyKind", "enum", { required: true, values: ["application", "cadence"] }),
    option("--target", "policyTarget", "enum", { required: true, values: ["global", "scope", "marketplace", "plugin"] }),
    readScopeOption,
    option("--marketplace-id", "marketplaceId", "string"),
    option("--plugin", "plugin", "string"),
    option("--mode", "policyMode", "enum", { values: ["inherit", "manual", "automatic"] }),
    option("--cadence", "cadence", "enum", { values: ["paused", "conservative", "balanced", "frequent"] }),
    ...(includeConfirmation ? [option("--yes", "confirmed", "flag")] : []),
  ]);
}

export const NativeControlCommandRegistry = Object.freeze(registry);
export type NativeControlCommandId = keyof typeof NativeControlCommandRegistry;

const commandIds = Object.keys(NativeControlCommandRegistry) as NativeControlCommandId[];
export const NativeControlCommandIdSchema = z.enum(commandIds as [NativeControlCommandId, ...NativeControlCommandId[]]);

export type NativeControlCommand = {
  [K in NativeControlCommandId]: Readonly<{
    command: K;
    request: z.infer<(typeof NativeControlCommandRegistry)[K]["request"]>;
    invocation: NativeControlInvocation;
  }>
}[NativeControlCommandId];

const commandSchemas = commandIds.map((id) => z.object({
  command: z.literal(id),
  request: NativeControlCommandRegistry[id].request,
  invocation: NativeControlInvocationSchema,
}).strict().readonly());

export const NativeControlCommandSchema: z.ZodType<NativeControlCommand> = z.union(commandSchemas as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]) as z.ZodType<NativeControlCommand>;

function validateRegistry(): void {
  const paths = new Map<string, string>();
  for (const [id, definition] of Object.entries(NativeControlCommandRegistry)) {
    if (definition.path.length === 0 && id !== "presentation") throw new Error("only presentation may have an empty command path");
    for (const path of [definition.path, ...definition.aliases.map((alias) => alias.path)]) {
      const key = path.join("\0");
      const previous = paths.get(key);
      if (previous !== undefined) throw new Error(`native control path ${path.join(" ")} belongs to both ${previous} and ${id}`);
      paths.set(key, id);
    }
    const names = new Set<string>();
    for (const owned of definition.options) {
      if (names.has(owned.name)) throw new Error(`duplicate option ${owned.name} on ${id}`);
      names.add(owned.name);
      if (owned.deprecatedSince !== undefined && (owned.replacement === undefined || owned.removeInMajor === undefined)) throw new Error(`deprecated option ${owned.name} lacks replacement/removal metadata`);
    }
    for (const alias of definition.aliases) {
      if (alias.deprecatedSince !== undefined && (alias.replacement === undefined || alias.removeInMajor === undefined)) throw new Error(`deprecated alias on ${id} lacks replacement/removal metadata`);
    }
  }
}
validateRegistry();

export function nativeControlCommandIds(): readonly NativeControlCommandId[] {
  return Object.freeze([...commandIds]);
}
