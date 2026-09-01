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
export type SessionQueryField = "text" | "toolName" | "toolCallId" | "arguments" | "result";
export type SessionQueryOutcome = "matches" | "no_matches" | "page_out_of_range";

export const DEFAULT_QUERY_LIMIT = 20;
export const MIN_QUERY_LIMIT = 1;
export const MAX_QUERY_LIMIT = 50;

/** Returned message text is bounded; matching always uses its complete source field. */
export const MESSAGE_EXCERPT_CAP = 2_000;
export const TOOL_ARGUMENTS_EXCERPT_CAP = 2_000;
export const TOOL_RESULT_EXCERPT_CAP = 4_000;

export interface QueryTruncation {
  /** Returned excerpts capped for the caller, by field name. */
  readonly excerpts: readonly string[];
}

export interface QueryMatch {
  /** The complete source field containing the first match. */
  readonly field: SessionQueryField;
  /** UTF-16 offsets in the complete, unmarked source field. */
  readonly sourceRange: {
    readonly start: number;
    readonly end: number;
  };
}

interface QueryEntryBase {
  /** Stable only within this projection; it is never written to a session. */
  readonly id: string;
  /** Position of the originating SessionMessage in the source snapshot. */
  readonly sourceIndex: number;
  readonly timestamp?: number;
  readonly truncation: QueryTruncation;
  /** Present only for a non-empty query; absent for prefix browsing. */
  readonly match?: QueryMatch;
}

export interface MessageQueryEntry extends QueryEntryBase {
  readonly kind: "message";
  readonly role: "user" | "assistant";
  /** A prefix preview for browsing, or a match-centered excerpt for a query. */
  readonly text: string;
}

export interface ToolCallQueryEntry extends QueryEntryBase {
  readonly kind: "tool_call";
  /** Bounded display preview; undefined for native bash-execution messages. */
  readonly toolCallId?: string;
  /** Bounded display preview; the complete name remains query-local. */
  readonly toolName: string;
  /** A bounded JSON arguments preview, or a match-centered excerpt for a query. */
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
  /** Ordered matching-entry offset; no cursor or query state is retained. */
  readonly offset?: number;
}

export interface SessionQueryResult {
  readonly entries: readonly SessionQueryEntry[];
  /** Number of matching entries before paging. */
  readonly totalMatches: number;
  /** Offset applied to the ordered matching-entry set. */
  readonly offset: number;
  /** Number of entries returned by this model page. */
  readonly returnedCount: number;
  /** Offset for the next page, when entries remain after this page. */
  readonly nextOffset?: number;
  /** Offset for a preceding page, when this result has a preceding page. */
  readonly previousOffset?: number;
  /** Matching entries before the returned page. */
  readonly omittedBefore: number;
  /** Matching entries after the returned page. */
  readonly omittedAfter: number;
  readonly hasMore: boolean;
  /** True whenever the transcript source was read successfully. */
  readonly searchComplete: true;
  readonly outcome: SessionQueryOutcome;
}

interface SearchableEntry {
  entry: SessionQueryEntry;
  /** Complete raw searchable fields; this object never escapes the query call. */
  searchable: Readonly<Partial<Record<SessionQueryField, string>>>;
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
        const searchable = { text };
        projected.push({
          entry: {
            kind: "message",
            id: messageIdentity(message.role, sourceIndex, message.timestamp),
            sourceIndex,
            ...(timestampOf(message) === undefined ? {} : { timestamp: timestampOf(message) }),
            role: message.role,
            text: bounded.value,
            truncation: truncationFor({ text: bounded }),
          },
          searchable,
        });
      }
      if (message.role === "assistant") {
        for (const content of message.content) {
          if (content.type !== "toolCall") continue;
          const callId = content.id;
          const args = stringifyArguments(content.arguments);
          const boundedToolName = boundPreview(content.name, TOOL_ARGUMENTS_EXCERPT_CAP);
          const boundedToolCallId = boundPreview(callId, TOOL_ARGUMENTS_EXCERPT_CAP);
          const boundedArgs = bound(args, TOOL_ARGUMENTS_EXCERPT_CAP);
          // Keep the complete name and id only in this projection-local search
          // record. The public entry carries bounded display values, while its
          // stable `id` remains the full correlation key used by the overlay.
          const searchable = { toolName: content.name, toolCallId: callId, arguments: args };
          const call: SearchableEntry = {
            entry: {
              kind: "tool_call",
              id: callId,
              sourceIndex,
              ...(timestampOf(message) === undefined ? {} : { timestamp: timestampOf(message) }),
              toolCallId: boundedToolCallId.value,
              toolName: boundedToolName.value,
              arguments: boundedArgs.value,
              state: "pending",
              truncation: truncationFor({
                toolName: boundedToolName,
                toolCallId: boundedToolCallId,
                arguments: boundedArgs,
              }),
            },
            searchable,
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
      const searchable = { toolName: "bash", arguments: args, ...(result === undefined ? {} : { result }) };
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
          truncation: truncationFor({
            arguments: boundedArgs,
            ...(boundedResult === undefined ? {} : { result: boundedResult }),
          }),
        },
        searchable,
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
    const searchable = { ...call.searchable, result: resultText };
    const updated: ToolCallQueryEntry = {
      ...current,
      state: message.isError ? "failed" : "completed",
      // Preserve an empty but completed result as `""`; undefined means that
      // no correlated result has arrived yet.
      result: boundedResult.value,
      truncation: truncationFor({
        arguments: bound(call.searchable.arguments ?? current.arguments, TOOL_ARGUMENTS_EXCERPT_CAP),
        result: boundedResult,
      }),
    };
    call.entry = updated;
    call.searchable = searchable;
  }

  return projected;
}

