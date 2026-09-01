/**
 * Pure, bounded projection and query model for child-session transcripts.
 *
 * The projection deliberately has only two entry families. Tool results enrich
 * their matching call instead of becoming a second row, which keeps the tool
 * and the transcript UI consistent when a call is still pending or finishes
 * out of order.
 */
import type { SessionMessage } from "#src/types";

export type SessionQueryKind = "all" | "messages" | "tool_calls" | "tool_results";
export type SessionQueryOrder = "newest" | "oldest";
/** Overlay family filter; tool query parameters continue to use `kind`. */
export type SessionQueryEntryFamily = "all" | "tools";
export type ToolCallState = "pending" | "completed" | "failed";

export const DEFAULT_QUERY_LIMIT = 20;
export const MIN_QUERY_LIMIT = 1;
export const MAX_QUERY_LIMIT = 50;

/** Caps are character caps: transcript content is text, not a byte protocol. */
export const QUERY_SEARCH_FIELD_CAP = 8_192;
export const MESSAGE_EXCERPT_CAP = 2_000;
export const TOOL_ARGUMENTS_EXCERPT_CAP = 2_000;
export const TOOL_RESULT_EXCERPT_CAP = 4_000;

export interface QueryTruncation {
  /** Search fields capped before matching, by field name. */
  readonly searchFields: readonly string[];
  /** Returned excerpts capped for the caller, by field name. */
  readonly excerpts: readonly string[];
}

interface QueryEntryBase {
  /** Stable only within this projection; it is never written to a session. */
  readonly id: string;
  /** Position of the originating SessionMessage in the source snapshot. */
  readonly sourceIndex: number;
  readonly timestamp?: number;
  readonly truncation: QueryTruncation;
}

export interface MessageQueryEntry extends QueryEntryBase {
  readonly kind: "message";
  readonly role: "user" | "assistant";
  /** Bounded visible message text. */
  readonly text: string;
}

export interface ToolCallQueryEntry extends QueryEntryBase {
  readonly kind: "tool_call";
  /** Undefined for a native bash-execution message, which has no call id. */
  readonly toolCallId?: string;
  readonly toolName: string;
  /** Bounded JSON arguments (or the command for a bash execution). */
  readonly arguments: string;
  readonly state: ToolCallState;
  /** Bounded result text; undefined means pending/no correlated result, while `""` is a completed empty result. */
  readonly result?: string;
}

export type SessionQueryEntry = MessageQueryEntry | ToolCallQueryEntry;

export interface SessionQueryOptions {
  readonly query?: string;
  readonly kind?: SessionQueryKind;
  readonly order?: SessionQueryOrder;
  readonly limit?: number;
  /** Restrict the result to the overlay's tool family without changing search fields. */
  readonly entryFamily?: SessionQueryEntryFamily;
}

export interface SessionQueryResult {
  readonly entries: readonly SessionQueryEntry[];
  /** Number of entries matching before the result limit is applied. */
  readonly totalMatches: number;
  readonly omittedCount: number;
  readonly hasMore: boolean;
}

interface SearchableEntry {
  entry: SessionQueryEntry;
  searchable: Readonly<Record<string, string>>;
  rawSearchable: Readonly<Record<string, string>>;
}

interface BoundedText {
  readonly value: string;
  readonly truncated: boolean;
}

/** Project raw Pi messages into the stable two-family query algebra. */
export function projectSessionMessages(messages: readonly SessionMessage[]): readonly SessionQueryEntry[] {
  return projectSearchableMessages(messages).map(({ entry }) => entry);
}

