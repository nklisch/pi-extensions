/**
 * Corpus query model — the structured, JSON-compatible surface ratchet-mode tools
 * read instead of re-enumerating outcome labels or scraping markdown reports.
 *
 * This module is the query and filtering layer over the native replay model.
 * Corpus acquisition remains in TypeScript; parsing, policy evaluation, record
 * construction, family derivation, and aggregate math run in Rust.
 *
 * Safety boundary: captured commands are analyzed and evaluated, never executed.
 * The native kernel never reads files, calls a model, spawns a shell, or mutates
 * config. Parser and unknown-tool uncertainty remain queryable records.
 *
 * JSON contract: every summary is an array of `{ label, calls, uniqueCommands? }`
 * (see `corpus-model.ts`), never a `Map`, so `JSON.stringify(model)` works without
 * custom Map handling and Pi ratchet tools can return the model directly.
 */
import type { PathFactsResolvedConfig } from "../parse/native-path-facts.ts";
import type { DecisionEffect, EffectivePolicy } from "../policy/core.ts";
import type {
  CapturedOutcomeLabel,
  CommandFamilyKey,
  CorpusRecord,
  CountByLabel,
  ReplayStatus,
} from "./corpus-model.ts";
import {
  CAPTURED_OUTCOME_LABELS,
  countByLabel,
  REPLAY_STATUSES,
} from "./corpus-model.ts";
import type { CorpusFidelity, CorpusSource, ReplayCorpus } from "./history.ts";
import {
  buildNativeCorpusModel,
  type NativeReplayKernelOptions,
} from "./native-kernels.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CorpusQueryBuildOptions {
  /** Native compiled policy handle, supplied by the cached runtime policy when available. */
  readonly nativePolicy?: import("../policy/core.ts").NativePolicyHandle;
  /** Replayed effect for non-bash records; defaults to review-as-safe-uncertainty. */
  readonly unknownToolPosture?: DecisionEffect;
  /**
   * Retain the full `ToolShape` on each record's `ParsedEvidence` and bypass the
   * argument/flag preview cap in its summary. Default `false` keeps the model lean
   * (summary only); proposal-validation callers pass `true` to keep the full shape.
   * The full shape is ALWAYS retained internally during the build so `decide()` can
   * run; this flag only controls what lands on the returned record.
   */
  readonly includeFullShape?: boolean;
  /**
   * Resolved path-fact context. When supplied, each parsed bash shape is enriched
   * with path facts (via `enrichToolShapeWithPathFacts`) before `decide()`, mirroring
   * the runtime handler so path-scoped matchers see the same `shape.pathFacts` they
   * would at decision time. The derived `pathFacts` envelope is also stamped on the
   * record's `ParsedEvidence` so downstream comparison can count unknown-path records
   * without depending on `includeFullShape`. Enrichment is applied per-build (after
   * retrieving the parser-only shape from the shared parse cache), so distinct
   * baseline/candidate contexts do not invalidate the cache — parsing is
   * context-free. Omit for parser-only replay (path-scoped allows fail closed).
   */
  readonly pathFacts?: PathFactsResolvedConfig;
}

export interface CommandFamilySummaryOptions {
  /** Cap for `sampleRecordIds` and distinct `sampleCommands`. Default 5. */
  readonly sampleLimit?: number;
}

export interface CommandFamilySummary {
  readonly family: CommandFamilyKey;
  readonly calls: number;
  readonly uniqueCommands: number;
  readonly replayStatusCounts: readonly CountByLabel<ReplayStatus>[];
  readonly capturedOutcomeCounts: readonly CountByLabel<CapturedOutcomeLabel>[];
  readonly modelReviewCalls: number;
  readonly capturedDenialCalls: number;
  readonly lowFidelityCalls: number;
  readonly redactedCalls: number;
  readonly sources: readonly CorpusSource[];
  readonly sampleRecordIds: readonly string[];
  readonly sampleCommands: readonly string[];
}

