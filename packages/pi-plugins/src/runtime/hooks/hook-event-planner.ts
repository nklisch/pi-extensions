import { ContentDigestSchema } from "../../domain/content-manifest.js";
import {
  HookComponentSchema,
  type HookComponent,
} from "../../domain/components.js";
import {
  compileHookSelector,
  matchesHookSelector,
  type HookSelectorSubject,
  type HookToolAliasDefinition,
} from "../../domain/hook-runtime-contract.js";
import { PluginKeySchema } from "../../domain/identity.js";
import {
  ProjectionRootRefSchema,
  PluginContentRefSchema,
  PluginDataRefSchema,
} from "../../domain/state/references.js";
import { ScopeReferenceSchema } from "../../domain/state/scope.js";
import { CurrentProjectRuntimeContextSchema } from "../../application/ports/project-trust.js";
import type { SkillHookRuntimeCatalog, } from "../skill-hook/runtime-catalog.js";
import type { SkillHookRuntimeSnapshot } from "../skill-hook/runtime-snapshot.js";
import {
  HookCancellationSchema,
  HookEventPlanSchema,
  HookSessionEvidenceSchema,
  type HookCancellation,
  type HookEventPlan,
  type HookPlanningFailureCode,
  type HookPlanningResult,
  type HookSessionEvidence,
  type PlannedCommandHook,
} from "./event-contract.js";
import {
  buildCompactSessionStartInput,
  buildPostCompactInput,
  buildPreCompactInput,
  buildSessionEndInput,
  buildSessionStartInput,
  buildStopInput,
  buildSubagentStartInput,
  buildSubagentStopInput,
  buildUserPromptSubmitInput,
  type HookBoundaryRequest,
  compactTrigger,
} from "./event-input.js";
import type { SubagentHookEvent } from "../../domain/hook-runtime-contract.js";
import {
  buildPostToolInput,
  buildPreToolUseInput,
  createHookToolIdentityResolver,
  subjectForTool,
} from "./tool-event-input.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}
function abortSignal(value: unknown): value is AbortSignal {
  return value !== null && typeof value === "object" && typeof (value as { aborted?: unknown }).aborted === "boolean" && typeof (value as { addEventListener?: unknown }).addEventListener === "function";
}
function cancellation(signal: AbortSignal | undefined, absent: "idle-boundary" | "session-boundary" | "pi-signal-unavailable"): HookCancellation {
  if (signal !== undefined && abortSignal(signal)) return HookCancellationSchema.parse({ kind: "available", signal, abortedAtPlanning: signal.aborted });
  return HookCancellationSchema.parse({ kind: "unavailable", reason: absent });
}
function persistence(session: HookSessionEvidence): "persisted" | "ephemeral" {
  return session.transcriptPath === undefined ? "ephemeral" : "persisted";
}
function failure(code: HookPlanningFailureCode, snapshot?: SkillHookRuntimeSnapshot, component?: HookComponent): HookPlanningResult {
  return {
    kind: "failed",
    code,
    ...(snapshot === undefined ? {} : { plugin: PluginKeySchema.parse(snapshot.plugin) }),
    ...(component === undefined ? {} : { componentId: component.id }),
  };
}
function verifySnapshot(snapshot: SkillHookRuntimeSnapshot, session: HookSessionEvidence, piTrusted: boolean): HookPlanningResult | undefined {
  try {
    if (snapshot.schemaVersion !== 1) return failure("PROJECTION_MISMATCH", snapshot);
    ScopeReferenceSchema.parse(snapshot.scope);
    PluginKeySchema.parse(snapshot.plugin);
    ContentDigestSchema.parse(snapshot.revision);
    ContentDigestSchema.parse(snapshot.projectionDigest);
    ProjectionRootRefSchema.parse(snapshot.projectionRef);
    ContentDigestSchema.parse(snapshot.contributionDigest);
    CurrentProjectRuntimeContextSchema.parse(snapshot.currentProject);
    if (!sameJson(snapshot.currentProject, session.currentProject)) return failure("CURRENT_PROJECT_MISMATCH", snapshot);
    if (snapshot.content.kind !== "plugin" || typeof snapshot.content.root !== "string" || snapshot.content.root.length === 0) return failure("PROJECTION_MISMATCH", snapshot);
    PluginContentRefSchema.parse(snapshot.content.contentRef);
    PluginDataRefSchema.parse(snapshot.data.dataRef);
    if (snapshot.data.root.length === 0 || snapshot.data.plugin !== snapshot.plugin || snapshot.data.scope.kind !== snapshot.scope.kind || (snapshot.scope.kind === "project" && snapshot.data.scope.kind === "project" && snapshot.data.scope.projectKey !== snapshot.scope.projectKey)) return failure("PROJECTION_MISMATCH", snapshot);
    if (snapshot.scope.kind === "project") {
      if (snapshot.scope.projectKey !== session.currentProject.projectKey) return failure("PROJECT_SCOPE_MISMATCH", snapshot);
      if (session.currentProject.trust.kind !== "trusted") return failure("PROJECT_UNTRUSTED", snapshot);
      if (!piTrusted) return failure("PI_PROJECT_UNTRUSTED", snapshot);
    }
    for (const hook of snapshot.hooks) HookComponentSchema.parse(hook);
    return undefined;
  } catch {
    return failure("PROJECTION_MISMATCH", snapshot);
  }
}

