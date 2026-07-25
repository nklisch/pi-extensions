import { z } from "zod";
import {
  matchesHookSelector,
  validateHookToolAliasDefinitions,
  type CompiledHookSelector,
  type HookSelectorSubject,
  type HookToolAliasDefinition,
} from "../../domain/hook-runtime-contract.js";
import { JsonValueSchema, type JsonValue } from "../../domain/schema.js";
import {
  HookSessionEvidenceSchema,
  PreToolUseHookInputSchema,
  PostToolUseHookInputSchema,
  PostToolUseFailureHookInputSchema,
  HookPiContentSchema,
  cloneJson,
  type HookSessionEvidence,
  type ForeignHookInput,
  type HookPiContent,
} from "./event-contract.js";

export const HookToolIdentitySchema = z.object({
  piName: z.string().min(1).max(256),
  foreignName: z.string().min(1).max(256),
  aliases: z.array(z.string().min(1).max(256)).min(1).readonly(),
}).strict().readonly();
export type HookToolIdentity = z.infer<typeof HookToolIdentitySchema>;

export type HookToolCallEvidence = Readonly<{
  toolName: string;
  toolCallId: string;
  input: JsonValue;
  signal?: AbortSignal;
}>;

export type HookToolResultEvidence = Readonly<{
  toolName: string;
  toolCallId: string;
  input: JsonValue;
  content: readonly HookPiContent[];
  details?: unknown;
  isError: boolean;
  signal?: AbortSignal;
}>;

function dedupe(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

export function createHookToolIdentityResolver(input: Readonly<{ additional: readonly HookToolAliasDefinition[] }> = { additional: [] }): Readonly<{ resolve(piName: string): HookToolIdentity }> {
  const rows = validateHookToolAliasDefinitions(input.additional);
  function resolve(piNameInput: string): HookToolIdentity {
    const piName = z.string().min(1).max(256).parse(piNameInput);
    const row = rows.find((candidate) => candidate.piNames.includes(piName));
    if (row === undefined) return HookToolIdentitySchema.parse({ piName, foreignName: piName, aliases: [piName] });
    return HookToolIdentitySchema.parse({ piName, foreignName: row.preferred, aliases: dedupe(row.aliases) });
  }
  return Object.freeze({ resolve });
}

const defaultToolIdentityResolver = createHookToolIdentityResolver({ additional: [] });

function jsonObject(value: JsonValue): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new TypeError("tool input must be a JSON object");
  return cloneJson(value) as Record<string, JsonValue>;
}

function jsonDetails(value: unknown): JsonValue | undefined {
  const result = JsonValueSchema.safeParse(value);
  return result.success ? cloneJson(result.data) : undefined;
}

function snapshotPiContent(content: readonly unknown[]): readonly HookPiContent[] {
  const projected = content.map((item) => {
    if (item === null || typeof item !== "object") throw new TypeError("tool result content item must be an object");
    const value = item as Record<string, unknown>;
    if (value.type === "text") return { type: "text" as const, text: z.string().parse(value.text) };
    if (value.type === "image") {
      return {
        type: "image" as const,
        data: z.string().parse(value.data),
        mimeType: z.string().min(1).parse(value.mimeType),
      };
    }
    throw new TypeError("unsupported tool result content item");
  });
  const validated = HookPiContentSchema.array().parse(projected);
  return cloneJson(validated as unknown as JsonValue) as unknown as readonly HookPiContent[];
}

function resultText(content: readonly HookPiContent[]): string | undefined {
  const text = content.filter((item): item is Extract<HookPiContent, { type: "text" }> => item.type === "text").map((item) => item.text).filter((value) => value.length > 0).join("\n");
  return text.length === 0 ? undefined : text;
}

export function buildPreToolUseInput(sessionInput: HookSessionEvidence, evidenceInput: HookToolCallEvidence, identityInput?: HookToolIdentity): Extract<ForeignHookInput, { hook_event_name: "PreToolUse" }> {
  const session = HookSessionEvidenceSchema.parse(sessionInput);
  const evidence = {
    toolName: z.string().min(1).max(256).parse(evidenceInput.toolName),
    toolCallId: z.string().min(1).parse(evidenceInput.toolCallId),
    input: JsonValueSchema.parse(evidenceInput.input),
  };
  const identity = identityInput ?? defaultToolIdentityResolver.resolve(evidence.toolName);
  return PreToolUseHookInputSchema.parse({
    session_id: session.sessionId,
    ...(session.transcriptPath === undefined ? {} : { transcript_path: session.transcriptPath }),
    cwd: session.cwd,
    hook_event_name: "PreToolUse",
    tool_name: identity.foreignName,
    tool_input: jsonObject(evidence.input),
    tool_use_id: evidence.toolCallId,
  });
}

export function buildPostToolInput(sessionInput: HookSessionEvidence, evidenceInput: HookToolResultEvidence, identityInput?: HookToolIdentity): Extract<ForeignHookInput, { hook_event_name: "PostToolUse" | "PostToolUseFailure" }> {
  const session = HookSessionEvidenceSchema.parse(sessionInput);
  const evidence = {
    toolName: z.string().min(1).max(256).parse(evidenceInput.toolName),
    toolCallId: z.string().min(1).parse(evidenceInput.toolCallId),
    input: JsonValueSchema.parse(evidenceInput.input),
    content: evidenceInput.content,
    details: evidenceInput.details,
    isError: z.boolean().parse(evidenceInput.isError),
    signal: evidenceInput.signal,
  };
  const content = snapshotPiContent(evidence.content);
  const response = jsonDetails(evidence.details);
  const identity = identityInput ?? defaultToolIdentityResolver.resolve(evidence.toolName);
  const common = {
    session_id: session.sessionId,
    ...(session.transcriptPath === undefined ? {} : { transcript_path: session.transcriptPath }),
    cwd: session.cwd,
    tool_name: identity.foreignName,
    tool_input: jsonObject(evidence.input),
    ...(response === undefined ? {} : { tool_response: response }),
    tool_use_id: evidence.toolCallId,
  };
  const pi = {
    toolResult: {
      content,
      ...(response === undefined ? {} : { details: response }),
      isError: evidence.isError,
    },
  };
  if (!evidence.isError) return PostToolUseHookInputSchema.parse({ ...common, hook_event_name: "PostToolUse", pi });
  const error = resultText(content);
  const interrupted = evidence.signal?.aborted === true;
  return PostToolUseFailureHookInputSchema.parse({
    ...common,
    hook_event_name: "PostToolUseFailure",
    ...(error === undefined ? {} : { error }),
    ...(interrupted ? { is_interrupt: true } : {}),
    pi,
  });
}

export function subjectForTool(identity: HookToolIdentity, event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure", input: JsonValue, response?: JsonValue): HookSelectorSubject {
  return {
    event,
    matcherCandidates: identity.aliases,
    toolNameAliases: identity.aliases,
    toolInput: input,
    ...(response === undefined ? {} : { toolResponse: response }),
  };
}

export function evaluateHookConditions(selector: CompiledHookSelector, subject: HookSelectorSubject): boolean {
  return matchesHookSelector(selector, subject);
}

