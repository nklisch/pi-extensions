import { z } from "zod";
import { ContentDigestSchema } from "../../domain/content-manifest.js";
import { HookComponentSchema, type ComponentId } from "../../domain/components.js";
import { PluginKeySchema } from "../../domain/identity.js";
import {
  OrdinaryHookEventSchema,
  ordinaryHookEvents,
  subagentHookEvents,
  type OrdinaryHookEvent,
  type SubagentHookEvent,
} from "../../domain/hook-runtime-contract.js";
import { ScopeReferenceSchema } from "../../domain/state/scope.js";
import { CurrentProjectRuntimeContextSchema } from "../../application/ports/project-trust.js";
import type { PluginKey } from "../../domain/identity.js";
import { JsonValueSchema, type JsonValue } from "../../domain/schema.js";

export const HookSessionEvidenceSchema = z.object({
  sessionId: z.string().min(1),
  transcriptPath: z.string().min(1).optional(),
  cwd: z.string().min(1),
  currentProject: CurrentProjectRuntimeContextSchema,
  piProjectTrusted: z.boolean(),
}).strict().readonly();
export type HookSessionEvidence = z.infer<typeof HookSessionEvidenceSchema>;

function isAbortSignal(value: unknown): value is AbortSignal {
  return value !== null && typeof value === "object" &&
    typeof (value as { aborted?: unknown }).aborted === "boolean" &&
    typeof (value as { addEventListener?: unknown }).addEventListener === "function";
}

export const HookCancellationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("available"),
    signal: z.custom<AbortSignal>(isAbortSignal),
    abortedAtPlanning: z.boolean(),
  }).strict().readonly(),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum(["idle-boundary", "session-boundary", "pi-signal-unavailable"]),
  }).strict().readonly(),
]);
export type HookCancellation = z.infer<typeof HookCancellationSchema>;

const TextContentSchema = z.object({ type: z.literal("text"), text: z.string() }).strict().readonly();
const ImageContentSchema = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string().min(1) }).strict().readonly();
export const HookPiContentSchema = z.discriminatedUnion("type", [TextContentSchema, ImageContentSchema]).readonly();
export type HookPiContent = z.infer<typeof HookPiContentSchema>;

const piEvidenceShape = {
  session: z.object({ persistence: z.enum(["persisted", "ephemeral"]) }).strict().readonly().optional(),
  sessionStart: z.object({ reason: z.enum(["startup", "reload", "new", "resume", "fork"]) }).strict().readonly().optional(),
  sessionEnd: z.object({ reason: z.enum(["quit", "reload", "new", "resume", "fork"]) }).strict().readonly().optional(),
  sessionShutdown: z.object({ reason: z.enum(["quit", "reload", "new", "resume", "fork"]) }).strict().readonly().optional(),
  input: z.object({ source: z.enum(["interactive", "rpc", "extension"]), streamingBehavior: z.enum(["steer", "followUp"]).optional() }).strict().readonly().optional(),
  compact: z.object({ reason: z.enum(["manual", "threshold", "overflow"]), willRetry: z.boolean(), fromExtension: z.boolean().optional() }).strict().readonly().optional(),
  toolResult: z.object({ content: z.array(HookPiContentSchema).readonly(), details: JsonValueSchema.optional(), isError: z.boolean() }).strict().readonly().optional(),
} as const;

export const PiEvidenceSchema = z.object(piEvidenceShape).strict().readonly();

const commonFields = {
  session_id: z.string().min(1),
  transcript_path: z.string().min(1).optional(),
  cwd: z.string().min(1),
} as const;
const commonInput = {
  ...commonFields,
  hook_event_name: OrdinaryHookEventSchema,
  pi: PiEvidenceSchema.optional(),
};

const SubagentStartBoundaryEvidenceSchemaV1 = z.object({
  boundary: z.literal("start"),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  phase: z.enum(["initial", "resume"]),
  origin: z.enum(["tool", "service"]),
  mode: z.enum(["foreground", "background"]),
  admission: z.enum(["immediate", "queued"]),
}).strict().readonly();

const SubagentCompletionBoundaryEvidenceSchemaV1 = z.object({
  boundary: z.literal("completion"),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  phase: z.enum(["initial", "resume"]),
  origin: z.enum(["tool", "service"]),
  mode: z.enum(["foreground", "background"]),
  admission: z.enum(["immediate", "queued"]),
  outcome: z.enum(["completed", "steered", "aborted"]),
  continuationRound: z.number().int().nonnegative(),
  maxContinuationRounds: z.number().int().positive(),
}).strict().readonly();

const SubagentStartPiEvidenceSchema = z.object({
  ...piEvidenceShape,
  subagent: SubagentStartBoundaryEvidenceSchemaV1,
}).strict().readonly();
const SubagentStopPiEvidenceSchema = z.object({
  ...piEvidenceShape,
  subagent: SubagentCompletionBoundaryEvidenceSchemaV1,
}).strict().readonly();