function plannedHook(snapshot: SkillHookRuntimeSnapshot, component: HookComponent, snapshotOrdinal: number, hookOrdinal: number): PlannedCommandHook {
  return {
    sourceOrder: { snapshotOrdinal, hookOrdinal },
    scope: ScopeReferenceSchema.parse(snapshot.scope),
    plugin: PluginKeySchema.parse(snapshot.plugin),
    revision: ContentDigestSchema.parse(snapshot.revision),
    projectionDigest: ContentDigestSchema.parse(snapshot.projectionDigest),
    contributionDigest: ContentDigestSchema.parse(snapshot.contributionDigest),
    component: HookComponentSchema.parse(component),
    pluginRoot: snapshot.content.root,
    pluginDataRoot: snapshot.data.root,
  };
}

function subjectForEvent(event: string, value?: string): HookSelectorSubject {
  return { event, ...(value === undefined ? {} : { matcherCandidates: [value] }) };
}

function freezePlan(plan: HookEventPlan): HookEventPlan {
  Object.freeze(plan.input);
  Object.freeze(plan.hooks);
  Object.freeze(plan);
  return plan;
}

export interface SubagentHookEventPlanner {
  plan(request: HookBoundaryRequest): HookPlanningResult;
  hasMatchingSubagentHooks(event: SubagentHookEvent, agentType: string): boolean;
}

