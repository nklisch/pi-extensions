import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  CAPTURED_OUTCOME_LABELS,
  type CorpusRecord,
  REPLAY_STATUSES,
} from "../../replay/corpus-model.ts";
import {
  type CommandFamilySummary,
  type CorpusQuery,
  type CorpusQuerySummary,
  queryCorpus,
} from "../../replay/corpus-query.ts";
import type { CorpusFidelity, CorpusSource } from "../../replay/history.ts";
import type { RatchetToolDefinition } from "../ratchet-mode.ts";
import { buildRatchetCorpusModel, resolveRatchetPolicy } from "./analysis.ts";
import { RATCHET_TOOL_IDS } from "./ids.ts";
import { formatRatchetToolError, formatRatchetToolResult } from "./result.ts";
import type { RatchetToolDependencies } from "./types.ts";

const STRICT = { additionalProperties: false } as const;

const CORPUS_SOURCES = [
  "session",
  "audit",
  "corpus",
] as const satisfies readonly CorpusSource[];

const CORPUS_FIDELITY = [
  "high",
  "redacted",
] as const satisfies readonly CorpusFidelity[];

const ORDER_BY_VALUES = [
  "friction",
  "timestamp",
  "command",
  "family",
] as const satisfies readonly NonNullable<CorpusQuery["orderBy"]>[];

export const AutoReviewerListHistoryFamiliesParameters = Type.Object(
  {
    toolNames: Type.Optional(
      Type.Array(
        Type.String({ description: "Tool names to include, such as bash." }),
      ),
    ),
    familyIds: Type.Optional(
      Type.Array(
        Type.String({ description: "Command family ids to include." }),
      ),
    ),
    replayStatuses: Type.Optional(
      Type.Array(
        Type.String({
          description: "Replay status filters: fast_path, review, hard_block.",
        }),
      ),
    ),
    capturedOutcomeLabels: Type.Optional(
      Type.Array(
        Type.String({ description: "Captured runtime outcome labels." }),
      ),
    ),
    sources: Type.Optional(
      Type.Array(
        Type.String({
          description: "Corpus source filters: session, audit, corpus.",
        }),
      ),
    ),
    fidelity: Type.Optional(
      Type.Array(
        Type.String({
          description: "Evidence fidelity filters: high, redacted.",
        }),
      ),
    ),
    redacted: Type.Optional(
      Type.Boolean({ description: "Filter redacted or non-redacted records." }),
    ),
    hasModelReview: Type.Optional(
      Type.Boolean({
        description: "Filter records with model-review evidence.",
      }),
    ),
    hasCapturedDenial: Type.Optional(
      Type.Boolean({
        description: "Filter records with captured denial evidence.",
      }),
    ),
    hasParserDiagnostics: Type.Optional(
      Type.Boolean({ description: "Filter records with parser diagnostics." }),
    ),
    hasSubstitution: Type.Optional(
      Type.Boolean({
        description: "Filter records containing shell substitution.",
      }),
    ),
    hasStdoutRedirect: Type.Optional(
      Type.Boolean({
        description: "Filter records containing stdout redirects.",
      }),
    ),
    orderBy: Type.Optional(
      Type.String({
        description: "Sort by friction, timestamp, command, or family.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 0, maximum: 200, description: "Page size." }),
    ),
    offset: Type.Optional(
      Type.Integer({ minimum: 0, description: "Zero-based page offset." }),
    ),
  },
  STRICT,
);

export interface AutoReviewerListHistoryFamiliesDetails {
  readonly summary: CorpusQuerySummary;
  readonly families: readonly CommandFamilySummary[];
  readonly records: readonly CorpusRecord[];
  readonly page: {
    readonly offset: number;
    readonly limit: number;
    readonly total: number;
  };
  readonly warnings: readonly string[];
}

interface ParsedHistoryParameters {
  readonly query: CorpusQuery;
  readonly warnings: readonly string[];
}

type MutableCorpusQuery = {
  -readonly [Key in keyof CorpusQuery]?: CorpusQuery[Key];
};

export function createAutoReviewerListHistoryFamiliesTool(
  deps: RatchetToolDependencies,
): RatchetToolDefinition {
  return {
    name: RATCHET_TOOL_IDS.listHistoryFamilies,
    label: "List History Families",
    description:
      "Query captured Pi tool-call history by structured command family, replay status, captured outcome, source, fidelity, and pagination.",
    promptSnippet:
      "Query structured ratchet history by family, replay status, outcome, and evidence quality.",
    promptGuidelines: [
      "Use clearance_list_history_families to inspect structured command history before reading raw logs or generating proposals.",
    ],
    parameters: AutoReviewerListHistoryFamiliesParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const parsed = parseHistoryParameters(params);
        const policy = await resolveRatchetPolicy(ctx, deps);
        const model = await buildRatchetCorpusModel(ctx, policy);
        const result = queryCorpus(model, parsed.query);
        const details: AutoReviewerListHistoryFamiliesDetails = {
          summary: result.summary,
          families: result.families,
          records: result.records,
          page: result.page,
          warnings: stableUnique([...parsed.warnings, ...result.warnings]),
        };

        return formatRatchetToolResult(
          details,
          formatHistoryFamiliesMarkdown(details, parsed.query),
        ) as unknown as AgentToolResult<AutoReviewerListHistoryFamiliesDetails>;
      } catch (error: unknown) {
        return formatRatchetToolError(
          RATCHET_TOOL_IDS.listHistoryFamilies,
          error,
        ) as unknown as AgentToolResult<AutoReviewerListHistoryFamiliesDetails>;
      }
    },
  };
}

