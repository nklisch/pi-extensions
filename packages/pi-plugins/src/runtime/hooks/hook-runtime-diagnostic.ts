import { z } from "zod";
import { ComponentIdSchema } from "../../domain/components.js";
import { HookEventNameSchema, type OrdinaryHookEvent, type SubagentHookEvent } from "../../domain/hook-runtime-contract.js";
import { PluginKeySchema } from "../../domain/identity.js";
import type { HookExecutionBinding } from "../../domain/hook-execution-binding.js";

export const HookRuntimeDiagnosticCodeRegistry = Object.freeze({
  invalidPlan: "HOOK_INVALID_PLAN",
  selectedLimit: "HOOK_SELECTED_LIMIT",
  cancelled: "HOOK_CANCELLED",
  authorityRejected: "HOOK_AUTHORITY_REJECTED",
  configurationFailed: "HOOK_CONFIGURATION_FAILED",
  executableUnavailable: "HOOK_EXECUTABLE_UNAVAILABLE",
  spawnFailed: "HOOK_SPAWN_FAILED",
  timeout: "HOOK_TIMEOUT",
  outputLimit: "HOOK_OUTPUT_LIMIT",
  invalidUtf8: "HOOK_INVALID_UTF8",
  invalidOutput: "HOOK_INVALID_OUTPUT",
  unsupportedOutput: "HOOK_UNSUPPORTED_OUTPUT",
  exitStatus: "HOOK_EXIT_STATUS",
  aggregateLimit: "HOOK_AGGREGATE_LIMIT",
  continuationExhausted: "HOOK_CONTINUATION_EXHAUSTED",
  permissionUnavailable: "HOOK_PERMISSION_UNAVAILABLE",
} as const);

export type HookRuntimeDiagnosticCode = typeof HookRuntimeDiagnosticCodeRegistry[keyof typeof HookRuntimeDiagnosticCodeRegistry];
export const HookRuntimeDiagnosticCodeSchema = z.enum(Object.values(HookRuntimeDiagnosticCodeRegistry) as [HookRuntimeDiagnosticCode, ...HookRuntimeDiagnosticCode[]]);

const messages: Readonly<Record<HookRuntimeDiagnosticCode, string>> = Object.freeze({
  HOOK_INVALID_PLAN: "Hook execution plan is invalid",
  HOOK_SELECTED_LIMIT: "Hook execution selection exceeds its bound",
  HOOK_CANCELLED: "Hook execution was cancelled",
  HOOK_AUTHORITY_REJECTED: "Hook execution authority rejected the active binding",
  HOOK_CONFIGURATION_FAILED: "Hook configuration could not be resolved",
  HOOK_EXECUTABLE_UNAVAILABLE: "Hook executable could not be resolved",
  HOOK_SPAWN_FAILED: "Hook process could not be started",
  HOOK_TIMEOUT: "Hook process exceeded its time limit",
  HOOK_OUTPUT_LIMIT: "Hook output exceeded its bound",
  HOOK_INVALID_UTF8: "Hook output was not valid UTF-8",
  HOOK_INVALID_OUTPUT: "Hook output did not match the supported contract",
  HOOK_UNSUPPORTED_OUTPUT: "Hook output requested an unsupported behavior",
  HOOK_EXIT_STATUS: "Hook process returned an unsupported status",
  HOOK_AGGREGATE_LIMIT: "Hook decisions exceeded their aggregate bound",
  HOOK_CONTINUATION_EXHAUSTED: "Hook continuation budget is exhausted",
  HOOK_PERMISSION_UNAVAILABLE: "Hook permission could not be confirmed in this mode",
});

export const HookRuntimeDiagnosticSchema = z.object({
  code: HookRuntimeDiagnosticCodeSchema,
  severity: z.enum(["warning", "error"]),
  event: HookEventNameSchema,
  plugin: PluginKeySchema,
  componentId: ComponentIdSchema,
  sourceOrder: z.object({ snapshotOrdinal: z.number().int().nonnegative(), hookOrdinal: z.number().int().nonnegative() }).strict().readonly(),
  message: z.string().min(1),
}).strict().readonly();
export type HookRuntimeDiagnostic = z.infer<typeof HookRuntimeDiagnosticSchema>;

export function createHookRuntimeDiagnostic(
  binding: HookExecutionBinding,
  event: OrdinaryHookEvent | SubagentHookEvent,
  code: HookRuntimeDiagnosticCode,
  severity: "warning" | "error" = "error",
  /** Underlying cause preserved for the failure log; never user-supplied text. */
  detail?: string,
): HookRuntimeDiagnostic {
  return HookRuntimeDiagnosticSchema.parse({
    code,
    severity,
    event,
    plugin: binding.plugin,
    componentId: binding.componentId,
    sourceOrder: binding.sourceOrder,
    message: detail === undefined ? messages[code] : `${messages[code]} (${detail})`.slice(0, 512),
  });
}