/** Query a fresh projection; no derived state is retained between calls. */
export function querySession(
  messages: readonly SessionMessage[],
  options: SessionQueryOptions = {},
): SessionQueryResult {
  const limit = normalizeLimit(options.limit);
  const offset = normalizeOffset(options.offset);
  const kind = options.kind ?? "all";
  const order = options.order ?? "newest";
  const query = options.query ?? "";
  const needle = query.toLowerCase();
  const projected = projectSearchableMessages(messages);
  const matching = projected.flatMap((candidate): SessionQueryEntry[] => {
    if (options.entryFamily === "tools" && candidate.entry.kind !== "tool_call") return [];
    if (!matchesKind(candidate.entry, kind)) return [];
    if (needle.length === 0) return [candidate.entry];
    const match = findFirstMatch(candidate.entry, candidate.searchable, needle, kind);
    return match === undefined ? [] : [entryWithMatch(candidate, match)];
  });
  const ordered = order === "newest" ? [...matching].reverse() : matching;
  const totalMatches = ordered.length;
  const outcome: SessionQueryOutcome = totalMatches === 0
    ? "no_matches"
    : offset >= totalMatches
      ? "page_out_of_range"
      : "matches";
  const entries = outcome === "matches"
    ? ordered.slice(offset, Math.min(totalMatches, offset + limit))
    : [];
  const returnedCount = entries.length;
  const nextOffset = offset < totalMatches && offset + returnedCount < totalMatches
    ? offset + returnedCount
    : undefined;
  const previousOffset = totalMatches > 0 && offset > 0
    ? Math.max(0, Math.min(Math.max(0, totalMatches - limit), offset - limit))
    : undefined;
  const omittedBefore = Math.min(offset, totalMatches);
  const omittedAfter = Math.max(0, totalMatches - offset - returnedCount);
  return {
    entries,
    totalMatches,
    offset,
    returnedCount,
    ...(nextOffset === undefined ? {} : { nextOffset }),
    ...(previousOffset === undefined ? {} : { previousOffset }),
    omittedBefore,
    omittedAfter,
    hasMore: nextOffset !== undefined,
    searchComplete: true,
    outcome,
  };
}

export function normalizeLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_QUERY_LIMIT;
  if (!Number.isInteger(value) || value < MIN_QUERY_LIMIT || value > MAX_QUERY_LIMIT) {
    throw new RangeError(`limit must be an integer from ${MIN_QUERY_LIMIT} to ${MAX_QUERY_LIMIT}`);
  }
  return value;
}

export function normalizeOffset(offset: number | undefined): number {
  const value = offset ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("offset must be a non-negative safe integer");
  }
  return value;
}

function matchesKind(entry: SessionQueryEntry, kind: SessionQueryKind): boolean {
  if (kind === "all") return true;
  if (kind === "messages") return entry.kind === "message";
  if (kind === "tool_calls") return entry.kind === "tool_call";
  return entry.kind === "tool_call" && entry.result !== undefined;
}

function findFirstMatch(
  entry: SessionQueryEntry,
  searchable: Readonly<Partial<Record<SessionQueryField, string>>>,
  needle: string,
  kind: SessionQueryKind,
): QueryMatch | undefined {
  const fields = entry.kind === "message"
    ? ["text"] as const
    : kind === "tool_results"
      ? ["result"] as const
      : kind === "tool_calls"
        ? ["toolName", "toolCallId", "arguments"] as const
        : ["toolName", "toolCallId", "arguments", "result"] as const;
  for (const field of fields) {
    const value = searchable[field];
    if (value === undefined) continue;
    const lowered = value.toLowerCase();
    const matchStart = lowered.indexOf(needle);
    if (matchStart < 0) continue;
    const matchEnd = matchStart + needle.length;
    const sourceStart = sourceOffsetForLower(value, matchStart, false);
    const sourceEnd = Math.max(sourceStart + 1, sourceOffsetForLower(value, matchEnd, true));
    return { field, sourceRange: { start: sourceStart, end: Math.min(value.length, sourceEnd) } };
  }
  return undefined;
}

