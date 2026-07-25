import { z } from "zod";
import type { HookComponent } from "./components.js";
import { JsonValueSchema, type JsonValue } from "./schema.js";

export {
  HOOK_STDIN_MAX_BYTES,
  HOOK_STDOUT_MAX_BYTES,
  HOOK_STDERR_MAX_BYTES,
  HOOK_DEFAULT_TIMEOUT_MS,
  HOOK_MAX_TIMEOUT_MS,
  HOOK_MAX_SELECTED_HANDLERS,
  HOOK_MAX_CONCURRENCY,
  HOOK_MAX_AGGREGATED_TEXT_BYTES,
  HOOK_ASK_TIMEOUT_MS,
  HOOK_STOP_CONTINUATION_BUDGET,
  HOOK_SUBAGENT_CONTINUATION_BUDGET,
  HookRuntimeLimits,
} from "./hook-runtime-limits.js";

export const HookRuntimeEventDefinitionRegistry = Object.freeze({
  SessionStart: { owner: "ordinary", piBoundaries: ["session_start", "session_compact"], matcher: "session-source", rank: 10, conditionFields: [] },
  SessionEnd: { owner: "ordinary", piBoundaries: ["session_shutdown"], matcher: "none", rank: 20, conditionFields: [] },
  UserPromptSubmit: { owner: "ordinary", piBoundaries: ["input"], matcher: "none", rank: 30, conditionFields: [] },
  PreToolUse: { owner: "ordinary", piBoundaries: ["tool_call"], matcher: "tool", rank: 40, conditionFields: ["tool_name", "tool_input", "hook_event_name"] },
  PostToolUse: { owner: "ordinary", piBoundaries: ["tool_result"], matcher: "tool", rank: 50, conditionFields: ["tool_name", "tool_input", "tool_response", "hook_event_name"] },
  PostToolUseFailure: { owner: "ordinary", piBoundaries: ["tool_result"], matcher: "tool", rank: 60, conditionFields: ["tool_name", "tool_input", "tool_response", "hook_event_name"] },
  PreCompact: { owner: "ordinary", piBoundaries: ["session_before_compact"], matcher: "compact-trigger", rank: 70, conditionFields: [] },
  PostCompact: { owner: "ordinary", piBoundaries: ["session_compact"], matcher: "compact-trigger", rank: 80, conditionFields: [] },
  Stop: { owner: "ordinary", piBoundaries: ["agent_settled"], matcher: "none", rank: 90, conditionFields: [] },
  SubagentStart: { owner: "subagent", piBoundaries: [], matcher: "subagent", rank: 100, conditionFields: [] },
  SubagentStop: { owner: "subagent", piBoundaries: [], matcher: "subagent", rank: 110, conditionFields: [] },
  PermissionRequest: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 120, conditionFields: [] },
  PermissionDenied: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 121, conditionFields: [] },
  Setup: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 122, conditionFields: [] },
  UserPromptExpansion: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 123, conditionFields: [] },
  PostToolBatch: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 124, conditionFields: [] },
  Notification: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 125, conditionFields: [] },
  MessageDisplay: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 126, conditionFields: [] },
  TaskCreated: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 127, conditionFields: [] },
  TaskCompleted: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 128, conditionFields: [] },
  StopFailure: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 129, conditionFields: [] },
  TeammateIdle: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 130, conditionFields: [] },
  InstructionsLoaded: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 131, conditionFields: [] },
  ConfigChange: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 132, conditionFields: [] },
  CwdChanged: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 133, conditionFields: [] },
  FileChanged: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 134, conditionFields: [] },
  WorktreeCreate: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 135, conditionFields: [] },
  WorktreeRemove: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 136, conditionFields: [] },
  Elicitation: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 137, conditionFields: [] },
  ElicitationResult: { owner: "incompatible", piBoundaries: [], matcher: "none", rank: 138, conditionFields: [] },
} as const);

export type HookEventName = keyof typeof HookRuntimeEventDefinitionRegistry;
export type OrdinaryHookEvent = {
  [K in HookEventName]: typeof HookRuntimeEventDefinitionRegistry[K]["owner"] extends "ordinary" ? K : never;
}[HookEventName];
export type SubagentHookEvent = {
  [K in HookEventName]: typeof HookRuntimeEventDefinitionRegistry[K]["owner"] extends "subagent" ? K : never;
}[HookEventName];
export type ExecutableHookEvent = OrdinaryHookEvent | SubagentHookEvent;
export type IncompatibleHookEvent = {
  [K in HookEventName]: typeof HookRuntimeEventDefinitionRegistry[K]["owner"] extends "incompatible" ? K : never;
}[HookEventName];