function projectSearchableMessages(messages: readonly SessionMessage[]): SearchableEntry[] {
  const projected: SearchableEntry[] = [];
  const calls = new Map<string, SearchableEntry>();

  for (let sourceIndex = 0; sourceIndex < messages.length; sourceIndex++) {
    const message = messages[sourceIndex]!;
    if (message.role === "user" || message.role === "assistant") {
      const text = visibleText(message.content);
      if (text.trim()) {
        const bounded = bound(text, MESSAGE_EXCERPT_CAP);
        const rawSearchable = { text };
        const searchable = searchFields(rawSearchable);
        projected.push({
          entry: {
            kind: "message",
            id: messageIdentity(message.role, sourceIndex, message.timestamp),
            sourceIndex,
            ...(timestampOf(message) === undefined ? {} : { timestamp: timestampOf(message) }),
            role: message.role,
            text: bounded.value,
            truncation: truncationFor(rawSearchable, { text: bounded }),
          },
          searchable,
          rawSearchable,
        });
      }
      if (message.role === "assistant") {
        for (const content of message.content) {
          if (content.type !== "toolCall") continue;
          const callId = content.id;
          const args = stringifyArguments(content.arguments);
          const boundedArgs = bound(args, TOOL_ARGUMENTS_EXCERPT_CAP);
          const rawSearchable = { toolName: content.name, toolCallId: callId, arguments: args };
          const searchable = searchFields(rawSearchable);
          const call: SearchableEntry = {
            entry: {
              kind: "tool_call",
              id: callId,
              sourceIndex,
              ...(timestampOf(message) === undefined ? {} : { timestamp: timestampOf(message) }),
              toolCallId: callId,
              toolName: content.name,
              arguments: boundedArgs.value,
              state: "pending",
              truncation: truncationFor(rawSearchable, { arguments: boundedArgs }),
            },
            searchable,
            rawSearchable,
          };
          projected.push(call);
          calls.set(callId, call);
        }
      }
      continue;
    }

    if (message.role === "bashExecution") {
      const args = message.command;
      const state: ToolCallState = message.exitCode === undefined && !message.cancelled
        ? "pending"
        : message.cancelled || message.exitCode !== 0
          ? "failed"
          : "completed";
      // An empty output after completion is still a result. Keeping `""` rather
      // than collapsing it to undefined lets tool_results distinguish a call
      // that completed silently from one that is still pending.
      const result = state === "pending" ? undefined : message.output ?? "";
      const boundedArgs = bound(args, TOOL_ARGUMENTS_EXCERPT_CAP);
      const boundedResult = result === undefined ? undefined : bound(result, TOOL_RESULT_EXCERPT_CAP);
      const rawSearchable = { toolName: "bash", arguments: args, ...(result === undefined ? {} : { result }) };
      const searchable = searchFields(rawSearchable);
      projected.push({
        entry: {
          kind: "tool_call",
          id: `bash:${sourceIndex}`,
          sourceIndex,
          ...(timestampOf(message) === undefined ? {} : { timestamp: timestampOf(message) }),
          toolName: "bash",
          arguments: boundedArgs.value,
          state,
          ...(boundedResult === undefined ? {} : { result: boundedResult.value }),
          truncation: truncationFor(rawSearchable, {
            arguments: boundedArgs,
            ...(boundedResult === undefined ? {} : { result: boundedResult }),
          }),
        },
        searchable,
        rawSearchable,
      });
    }
  }

  // Correlate after projection so out-of-order results work and an orphan
  // result never creates a duplicate row.
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const call = calls.get(message.toolCallId);
    if (!call) continue;
    const current = call.entry as ToolCallQueryEntry;
    const resultText = visibleText(message.content);
    const boundedResult = bound(resultText, TOOL_RESULT_EXCERPT_CAP);
    const rawSearchable = { ...call.rawSearchable, result: resultText };
    const searchable = searchFields(rawSearchable);
    const updated: ToolCallQueryEntry = {
      ...current,
      state: message.isError ? "failed" : "completed",
      // Preserve an empty but completed result as `""`; undefined means that
      // no correlated result has arrived yet.
      result: boundedResult.value,
      truncation: truncationFor(rawSearchable, {
        arguments: bound(call.rawSearchable.arguments ?? current.arguments, TOOL_ARGUMENTS_EXCERPT_CAP),
        result: boundedResult,
      }),
    };
    call.entry = updated;
    call.searchable = searchable;
    call.rawSearchable = rawSearchable;
  }

  return projected;
}

