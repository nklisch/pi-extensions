import type {
  AgentSettledEvent,
  ExtensionContext,
  InputEvent,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { CurrentProjectRuntimeContextSchema, type CurrentProjectRuntimeContext } from "../../application/ports/project-trust.js";
import type { HookPlanningResult } from "../../runtime/hooks/event-contract.js";
import { createHookEventPlanner } from "../../runtime/hooks/hook-event-planner.js";
import type { HookBoundaryRequest } from "../../runtime/hooks/event-input.js";
import type { HookToolAliasDefinition } from "../../domain/hook-runtime-contract.js";
import { readPiSessionEvidence, lastAssistantText } from "./pi-session-evidence.js";

function currentSession(ctx: ExtensionContext, currentProject: CurrentProjectRuntimeContext) {
  return readPiSessionEvidence(ctx, currentProject);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function piContent(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export interface PiHookEventAdapter {
  sessionStart(event: SessionStartEvent, ctx: ExtensionContext): HookPlanningResult;
  sessionShutdown(event: SessionShutdownEvent, ctx: ExtensionContext): HookPlanningResult;
  input(event: InputEvent, ctx: ExtensionContext): HookPlanningResult;
  toolCall(event: ToolCallEvent, ctx: ExtensionContext): HookPlanningResult;
  toolResult(event: ToolResultEvent, ctx: ExtensionContext): HookPlanningResult;
  beforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): HookPlanningResult;
  compact(event: SessionCompactEvent, ctx: ExtensionContext): HookPlanningResult;
  agentSettled(event: AgentSettledEvent, ctx: ExtensionContext, stop: Readonly<{ stopHookActive: boolean }>): HookPlanningResult;
}

export function createPiHookEventAdapter(input: Readonly<{
  planner?: Readonly<{ plan(request: HookBoundaryRequest): HookPlanningResult }>;
  catalog?: import("../../runtime/skill-hook/runtime-catalog.js").SkillHookRuntimeCatalog;
  currentProject(): CurrentProjectRuntimeContext;
  additionalToolAliases?: readonly HookToolAliasDefinition[];
}>): PiHookEventAdapter {
  if (input === null || typeof input !== "object" || typeof input.currentProject !== "function") throw new TypeError("Pi hook adapter requires current project evidence");
  const planner = input.planner ?? createHookEventPlanner({ catalog: input.catalog!, ...(input.additionalToolAliases === undefined ? {} : { additionalToolAliases: input.additionalToolAliases }) });
  function plan(request: HookBoundaryRequest): HookPlanningResult { return planner.plan(request); }
  function session(ctx: ExtensionContext) { return currentSession(ctx, CurrentProjectRuntimeContextSchema.parse(input.currentProject())); }

  function sessionStart(event: SessionStartEvent, ctx: ExtensionContext): HookPlanningResult {
    return plan({ kind: "session-start", session: session(ctx), reason: event.reason, ...(event.previousSessionFile === undefined ? {} : { previousSessionFile: event.previousSessionFile }) });
  }
  function sessionShutdown(event: SessionShutdownEvent, ctx: ExtensionContext): HookPlanningResult {
    return plan({ kind: "session-end", session: session(ctx), reason: event.reason });
  }
  function userInput(event: InputEvent, ctx: ExtensionContext): HookPlanningResult {
    return plan({ kind: "input", session: session(ctx), text: event.text, source: event.source, ...(event.streamingBehavior === undefined ? {} : { streamingBehavior: event.streamingBehavior }), ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) });
  }
  function toolCall(event: ToolCallEvent, ctx: ExtensionContext): HookPlanningResult {
    return plan({ kind: "tool-call", session: session(ctx), evidence: { toolName: event.toolName, toolCallId: event.toolCallId, input: jsonRecord(event.input) as never, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) } });
  }
  function toolResult(event: ToolResultEvent, ctx: ExtensionContext): HookPlanningResult {
    return plan({ kind: "tool-result", session: session(ctx), evidence: { toolName: event.toolName, toolCallId: event.toolCallId, input: jsonRecord(event.input) as never, content: piContent(event.content) as never, details: event.details, isError: event.isError, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) } });
  }
  function beforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): HookPlanningResult {
    return plan({ kind: "before-compact", session: session(ctx), reason: event.reason, willRetry: event.willRetry, signal: event.signal });
  }
  function compact(event: SessionCompactEvent, ctx: ExtensionContext): HookPlanningResult {
    return plan({ kind: "compact", session: session(ctx), reason: event.reason, willRetry: event.willRetry, fromExtension: event.fromExtension });
  }
  function agentSettled(_event: AgentSettledEvent, ctx: ExtensionContext, stop: Readonly<{ stopHookActive: boolean }>): HookPlanningResult {
    if (stop === null || typeof stop.stopHookActive !== "boolean") return { kind: "failed", code: "INVALID_REQUEST" };
    const last = lastAssistantText(ctx);
    return plan({ kind: "agent-settled", session: session(ctx), ...(last === undefined ? {} : { lastAssistantMessage: last }), stopHookActive: stop.stopHookActive });
  }
  return Object.freeze({ sessionStart, sessionShutdown, input: userInput, toolCall, toolResult, beforeCompact, compact, agentSettled });
}