function parseHistoryParameters(params: unknown): ParsedHistoryParameters {
  const record = asRecord(params);
  const warnings: string[] = [];
  const query: MutableCorpusQuery = {};

  const toolNames = readStringList(record, "toolNames", warnings);
  if (toolNames !== undefined && toolNames.length > 0) {
    query.toolNames = toolNames;
  }

  const familyIds = readStringList(record, "familyIds", warnings);
  if (familyIds !== undefined && familyIds.length > 0) {
    query.familyIds = familyIds;
  }

  const replayStatuses = readEnumList(
    record,
    "replayStatuses",
    REPLAY_STATUSES,
    warnings,
  );
  if (replayStatuses !== undefined && replayStatuses.length > 0) {
    query.replayStatuses = replayStatuses;
  }

  const capturedOutcomeLabels = readEnumList(
    record,
    "capturedOutcomeLabels",
    CAPTURED_OUTCOME_LABELS,
    warnings,
  );
  if (capturedOutcomeLabels !== undefined && capturedOutcomeLabels.length > 0) {
    query.capturedOutcomeLabels = capturedOutcomeLabels;
  }

  const sources = readEnumList(record, "sources", CORPUS_SOURCES, warnings);
  if (sources !== undefined && sources.length > 0) {
    query.sources = sources;
  }

  const fidelity = readEnumList(record, "fidelity", CORPUS_FIDELITY, warnings);
  if (fidelity !== undefined && fidelity.length > 0) {
    query.fidelity = fidelity;
  }

  setBooleanQuery(record, "redacted", warnings, query);
  setBooleanQuery(record, "hasModelReview", warnings, query);
  setBooleanQuery(record, "hasCapturedDenial", warnings, query);
  setBooleanQuery(record, "hasParserDiagnostics", warnings, query);
  setBooleanQuery(record, "hasSubstitution", warnings, query);
  setBooleanQuery(record, "hasStdoutRedirect", warnings, query);

  const orderBy = readOrderBy(record, warnings);
  if (orderBy !== undefined) {
    query.orderBy = orderBy;
  }

  const limit = readInteger(record, "limit", { min: 0, max: 200 }, warnings);
  if (limit !== undefined) {
    query.limit = limit;
  }

  const offset = readInteger(record, "offset", { min: 0 }, warnings);
  if (offset !== undefined) {
    query.offset = offset;
  }

  return { query, warnings };
}

function asRecord(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function readStringList(
  record: Record<string, unknown>,
  key: string,
  warnings: string[],
): readonly string[] | undefined {
  if (!hasOwn(record, key)) {
    return undefined;
  }

  const value = record[key];
  if (!Array.isArray(value)) {
    warnings.push(
      `Ignoring ${key} filter because it must be an array of strings.`,
    );
    return undefined;
  }

  const strings: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item === "string") {
      strings.push(item);
      continue;
    }

    warnings.push(`Ignoring ${key}[${index}] because it must be a string.`);
  }

  return stableUnique(strings);
}

function readEnumList<TValue extends string>(
  record: Record<string, unknown>,
  key: string,
  validValues: readonly TValue[],
  warnings: string[],
): readonly TValue[] | undefined {
  const strings = readStringList(record, key, warnings);
  if (strings === undefined) {
    return undefined;
  }

  const validSet = new Set<string>(validValues);
  const result: TValue[] = [];
  for (const value of strings) {
    if (validSet.has(value)) {
      result.push(value as TValue);
      continue;
    }

    warnings.push(
      `Ignoring invalid ${key} filter ${JSON.stringify(value)}. Expected one of: ${validValues.join(", ")}.`,
    );
  }

  return stableUnique(result);
}

function setBooleanQuery(
  record: Record<string, unknown>,
  key: keyof Pick<
    CorpusQuery,
    | "redacted"
    | "hasModelReview"
    | "hasCapturedDenial"
    | "hasParserDiagnostics"
    | "hasSubstitution"
    | "hasStdoutRedirect"
  >,
  warnings: string[],
  query: MutableCorpusQuery,
): void {
  if (!hasOwn(record, key)) {
    return;
  }

  const value = record[key];
  if (typeof value === "boolean") {
    query[key] = value;
    return;
  }

  warnings.push(`Ignoring ${key} filter because it must be a boolean.`);
}