export interface CorpusQuerySummary {
  readonly totalRecords: number;
  readonly totalUniqueCommands: number;
  readonly replayStatusCounts: readonly CountByLabel<ReplayStatus>[];
  readonly capturedOutcomeCounts: readonly CountByLabel<CapturedOutcomeLabel>[];
  readonly sourceCounts: readonly CountByLabel<CorpusSource>[];
  readonly modelReviewLoad: {
    readonly calls: number;
    readonly uniqueCommands: number;
  };
  readonly lowFidelityCalls: number;
  readonly redactedCalls: number;
  readonly unmatchedAuditEntries: number;
}

export interface CorpusQueryModel {
  readonly records: readonly CorpusRecord[];
  readonly families: readonly CommandFamilySummary[];
  readonly summary: CorpusQuerySummary;
  readonly warnings: readonly string[];
}

export interface CorpusQuery {
  readonly toolNames?: readonly string[];
  readonly familyIds?: readonly string[];
  readonly replayStatuses?: readonly ReplayStatus[];
  readonly capturedOutcomeLabels?: readonly CapturedOutcomeLabel[];
  /** Match a record's PRIMARY source (`record.source.source`). */
  readonly sources?: readonly CorpusSource[];
  readonly fidelity?: readonly CorpusFidelity[];
  readonly redacted?: boolean;
  readonly hasModelReview?: boolean;
  readonly hasCapturedDenial?: boolean;
  readonly hasParserDiagnostics?: boolean;
  readonly hasSubstitution?: boolean;
  readonly hasStdoutRedirect?: boolean;
  readonly orderBy?: "friction" | "timestamp" | "command" | "family";
  readonly limit?: number;
  readonly offset?: number;
}

