import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { AggregatedHookDecision } from "../../domain/hook-output-contract.js";

type SessionBeforeCompactResult = { cancel?: boolean };
type ToolResultEventResult = { content?: ToolResultEvent["content"]; details?: unknown; isError?: boolean };
import { HOOK_ASK_TIMEOUT_MS } from "../../domain/hook-runtime-limits.js";
import { plainHookWarning } from "../plain-language.js";

const CONTEXT_MESSAGE_TYPE = "pi-plugin-host.hook-context-v1";

export interface PiHookDecisionAdapter {
  applyInput(event: InputEvent, ctx: ExtensionContext, value: AggregatedHookDecision): Promise<InputEventResult | undefined>;
  applyToolCall(event: ToolCallEvent, ctx: ExtensionContext, value: AggregatedHookDecision): Promise<ToolCallEventResult | undefined>;
  applyToolResult(event: ToolResultEvent, ctx: ExtensionContext, value: AggregatedHookDecision): Promise<ToolResultEventResult | undefined>;
  applyBeforeCompact(ctx: ExtensionContext, value: AggregatedHookDecision): Promise<SessionBeforeCompactResult | undefined>;
  applyLifecycle(ctx: ExtensionContext, value: AggregatedHookDecision): Promise<void>;
  applyStop(ctx: ExtensionContext, value: AggregatedHookDecision): Promise<void>;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function reason(value: string | undefined, fallback: string): string {
  if (value === undefined || value.length === 0) return fallback;
  return value.length > 1024 ? value.slice(0, 1024) : value;
}

function delivery(event: AggregatedHookDecision["event"]): "nextTurn" | "steer" {
  return event === "SessionStart" || event === "UserPromptSubmit" || event === "PostCompact" ? "nextTurn" : "steer";
}

function hasFailure(value: AggregatedHookDecision): boolean {
  return value.diagnostics.length > 0;
}

function firstDiagnosticSentence(value: AggregatedHookDecision): string {
  const first = value.diagnostics[0];
  if (first === undefined) return "A plugin's hook didn't run. Continuing without it.";
  const rest = value.diagnostics.length - 1;
  return `${plainHookWarning({ event: first.event, code: first.code, plugin: first.plugin })}${rest === 0 ? "" : ` (${rest} more in the hook log)`}`;
}

export function createPiHookDecisionAdapter(input: Readonly<{
  pi: Pick<ExtensionAPI, "sendMessage" | "setSessionName">;
}>): PiHookDecisionAdapter {
  if (input === null || typeof input !== "object" || input.pi === undefined ||
      typeof input.pi.sendMessage !== "function" || typeof input.pi.setSessionName !== "function") {
    throw new TypeError("Pi decision adapter requires message and title actions");
  }

  function sendContext(ctx: ExtensionContext, value: AggregatedHookDecision): void {
    for (const text of value.contexts) {
      input.pi.sendMessage({ customType: CONTEXT_MESSAGE_TYPE, content: text, display: false, details: undefined }, { deliverAs: delivery(value.event) });
    }
    if (ctx.hasUI) {
      for (const message of value.systemMessages) ctx.ui.notify(message, "info");
    }
    if (value.title !== undefined) input.pi.setSessionName(value.title);
  }

  async function ask(ctx: ExtensionContext): Promise<boolean> {
    if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) return false;
    try {
      const options = ctx.signal === undefined
        ? { timeout: HOOK_ASK_TIMEOUT_MS }
        : { timeout: HOOK_ASK_TIMEOUT_MS, signal: ctx.signal };
      return await ctx.ui.confirm("Hook permission", "Allow this tool operation?", options);
    } catch {
      return false;
    }
  }

  function blocked(value: AggregatedHookDecision): ToolCallEventResult {
    return { block: true, reason: reason(value.block?.reason, value.diagnostics[0]?.message ?? "Hook blocked this operation") };
  }

  // Infrastructure diagnostics warn in plain language and the boundary
  // continues; only explicit hook decisions (block / deny / stop) change
  // behavior. Exact codes stay in the failure log.
  function warnFailures(ctx: ExtensionContext, value: AggregatedHookDecision): void {
    if (!hasFailure(value) || !ctx.hasUI) return;
    ctx.ui.notify(firstDiagnosticSentence(value), "warning");
  }

  async function applyInput(event: InputEvent, ctx: ExtensionContext, value: AggregatedHookDecision): Promise<InputEventResult | undefined> {
    warnFailures(ctx, value);
    sendContext(ctx, value);
    if (value.block !== undefined || value.stop !== undefined || value.permission?.kind === "deny") return { action: "handled" };
    return undefined;
  }

  async function applyToolCall(event: ToolCallEvent, ctx: ExtensionContext, value: AggregatedHookDecision): Promise<ToolCallEventResult | undefined> {
    warnFailures(ctx, value);
    if (value.block !== undefined || value.permission?.kind === "deny") return blocked(value);
    sendContext(ctx, value);
    if (value.permission?.kind === "ask" && !(await ask(ctx))) {
      return { block: true, reason: "Hook permission was not approved" };
    }
    if (value.updatedInput !== undefined && value.event === "PreToolUse") {
      const replacement = cloneJson(value.updatedInput);
      const mutableInput = event.input as Record<string, unknown>;
      for (const key of Object.keys(mutableInput)) delete mutableInput[key];
      Object.assign(mutableInput, replacement);
    }
    if (value.block !== undefined || value.stop !== undefined) return blocked(value);
    return undefined;
  }

  async function applyToolResult(_event: ToolResultEvent, ctx: ExtensionContext, value: AggregatedHookDecision): Promise<ToolResultEventResult | undefined> {
    warnFailures(ctx, value);
    sendContext(ctx, value);
    if (value.updatedToolOutput !== undefined && value.event === "PostToolUse") return { details: cloneJson(value.updatedToolOutput) };
    return undefined;
  }

  async function applyBeforeCompact(ctx: ExtensionContext, value: AggregatedHookDecision): Promise<SessionBeforeCompactResult | undefined> {
    warnFailures(ctx, value);
    sendContext(ctx, value);
    if (value.block !== undefined || value.stop !== undefined || value.continuation !== undefined) return { cancel: true };
    return undefined;
  }

  async function applyLifecycle(ctx: ExtensionContext, value: AggregatedHookDecision): Promise<void> {
    warnFailures(ctx, value);
    sendContext(ctx, value);
    if (value.stop !== undefined || value.continuation !== undefined) ctx.abort();
  }

  async function applyStop(ctx: ExtensionContext, value: AggregatedHookDecision): Promise<void> {
    warnFailures(ctx, value);
    sendContext(ctx, value);
  }

  return Object.freeze({ applyInput, applyToolCall, applyToolResult, applyBeforeCompact, applyLifecycle, applyStop });
}

export { CONTEXT_MESSAGE_TYPE };
