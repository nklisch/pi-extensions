import { CommandHookJsonOutputSchema, HookOutputEventPolicyRegistry, HookOutputFieldRegistry, type CommandHookJsonOutput, type ParsedHookDecision } from "../../domain/hook-output-contract.js";
import type { JsonValue } from "../../domain/schema.js";
import { HOOK_MAX_AGGREGATED_TEXT_BYTES, HOOK_STDERR_MAX_BYTES, HOOK_STDOUT_MAX_BYTES } from "../../domain/hook-runtime-limits.js";
import type { HookExecutionBinding } from "../../domain/hook-execution-binding.js";
import type { OrdinaryHookEvent, SubagentHookEvent } from "../../domain/hook-runtime-contract.js";
import { createHookRuntimeDiagnostic, type HookRuntimeDiagnostic } from "./hook-runtime-diagnostic.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

type HookHandlerExecution = Readonly<{
  binding: HookExecutionBinding;
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  stderrTruncated?: boolean;
}>;

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function diagnostic(
  execution: HookHandlerExecution,
  event: OrdinaryHookEvent | SubagentHookEvent,
  code: Parameters<typeof createHookRuntimeDiagnostic>[2],
): HookRuntimeDiagnostic {
  return createHookRuntimeDiagnostic(execution.binding, event, code);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  Object.freeze(value);
  return value;
}

function redactJson(value: JsonValue, redact: (text: string) => string): JsonValue {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return deepFreeze(value.map((item) => redactJson(item, redact)));
  if (value !== null && typeof value === "object") {
    return deepFreeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item!, redact)])));
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fieldAllowed(event: OrdinaryHookEvent | SubagentHookEvent, field: string): boolean {
  const definition = HookOutputFieldRegistry[field as keyof typeof HookOutputFieldRegistry];
  return definition !== undefined && (definition.events as readonly string[]).includes(event);
}

type MergeOutputResult =
  | Readonly<{ kind: "accepted"; output: CommandHookJsonOutput }>
  | Readonly<{ kind: "unsupported" }>;

function mergeOutput(
  event: OrdinaryHookEvent | SubagentHookEvent,
  output: CommandHookJsonOutput,
): MergeOutputResult {
  const nested = output.hookSpecificOutput;
  if (nested === undefined) return { kind: "accepted", output };
  if (nested.hookEventName !== event) return { kind: "unsupported" };
  const result: Record<string, unknown> = { ...output };
  delete result.hookSpecificOutput;
  for (const [field, value] of Object.entries(nested)) {
    if (field === "hookEventName" || value === undefined) continue;
    if (!fieldAllowed(event, field)) return { kind: "unsupported" };
    if (field in result && !sameJson(result[field], value)) return { kind: "unsupported" };
    result[field] = value;
  }
  return { kind: "accepted", output: result as CommandHookJsonOutput };
}

function parseObject(
  event: OrdinaryHookEvent | SubagentHookEvent,
  text: string,
  execution: HookHandlerExecution,
): CommandHookJsonOutput | HookRuntimeDiagnostic {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return diagnostic(execution, event, "HOOK_INVALID_OUTPUT"); }
  const parsed = CommandHookJsonOutputSchema.safeParse(value);
  if (!parsed.success) return diagnostic(execution, event, "HOOK_INVALID_OUTPUT");
  const merged = mergeOutput(event, parsed.data);
  if (merged.kind === "unsupported") return diagnostic(execution, event, "HOOK_UNSUPPORTED_OUTPUT");
  return merged.output;
}