export interface CorpusQueryResult {
  readonly records: readonly CorpusRecord[];
  /** Families over the FILTERED set, pre-pagination. */
  readonly families: readonly CommandFamilySummary[];
  /** Summary over the FILTERED set, pre-pagination. */
  readonly summary: CorpusQuerySummary;
  readonly page: {
    readonly offset: number;
    readonly limit: number;
    readonly total: number;
  };
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// Build option defaults + outcome label sets
// ---------------------------------------------------------------------------

const CORPUS_SOURCES = [
  "session",
  "audit",
  "corpus",
] as const satisfies readonly CorpusSource[];

/** Captured outcomes that originated from a model auto-review (runtime evidence). */
const MODEL_OUTCOME_LABELS: ReadonlySet<CapturedOutcomeLabel> = new Set([
  "model-allow",
  "model-deny",
  "model-review",
]);

/** Captured outcomes that represent a historical denial (review-load signal). */
const DENIAL_OUTCOME_LABELS: ReadonlySet<CapturedOutcomeLabel> = new Set([
  "deterministic-deny",
  "model-deny",
  "human-deny",
  "block-and-log",
  "fixture-hard-block",
]);

const DEFAULT_SAMPLE_LIMIT = 5;

// ---------------------------------------------------------------------------
// buildCorpusQueryModel
// ---------------------------------------------------------------------------

/**
 * Build the structured query model from a replay corpus and effective policy.
 *
 * The native kernel parses each unique bash command once, analyzes typed tools,
 * enriches path facts, evaluates the compiled policy, and emits one record per
 * corpus occurrence. Malformed or empty corpus input yields an empty model plus
 * warnings rather than throwing.
 */
export async function buildCorpusQueryModel(
  corpus: ReplayCorpus,
  policy: EffectivePolicy,
  options?: CorpusQueryBuildOptions,
): Promise<CorpusQueryModel> {
  return buildNativeCorpusModel({
    corpus,
    policy,
    ...(options?.nativePolicy === undefined
      ? {}
      : { nativePolicy: options.nativePolicy }),
    options: nativeBuildOptions(options),
  });
}

function nativeBuildOptions(
  options: CorpusQueryBuildOptions | undefined,
): NativeReplayKernelOptions {
  return {
    ...(options?.unknownToolPosture === undefined
      ? {}
      : { unknownToolPosture: options.unknownToolPosture }),
    ...(options?.includeFullShape === undefined
      ? {}
      : { includeFullShape: options.includeFullShape }),
    ...(options?.pathFacts === undefined
      ? {}
      : { pathFacts: options.pathFacts }),
  };
}

// ---------------------------------------------------------------------------
// summarizeCommandFamilies + getFamily
// ---------------------------------------------------------------------------

/**
 * Group records into command-family summaries. Includes ALL families (clean ones
 * too), sorted by friction (review + hard-block + model-review + captured-denial
 * calls) desc, then calls desc, then family id asc. Pure: never mutates records.
 *
 * `sampleLimit` caps `sampleRecordIds` and `sampleCommands` (distinct commands).
 */
export function summarizeCommandFamilies(
  records: readonly CorpusRecord[],
  options?: CommandFamilySummaryOptions,
): readonly CommandFamilySummary[] {
  const sampleLimit =
    typeof options?.sampleLimit === "number" && options.sampleLimit >= 0
      ? Math.floor(options.sampleLimit)
      : DEFAULT_SAMPLE_LIMIT;

  const groups = new Map<string, CorpusRecord[]>();
  for (const record of records) {
    const group = groups.get(record.family.id);
    if (group === undefined) {
      groups.set(record.family.id, [record]);
    } else {
      group.push(record);
    }
  }

  return [...groups.values()]
    .map((group) => familySummaryFor(group, sampleLimit))
    .sort(compareFamilySummaries);
}

function familySummaryFor(
  records: readonly CorpusRecord[],
  sampleLimit: number,
): CommandFamilySummary {
  const first = records[0];
  if (first === undefined) {
    // A family group always has at least one record; guard for type safety only.
    throw new Error("familySummaryFor requires a non-empty record group");
  }

  const family = first.family;
  const statuses: ReplayStatus[] = [];
  const capturedLabels: CapturedOutcomeLabel[] = [];
  const commands = new Set<string>();
  const sourcesSeen = new Set<CorpusSource>();
  let modelReviewCalls = 0;
  let capturedDenialCalls = 0;
  let lowFidelityCalls = 0;
  let redactedCalls = 0;
  const sampleRecordIds: string[] = [];
  const sampleCommandsSeen = new Set<string>();
  const sampleCommands: string[] = [];

  for (const record of records) {
    statuses.push(record.replayed.status);
    capturedLabels.push(record.captured.label);
    commands.add(record.command);
    sourcesSeen.add(record.source.source);
    if (isModelReviewLabel(record.captured.label)) {
      modelReviewCalls += 1;
    }
    if (isDenialLabel(record.captured.label)) {
      capturedDenialCalls += 1;
    }
    if (record.source.lowFidelityReasons.length > 0) {
      lowFidelityCalls += 1;
    }
    if (record.source.redacted) {
      redactedCalls += 1;
    }
    if (sampleRecordIds.length < sampleLimit) {
      sampleRecordIds.push(record.id);
    }
    if (
      sampleCommands.length < sampleLimit &&
      !sampleCommandsSeen.has(record.command)
    ) {
      sampleCommandsSeen.add(record.command);
      sampleCommands.push(record.command);
    }
  }

  return {
    family,
    calls: records.length,
    uniqueCommands: commands.size,
    replayStatusCounts: countByLabel(REPLAY_STATUSES, statuses),
    capturedOutcomeCounts: countByLabel(
      CAPTURED_OUTCOME_LABELS,
      capturedLabels,
    ),
    modelReviewCalls,
    capturedDenialCalls,
    lowFidelityCalls,
    redactedCalls,
    sources: CORPUS_SOURCES.filter((source) => sourcesSeen.has(source)),
    sampleRecordIds,
    sampleCommands,
  };
}

function compareFamilySummaries(
  left: CommandFamilySummary,
  right: CommandFamilySummary,
): number {
  return (
    familyFrictionScore(right) - familyFrictionScore(left) ||
    right.calls - left.calls ||
    right.uniqueCommands - left.uniqueCommands ||
    left.family.id.localeCompare(right.family.id)
  );
}

function familyFrictionScore(summary: CommandFamilySummary): number {
  return (
    summary.modelReviewCalls +
    summary.capturedDenialCalls +
    countOf(summary.replayStatusCounts, "review") +
    countOf(summary.replayStatusCounts, "hard_block")
  );
}

function countOf<TLabel extends string>(
  counts: readonly CountByLabel<TLabel>[],
  label: TLabel,
): number {
  for (const entry of counts) {
    if (entry.label === label) {
      return entry.calls;
    }
  }
  return 0;
}

/** Look up a family summary by family id. */
export function getFamily(
  model: CorpusQueryModel,
  familyId: string,
): CommandFamilySummary | undefined {
  return model.families.find((summary) => summary.family.id === familyId);
}

// ---------------------------------------------------------------------------
// queryCorpus
// ---------------------------------------------------------------------------

/**
 * Pure query over a built model. Filters by facets, sorts, paginates, and returns
 * records plus families/summary over the FILTERED set (pre-pagination) and a page
 * descriptor. Never mutates `model`. `orderBy` undefined preserves build order.
 */
export function queryCorpus(
  model: CorpusQueryModel,
  query?: CorpusQuery,
): CorpusQueryResult {
  const filtered = filterRecords(model.records, query);
  const ordered = sortRecords(filtered, query?.orderBy);
  const total = ordered.length;
  const offset = clampOffset(query?.offset);
  const limit = resolveLimit(query?.limit);
  const sliced =
    limit === undefined
      ? ordered.slice(offset)
      : ordered.slice(offset, offset + limit);

  return {
    records: sliced,
    families: summarizeCommandFamilies(ordered),
    summary: summarizeModel(ordered, model.summary.unmatchedAuditEntries),
    page: { offset, limit: limit ?? total, total },
    warnings: model.warnings,
  };
}

function filterRecords(
  records: readonly CorpusRecord[],
  query: CorpusQuery | undefined,
): CorpusRecord[] {
  if (query === undefined) {
    return [...records];
  }
  return records.filter((record) => matchesQuery(record, query));
}

function matchesQuery(record: CorpusRecord, query: CorpusQuery): boolean {
  if (
    query.toolNames !== undefined &&
    !query.toolNames.includes(record.toolName)
  ) {
    return false;
  }
  if (
    query.familyIds !== undefined &&
    !query.familyIds.includes(record.family.id)
  ) {
    return false;
  }
  if (
    query.replayStatuses !== undefined &&
    !query.replayStatuses.includes(record.replayed.status)
  ) {
    return false;
  }
  if (
    query.capturedOutcomeLabels !== undefined &&
    !query.capturedOutcomeLabels.includes(record.captured.label)
  ) {
    return false;
  }
  if (
    query.sources !== undefined &&
    !query.sources.includes(record.source.source)
  ) {
    return false;
  }
  if (
    query.fidelity !== undefined &&
    !query.fidelity.includes(record.source.fidelity)
  ) {
    return false;
  }
  if (
    query.redacted !== undefined &&
    record.source.redacted !== query.redacted
  ) {
    return false;
  }
  if (
    query.hasModelReview !== undefined &&
    isModelReviewLabel(record.captured.label) !== query.hasModelReview
  ) {
    return false;
  }
  if (
    query.hasCapturedDenial !== undefined &&
    isDenialLabel(record.captured.label) !== query.hasCapturedDenial
  ) {
    return false;
  }
  if (
    query.hasParserDiagnostics !== undefined &&
    hasParserDiagnostics(record) !== query.hasParserDiagnostics
  ) {
    return false;
  }
  if (
    query.hasSubstitution !== undefined &&
    record.parsed.summary.hasSubstitution !== query.hasSubstitution
  ) {
    return false;
  }
  if (
    query.hasStdoutRedirect !== undefined &&
    record.parsed.summary.hasStdoutRedirect !== query.hasStdoutRedirect
  ) {
    return false;
  }
  return true;
}

/** A record has parser diagnostics when its bash shape emitted diagnostics OR the
 *  parser threw (parser-error family). Unknown-tool metadata does not count. */
function hasParserDiagnostics(record: CorpusRecord): boolean {
  const summary = record.parsed.summary;
  return (
    summary.diagnosticCodes.length > 0 || summary.toolKind === "parser-error"
  );
}

function sortRecords(
  records: readonly CorpusRecord[],
  orderBy: CorpusQuery["orderBy"],
): CorpusRecord[] {
  const sorted = [...records];
  switch (orderBy) {
    case "friction":
      sorted.sort(compareRecordFriction);
      break;
    case "timestamp":
      sorted.sort(compareRecordTimestamp);
      break;
    case "command":
      sorted.sort(compareRecordCommand);
      break;
    case "family":
      sorted.sort(compareRecordFamily);
      break;
    case undefined:
      break; // preserve build order
  }
  return sorted;
}

function compareRecordFriction(
  left: CorpusRecord,
  right: CorpusRecord,
): number {
  return (
    recordFrictionScore(right) - recordFrictionScore(left) ||
    left.command.localeCompare(right.command) ||
    left.id.localeCompare(right.id)
  );
}

function recordFrictionScore(record: CorpusRecord): number {
  let score = 0;
  if (record.replayed.status === "hard_block") {
    score += 4;
  } else if (record.replayed.status === "review") {
    score += 2;
  }
  if (isDenialLabel(record.captured.label)) {
    score += 3;
  }
  if (isModelReviewLabel(record.captured.label)) {
    score += 1;
  }
  return score;
}

/** Ascending by timestamp; records without a timestamp sort last. Stable via id. */
function compareRecordTimestamp(
  left: CorpusRecord,
  right: CorpusRecord,
): number {
  const leftMissing = left.identity.timestamp === undefined ? 1 : 0;
  const rightMissing = right.identity.timestamp === undefined ? 1 : 0;
  return (
    leftMissing - rightMissing ||
    (left.identity.timestamp ?? "").localeCompare(
      right.identity.timestamp ?? "",
    ) ||
    left.id.localeCompare(right.id)
  );
}

function compareRecordCommand(left: CorpusRecord, right: CorpusRecord): number {
  return (
    left.command.localeCompare(right.command) || left.id.localeCompare(right.id)
  );
}

function compareRecordFamily(left: CorpusRecord, right: CorpusRecord): number {
  return (
    left.family.id.localeCompare(right.family.id) ||
    left.command.localeCompare(right.command) ||
    left.id.localeCompare(right.id)
  );
}

function clampOffset(offset: number | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) {
    return 0;
  }
  return Math.floor(offset);
}