/** Query a fresh projection; no derived state is retained between calls. */
export function querySession(
  messages: readonly SessionMessage[],
  options: SessionQueryOptions = {},
): SessionQueryResult {
  const limit = normalizeLimit(options.limit);
  const kind = options.kind ?? "all";
  const order = options.order ?? "newest";
  const query = options.query ?? "";
  const needle = query.toLowerCase();
  const projected = projectSearchableMessages(messages);
  const matches = projected
    .filter(({ entry }) => options.entryFamily !== "tools" || entry.kind === "tool_call")
    .filter(({ entry }) => matchesKind(entry, kind))
    .filter(({ searchable }) => matchesQuery(searchable, needle, kind))
    .map(({ entry }) => entry);
  const ordered = order === "newest" ? [...matches].reverse() : matches;
  const entries = ordered.slice(0, limit);
  return {
    entries,
    totalMatches: matches.length,
    omittedCount: Math.max(0, matches.length - entries.length),
    hasMore: matches.length > entries.length,
  };
}

export function normalizeLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_QUERY_LIMIT;
  if (!Number.isInteger(value) || value < MIN_QUERY_LIMIT || value > MAX_QUERY_LIMIT) {
    throw new RangeError(`limit must be an integer from ${MIN_QUERY_LIMIT} to ${MAX_QUERY_LIMIT}`);
  }
  return value;
}

function matchesKind(entry: SessionQueryEntry, kind: SessionQueryKind): boolean {
  if (kind === "all") return true;
  if (kind === "messages") return entry.kind === "message";
  if (kind === "tool_calls") return entry.kind === "tool_call";
  return entry.kind === "tool_call" && entry.result !== undefined;
}

function matchesQuery(
  searchable: Readonly<Record<string, string>>,
  needle: string,
  kind: SessionQueryKind,
): boolean {
  if (!needle) return true;
  if (kind === "messages") return searchable.text?.toLowerCase().includes(needle) ?? false;
  if (kind === "tool_calls") {
    return [searchable.toolName, searchable.toolCallId, searchable.arguments]
      .filter((value): value is string => value !== undefined)
      .some((value) => value.toLowerCase().includes(needle));
  }
  if (kind === "tool_results") return searchable.result?.toLowerCase().includes(needle) ?? false;
  return Object.values(searchable).some((value) => value.toLowerCase().includes(needle));
}

function visibleText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text?: string } =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text",
    )
    .map((part) => part.text ?? "")
    .join("\n");
}

function stringifyArguments(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function timestampOf(message: SessionMessage): number | undefined {
  return typeof message.timestamp === "number" ? message.timestamp : undefined;
}

function messageIdentity(role: "user" | "assistant", sourceIndex: number, timestamp: unknown): string {
  return `message:${role}:${sourceIndex}${typeof timestamp === "number" ? `:${timestamp}` : ""}`;
}

function capForSearch(value: string): string {
  return value.length > QUERY_SEARCH_FIELD_CAP ? value.slice(0, QUERY_SEARCH_FIELD_CAP) : value;
}

function searchFields(fields: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, capForSearch(value)]));
}

function bound(value: string, cap: number): BoundedText {
  return value.length > cap ? { value: value.slice(0, cap), truncated: true } : { value, truncated: false };
}

function truncationFor(
  rawSearchable: Readonly<Record<string, string>>,
  excerpts: Readonly<Record<string, BoundedText>>,
): QueryTruncation {
  const searchFields = Object.entries(rawSearchable)
    .filter(([, value]) => value.length > QUERY_SEARCH_FIELD_CAP)
    .map(([name]) => name);
  const excerptFields = Object.entries(excerpts)
    .filter(([, value]) => value.truncated)
    .map(([name]) => name);
  return { searchFields, excerpts: excerptFields };
}
