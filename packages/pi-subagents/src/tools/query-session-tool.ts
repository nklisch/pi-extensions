import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Subagent } from "#src/lifecycle/subagent";
import {
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  MIN_QUERY_LIMIT,
  querySession,
  type SessionQueryEntry,
  type SessionQueryKind,
  type SessionQueryOrder,
} from "#src/session/query";
import { readSessionFileMessages } from "#src/session/query-source";
import { textResult } from "#src/tools/helpers";
import { describeActivity, formatMs, formatModelThinking } from "#src/ui/display";

const MAX_QUERY_OUTPUT_BYTES = 50 * 1024;
const MAX_QUERY_OUTPUT_LINES = 2_000;
// Leave room for the summary, source path, omission tail, and a final line/
// byte boundary. The entry budget is intentionally smaller than Pi's limits;
// entries are additionally checked against the actual fixed text below.
const MAX_QUERY_ENTRY_BYTES = 39 * 1024;
const MAX_QUERY_ENTRY_LINES = 1_800;
const MAX_QUERY_METADATA_LINE_BYTES = 2_048;
const MAX_QUERY_TRANSCRIPT_PATH_BYTES = 1_024;
const utf8Encoder = new TextEncoder();
const VALID_KINDS = new Set<SessionQueryKind>(["all", "messages", "tool_calls", "tool_results"]);
const VALID_ORDERS = new Set<SessionQueryOrder>(["newest", "oldest"]);

export type QuerySessionOutcome = "matches" | "no_matches" | "page_out_of_range" | "transcript_unavailable" | "not_found" | "read_error";

export interface QuerySessionDetails {
  readonly outcome: QuerySessionOutcome;
  readonly agentId: string;
  readonly runId?: number;
  readonly mode?: string;
  readonly status?: string;
  readonly terminalReason?: string;
  readonly model?: string;
  readonly thinkingLevel?: Subagent["effectiveThinkingLevel"];
  readonly activeRuntimeMs?: number;
  readonly activity?: string;
  readonly source?: "live" | "file";
  readonly transcriptPath?: string;
  readonly query?: string;
  readonly kind?: SessionQueryKind;
  readonly order?: SessionQueryOrder;
  readonly limit?: number;
  readonly offset?: number;
  readonly entries?: readonly SessionQueryEntry[];
  readonly totalMatches?: number;
  readonly returnedCount?: number;
  readonly nextOffset?: number;
  readonly previousOffset?: number;
  readonly omittedBefore?: number;
  readonly omittedAfter?: number;
  readonly hasMore?: boolean;
  /** True means every searchable field was examined, not just a preview prefix. */
  readonly searchComplete?: boolean;
  readonly truncation?: {
    readonly output: boolean;
    readonly omittedMatches: number;
    readonly transcriptPath?: string;
  };
  readonly error?: string;
}

export interface QuerySessionToolManager {
  getRecord(id: string): Subagent | undefined;
}

export type QuerySessionFileReader = (path: string) => string;

/** Parent-only bounded transcript drill-down. */
export class QuerySessionTool {
  constructor(
    private readonly manager: QuerySessionToolManager,
    private readonly readFile: QuerySessionFileReader,
  ) {}