/** A finite non-negative limit; anything else means "no limit" (return all). */
function resolveLimit(limit: number | undefined): number | undefined {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
    return undefined;
  }
  return Math.floor(limit);
}

// ---------------------------------------------------------------------------
// summarizeModel (CorpusQuerySummary)
// ---------------------------------------------------------------------------

function summarizeModel(
  records: readonly CorpusRecord[],
  unmatchedAuditEntries: number,
): CorpusQuerySummary {
  const statuses: ReplayStatus[] = [];
  const capturedLabels: CapturedOutcomeLabel[] = [];
  const sources: CorpusSource[] = [];
  const uniqueCommands = new Set<string>();
  const modelReviewCommands = new Set<string>();
  let modelReviewCalls = 0;
  let lowFidelityCalls = 0;
  let redactedCalls = 0;

  for (const record of records) {
    statuses.push(record.replayed.status);
    capturedLabels.push(record.captured.label);
    sources.push(record.source.source);
    uniqueCommands.add(record.command);
    if (isModelReviewLabel(record.captured.label)) {
      modelReviewCalls += 1;
      modelReviewCommands.add(record.command);
    }
    if (record.source.lowFidelityReasons.length > 0) {
      lowFidelityCalls += 1;
    }
    if (record.source.redacted) {
      redactedCalls += 1;
    }
  }

  return {
    totalRecords: records.length,
    totalUniqueCommands: uniqueCommands.size,
    replayStatusCounts: countByLabel(REPLAY_STATUSES, statuses),
    capturedOutcomeCounts: countByLabel(
      CAPTURED_OUTCOME_LABELS,
      capturedLabels,
    ),
    sourceCounts: countByLabel(CORPUS_SOURCES, sources),
    modelReviewLoad: {
      calls: modelReviewCalls,
      uniqueCommands: modelReviewCommands.size,
    },
    lowFidelityCalls,
    redactedCalls,
    unmatchedAuditEntries,
  };
}

// ---------------------------------------------------------------------------
// Outcome label predicates
// ---------------------------------------------------------------------------

function isModelReviewLabel(label: CapturedOutcomeLabel): boolean {
  return MODEL_OUTCOME_LABELS.has(label);
}

function isDenialLabel(label: CapturedOutcomeLabel): boolean {
  return DENIAL_OUTCOME_LABELS.has(label);
}
