import type {
  AgentSettledEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { CurrentProjectRuntimeContext } from "../../application/ports/project-trust.js";
import type { HookPlanningResult } from "../../runtime/hooks/event-contract.js";
import type { PiHookEventAdapter } from "./pi-hook-event-adapter.js";
import type { GuardedCommandHookExecutor, HookPlanExecutionResult } from "../../runtime/hooks/guarded-command-executor.js";
import type { PiHookDecisionAdapter } from "./pi-hook-decision-adapter.js";
import { aggregateHookDecisions } from "../../runtime/hooks/hook-decision-aggregator.js";
import type { AggregatedHookDecision } from "../../domain/hook-output-contract.js";
import type { StopContinuationGuard } from "../../runtime/hooks/stop-continuation-guard.js";
import { createNullHookFailureLog, type HookFailureLog } from "../../runtime/hooks/hook-failure-log.js";
import { plainHookWarning } from "../plain-language.js";

type SessionBeforeCompactResult = { cancel?: boolean };
type ToolResultEventResult = { content?: ToolResultEvent["content"]; details?: unknown; isError?: boolean };

export type PiCommandHookRuntimeRegistration = Readonly<{
  pi: ExtensionAPI;
  events: PiHookEventAdapter;
  executor: GuardedCommandHookExecutor;
  decisions: PiHookDecisionAdapter;
  continuation: StopContinuationGuard;
  currentProject: () => CurrentProjectRuntimeContext;
  runtimeSignal: AbortSignal;
  failureLog?: HookFailureLog;
}>;

function failedDecision(event: AggregatedHookDecision["event"]): AggregatedHookDecision {
  return Object.freeze({ event, contexts: Object.freeze([]), systemMessages: Object.freeze([]), diagnostics: Object.freeze([]) });
}

function aggregate(plan: Extract<HookPlanningResult, { kind: "ready" }>["plans"][number], result: HookPlanExecutionResult): AggregatedHookDecision {
  if (result.kind === "completed") return aggregateHookDecisions({ event: plan.event, originalInput: plan.input, decisions: result.handlers });
  return Object.freeze({
    event: plan.event,
    contexts: Object.freeze([]),
    systemMessages: Object.freeze([]),
    diagnostics: Object.freeze([...result.diagnostics]),
  });
}

export function registerPiCommandHookRuntime(input: PiCommandHookRuntimeRegistration): void {
  if (input === null || typeof input !== "object" || input.pi === undefined || input.events === undefined ||
      input.executor === undefined || input.decisions === undefined || input.continuation === undefined ||
      typeof input.currentProject !== "function") throw new TypeError("Pi command-hook runtime dependencies are required");

  const failureLog = input.failureLog ?? createNullHookFailureLog();

  function logPlanningFailure(event: string, planning: Extract<HookPlanningResult, { kind: "failed" }>): void {
    failureLog.record({
      at: Date.now(),
      event,
      phase: "planning",
      code: planning.code,
      ...(planning.plugin === undefined ? {} : { plugin: planning.plugin }),
      ...(planning.componentId === undefined ? {} : { componentId: planning.componentId }),
    });
  }

  function logDiagnostics(values: readonly AggregatedHookDecision[]): void {
    for (const value of values) {
      for (const diagnostic of value.diagnostics) {
        failureLog.record({
          at: Date.now(),
          event: value.event,
          phase: "execution",
          code: diagnostic.code,
          plugin: diagnostic.plugin,
          componentId: diagnostic.componentId,
          detail: diagnostic.message,
        });
      }
    }
  }

  // Planning failures fail open everywhere: the boundary proceeds without
  // hook influence, the user gets one plain-language warning, and the
  // failure log keeps the exact code for debugging.
  function planningFailed(ctx: ExtensionContext, event: string, planning: HookPlanningResult): boolean {
    if (planning.kind === "ready") return false;
    logPlanningFailure(event, planning);
    if (ctx.hasUI) {
      const sentence = plainHookWarning({ event, code: planning.code, ...(planning.plugin === undefined ? {} : { plugin: planning.plugin }) });
      ctx.ui.notify(failureLog.file === "" ? sentence : `${sentence} Details: ${failureLog.file}`, "warning");
    }
    return true;
  }

  async function execute(planning: HookPlanningResult): Promise<readonly AggregatedHookDecision[]> {
    if (planning.kind !== "ready") return Object.freeze([]);
    const values: AggregatedHookDecision[] = [];
    for (const plan of planning.plans) {
      try {
        const result = await input.executor.execute(plan, {
          currentProject: input.currentProject(),
          runtimeSignal: input.runtimeSignal,
        });
        values.push(aggregate(plan, result));
      } catch {
        values.push(failedDecision(plan.event));
      }
    }
    logDiagnostics(values);
    return Object.freeze(values);
  }

  input.pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext): Promise<void> => {
    const planning = input.events.sessionStart(event, ctx);
    if (planningFailed(ctx, "SessionStart", planning)) return;
    for (const value of await execute(planning)) await input.decisions.applyLifecycle(ctx, value);
  });

  input.pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx: ExtensionContext): Promise<void> => {
    input.continuation.reset();
    const planning = input.events.sessionShutdown(event, ctx);
    if (planningFailed(ctx, "SessionEnd", planning)) return;
    for (const value of await execute(planning)) await input.decisions.applyLifecycle(ctx, value);
  });

  input.pi.on("input", async (event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult | undefined> => {
    if (event.source !== "extension") input.continuation.reset();
    const planning = input.events.input(event, ctx);
    if (planningFailed(ctx, "UserPromptSubmit", planning)) return undefined;
    let result: InputEventResult | undefined;
    for (const value of await execute(planning)) {
      const applied = await input.decisions.applyInput(event, ctx, value);
      if (applied !== undefined) result = applied;
    }
    return result;
  });

  input.pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
    const planning = input.events.toolCall(event, ctx);
    if (planningFailed(ctx, "PreToolUse", planning)) return undefined;
    let result: ToolCallEventResult | undefined;
    for (const value of await execute(planning)) {
      const applied = await input.decisions.applyToolCall(event, ctx, value);
      if (applied !== undefined) result = applied;
    }
    return result;
  });

  input.pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultEventResult | undefined> => {
    const planning = input.events.toolResult(event, ctx);
    if (planningFailed(ctx, "PostToolUse", planning)) return undefined;
    let result: ToolResultEventResult | undefined;
    for (const value of await execute(planning)) {
      const applied = await input.decisions.applyToolResult(event, ctx, value);
      if (applied !== undefined) result = applied;
    }
    return result;
  });

  input.pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext): Promise<SessionBeforeCompactResult | undefined> => {
    const planning = input.events.beforeCompact(event, ctx);
    if (planningFailed(ctx, "PreCompact", planning)) return undefined;
    let result: SessionBeforeCompactResult | undefined;
    for (const value of await execute(planning)) {
      const applied = await input.decisions.applyBeforeCompact(ctx, value);
      if (applied !== undefined) result = applied;
    }
    return result;
  });

  input.pi.on("session_compact", async (event: SessionCompactEvent, ctx: ExtensionContext): Promise<void> => {
    const planning = input.events.compact(event, ctx);
    if (planningFailed(ctx, "PostCompact", planning)) return;
    for (const value of await execute(planning)) await input.decisions.applyLifecycle(ctx, value);
  });

  input.pi.on("agent_settled", async (event: AgentSettledEvent, ctx: ExtensionContext): Promise<void> => {
    const planning = input.events.agentSettled(event, ctx, { stopHookActive: input.continuation.state().stopHookActive });
    if (planningFailed(ctx, "Stop", planning)) return;
    let continued = false;
    let exhausted = false;
    for (const value of await execute(planning)) {
      await input.decisions.applyStop(ctx, value);
      if (value.continuation !== undefined) {
        if (input.continuation.request() === "allowed") {
          continued = true;
          try {
            await input.pi.sendMessage({ customType: "pi-plugin-host.stop-continuation-v1", content: value.continuation.reason ?? "Hook requested continuation", display: false, details: undefined }, { triggerTurn: true, deliverAs: "steer" });
          } catch {
            input.continuation.settleWithoutContinuation();
          }
        } else {
          exhausted = true;
          if (ctx.hasUI) ctx.ui.notify("Hook continuation budget exhausted", "warning");
        }
      }
    }
    if (!continued && !exhausted) input.continuation.settleWithoutContinuation();
  });
}