export const ordinaryHookEvents = Object.entries(HookRuntimeEventDefinitionRegistry)
  .filter(([, value]) => value.owner === "ordinary")
  .sort(([, left], [, right]) => left.rank - right.rank)
  .map(([key]) => key) as [OrdinaryHookEvent, ...OrdinaryHookEvent[]];
export const subagentHookEvents = Object.entries(HookRuntimeEventDefinitionRegistry)
  .filter(([, value]) => value.owner === "subagent")
  .sort(([, left], [, right]) => left.rank - right.rank)
  .map(([key]) => key) as [SubagentHookEvent, ...SubagentHookEvent[]];
export const incompatibleHookEvents = Object.entries(HookRuntimeEventDefinitionRegistry)
  .filter(([, value]) => value.owner === "incompatible")
  .sort(([, left], [, right]) => left.rank - right.rank)
  .map(([key]) => key) as [IncompatibleHookEvent, ...IncompatibleHookEvent[]];

export const OrdinaryHookEventSchema = z.enum(ordinaryHookEvents);
export const SubagentHookEventSchema = z.enum(subagentHookEvents);
export const IncompatibleHookEventSchema = z.enum(incompatibleHookEvents);
export const HookEventNameSchema = z.enum([...ordinaryHookEvents, ...subagentHookEvents, ...incompatibleHookEvents] as [HookEventName, ...HookEventName[]]);

export const HookToolAliasDefinitionSchema = z.object({
  preferred: z.string().min(1).max(256),
  piNames: z.array(z.string().min(1).max(256)).min(1).readonly(),
  aliases: z.array(z.string().min(1).max(256)).min(1).readonly(),
  rank: z.number().int().nonnegative(),
}).strict().readonly();
export type HookToolAliasDefinition = z.infer<typeof HookToolAliasDefinitionSchema>;

export const HookToolAliasDefinitionRegistry = Object.freeze({
  Bash: { preferred: "Bash", piNames: ["bash"], aliases: ["Bash", "bash"], rank: 10 },
  Read: { preferred: "Read", piNames: ["read"], aliases: ["Read", "read"], rank: 20 },
  Write: { preferred: "Write", piNames: ["write"], aliases: ["Write", "write", "apply_patch"], rank: 30 },
  Edit: { preferred: "Edit", piNames: ["edit"], aliases: ["Edit", "edit", "apply_patch"], rank: 40 },
  Glob: { preferred: "Glob", piNames: ["find"], aliases: ["Glob", "find"], rank: 50 },
  Grep: { preferred: "Grep", piNames: ["grep"], aliases: ["Grep", "grep"], rank: 60 },
  Ls: { preferred: "ls", piNames: ["ls"], aliases: ["ls"], rank: 70 },
} as const satisfies Record<string, HookToolAliasDefinition>);

export const HookConditionOperatorDefinitionRegistry = Object.freeze({
  equals: "primitive",
  contains: "string",
  matches: "string",
  regex: "string",
  in: "primitive-array",
} as const);
export const HookConditionOperatorRegistry = Object.freeze(Object.keys(HookConditionOperatorDefinitionRegistry) as [keyof typeof HookConditionOperatorDefinitionRegistry, ...(keyof typeof HookConditionOperatorDefinitionRegistry)[]]);
export const HookConditionFieldRegistry = ["tool_name", "tool_input", "tool_response", "hook_event_name"] as const;

export const HookConditionPredicateSchema = z.object({
  field: z.enum(["tool_name", "tool_input", "tool_response", "hook_event_name"]),
  operator: z.enum(["equals", "contains", "matches", "regex", "in"]),
  value: JsonValueSchema,
}).strict().readonly();
export type HookConditionPredicate = z.infer<typeof HookConditionPredicateSchema>;

export type HookSelectorFailureCode =
  | "unknown-event"
  | "matcher-not-applicable"
  | "matcher-too-large"
  | "matcher-invalid"
  | "condition-multiple"
  | "condition-invalid"
  | "condition-field-not-applicable"
  | "condition-value-invalid"
  | "condition-too-large";

export type HookSelectorSubject = Readonly<{
  event: string;
  matcherCandidates?: readonly string[];
  toolNameAliases?: readonly string[];
  toolInput?: JsonValue;
  toolResponse?: JsonValue;
}>;

