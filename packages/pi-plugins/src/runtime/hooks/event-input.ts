import {
  HookSessionEvidenceSchema,
  SessionEndHookInputSchema,
  SessionStartHookInputSchema,
  UserPromptSubmitHookInputSchema,
  PreCompactHookInputSchema,
  PostCompactHookInputSchema,
  StopHookInputSchema,
  SubagentStartHookInputSchema,
  SubagentStopHookInputSchema,
  type HookSessionEvidence,
  type ForeignHookInput,
} from "./event-contract.js";
import type { HookToolCallEvidence, HookToolResultEvidence } from "./tool-event-input.js";
import {
  SubagentExecutionIdentitySchemaV1,
  SubagentExecutionPathSchemaV1,
  type SubagentCompletionOutcome,
  type SubagentExecutionIdentity,
  type SubagentExecutionPath,
} from "../../application/ports/subagent-lifecycle.js";
import type { OrdinaryHookEvent } from "../../domain/hook-runtime-contract.js";

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";
export type SessionEndReason = "quit" | "reload" | "new" | "resume" | "fork";
export type CompactReason = "manual" | "threshold" | "overflow";
export type InputSource = "interactive" | "rpc" | "extension";
export type StreamingBehavior = "steer" | "followUp";

export type HookPiInputEvidence = Readonly<{
  sessionStartReason?: SessionStartReason;
  sessionEndReason?: SessionEndReason;
  inputSource?: InputSource;
  streamingBehavior?: StreamingBehavior;
  compactReason?: CompactReason;
  compactWillRetry?: boolean;
  compactFromExtension?: boolean;
  persistence: "persisted" | "ephemeral";
}>;

export type HookBoundaryRequest =
  | Readonly<{ kind: "session-start"; session: HookSessionEvidence; reason: SessionStartReason; previousSessionFile?: string }>
  | Readonly<{ kind: "session-end"; session: HookSessionEvidence; reason: SessionEndReason }>
  | Readonly<{ kind: "input"; session: HookSessionEvidence; text: string; source: InputSource; streamingBehavior?: StreamingBehavior; signal?: AbortSignal }>
  | Readonly<{ kind: "tool-call"; session: HookSessionEvidence; evidence: HookToolCallEvidence }>
  | Readonly<{ kind: "tool-result"; session: HookSessionEvidence; evidence: HookToolResultEvidence }>
  | Readonly<{ kind: "before-compact"; session: HookSessionEvidence; reason: CompactReason; willRetry: boolean; signal?: AbortSignal }>
  | Readonly<{ kind: "compact"; session: HookSessionEvidence; reason: CompactReason; willRetry: boolean; fromExtension: boolean }>
  | Readonly<{ kind: "agent-settled"; session: HookSessionEvidence; lastAssistantMessage?: string; stopHookActive: boolean }>
  | Readonly<{ kind: "subagent-start"; session: HookSessionEvidence; identity: SubagentExecutionIdentity; execution: SubagentExecutionPath; signal: AbortSignal }>
  | Readonly<{ kind: "subagent-stop"; session: HookSessionEvidence; identity: SubagentExecutionIdentity; execution: SubagentExecutionPath; proposedResult: string; outcome: SubagentCompletionOutcome; continuationRound: number; maxContinuationRounds: number; signal: AbortSignal }>;

export function sessionSource(reason: SessionStartReason): "startup" | "resume" | "clear" {
  if (reason === "resume") return "resume";
  if (reason === "new") return "clear";
  return "startup";
}

export function compactTrigger(reason: CompactReason): "manual" | "auto" {
  return reason === "manual" ? "manual" : "auto";
}

function common(session: HookSessionEvidence, event: OrdinaryHookEvent, pi: HookPiInputEvidence): Record<string, unknown> {
  const evidence = HookSessionEvidenceSchema.parse(session);
  return {
    session_id: evidence.sessionId,
    ...(evidence.transcriptPath === undefined ? {} : { transcript_path: evidence.transcriptPath }),
    cwd: evidence.cwd,
    hook_event_name: event,
    pi: {
      session: { persistence: pi.persistence },
      ...(pi.sessionStartReason === undefined ? {} : { sessionStart: { reason: pi.sessionStartReason } }),
      ...(pi.sessionEndReason === undefined ? {} : { sessionEnd: { reason: pi.sessionEndReason } }),
      ...(pi.inputSource === undefined ? {} : { input: { source: pi.inputSource, ...(pi.streamingBehavior === undefined ? {} : { streamingBehavior: pi.streamingBehavior }) } }),
      ...(pi.compactReason === undefined ? {} : { compact: { reason: pi.compactReason, willRetry: pi.compactWillRetry ?? false, ...(pi.compactFromExtension === undefined ? {} : { fromExtension: pi.compactFromExtension }) } }),
    },
  };
}

export function buildSessionStartInput(session: HookSessionEvidence, reason: SessionStartReason, persistence: "persisted" | "ephemeral" = session.transcriptPath === undefined ? "ephemeral" : "persisted"): Extract<ForeignHookInput, { hook_event_name: "SessionStart" }> {
  return SessionStartHookInputSchema.parse({ ...common(session, "SessionStart", { persistence, sessionStartReason: reason }), source: sessionSource(reason) });
}

export function buildSessionEndInput(session: HookSessionEvidence, reason: SessionEndReason, persistence: "persisted" | "ephemeral" = session.transcriptPath === undefined ? "ephemeral" : "persisted"): Extract<ForeignHookInput, { hook_event_name: "SessionEnd" }> {
  return SessionEndHookInputSchema.parse({ ...common(session, "SessionEnd", { persistence, sessionEndReason: reason }) });
}