function makeDecision(
  event: OrdinaryHookEvent | SubagentHookEvent,
  output: CommandHookJsonOutput,
  execution: HookHandlerExecution,
  redact: (text: string) => string,
): ParsedHookDecision | HookRuntimeDiagnostic {
  const values: Record<string, unknown> = output;
  for (const field of Object.keys(values)) {
    if (field === "hookSpecificOutput" || values[field] === undefined) continue;
    if (!fieldAllowed(event, field)) return diagnostic(execution, event, "HOOK_UNSUPPORTED_OUTPUT");
  }
  const contextValues: string[] = [];
  if (output.additionalContext !== undefined) contextValues.push(redact(output.additionalContext));
  const reason = output.reason === undefined ? undefined : redact(output.reason);
  const stopReason = output.stopReason === undefined ? reason : redact(output.stopReason);
  const permissionReason = output.permissionDecisionReason === undefined ? undefined : redact(output.permissionDecisionReason);
  const blockReason = reason ?? stopReason;
  const block = output.decision === "block"
    ? { ...(blockReason === undefined ? {} : { reason: blockReason }) }
    : undefined;
  const permission = output.permissionDecision === undefined
    ? undefined
    : { kind: output.permissionDecision, ...(permissionReason === undefined ? {} : { reason: permissionReason }) } as const;
  const updatedInput = output.updatedInput === undefined
    ? undefined
    : deepFreeze(Object.fromEntries(Object.entries(output.updatedInput).map(([key, value]) => [key, redactJson(value!, redact)]))) as Readonly<Record<string, JsonValue>>;
  const updatedToolOutput = output.updatedToolOutput === undefined ? undefined : redactJson(output.updatedToolOutput, redact);
  const title = output.title === undefined ? undefined : redact(output.title);
  const isContinuationEvent = event === "Stop" || event === "SubagentStop";
  const continuation = isContinuationEvent && (output.decision === "block" || output.continue === false || output.stopReason !== undefined)
    ? { ...(blockReason === undefined ? {} : { reason: blockReason }) }
    : undefined;
  const effectiveBlock = isContinuationEvent ? undefined : block;
  const stop = !isContinuationEvent && (output.continue === false || output.stopReason !== undefined)
    ? { ...(stopReason === undefined ? {} : { reason: stopReason }) }
    : undefined;
  return Object.freeze({
    binding: execution.binding,
    contexts: Object.freeze(contextValues),
    systemMessages: output.systemMessage === undefined ? Object.freeze([]) : Object.freeze([redact(output.systemMessage)]),
    ...(effectiveBlock === undefined ? {} : { block: effectiveBlock }),
    ...(permission === undefined ? {} : { permission }),
    ...(updatedInput === undefined ? {} : { updatedInput }),
    ...(updatedToolOutput === undefined ? {} : { updatedToolOutput }),
    ...(stop === undefined ? {} : { stop }),
    ...(title === undefined ? {} : { title }),
    ...(continuation === undefined ? {} : { continuation }),
  });
}

/** Parse one already-bounded process result while still inside the config callback. */
export function parseHookHandlerOutput(input: Readonly<{
  event: OrdinaryHookEvent | SubagentHookEvent;
  execution: HookHandlerExecution;
  redact(text: string): string;
}>): ParsedHookDecision | HookRuntimeDiagnostic {
  const { event, execution, redact } = input;
  if (execution.stdout.byteLength > HOOK_STDOUT_MAX_BYTES || execution.stderr.byteLength > HOOK_STDERR_MAX_BYTES || execution.stderrTruncated === true) {
    return diagnostic(execution, event, "HOOK_OUTPUT_LIMIT");
  }
  let stdout: string;
  try {
    // Decode stderr as well even though it never enters a decision. A process
    // that emits invalid bytes must not get a different observable contract.
    decoder.decode(execution.stderr);
    stdout = decoder.decode(execution.stdout);
  } catch {
    return diagnostic(execution, event, "HOOK_INVALID_UTF8");
  }
  const policy = HookOutputEventPolicyRegistry[event];
  if (policy === undefined) return diagnostic(execution, event, "HOOK_UNSUPPORTED_OUTPUT");
  if (execution.exitCode !== 0 && execution.exitCode !== 2) return diagnostic(execution, event, "HOOK_EXIT_STATUS");

  if (stdout.length === 0) {
    if (execution.exitCode === 2 && policy.exitTwo !== "unsupported") {
      const fallback: CommandHookJsonOutput = policy.exitTwo === "continuation"
        ? { decision: "block" }
        : { decision: "block" };
      return makeDecision(event, fallback, execution, redact);
    }
    if (execution.exitCode === 2) return diagnostic(execution, event, "HOOK_EXIT_STATUS");
    return Object.freeze({ binding: execution.binding, contexts: Object.freeze([]), systemMessages: Object.freeze([]) });
  }

  const first = stdout.trimStart()[0];
  let parsed: ParsedHookDecision | HookRuntimeDiagnostic;
  if (first === "{" && stdout.trimEnd().endsWith("}")) {
    const object = parseObject(event, stdout, execution);
    if ("code" in object) return object;
    parsed = makeDecision(event, object, execution, redact);
  } else {
    if (!policy.plain || execution.exitCode !== 0) return diagnostic(execution, event, "HOOK_INVALID_OUTPUT");
    if (bytes(stdout) > HOOK_MAX_AGGREGATED_TEXT_BYTES) return diagnostic(execution, event, "HOOK_OUTPUT_LIMIT");
    parsed = Object.freeze({
      binding: execution.binding,
      contexts: Object.freeze([redact(stdout)]),
      systemMessages: Object.freeze([]),
    });
  }
  if ("code" in parsed) return parsed;
  if (execution.exitCode === 2) {
    if (policy.exitTwo === "unsupported") return diagnostic(execution, event, "HOOK_EXIT_STATUS");
    if (policy.exitTwo === "continuation") {
      return Object.freeze({ ...parsed, continuation: parsed.continuation ?? { ...(parsed.stop?.reason === undefined ? {} : { reason: parsed.stop.reason }) } });
    }
    return Object.freeze({ ...parsed, block: parsed.block ?? { ...(parsed.stop?.reason === undefined ? {} : { reason: parsed.stop.reason }) } });
  }
  return parsed;
}

export type { HookHandlerExecution };