type CompiledPredicate = Readonly<{
  field: HookConditionPredicate["field"];
  operator: HookConditionPredicate["operator"];
  value: JsonValue;
  regex?: RegExp;
}>;
export type CompiledHookSelector = Readonly<{
  event: OrdinaryHookEvent | SubagentHookEvent;
  matcherKind: (typeof HookRuntimeEventDefinitionRegistry)[HookEventName]["matcher"];
  matcher: Readonly<{ kind: "all" } | { kind: "exact"; values: readonly string[] } | { kind: "regex"; expression: RegExp }>;
  predicates: readonly CompiledPredicate[];
}>;

export type HookSelectorContractResult =
  | Readonly<{ kind: "valid"; selector: CompiledHookSelector }>
  | Readonly<{ kind: "incompatible"; code: HookSelectorFailureCode; field: string }>;

export const HOOK_MATCHER_MAX_LENGTH = 1024;
export const HOOK_CONDITION_PATTERN_MAX_LENGTH = 1024;
export const HOOK_CONDITION_SUBJECT_MAX_LENGTH = 64 * 1024;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/;

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as { readonly [key: string]: JsonValue }).sort().map((key) => [key, canonicalize((value as { readonly [key: string]: JsonValue })[key]!) ]));
  }
  return value;
}
export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

type MatcherCompilation =
  | Readonly<{ kind: "valid"; matcher: CompiledHookSelector["matcher"] }>
  | Readonly<{ kind: "incompatible"; code: HookSelectorFailureCode; field: string }>;

function compileMatcher(value: string | undefined, kind: CompiledHookSelector["matcherKind"]): MatcherCompilation {
  if (value === undefined || value === "" || value === "*") return { kind: "valid", matcher: { kind: "all" } };
  if (kind === "none") return { kind: "incompatible", code: "matcher-not-applicable", field: "matcher" };
  if (value.length > HOOK_MATCHER_MAX_LENGTH) return { kind: "incompatible", code: "matcher-too-large", field: "matcher" };
  const parts = value.split(/[|,]/);
  if (parts.every((part) => identifier.test(part))) {
    return { kind: "valid", matcher: { kind: "exact", values: Object.freeze([...new Set(parts)]) } };
  }
  try {
    return { kind: "valid", matcher: { kind: "regex", expression: new RegExp(value) } };
  } catch {
    return { kind: "incompatible", code: "matcher-invalid", field: "matcher" };
  }
}

function conditionMetadata(component: HookComponent): readonly { field: string; value: JsonValue }[] {
  return component.metadata
    .filter((metadata) => metadata.key.endsWith(".if") || metadata.key.endsWith(".conditions"))
    .map((metadata) => ({ field: metadata.key.split(".").at(-1) ?? metadata.key, value: JsonValueSchema.parse(metadata.claimed.value) }));
}

function flattenPredicates(value: JsonValue): readonly JsonValue[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 && "if" in value) {
    return flattenPredicates(value.if!);
  }
  return [value];
}

type PredicateCompilation =
  | Readonly<{ kind: "valid"; predicates: readonly CompiledPredicate[] }>
  | Readonly<{ kind: "incompatible"; code: HookSelectorFailureCode; field: string }>;

function compilePredicates(component: HookComponent, allowedFields: readonly string[]): PredicateCompilation {
  const declarations = conditionMetadata(component);
  if (declarations.length > 1) return { kind: "incompatible", code: "condition-multiple", field: declarations[1]!.field };
  if (declarations.length === 0) return { kind: "valid", predicates: Object.freeze([]) };
  const value = declarations[0]!.value;
  const entries = flattenPredicates(value);
  if (entries.length === 0) return { kind: "incompatible", code: "condition-invalid", field: declarations[0]!.field };
  const predicates: CompiledPredicate[] = [];
  for (const entry of entries) {
    const parsed = HookConditionPredicateSchema.safeParse(entry);
    if (!parsed.success) return { kind: "incompatible", code: "condition-invalid", field: declarations[0]!.field };
    if (!allowedFields.includes(parsed.data.field)) return { kind: "incompatible", code: "condition-field-not-applicable", field: parsed.data.field };
    const { field, operator, value: predicateValue } = parsed.data;
    if (operator === "equals" && !["string", "number", "boolean"].includes(typeof predicateValue)) return { kind: "incompatible", code: "condition-value-invalid", field };
    if (["contains", "matches", "regex"].includes(operator) && typeof predicateValue !== "string") return { kind: "incompatible", code: "condition-value-invalid", field };
    if (operator === "in" && (!Array.isArray(predicateValue) || predicateValue.length === 0 || !predicateValue.every((entry) => ["string", "number", "boolean"].includes(typeof entry)))) return { kind: "incompatible", code: "condition-value-invalid", field };
    if (["matches", "regex"].includes(operator)) {
      if ((predicateValue as string).length > HOOK_CONDITION_PATTERN_MAX_LENGTH) return { kind: "incompatible", code: "condition-too-large", field };
      try { predicates.push({ field, operator, value: predicateValue, regex: new RegExp(predicateValue as string) }); } catch { return { kind: "incompatible", code: "condition-invalid", field }; }
    } else predicates.push({ field, operator, value: predicateValue });
  }
  return { kind: "valid", predicates: Object.freeze(predicates) };
}