function entryWithMatch(candidate: SearchableEntry, match: QueryMatch): SessionQueryEntry {
  const { entry, searchable } = candidate;
  if (entry.kind === "message") {
    const text = searchable.text ?? entry.text;
    const bounded = boundAroundMatch(text, match.sourceRange, MESSAGE_EXCERPT_CAP);
    return { ...entry, text: bounded.value, truncation: truncationFor({ text: bounded }), match };
  }

  const toolName = searchable.toolName ?? entry.toolName;
  const boundedToolName = match.field === "toolName"
    ? boundAroundMatch(toolName, match.sourceRange, TOOL_ARGUMENTS_EXCERPT_CAP)
    : boundPreview(toolName, TOOL_ARGUMENTS_EXCERPT_CAP);
  const toolCallId = searchable.toolCallId;
  const boundedToolCallId = toolCallId === undefined
    ? undefined
    : match.field === "toolCallId"
      ? boundAroundMatch(toolCallId, match.sourceRange, TOOL_ARGUMENTS_EXCERPT_CAP)
      : boundPreview(toolCallId, TOOL_ARGUMENTS_EXCERPT_CAP);
  const argumentsText = searchable.arguments ?? entry.arguments;
  const boundedArguments = match.field === "arguments"
    ? boundAroundMatch(argumentsText, match.sourceRange, TOOL_ARGUMENTS_EXCERPT_CAP)
    : bound(argumentsText, TOOL_ARGUMENTS_EXCERPT_CAP);
  const boundedResult = searchable.result === undefined
    ? undefined
    : match.field === "result"
      ? boundAroundMatch(searchable.result, match.sourceRange, TOOL_RESULT_EXCERPT_CAP)
      : bound(searchable.result, TOOL_RESULT_EXCERPT_CAP);
  return {
    ...entry,
    toolName: boundedToolName.value,
    ...(boundedToolCallId === undefined ? {} : { toolCallId: boundedToolCallId.value }),
    arguments: boundedArguments.value,
    ...(boundedResult === undefined ? {} : { result: boundedResult.value }),
    truncation: truncationFor({
      toolName: boundedToolName,
      ...(boundedToolCallId === undefined ? {} : { toolCallId: boundedToolCallId }),
      arguments: boundedArguments,
      ...(boundedResult === undefined ? {} : { result: boundedResult }),
    }),
    match,
  };
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

function bound(value: string, cap: number): BoundedText {
  return value.length > cap ? { value: value.slice(0, cap), truncated: true } : { value, truncated: false };
}

/** Prefix previews identify omitted metadata without exposing the full field. */
function boundPreview(value: string, cap: number): BoundedText {
  if (value.length <= cap) return { value, truncated: false };
  const marker = "…";
  const contentCap = Math.max(0, cap - marker.length);
  return { value: `${value.slice(0, contentCap)}${marker}`, truncated: true };
}

/**
 * Keep the first match visible while spending the excerpt budget on context.
 * The source range remains in raw-field coordinates; markers are presentation
 * text and are not included in that range.
 */
function boundAroundMatch(value: string, sourceRange: { start: number; end: number }, cap: number): BoundedText {
  if (value.length <= cap) return { value, truncated: false };
  const contentCap = Math.max(1, cap - 2);
  const matchStart = Math.max(0, Math.min(value.length, sourceRange.start));
  const matchEnd = Math.max(matchStart + 1, Math.min(value.length, sourceRange.end));
  if (matchEnd - matchStart >= contentCap) {
    const end = Math.min(value.length, matchStart + contentCap);
    return { value: `${value.slice(0, matchStart) ? "…" : ""}${value.slice(matchStart, end)}${end < value.length ? "…" : ""}`, truncated: true };
  }

  const windowStart = Math.max(0, matchEnd - contentCap);
  const windowEnd = Math.min(matchStart, value.length - contentCap);
  const centeredStart = matchStart - Math.floor((contentCap - (matchEnd - matchStart)) / 2);
  const start = Math.max(windowStart, Math.min(windowEnd, centeredStart));
  const end = Math.min(value.length, start + contentCap);
  return {
    value: `${start > 0 ? "…" : ""}${value.slice(start, end)}${end < value.length ? "…" : ""}`,
    truncated: true,
  };
}

/**
 * Map an offset in the lower-cased field back to the original UTF-16 field.
 * Matching itself uses `value.toLowerCase()` as a whole; this linear walk only
 * accounts for each code point's lower-case UTF-16 width, including expanding
 * mappings such as `İ` → `i` plus a combining dot.
 */
function sourceOffsetForLower(value: string, lowerOffset: number, end: boolean): number {
  let sourceOffset = 0;
  let lowerPosition = 0;
  for (const character of value) {
    if (lowerOffset <= lowerPosition) return sourceOffset;
    const lowerLength = character.toLowerCase().length;
    const nextLowerPosition = lowerPosition + lowerLength;
    if (lowerOffset < nextLowerPosition || (end && lowerOffset === nextLowerPosition)) {
      return end ? sourceOffset + character.length : sourceOffset;
    }
    sourceOffset += character.length;
    lowerPosition = nextLowerPosition;
  }
  return sourceOffset;
}

function truncationFor(excerpts: Readonly<Record<string, BoundedText>>): QueryTruncation {
  return {
    excerpts: Object.entries(excerpts)
      .filter(([, value]) => value.truncated)
      .map(([name]) => name),
  };
}
