import type { JsonValue } from "../../domain/schema.js";
import { HOOK_MAX_AGGREGATED_TEXT_BYTES } from "../../domain/hook-runtime-limits.js";
import type { AggregatedHookDecision, ParsedHookDecision } from "../../domain/hook-output-contract.js";
import type { ForeignHookInput } from "./event-contract.js";
import { createHookRuntimeDiagnostic, type HookRuntimeDiagnostic } from "./hook-runtime-diagnostic.js";

function isDiagnostic(value: ParsedHookDecision | HookRuntimeDiagnostic): value is HookRuntimeDiagnostic {
  return "code" in value;
}

function sourceOrder(value: ParsedHookDecision | HookRuntimeDiagnostic): string {
  const order = isDiagnostic(value) ? value.sourceOrder : value.binding.sourceOrder;
  return `${order.snapshotOrdinal.toString().padStart(12, "0")}\0${order.hookOrdinal.toString().padStart(12, "0")}`;
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  Object.freeze(value);
  return value;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function empty(event: AggregatedHookDecision["event"], diagnostics: readonly HookRuntimeDiagnostic[] = []): AggregatedHookDecision {
  return Object.freeze({
    event,
    contexts: Object.freeze([]),
    systemMessages: Object.freeze([]),
    diagnostics: Object.freeze([...diagnostics]),
  });
}

/**
 * Fold source-ordered, callback-sanitized decisions. One broken hook no
 * longer discards the explicit decisions of healthy hooks: diagnostics ride
 * alongside the folded result so callers can warn and log while still
 * honoring real block/permission/context decisions. The aggregate-limit
 * collapse below remains total because partial output cannot be trusted.
 */
export function aggregateHookDecisions(input: Readonly<{
  event: AggregatedHookDecision["event"];
  originalInput: ForeignHookInput;
  decisions: readonly (ParsedHookDecision | HookRuntimeDiagnostic)[];
}>): AggregatedHookDecision {
  const ordered = [...input.decisions].sort((left, right) => sourceOrder(left).localeCompare(sourceOrder(right)));
  const diagnostics = ordered.filter(isDiagnostic);

  const contexts: string[] = [];
  const systemMessages: string[] = [];
  let textBytes = 0;
  let block: Readonly<{ reason?: string }> | undefined;
  let permission: Readonly<{ kind: "allow" | "deny" | "ask"; reason?: string }> | undefined;
  let updatedInput: Record<string, JsonValue> | undefined;
  let updatedToolOutput: JsonValue | undefined;
  let hasToolOutput = false;
  let stop: Readonly<{ reason?: string }> | undefined;
  let title: string | undefined;
  let continuation: Readonly<{ reason?: string }> | undefined;

  const decisions = ordered.filter((value): value is ParsedHookDecision => !isDiagnostic(value));
  for (const decision of decisions) {
    for (const context of decision.contexts) {
      contexts.push(context);
      textBytes += new TextEncoder().encode(context).byteLength;
    }
    for (const message of decision.systemMessages) {
      systemMessages.push(message);
      textBytes += new TextEncoder().encode(message).byteLength;
    }
    if (textBytes > HOOK_MAX_AGGREGATED_TEXT_BYTES) {
      const source = ordered[0];
      if (source === undefined || isDiagnostic(source)) return empty(input.event);
      return empty(input.event, [createHookRuntimeDiagnostic(source.binding, input.event, "HOOK_AGGREGATE_LIMIT")]);
    }

    if (block === undefined && decision.block !== undefined) block = decision.block;
    if (decision.permission !== undefined) {
      if (permission === undefined) permission = decision.permission;
      else if (permission.kind !== "deny" && decision.permission.kind === "deny") permission = decision.permission;
      else if (permission.kind === "allow" && decision.permission.kind === "ask") permission = decision.permission;
    }
    if (decision.updatedInput !== undefined) {
      updatedInput ??= input.originalInput.hook_event_name === "PreToolUse" ? cloneJson(input.originalInput.tool_input) : {};
      const patch = updatedInput;
      for (const [key, value] of Object.entries(decision.updatedInput)) patch[key] = cloneJson(value);
    }
    if (decision.updatedToolOutput !== undefined) {
      updatedToolOutput = deepFreeze(cloneJson(decision.updatedToolOutput));
      hasToolOutput = true;
    }
    if (decision.stop !== undefined) stop = decision.stop;
    if (decision.title !== undefined) title = decision.title;
    if (decision.continuation !== undefined) continuation = decision.continuation;
  }

  if (updatedInput !== undefined && utf8Bytes(updatedInput) > HOOK_MAX_AGGREGATED_TEXT_BYTES) {
    const source = ordered[0];
    if (source === undefined || isDiagnostic(source)) return empty(input.event);
    return empty(input.event, [createHookRuntimeDiagnostic(source.binding, input.event, "HOOK_AGGREGATE_LIMIT")]);
  }
  if (hasToolOutput && updatedToolOutput !== undefined && utf8Bytes(updatedToolOutput) > HOOK_MAX_AGGREGATED_TEXT_BYTES) {
    const source = ordered[0];
    if (source === undefined || isDiagnostic(source)) return empty(input.event);
    return empty(input.event, [createHookRuntimeDiagnostic(source.binding, input.event, "HOOK_AGGREGATE_LIMIT")]);
  }

  return Object.freeze({
    event: input.event,
    contexts: Object.freeze([...contexts]),
    systemMessages: Object.freeze([...systemMessages]),
    ...(block === undefined ? {} : { block }),
    ...(permission === undefined ? {} : { permission }),
    ...(updatedInput === undefined ? {} : { updatedInput: deepFreeze(updatedInput) }),
    ...(hasToolOutput && updatedToolOutput !== undefined ? { updatedToolOutput } : {}),
    ...(stop === undefined ? {} : { stop }),
    ...(title === undefined ? {} : { title }),
    ...(continuation === undefined ? {} : { continuation }),
    diagnostics: Object.freeze([...diagnostics]),
  });
}