export function compileHookSelector(component: HookComponent): HookSelectorContractResult {
  const event = component.event.value;
  const definition = HookRuntimeEventDefinitionRegistry[event as HookEventName];
  if (definition === undefined || definition.owner === "incompatible") return { kind: "incompatible", code: "unknown-event", field: "event" };
  const matcherResult = compileMatcher(component.matcher?.value, definition.matcher);
  if (matcherResult.kind === "incompatible") return matcherResult;
  const predicateResult = compilePredicates(component, definition.conditionFields);
  if (predicateResult.kind === "incompatible") return predicateResult;
  return Object.freeze({
    kind: "valid",
    selector: Object.freeze({
      event: event as OrdinaryHookEvent | SubagentHookEvent,
      matcherKind: definition.matcher,
      matcher: matcherResult.matcher,
      predicates: predicateResult.predicates,
    }),
  });
}

function subjectString(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : canonicalJson(value);
  return text.length > HOOK_CONDITION_SUBJECT_MAX_LENGTH ? undefined : text;
}

function predicateMatches(predicate: CompiledPredicate, subject: HookSelectorSubject): boolean {
  let candidates: readonly string[] | undefined;
  if (predicate.field === "tool_name") candidates = subject.toolNameAliases ?? subject.matcherCandidates;
  else if (predicate.field === "hook_event_name") candidates = [subject.event];
  else candidates = [subjectString(predicate.field === "tool_input" ? subject.toolInput : subject.toolResponse)].filter((value): value is string => value !== undefined);
  if (candidates === undefined) return false;
  if (predicate.operator === "equals") return candidates.some((candidate) => candidate === predicate.value);
  if (predicate.operator === "in") return candidates.some((candidate) => (predicate.value as readonly JsonValue[]).some((expected) => candidate === expected));
  if (predicate.operator === "contains") return candidates.some((candidate) => candidate.includes(predicate.value as string));
  return candidates.some((candidate) => predicate.regex?.test(candidate) ?? false);
}

export function matchesHookSelector(selector: CompiledHookSelector, subject: HookSelectorSubject): boolean {
  if (selector.event !== subject.event) return false;
  const candidates = subject.matcherCandidates ?? subject.toolNameAliases ?? [];
  const matcher = selector.matcher;
  const matcherMatches = matcher.kind === "all"
    ? true
    : matcher.kind === "exact"
      ? candidates.some((candidate) => matcher.values.includes(candidate))
      : candidates.some((candidate) => matcher.expression.test(candidate));
  return matcherMatches && selector.predicates.every((predicate) => predicateMatches(predicate, subject));
}

export function validateHookToolAliasDefinitions(additional: readonly HookToolAliasDefinition[] = []): readonly HookToolAliasDefinition[] {
  const values = [...Object.values(HookToolAliasDefinitionRegistry), ...additional].map((value) => HookToolAliasDefinitionSchema.parse(value));
  const seenPreferred = new Set<string>();
  const seenPi = new Set<string>();
  const staticAliases = new Set<string>(Object.values(HookToolAliasDefinitionRegistry).flatMap((value) => value.aliases));
  for (const [index, value] of values.entries()) {
    if (seenPreferred.has(value.preferred)) throw new Error("duplicate hook alias preferred identity");
    seenPreferred.add(value.preferred);
    for (const name of value.piNames) {
      if (seenPi.has(name)) throw new Error("duplicate hook alias Pi identity");
      seenPi.add(name);
    }
    if (index >= Object.keys(HookToolAliasDefinitionRegistry).length && value.aliases.some((name) => staticAliases.has(name))) {
      throw new Error("dynamic hook alias collides with a static identity");
    }
  }
  return Object.freeze(values);
}