  async execute(
    _toolCallId: string,
    params: {
      agent_id?: string;
      query?: string;
      kind?: SessionQueryKind;
      order?: SessionQueryOrder;
      limit?: number;
      offset?: number;
    },
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    _ctx: unknown,
  ) {
    const validation = validateParams(params);
    if (validation) return textResult(validation);

    const agentId = params.agent_id!;
    const record = this.manager.getRecord(agentId);
    if (!record) {
      return textResult(`Agent not found: "${boundedOutputLine(agentId, MAX_QUERY_METADATA_LINE_BYTES)}". It may have been cleaned up.`, {
        outcome: "not_found",
        agentId,
      } satisfies QuerySessionDetails);
    }

    const base = recordDetails(record, agentId);
    let source: "live" | "file";
    let messages;
    try {
      if (record.isSessionReady()) {
        source = "live";
        messages = record.agentMessages;
      } else if (record.outputFile) {
        source = "file";
        messages = readSessionFileMessages(record.outputFile, this.readFile);
      } else {
        return textResult(
          `${boundedOutputLine(summaryLine(base), MAX_QUERY_METADATA_LINE_BYTES)}\nTranscript unavailable: no retained live session or persisted transcript is available.`,
          { ...base, outcome: "transcript_unavailable" } satisfies QuerySessionDetails,
        );
      }
    } catch (error) {
      if (sourceIsMissingFile(record, error)) {
        return textResult(
          `${boundedOutputLine(summaryLine(base), MAX_QUERY_METADATA_LINE_BYTES)}\nTranscript unavailable: ${boundedOutputLine(record.outputFile ?? "", MAX_QUERY_TRANSCRIPT_PATH_BYTES)}.`,
          { ...base, outcome: "transcript_unavailable", source: "file", transcriptPath: record.outputFile } satisfies QuerySessionDetails,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      return textResult(
        `${boundedOutputLine(summaryLine(base), MAX_QUERY_METADATA_LINE_BYTES)}\nCould not read the subagent transcript: ${boundedOutputLine(message, MAX_QUERY_METADATA_LINE_BYTES)}`,
        { ...base, outcome: "read_error", source: record.isSessionReady() ? "live" : "file", transcriptPath: record.outputFile, error: message } satisfies QuerySessionDetails,
      );
    }

    const result = querySession(messages, {
      query: params.query,
      kind: params.kind,
      order: params.order,
      limit: params.limit,
      offset: params.offset,
    });
    const summary = boundedOutputLine(summaryLine(base), MAX_QUERY_METADATA_LINE_BYTES);
    const sourceDescription = boundedOutputLine(
      `${source}${record.outputFile ? ` (${record.outputFile})` : ""}`,
      MAX_QUERY_METADATA_LINE_BYTES,
    );
    const prefix = `${summary}\nSource: ${sourceDescription}\nSearch: complete (full transcript fields).\n`;
    // Reserve the largest possible omission/navigation tail before selecting
    // entries. This keeps a later bounds notice from pushing the body over
    // Pi's byte or line ceiling.
    const maximumOmittedCount = result.omittedBefore + result.omittedAfter + result.entries.length;
    const reservedTail = omissionTail(
      maximumOmittedCount,
      maximumOmittedCount,
      maximumOmittedCount,
      result.nextOffset,
      result.previousOffset,
      record.outputFile,
    );
    const output = formatEntries(
      result.entries,
      Math.min(
        MAX_QUERY_ENTRY_BYTES,
        Math.max(0, MAX_QUERY_OUTPUT_BYTES - utf8ByteLength(prefix) - utf8ByteLength(reservedTail) - 1),
      ),
      Math.min(
        MAX_QUERY_ENTRY_LINES,
        Math.max(0, MAX_QUERY_OUTPUT_LINES - lineCount(prefix) - lineCount(reservedTail) - 1),
      ),
    );
    const returnedCount = output.entries.length;
    const omittedBefore = result.omittedBefore;
    const omittedAfter = Math.max(0, result.totalMatches - result.offset - returnedCount);
    // Recompute this from entries that really made it into the output. If the
    // byte/line budget drops entries from a page, the next request starts after
    // only those entries and cannot skip an unseen match.
    const nextOffset = result.outcome === "matches" && returnedCount > 0 && result.offset + returnedCount < result.totalMatches
      ? result.offset + returnedCount
      : undefined;
    const outcome = result.outcome;
    const details: QuerySessionDetails = {
      ...base,
      outcome,
      source,
      transcriptPath: record.outputFile,
      query: params.query ?? "",
      kind: params.kind ?? "all",
      order: params.order ?? "newest",
      limit: params.limit ?? DEFAULT_QUERY_LIMIT,
      offset: result.offset,
      entries: output.entries,
      totalMatches: result.totalMatches,
      returnedCount,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      ...(result.previousOffset === undefined ? {} : { previousOffset: result.previousOffset }),
      omittedBefore,
      omittedAfter,
      hasMore: nextOffset !== undefined,
      searchComplete: true,
      ...(output.omittedCount > 0 ? {
        truncation: {
          output: true,
          omittedMatches: output.omittedCount,
          ...(record.outputFile ? { transcriptPath: record.outputFile } : {}),
        },
      } : {}),
    };
    const body = outcome === "no_matches"
      ? "No transcript entries match the requested query."
      : outcome === "page_out_of_range"
        ? `No transcript page starts at offset ${result.offset}; ${result.totalMatches} matching entr${result.totalMatches === 1 ? "y is" : "ies are"} available.`
        : output.lines.join("\n");
    const tail = omissionTail(
      omittedBefore,
      omittedAfter,
      output.omittedCount,
      nextOffset,
      result.previousOffset,
      record.outputFile,
    );
    return textResult(`${prefix}${body}${tail}`, details);
  }

  toToolDefinition() {
    return defineTool({
      name: "query_subagent_session" as const,
      label: "Query Subagent Session",
      promptSnippet: "query_subagent_session: Search a bounded child transcript without steering it.",
      description: "Query a subagent's recent or matching messages and tool calls. Search is complete, case-insensitive literal text over full fields, bounded only in returned excerpts/output, and read-only; use get_subagent_result for the final result and list_subagents for fleet triage.",
      parameters: Type.Object({
        agent_id: Type.String({ description: "The subagent ID to inspect." }),
        query: Type.Optional(Type.String({ description: "Case-insensitive literal text. Omit or use an empty string for beginning-of-entry previews." })),
        kind: Type.Optional(Type.Union([
          Type.Literal("all"),
          Type.Literal("messages"),
          Type.Literal("tool_calls"),
          Type.Literal("tool_results"),
        ], { description: "Search scope. Defaults to all." })),
        order: Type.Optional(Type.Union([
          Type.Literal("newest"),
          Type.Literal("oldest"),
        ], { description: "Result order. Defaults to newest." })),
        limit: Type.Optional(Type.Integer({ minimum: MIN_QUERY_LIMIT, maximum: MAX_QUERY_LIMIT, description: "Maximum entries, 1-50; defaults to 20." })),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Non-negative safe integer offset into the ordered matching entries; defaults to 0." })),
      }),
      execute: (toolCallId: string, params: {
        agent_id?: string;
        query?: string;
        kind?: SessionQueryKind;
        order?: SessionQueryOrder;
        limit?: number;
        offset?: number;
      }, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => this.execute(toolCallId, params, signal, onUpdate, ctx),
    });
  }
}

function validateParams(params: {
  agent_id?: string;
  query?: string;
  kind?: SessionQueryKind;
  order?: SessionQueryOrder;
  limit?: number;
  offset?: number;
}): string | undefined {
  if (typeof params.agent_id !== "string" || params.agent_id.length === 0) return "agent_id must be a non-empty string";
  if (params.query !== undefined && typeof params.query !== "string") return "query must be a string";
  if (params.kind !== undefined && !VALID_KINDS.has(params.kind)) return "kind must be all, messages, tool_calls, or tool_results";
  if (params.order !== undefined && !VALID_ORDERS.has(params.order)) return "order must be newest or oldest";
  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < MIN_QUERY_LIMIT || params.limit > MAX_QUERY_LIMIT)) {
    return `limit must be an integer from ${MIN_QUERY_LIMIT} to ${MAX_QUERY_LIMIT}`;
  }
  if (params.offset !== undefined && !Number.isSafeInteger(params.offset)) return "offset must be a non-negative safe integer";
  if (params.offset !== undefined && params.offset < 0) return "offset must be a non-negative safe integer";
  return undefined;
}

function recordDetails(record: Subagent, agentId: string): QuerySessionDetails {
  return {
    outcome: "read_error",
    agentId,
    runId: record.runId,
    mode: record.mode,
    status: record.status,
    terminalReason: record.stateTerminalReason,
    model: record.modelLabel,
    thinkingLevel: record.effectiveThinkingLevel,
    activeRuntimeMs: record.activeRuntimeMs,
    activity: describeActivity(record.activeTools, record.responseText),
  };
}

function summaryLine(details: QuerySessionDetails): string {
  const model = details.model && details.thinkingLevel ? ` · ${formatModelThinking(details.model, details.thinkingLevel)}` : "";
  const status = details.status ? ` · ${details.status}` : "";
  const activity = details.activity ? ` · ${details.activity}` : "";
  return `Agent ${details.agentId} run=${details.runId ?? "?"}${status}${model} · ${formatMs(details.activeRuntimeMs ?? 0)}${activity}`;
}

function sourceIsMissingFile(record: Subagent, error: unknown): boolean {
  return !record.isSessionReady() && (error as { code?: unknown } | undefined)?.code === "ENOENT";
}

function formatEntries(
  entries: readonly SessionQueryEntry[],
  maxBytes = MAX_QUERY_ENTRY_BYTES,
  maxLines = MAX_QUERY_ENTRY_LINES,
): {
  entries: SessionQueryEntry[];
  lines: string[];
  omittedCount: number;
} {
  const selected: SessionQueryEntry[] = [];
  const lines: string[] = [];
  let bytes = 0;
  let lineTotal = 0;
  for (const entry of entries) {
    const line = formatEntry(entry);
    const addition = selected.length === 0 ? line : `\n${line}`;
    const additionBytes = utf8ByteLength(addition);
    const additionLines = lineCount(addition);
    if (bytes + additionBytes > maxBytes || lineTotal + additionLines > maxLines) {
      // A newline-dense first entry can exceed the line budget even though its
      // projection is character-bounded. Compact only this fallback
      // representation so a real match can always make progress; later pages
      // still use the normal output bounds and the returned count remains exact.
      if (selected.length === 0) {
        const compactLine = formatEntry(entry, true);
        const compactAddition = compactLine;
        const compactBytes = utf8ByteLength(compactAddition);
        const compactLines = lineCount(compactAddition);
        if (compactBytes <= maxBytes && compactLines <= maxLines) {
          selected.push(entry);
          lines.push(compactLine);
          bytes = compactBytes;
          lineTotal = compactLines;
        }
      }
      break;
    }
    selected.push(entry);
    lines.push(line);
    bytes += additionBytes;
    lineTotal += additionLines;
  }
  return { entries: selected, lines, omittedCount: entries.length - selected.length };
}

function formatEntry(entry: SessionQueryEntry, compact = false): string {
  const display = (value: string): string => compact ? compactLineBreaks(value) : value;
  const match = entry.match === undefined
    ? ""
    : ` · match=${entry.match.field} [${entry.match.sourceRange.start},${entry.match.sourceRange.end})`;
  if (entry.kind === "message") {
    return `[${entry.role}] ${entry.id}${match}\n${display(entry.text)}`;
  }
  const callIdentity = entry.toolCallId ?? entry.id;
  const result = entry.result === undefined ? "" : `\nresult: ${display(entry.result)}`;
  return `[tool ${display(entry.toolName)} · ${entry.state}] id=${display(callIdentity)}${match}\narguments: ${display(entry.arguments)}${result}`;
}

function compactLineBreaks(value: string): string {
  return value.replace(/\r\n|\r|\n/g, " ");
}

function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

/** Count lines conservatively, including the empty line after a trailing newline. */
function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r\n|\r|\n/).length;
}