export const SessionStartHookInputSchema = z.object({ ...commonInput, hook_event_name: z.literal("SessionStart"), source: z.enum(["startup", "resume", "clear", "compact"]) }).strict().readonly();
export const SessionEndHookInputSchema = z.object({ ...commonInput, hook_event_name: z.literal("SessionEnd") }).strict().readonly();
export const UserPromptSubmitHookInputSchema = z.object({ ...commonInput, hook_event_name: z.literal("UserPromptSubmit"), prompt: z.string() }).strict().readonly();
export const PreToolUseHookInputSchema = z.object({ ...commonInput, hook_event_name: z.literal("PreToolUse"), tool_name: z.string().min(1), tool_input: z.record(z.string(), JsonValueSchema), tool_use_id: z.string().min(1) }).strict().readonly();
export const PostToolUseHookInputSchema = z.object({ ...commonInput, hook_event_name: z.literal("PostToolUse"), tool_name: z.string().min(1), tool_input: z.record(z.string(), JsonValueSchema), tool_response: JsonValueSchema.optional(), tool_use_id: z.string().min(1) }).strict().readonly();
export const PostToolUseFailureHookInputSchema = z.object({ ...commonInput, hook_event_name: z.literal("PostToolUseFailure"), tool_name: z.string().min(1), tool_input: z.record(z.string(), JsonValueSchema), tool_response: JsonValueSchema.optional(), tool_use_id: z.string().min(1), error: z.string().min(1).optional(), is_interrupt: z.boolean().optional() }).strict().readonly();
export const PreCompactHookInputSchema = z.object({ ...commonInput, hook_event_name: z.literal("PreCompact"), trigger: z.enum(["manual", "auto"]) }).strict().readonly();
export const PostCompactHookInputSchema = z.object({ ...commonInput, hook_event_name: z.literal("PostCompact"), trigger: z.enum(["manual", "auto"]) }).strict().readonly();
export const StopHookInputSchema = z.object({ ...commonInput, hook_event_name: z.literal("Stop"), last_assistant_message: z.string().min(1).optional(), stop_hook_active: z.boolean() }).strict().readonly();
export const SubagentStartHookInputSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("SubagentStart"),
  agent_id: z.string().min(1),
  agent_type: z.string().min(1),
  pi: SubagentStartPiEvidenceSchema,
}).strict().readonly();
export const SubagentStopHookInputSchema = z.object({
  ...commonFields,
  hook_event_name: z.literal("SubagentStop"),
  agent_id: z.string().min(1),
  agent_type: z.string().min(1),
  last_assistant_message: z.string(),
  pi: SubagentStopPiEvidenceSchema,
}).strict().readonly();

export const ForeignHookInputSchema = z.discriminatedUnion("hook_event_name", [
  SessionStartHookInputSchema,
  SessionEndHookInputSchema,
  UserPromptSubmitHookInputSchema,
  PreToolUseHookInputSchema,
  PostToolUseHookInputSchema,
  PostToolUseFailureHookInputSchema,
  PreCompactHookInputSchema,
  PostCompactHookInputSchema,
  StopHookInputSchema,
  SubagentStartHookInputSchema,
  SubagentStopHookInputSchema,
]);
export type ForeignHookInput = z.infer<typeof ForeignHookInputSchema>;

export const PlannedCommandHookSchema = z.object({
  sourceOrder: z.object({ snapshotOrdinal: z.number().int().nonnegative(), hookOrdinal: z.number().int().nonnegative() }).strict().readonly(),
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
  revision: ContentDigestSchema,
  projectionDigest: ContentDigestSchema,
  contributionDigest: ContentDigestSchema,
  component: HookComponentSchema,
  pluginRoot: z.string().min(1),
  pluginDataRoot: z.string().min(1),
}).strict().readonly();
export type PlannedCommandHook = z.infer<typeof PlannedCommandHookSchema>;

export const ExecutableHookEventSchema = z.enum([
  ...ordinaryHookEvents,
  ...subagentHookEvents,
] as [OrdinaryHookEvent | SubagentHookEvent, ...(OrdinaryHookEvent | SubagentHookEvent)[]]);

export const HookEventPlanSchema = z.object({
  schemaVersion: z.literal(1),
  event: ExecutableHookEventSchema,
  input: ForeignHookInputSchema,
  cancellation: HookCancellationSchema,
  hooks: z.array(PlannedCommandHookSchema).readonly(),
}).strict().readonly();
export type HookEventPlan = z.infer<typeof HookEventPlanSchema>;

export type HookPlanningFailureCode =
  | "INVALID_REQUEST"
  | "CATALOG_UNAVAILABLE"
  | "CATALOG_UNINITIALIZED"
  | "CURRENT_PROJECT_MISMATCH"
  | "PROJECT_SCOPE_MISMATCH"
  | "PROJECT_UNTRUSTED"
  | "PI_PROJECT_UNTRUSTED"
  | "PROJECTION_MISMATCH"
  | "SELECTOR_RECOMPILATION_MISMATCH"
  | "UNSUPPORTED_EVENT"
  | "CANCELLED";

export type HookPlanningResult =
  | Readonly<{ kind: "ready"; plans: readonly HookEventPlan[] }>
  | Readonly<{ kind: "failed"; code: HookPlanningFailureCode; plugin?: PluginKey; componentId?: ComponentId }>;

export function cloneJson<T extends JsonValue>(value: T): T {
  const parsed = JSON.parse(JSON.stringify(value)) as T;
  return deepFreeze(parsed);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  Object.freeze(value);
  return value;
}