export function buildUserPromptSubmitInput(session: HookSessionEvidence, text: string, source: InputSource, streamingBehavior: StreamingBehavior | undefined, persistence: "persisted" | "ephemeral" = session.transcriptPath === undefined ? "ephemeral" : "persisted"): Extract<ForeignHookInput, { hook_event_name: "UserPromptSubmit" }> {
  return UserPromptSubmitHookInputSchema.parse({ ...common(session, "UserPromptSubmit", { persistence, inputSource: source, ...(streamingBehavior === undefined ? {} : { streamingBehavior }) }), prompt: text });
}

export function buildPreCompactInput(session: HookSessionEvidence, reason: CompactReason, willRetry = false, persistence: "persisted" | "ephemeral" = session.transcriptPath === undefined ? "ephemeral" : "persisted"): Extract<ForeignHookInput, { hook_event_name: "PreCompact" }> {
  return PreCompactHookInputSchema.parse({ ...common(session, "PreCompact", { persistence, compactReason: reason, compactWillRetry: willRetry }), trigger: compactTrigger(reason) });
}

export function buildPostCompactInput(session: HookSessionEvidence, reason: CompactReason, willRetry: boolean, fromExtension: boolean, persistence: "persisted" | "ephemeral" = session.transcriptPath === undefined ? "ephemeral" : "persisted"): Extract<ForeignHookInput, { hook_event_name: "PostCompact" }> {
  return PostCompactHookInputSchema.parse({ ...common(session, "PostCompact", { persistence, compactReason: reason, compactWillRetry: willRetry, compactFromExtension: fromExtension }), trigger: compactTrigger(reason) });
}

export function buildCompactSessionStartInput(session: HookSessionEvidence, reason: CompactReason, willRetry: boolean, fromExtension: boolean, persistence: "persisted" | "ephemeral" = session.transcriptPath === undefined ? "ephemeral" : "persisted"): Extract<ForeignHookInput, { hook_event_name: "SessionStart" }> {
  return SessionStartHookInputSchema.parse({ ...common(session, "SessionStart", { persistence, compactReason: reason, compactWillRetry: willRetry, compactFromExtension: fromExtension }), source: "compact" });
}

export function buildStopInput(session: HookSessionEvidence, lastAssistantMessage: string | undefined, stopHookActive: boolean, persistence: "persisted" | "ephemeral" = session.transcriptPath === undefined ? "ephemeral" : "persisted"): Extract<ForeignHookInput, { hook_event_name: "Stop" }> {
  return StopHookInputSchema.parse({ ...common(session, "Stop", { persistence }), ...(lastAssistantMessage === undefined || lastAssistantMessage.length === 0 ? {} : { last_assistant_message: lastAssistantMessage }), stop_hook_active: stopHookActive });
}

function subagentCommon(sessionInput: HookSessionEvidence): Record<string, unknown> {
  const session = HookSessionEvidenceSchema.parse(sessionInput);
  return {
    session_id: session.sessionId,
    ...(session.transcriptPath === undefined ? {} : { transcript_path: session.transcriptPath }),
    cwd: session.cwd,
  };
}

function subagentEvidence(identityInput: SubagentExecutionIdentity, executionInput: SubagentExecutionPath): Record<string, unknown> {
  const identity = SubagentExecutionIdentitySchemaV1.parse(identityInput);
  const execution = SubagentExecutionPathSchemaV1.parse(executionInput);
  return {
    sessionId: identity.sessionId,
    runId: identity.runId,
    phase: execution.phase,
    origin: execution.origin,
    mode: execution.mode,
    admission: execution.admission,
  };
}

export function buildSubagentStartInput(
  session: HookSessionEvidence,
  identityInput: SubagentExecutionIdentity,
  executionInput: SubagentExecutionPath,
): Extract<ForeignHookInput, { hook_event_name: "SubagentStart" }> {
  const identity = SubagentExecutionIdentitySchemaV1.parse(identityInput);
  return SubagentStartHookInputSchema.parse({
    ...subagentCommon(session),
    hook_event_name: "SubagentStart",
    agent_id: identity.agentId,
    agent_type: identity.agentType,
    pi: {
      session: { persistence: session.transcriptPath === undefined ? "ephemeral" : "persisted" },
      subagent: { boundary: "start", ...subagentEvidence(identity, executionInput) },
    },
  });
}

export function buildSubagentStopInput(
  session: HookSessionEvidence,
  identityInput: SubagentExecutionIdentity,
  executionInput: SubagentExecutionPath,
  proposedResult: string,
  outcome: SubagentCompletionOutcome,
  continuationRound: number,
  maxContinuationRounds: number,
): Extract<ForeignHookInput, { hook_event_name: "SubagentStop" }> {
  const identity = SubagentExecutionIdentitySchemaV1.parse(identityInput);
  return SubagentStopHookInputSchema.parse({
    ...subagentCommon(session),
    hook_event_name: "SubagentStop",
    agent_id: identity.agentId,
    agent_type: identity.agentType,
    last_assistant_message: proposedResult,
    pi: {
      session: { persistence: session.transcriptPath === undefined ? "ephemeral" : "persisted" },
      subagent: {
        boundary: "completion",
        ...subagentEvidence(identity, executionInput),
        outcome,
        continuationRound,
        maxContinuationRounds,
      },
    },
  });
}