/** Keep metadata single-line and bounded; full paths remain available in details. */
function boundedOutputLine(value: string, maxBytes: number): string {
  const singleLine = value.replace(/\r\n|\r|\n/g, " ");
  if (utf8ByteLength(singleLine) <= maxBytes) return singleLine;
  const ellipsis = "…";
  const budget = Math.max(0, maxBytes - utf8ByteLength(ellipsis));
  let output = "";
  let bytes = 0;
  for (const character of singleLine) {
    const characterBytes = utf8ByteLength(character);
    if (bytes + characterBytes > budget) break;
    output += character;
    bytes += characterBytes;
  }
  return `${output}${ellipsis}`;
}

function omissionTail(
  omittedBefore: number,
  omittedAfter: number,
  outputOmitted: number,
  nextOffset: number | undefined,
  previousOffset: number | undefined,
  transcriptPath: string | undefined,
): string {
  const lines: string[] = [];
  if (omittedBefore > 0) lines.push(`${omittedBefore} matching entr${omittedBefore === 1 ? "y precedes" : "ies precede"} this page.`);
  if (omittedAfter > 0) lines.push(`${omittedAfter} matching entr${omittedAfter === 1 ? "y remains" : "ies remain"} after this page.`);
  if (outputOmitted > 0) lines.push(`${outputOmitted} entries from this page were omitted by the output bounds.`);
  if (nextOffset !== undefined) lines.push(`More matches available; repeat with offset: ${nextOffset}.`);
  if (previousOffset !== undefined) lines.push(`Previous page available; repeat with offset: ${previousOffset}.`);
  if (transcriptPath && outputOmitted > 0) {
    lines.push(`Full transcript: ${boundedOutputLine(transcriptPath, MAX_QUERY_TRANSCRIPT_PATH_BYTES)}`);
  }
  return lines.length === 0 ? "" : `\n\n${lines.join("\n")}`;
}