export function createHookEventPlanner(input: Readonly<{
  catalog: SkillHookRuntimeCatalog;
  additionalToolAliases?: readonly HookToolAliasDefinition[];
}>): SubagentHookEventPlanner {
  if (input === null || typeof input !== "object" || input.catalog === undefined) throw new TypeError("hook planner requires a runtime catalog");
  const catalog = input.catalog;
  if (typeof catalog.list !== "function" || typeof catalog.get !== "function") throw new TypeError("hook planner requires a verified runtime catalog");
  const tools = createHookToolIdentityResolver({ additional: input.additionalToolAliases ?? [] });

  function catalogSnapshots(session: HookSessionEvidence): { snapshots: readonly SkillHookRuntimeSnapshot[] } | { error: HookPlanningResult } {
    let snapshots: readonly SkillHookRuntimeSnapshot[];
    try { snapshots = catalog.list(); } catch { return { error: failure("CATALOG_UNAVAILABLE") }; }
    if (!Array.isArray(snapshots)) return { error: failure("CATALOG_UNAVAILABLE") };
    for (const snapshot of snapshots) {
      const invalid = verifySnapshot(snapshot, session, session.piProjectTrusted);
      if (invalid !== undefined) return { error: invalid };
    }
    return { snapshots };
  }

  function select(event: HookEventPlan["event"], session: HookSessionEvidence, subject: HookSelectorSubject): HookPlanningResult | readonly PlannedCommandHook[] {
    const checked = catalogSnapshots(session);
    if ("error" in checked) return checked.error;
    const selected: PlannedCommandHook[] = [];
    for (const [snapshotOrdinal, snapshot] of checked.snapshots.entries()) {
      for (const [hookOrdinal, component] of snapshot.hooks.entries()) {
        const compiled = compileHookSelector(component);
        if (compiled.kind === "incompatible") return failure("SELECTOR_RECOMPILATION_MISMATCH", snapshot, component);
        if (compiled.selector.event !== event) continue;
        if (matchesHookSelector(compiled.selector, subject)) selected.push(plannedHook(snapshot, component, snapshotOrdinal, hookOrdinal));
      }
    }
    return selected;
  }

  function makePlan(event: HookEventPlan["event"], inputValue: HookEventPlan["input"], session: HookSessionEvidence, subject: HookSelectorSubject, cancellationValue: HookCancellation): HookPlanningResult {
    const selected = select(event, session, subject);
    if ("kind" in selected) return selected;
    try {
      const plan = HookEventPlanSchema.parse({ schemaVersion: 1, event, input: inputValue, cancellation: cancellationValue, hooks: selected });
      return { kind: "ready", plans: Object.freeze([freezePlan(plan)]) };
    } catch {
      return failure("INVALID_REQUEST");
    }
  }

  function hasMatchingSubagentHooks(event: SubagentHookEvent, agentType: string): boolean {
    if (typeof agentType !== "string" || agentType.length === 0) return true;
    let snapshots: readonly SkillHookRuntimeSnapshot[];
    try { snapshots = catalog.list(); } catch { return true; }
    if (!Array.isArray(snapshots)) return true;
    for (const snapshot of snapshots) {
      for (const component of snapshot.hooks) {
        const compiled = compileHookSelector(component);
        if (compiled.kind === "incompatible") return true;
        if (compiled.selector.event === event && matchesHookSelector(compiled.selector, subjectForEvent(event, agentType))) {
          return true;
        }
      }
    }
    return false;
  }

  function plan(request: HookBoundaryRequest): HookPlanningResult {
    try {
      const session = HookSessionEvidenceSchema.parse(request.session);
      switch (request.kind) {
        case "session-start": {
          const inputValue = buildSessionStartInput(session, request.reason, persistence(session));
          return makePlan("SessionStart", inputValue, session, subjectForEvent("SessionStart", inputValue.source), cancellation(undefined, "session-boundary"));
        }
        case "session-end": {
          const inputValue = buildSessionEndInput(session, request.reason, persistence(session));
          return makePlan("SessionEnd", inputValue, session, subjectForEvent("SessionEnd"), cancellation(undefined, "session-boundary"));
        }
        case "input": {
          const inputValue = buildUserPromptSubmitInput(session, request.text, request.source, request.streamingBehavior, persistence(session));
          return makePlan("UserPromptSubmit", inputValue, session, subjectForEvent("UserPromptSubmit"), cancellation(request.signal, "pi-signal-unavailable"));
        }
        case "tool-call": {
          const identity = tools.resolve(request.evidence.toolName);
          const inputValue = buildPreToolUseInput(session, request.evidence, identity);
          const subject = subjectForTool(identity, "PreToolUse", request.evidence.input);
          return makePlan("PreToolUse", inputValue, session, subject, cancellation(request.evidence.signal, "pi-signal-unavailable"));
        }
        case "tool-result": {
          const identity = tools.resolve(request.evidence.toolName);
          const inputValue = buildPostToolInput(session, request.evidence, identity);
          const event = inputValue.hook_event_name;
          const response = "tool_response" in inputValue ? inputValue.tool_response : undefined;
          const subject = subjectForTool(identity, event, request.evidence.input, response);
          return makePlan(event, inputValue, session, subject, cancellation(request.evidence.signal, "pi-signal-unavailable"));
        }
        case "before-compact": {
          const inputValue = buildPreCompactInput(session, request.reason, request.willRetry, persistence(session));
          return makePlan("PreCompact", inputValue, session, subjectForEvent("PreCompact", compactTrigger(request.reason)), cancellation(request.signal, "pi-signal-unavailable"));
        }
        case "compact": {
          const postInput = buildPostCompactInput(session, request.reason, request.willRetry, request.fromExtension, persistence(session));
          const compactStart = buildCompactSessionStartInput(session, request.reason, request.willRetry, request.fromExtension, persistence(session));
          const post = makePlan("PostCompact", postInput, session, subjectForEvent("PostCompact", postInput.trigger), cancellation(undefined, "session-boundary"));
          if (post.kind === "failed") return post;
          const start = makePlan("SessionStart", compactStart, session, subjectForEvent("SessionStart", "compact"), cancellation(undefined, "session-boundary"));
          if (start.kind === "failed") return start;
          return { kind: "ready", plans: Object.freeze([...post.plans, ...start.plans]) };
        }
        case "agent-settled": {
          const inputValue = buildStopInput(session, request.lastAssistantMessage, request.stopHookActive, persistence(session));
          return makePlan("Stop", inputValue, session, subjectForEvent("Stop"), cancellation(undefined, "idle-boundary"));
        }
        case "subagent-start": {
          if (request.identity.parentSessionId !== session.sessionId) return failure("INVALID_REQUEST");
          const inputValue = buildSubagentStartInput(session, request.identity, request.execution);
          return makePlan("SubagentStart", inputValue, session, subjectForEvent("SubagentStart", request.identity.agentType), cancellation(request.signal, "pi-signal-unavailable"));
        }
        case "subagent-stop": {
          if (request.identity.parentSessionId !== session.sessionId) return failure("INVALID_REQUEST");
          const inputValue = buildSubagentStopInput(session, request.identity, request.execution, request.proposedResult, request.outcome, request.continuationRound, request.maxContinuationRounds);
          return makePlan("SubagentStop", inputValue, session, subjectForEvent("SubagentStop", request.identity.agentType), cancellation(request.signal, "pi-signal-unavailable"));
        }
        default:
          return failure("UNSUPPORTED_EVENT");
      }
    } catch {
      return failure("INVALID_REQUEST");
    }
  }

  return Object.freeze({ plan, hasMatchingSubagentHooks });
}