function readOrderBy(
  record: Record<string, unknown>,
  warnings: string[],
): CorpusQuery["orderBy"] | undefined {
  if (!hasOwn(record, "orderBy")) {
    return undefined;
  }

  const value = record.orderBy;
  if (typeof value !== "string") {
    warnings.push("Ignoring orderBy because it must be a string.");
    return undefined;
  }

  if ((ORDER_BY_VALUES as readonly string[]).includes(value)) {
    return value as CorpusQuery["orderBy"];
  }

  warnings.push(
    `Ignoring invalid orderBy ${JSON.stringify(value)}. Expected one of: ${ORDER_BY_VALUES.join(", ")}.`,
  );
  return undefined;
}

function readInteger(
  record: Record<string, unknown>,
  key: "limit" | "offset",
  bounds: { readonly min: number; readonly max?: number },
  warnings: string[],
): number | undefined {
  if (!hasOwn(record, key)) {
    return undefined;
  }

  const value = record[key];
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= bounds.min &&
    (bounds.max === undefined || value <= bounds.max)
  ) {
    return value;
  }

  const maxSuffix = bounds.max === undefined ? "" : ` and <= ${bounds.max}`;
  warnings.push(
    `Ignoring ${key} because it must be an integer >= ${bounds.min}${maxSuffix}.`,
  );
  return undefined;
}

function formatHistoryFamiliesMarkdown(
  details: AutoReviewerListHistoryFamiliesDetails,
  query: CorpusQuery,
): string {
  const lines = [
    "# Clearance history families",
    "",
    `- Matching records: ${details.summary.totalRecords}`,
    `- Page: offset=${details.page.offset}, limit=${details.page.limit}, total=${details.page.total}`,
    `- Families: ${details.families.length}`,
    `- Records returned: ${details.records.length}`,
    `- Warnings: ${details.warnings.length}`,
    `- Filters: ${formatFilterSummary(query)}`,
  ];

  const topFamilies = details.families.slice(0, 5);
  if (topFamilies.length > 0) {
    lines.push("", "## Top families");
    for (const family of topFamilies) {
      lines.push(
        `- \`${family.family.id}\`: ${family.calls} calls, ${family.uniqueCommands} unique; replay ${formatCounts(family.replayStatusCounts)}`,
      );
    }
  }

  return lines.join("\n");
}

function formatFilterSummary(query: CorpusQuery): string {
  const parts: string[] = [];
  appendListFilter(parts, "toolNames", query.toolNames);
  appendListFilter(parts, "familyIds", query.familyIds);
  appendListFilter(parts, "replayStatuses", query.replayStatuses);
  appendListFilter(parts, "capturedOutcomeLabels", query.capturedOutcomeLabels);
  appendListFilter(parts, "sources", query.sources);
  appendListFilter(parts, "fidelity", query.fidelity);
  appendBooleanFilter(parts, "redacted", query.redacted);
  appendBooleanFilter(parts, "hasModelReview", query.hasModelReview);
  appendBooleanFilter(parts, "hasCapturedDenial", query.hasCapturedDenial);
  appendBooleanFilter(
    parts,
    "hasParserDiagnostics",
    query.hasParserDiagnostics,
  );
  appendBooleanFilter(parts, "hasSubstitution", query.hasSubstitution);
  appendBooleanFilter(parts, "hasStdoutRedirect", query.hasStdoutRedirect);
  if (query.orderBy !== undefined) {
    parts.push(`orderBy=${query.orderBy}`);
  }
  if (query.limit !== undefined) {
    parts.push(`limit=${query.limit}`);
  }
  if (query.offset !== undefined) {
    parts.push(`offset=${query.offset}`);
  }

  return parts.length === 0 ? "none" : parts.join(", ");
}

function appendListFilter(
  parts: string[],
  label: string,
  values: readonly string[] | undefined,
): void {
  if (values !== undefined) {
    parts.push(`${label}=[${values.join("|")}]`);
  }
}

function appendBooleanFilter(
  parts: string[],
  label: string,
  value: boolean | undefined,
): void {
  if (value !== undefined) {
    parts.push(`${label}=${value}`);
  }
}

function formatCounts(
  counts: readonly { readonly label: string; readonly calls: number }[],
): string {
  return counts.length === 0
    ? "none"
    : counts.map((entry) => `${entry.label}:${entry.calls}`).join(", ");
}

function stableUnique<TValue>(values: readonly TValue[]): readonly TValue[] {
  const seen = new Set<TValue>();
  const result: TValue[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}
