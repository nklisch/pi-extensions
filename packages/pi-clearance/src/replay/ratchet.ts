// Re-export the moved classifier/status surface so existing imports from
// ratchet.ts keep working. New consumers should import from corpus-model.ts
// directly (the stable query-model home).

export type {
  CapturedOutcome,
  CapturedOutcomeLabel,
  ReplayBashParser,
  ReplayStatus,
} from "./corpus-model.ts";
export { classifyCapturedOutcome, effectToStatus } from "./corpus-model.ts";

import type {
  DecisionEffect,
  DecisionProvenance,
  EffectivePolicy,
} from "../policy/core.ts";
import type {
  CapturedOutcomeLabel,
  CorpusRecord,
  CountByLabel,
  ReplayStatus,
} from "./corpus-model.ts";
import { CAPTURED_OUTCOME_LABELS } from "./corpus-model.ts";
import type { CorpusQueryModel } from "./corpus-query.ts";
import { buildCorpusQueryModel } from "./corpus-query.ts";
import type { CorpusFidelity, CorpusSource, ReplayCorpus } from "./history.ts";

export interface OutcomeTally {
  readonly calls: number;
  readonly unique: number;
}

export interface PerCommandRow {
  readonly command: string;
  readonly count: number;
  readonly toolName: string;
  readonly executable?: string;
  readonly status: ReplayStatus;
  readonly reason: string;
  readonly ruleId?: string;
  readonly provenance?: DecisionProvenance;
  readonly capturedOutcomes: ReadonlyMap<CapturedOutcomeLabel, number>;
  readonly fidelity: CorpusFidelity;
  readonly sources: readonly CorpusSource[];
  readonly behaviors?: readonly string[];
}

export interface ExecutableTally {
  readonly executable: string;
  readonly calls: number;
  readonly unique: number;
  readonly fastPathCalls: number;
  readonly reviewCalls: number;
  readonly hardBlockCalls: number;
  readonly modelReviewCalls: number;
  readonly capturedDenialCalls: number;
}

export interface UnknownToolTally {
  readonly toolName: string;
  readonly calls: number;
  /**
   * Replayed-status partition. Every non-bash call shares the single configured
   * `unknownToolPosture`, so exactly one of review/hardBlock/fastPath is non-zero —
   * it documents which posture these tools hit, not per-call variance.
   */
  readonly reviewCalls: number;
  readonly hardBlockCalls: number;
  readonly fastPathCalls: number;
  /** Real friction signal: captured runtime outcomes per tool (model-review, human-deny, …). */
  readonly modelReviewCalls: number;
  readonly capturedDenialCalls: number;
  readonly capturedOutcomes: ReadonlyMap<CapturedOutcomeLabel, number>;
}

/** Repeated contentious/denied family — the structured signal the proposal flows consume. */
export interface FrictionFamily {
  readonly executable: string;
  readonly calls: number;
  readonly unique: number;
  readonly reviewCalls: number;
  readonly hardBlockCalls: number;
  readonly modelReviewCalls: number;
  readonly capturedDenialCalls: number;
  readonly sampleCommands: readonly string[];
}

export interface ReplaySummary {
  readonly totalCalls: number;
  readonly totalUnique: number;
  readonly fastPathCalls: number;
  readonly fastPathUnique: number;
  readonly reviewCalls: number;
  readonly reviewUnique: number;
  readonly hardBlockCalls: number;
  readonly hardBlockUnique: number;
  readonly byCapturedOutcome: ReadonlyMap<CapturedOutcomeLabel, OutcomeTally>;
  readonly modelReviewLoad: OutcomeTally;
  readonly redactedCalls: number;
}

export interface RatchetCorpusSummary {
  readonly totalCalls: number;
  readonly totalUnique: number;
  readonly sources: ReadonlyMap<CorpusSource, number>;
  readonly unmatchedAuditEntries: number;
  readonly warnings: readonly string[];
}

export interface ReplayCompare {
  readonly changedUnique: number;
  readonly changedCalls: number;
  readonly transitions: ReadonlyMap<string, number>;
  readonly expansions: OutcomeTally;
  readonly beforeSummary: ReplaySummary;
  readonly afterSummary: ReplaySummary;
  readonly changedCommands: readonly PerCommandRow[];
}

export interface RatchetReport {
  readonly generatedAt: string;
  readonly repoRoot?: string;
  readonly sourcePath?: string;
  readonly corpus: RatchetCorpusSummary;
  readonly summary: ReplaySummary;
  readonly topReviewedExecutables: readonly ExecutableTally[];
  readonly topFastPathExecutables: readonly ExecutableTally[];
  readonly topReviewedCommands: readonly PerCommandRow[];
  readonly topHardBlockedCommands: readonly PerCommandRow[];
  readonly topContentiousFamilies: readonly FrictionFamily[];
  readonly topUnknownTools: readonly UnknownToolTally[];
  readonly perCommand: readonly PerCommandRow[];
  readonly compare?: ReplayCompare;
}

export interface ReplayHistoryOptions {
  readonly repoRoot?: string;
  readonly sourcePath?: string;
  readonly clock?: () => Date;
  readonly unknownToolPosture?: DecisionEffect;
  readonly proposedPolicy?: EffectivePolicy;
}

const CORPUS_SOURCES = [
  "session",
  "audit",
  "corpus",
] as const satisfies readonly CorpusSource[];

const MODEL_OUTCOME_LABELS = new Set<CapturedOutcomeLabel>([
  "model-allow",
  "model-deny",
  "model-review",
]);

const DENIAL_OUTCOME_LABELS = new Set<CapturedOutcomeLabel>([
  "deterministic-deny",
  "model-deny",
  "human-deny",
  "block-and-log",
  "fixture-hard-block",
]);

const DEFAULT_TOP_LIMIT = 20;
const DEFAULT_SAMPLE_COMMAND_LIMIT = 5;
const DEFAULT_CHANGED_COMMAND_LIMIT = 50;

/**
 * Dry-run replay. Never executes commands; never reads files / calls a model / mutates config.
 *
 * This is now a COMPATIBILITY ADAPTER over the structured query model: it builds a
 * baseline `CorpusQueryModel` via `buildCorpusQueryModel`, converts the per-occurrence
 * records into the legacy `RatchetReport` shapes (grouped by exact command string for
 * `PerCommandRow`), and — when `options.proposedPolicy` is set — builds a second model
 * with the candidate policy and computes the existing `ReplayCompare` from the two row
 * sets. Markdown, proposal, and report consumers keep reading `RatchetReport`; the
 * corpus query model is the source of corpus truth (see the report-bridge story).
 *
 * Public behavior is preserved exactly: parse-once-per-unique-command (the parser is
 * memoized so the baseline + proposed builds share one parse per command), grouping by
 * exact command string, unknown-tool posture, compare transition labels, and redacted
 * row rendering. No callers need to change.
 */
export async function replayHistory(
  corpus: ReplayCorpus,
  policy: EffectivePolicy,
  options?: ReplayHistoryOptions,
): Promise<RatchetReport> {
  // The native replay kernel owns the production parse/enrich/decide loop.
  const unknownToolPosture = isDecisionEffect(options?.unknownToolPosture)
    ? options.unknownToolPosture
    : "review";
  const safePolicy = isRecord(policy) ? policy : {};
  const buildOptions = { unknownToolPosture } as const;

  const baselineModel = await buildCorpusQueryModel(
    corpus,
    safePolicy,
    buildOptions,
  );

  const perCommand = rowsFromModel(baselineModel);
  const summary = summarizeRows(perCommand);

  // Warnings come from the baseline model only. The query model collects corpus
  // warnings (malformed input) and per-command parser warnings in first-seen order,
  // matching the legacy `[...normalized.warnings, ...replayWarnings]`. The proposed
  // (compare) build would re-derive the same parser warnings; legacy dropped those, so
  // they are ignored here to avoid duplicates.
  const warnings = baselineModel.warnings;

  const proposedPolicy = options?.proposedPolicy;
  const compare =
    proposedPolicy === undefined
      ? undefined
      : buildCompare(
          perCommand,
          summary,
          rowsFromModel(
            await buildCorpusQueryModel(
              corpus,
              isRecord(proposedPolicy) ? proposedPolicy : {},
              buildOptions,
            ),
          ),
        );

  return optionalReportFields(
    {
      generatedAt: (options?.clock ?? (() => new Date()))().toISOString(),
      corpus: {
        totalCalls: baselineModel.records.length,
        totalUnique: perCommand.length,
        sources: sourcesMapFromCounts(baselineModel.summary.sourceCounts),
        unmatchedAuditEntries: baselineModel.summary.unmatchedAuditEntries,
        warnings,
      },
      summary,
      topReviewedExecutables: topExecutables(perCommand, "reviewCalls"),
      topFastPathExecutables: topExecutables(perCommand, "fastPathCalls"),
      topReviewedCommands: topRows(perCommand, "review"),
      topHardBlockedCommands: topRows(perCommand, "hard_block"),
      topContentiousFamilies: topContentiousFamilies(perCommand),
      topUnknownTools: topUnknownToolsFromRecords(baselineModel.records),
      perCommand,
      ...(compare === undefined ? {} : { compare }),
    },
    options,
  );
}

// ---------------------------------------------------------------------------
// Query-model -> legacy report bridge
// ---------------------------------------------------------------------------

/**
 * Convert a corpus query model into legacy `PerCommandRow`s grouped by exact command
 * string (preserving first-occurrence order, matching the legacy `groupByCommand`).
 *
 * Each row's decision/executable come from a "representative" record — the first bash
 * record in the group, or the first record when the group has no bash call — mirroring
 * the legacy `replayGroup` bash-wins / unknown-tool fallback. `toolName` is the first
 * occurrence's tool name (legacy `toolNameForGroup`). `capturedOutcomes`, `fidelity`,
 * and `sources` aggregate over ALL records in the group.
 */
function rowsFromModel(model: CorpusQueryModel): readonly PerCommandRow[] {
  return groupRecordsByCommand(model.records).map((group) =>
    rowForRecordGroup(group),
  );
}

function groupRecordsByCommand(
  records: readonly CorpusRecord[],
): readonly CorpusRecord[][] {
  const order: string[] = [];
  const groups = new Map<string, CorpusRecord[]>();
  for (const record of records) {
    let group = groups.get(record.command);
    if (group === undefined) {
      group = [];
      groups.set(record.command, group);
      order.push(record.command);
    }
    group.push(record);
  }
  // `order` holds first-occurrence command order; each group has at least one record.
  return order.map((command) => groups.get(command) as CorpusRecord[]);
}

function rowForRecordGroup(records: readonly CorpusRecord[]): PerCommandRow {
  const first = records[0];
  if (first === undefined) {
    // groupRecordsByCommand never produces an empty group; guard for type safety.
    throw new Error("rowForRecordGroup requires a non-empty record group");
  }

  const representative = representativeRecord(records);
  const capturedOutcomes = capturedOutcomeTallyFromRecords(records);
  const provenance = representative.replayed.provenance;
  const ruleId = representative.replayed.ruleId;
  const executable = representative.parsed.summary.primaryExecutable;
  const behaviors = behaviorsFromRuleId(ruleId);

  return {
    command: first.command,
    count: records.length,
    toolName: first.toolName,
    ...(executable === undefined ? {} : { executable }),
    status: representative.replayed.status,
    reason: representative.replayed.decision.reason,
    ...(ruleId === undefined ? {} : { ruleId }),
    provenance,
    capturedOutcomes,
    fidelity: fidelityForRecords(records),
    sources: sourcesForRecords(records),
    ...(behaviors.length === 0 ? {} : { behaviors }),
  };
}

/**
 * Pick the record that supplies the row's replayed decision. Bash records win over
 * non-bash (the legacy `replayGroup` parsed the bash entry); within bash the first one
 * wins. When the group has no bash call, the first record (an unknown-tool record) is
 * the representative — its decision is `unknownToolDecision(firstToolName, posture)`,
 * matching the legacy `unknown tool: <entries[0].toolName>` reason.
 */
function representativeRecord(records: readonly CorpusRecord[]): CorpusRecord {
  const bash = records.find((record) => record.toolName === "bash");
  if (bash !== undefined) {
    return bash;
  }
  const first = records[0];
  if (first === undefined) {
    throw new Error("representativeRecord requires a non-empty record group");
  }
  return first;
}

function capturedOutcomeTallyFromRecords(
  records: readonly CorpusRecord[],
): ReadonlyMap<CapturedOutcomeLabel, number> {
  const tally = new Map<CapturedOutcomeLabel, number>();
  for (const record of records) {
    const label = record.captured.label;
    tally.set(label, (tally.get(label) ?? 0) + 1);
  }
  return sortCapturedOutcomeMap(tally);
}

function fidelityForRecords(records: readonly CorpusRecord[]): CorpusFidelity {
  return records.some((record) => record.source.fidelity === "redacted")
    ? "redacted"
    : "high";
}

function sourcesForRecords(
  records: readonly CorpusRecord[],
): readonly CorpusSource[] {
  const found = new Set<CorpusSource>();
  for (const record of records) {
    for (const source of record.source.sources) {
      found.add(source);
    }
  }
  return CORPUS_SOURCES.filter((source) => found.has(source));
}

/**
 * Convert the query model's JSON-compatible source counts into the legacy
 * `ReadonlyMap<CorpusSource, number>` shape, including all canonical sources (with
 * zero counts) in `CORPUS_SOURCES` order — matching the legacy completed source summary.
 * The query model recomputes source counts from valid entries; this is equivalent to
 * the legacy entry-derived summary for all real corpora (`buildReplayCorpus` derives
 * `sourceSummary` from entries).
 */
function sourcesMapFromCounts(
  counts: readonly CountByLabel<CorpusSource>[],
): ReadonlyMap<CorpusSource, number> {
  const map = new Map<CorpusSource, number>();
  for (const source of CORPUS_SOURCES) {
    map.set(source, 0);
  }
  for (const entry of counts) {
    map.set(entry.label, entry.calls);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Legacy summary / top-list helpers (operate on PerCommandRow; unchanged behavior)
// ---------------------------------------------------------------------------

function summarizeRows(rows: readonly PerCommandRow[]): ReplaySummary {
  const byCapturedOutcome = new Map<CapturedOutcomeLabel, OutcomeTally>();
  let fastPathCalls = 0;
  let fastPathUnique = 0;
  let reviewCalls = 0;
  let reviewUnique = 0;
  let hardBlockCalls = 0;
  let hardBlockUnique = 0;
  let redactedCalls = 0;

  for (const row of rows) {
    switch (row.status) {
      case "fast_path":
        fastPathCalls += row.count;
        fastPathUnique += 1;
        break;
      case "review":
        reviewCalls += row.count;
        reviewUnique += 1;
        break;
      case "hard_block":
        hardBlockCalls += row.count;
        hardBlockUnique += 1;
        break;
    }

    if (row.fidelity === "redacted") {
      redactedCalls += row.count;
    }

    for (const [label, calls] of row.capturedOutcomes) {
      const previous = byCapturedOutcome.get(label) ?? { calls: 0, unique: 0 };
      byCapturedOutcome.set(label, {
        calls: previous.calls + calls,
        unique: previous.unique + 1,
      });
    }
  }

  return {
    totalCalls: rows.reduce((sum, row) => sum + row.count, 0),
    totalUnique: rows.length,
    fastPathCalls,
    fastPathUnique,
    reviewCalls,
    reviewUnique,
    hardBlockCalls,
    hardBlockUnique,
    byCapturedOutcome: sortOutcomeTallyMap(byCapturedOutcome),
    modelReviewLoad: modelReviewLoad(byCapturedOutcome),
    redactedCalls,
  };
}

function buildCompare(
  beforeRows: readonly PerCommandRow[],
  beforeSummary: ReplaySummary,
  afterRows: readonly PerCommandRow[],
): ReplayCompare {
  const afterSummary = summarizeRows(afterRows);
  const afterByCommand = new Map(
    afterRows.map((row) => [row.command, row] as const),
  );
  const transitionCounts = new Map<string, number>();
  const changedCommands: PerCommandRow[] = [];
  let changedUnique = 0;
  let changedCalls = 0;
  let expansionUnique = 0;
  let expansionCalls = 0;

  for (const before of beforeRows) {
    const after = afterByCommand.get(before.command);
    if (after === undefined || before.status === after.status) {
      continue;
    }

    const transition = `${before.status}->${after.status}`;
    changedUnique += 1;
    changedCalls += after.count;
    transitionCounts.set(
      transition,
      (transitionCounts.get(transition) ?? 0) + after.count,
    );
    if (transition === "review->fast_path") {
      expansionUnique += 1;
      expansionCalls += after.count;
    }
    changedCommands.push(after);
  }

  return {
    changedUnique,
    changedCalls,
    transitions: sortTransitionMap(transitionCounts),
    expansions: { calls: expansionCalls, unique: expansionUnique },
    beforeSummary,
    afterSummary,
    changedCommands: changedCommands
      .sort(compareRowsByFriction)
      .slice(0, DEFAULT_CHANGED_COMMAND_LIMIT),
  };
}

function sortTransitionMap(
  input: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  return new Map(
    [...input.entries()].sort(
      ([leftKey, leftCount], [rightKey, rightCount]) =>
        rightCount - leftCount || leftKey.localeCompare(rightKey),
    ),
  );
}

function modelReviewLoad(
  byCapturedOutcome: ReadonlyMap<CapturedOutcomeLabel, OutcomeTally>,
): OutcomeTally {
  let calls = 0;
  let unique = 0;
  for (const label of MODEL_OUTCOME_LABELS) {
    const tally = byCapturedOutcome.get(label);
    if (tally !== undefined) {
      calls += tally.calls;
      unique += tally.unique;
    }
  }
  return { calls, unique };
}

function topExecutables(
  rows: readonly PerCommandRow[],
  metric: "reviewCalls" | "fastPathCalls",
): readonly ExecutableTally[] {
  return [...executableTallies(rows).values()]
    .filter((tally) => tally[metric] > 0)
    .sort((left, right) => compareExecutableTally(left, right, metric))
    .slice(0, DEFAULT_TOP_LIMIT);
}

function executableTallies(
  rows: readonly PerCommandRow[],
): ReadonlyMap<string, ExecutableTally> {
  const tallies = new Map<string, MutableExecutableTally>();

  for (const row of rows) {
    if (row.executable === undefined) {
      continue;
    }

    const tally =
      tallies.get(row.executable) ?? emptyExecutableTally(row.executable);
    tally.calls += row.count;
    tally.unique += 1;
    tally.fastPathCalls += row.status === "fast_path" ? row.count : 0;
    tally.reviewCalls += row.status === "review" ? row.count : 0;
    tally.hardBlockCalls += row.status === "hard_block" ? row.count : 0;
    tally.modelReviewCalls += countLabels(
      row.capturedOutcomes,
      MODEL_OUTCOME_LABELS,
    );
    tally.capturedDenialCalls += countLabels(
      row.capturedOutcomes,
      DENIAL_OUTCOME_LABELS,
    );
    tallies.set(row.executable, tally);
  }

  return tallies;
}

interface MutableExecutableTally {
  executable: string;
  calls: number;
  unique: number;
  fastPathCalls: number;
  reviewCalls: number;
  hardBlockCalls: number;
  modelReviewCalls: number;
  capturedDenialCalls: number;
}

function emptyExecutableTally(executable: string): MutableExecutableTally {
  return {
    executable,
    calls: 0,
    unique: 0,
    fastPathCalls: 0,
    reviewCalls: 0,
    hardBlockCalls: 0,
    modelReviewCalls: 0,
    capturedDenialCalls: 0,
  };
}

function compareExecutableTally(
  left: ExecutableTally,
  right: ExecutableTally,
  metric: "reviewCalls" | "fastPathCalls",
): number {
  return (
    right[metric] - left[metric] ||
    right.calls - left.calls ||
    right.unique - left.unique ||
    left.executable.localeCompare(right.executable)
  );
}

function topRows(
  rows: readonly PerCommandRow[],
  status: ReplayStatus,
): readonly PerCommandRow[] {
  return rows
    .filter((row) => row.status === status)
    .sort(compareRowsByFriction)
    .slice(0, DEFAULT_TOP_LIMIT);
}

function compareRowsByFriction(
  left: PerCommandRow,
  right: PerCommandRow,
): number {
  return right.count - left.count || left.command.localeCompare(right.command);
}

function topContentiousFamilies(
  rows: readonly PerCommandRow[],
): readonly FrictionFamily[] {
  const families = new Map<string, MutableFrictionFamily>();

  for (const row of rows) {
    if (row.executable === undefined) {
      continue;
    }

    const family =
      families.get(row.executable) ?? emptyFrictionFamily(row.executable);
    family.calls += row.count;
    family.unique += 1;
    family.reviewCalls += row.status === "review" ? row.count : 0;
    family.hardBlockCalls += row.status === "hard_block" ? row.count : 0;
    family.modelReviewCalls += countLabels(
      row.capturedOutcomes,
      MODEL_OUTCOME_LABELS,
    );
    family.capturedDenialCalls += countLabels(
      row.capturedOutcomes,
      DENIAL_OUTCOME_LABELS,
    );
    if (family.sampleCommands.length < DEFAULT_SAMPLE_COMMAND_LIMIT) {
      family.sampleCommands.push(row.command);
    }
    families.set(row.executable, family);
  }

  return [...families.values()]
    .filter((family) => frictionScore(family) > 0)
    .sort(compareFrictionFamily)
    .slice(0, DEFAULT_TOP_LIMIT)
    .map((family) => ({
      ...family,
      sampleCommands: [...family.sampleCommands],
    }));
}

interface MutableFrictionFamily {
  executable: string;
  calls: number;
  unique: number;
  reviewCalls: number;
  hardBlockCalls: number;
  modelReviewCalls: number;
  capturedDenialCalls: number;
  sampleCommands: string[];
}

function emptyFrictionFamily(executable: string): MutableFrictionFamily {
  return {
    executable,
    calls: 0,
    unique: 0,
    reviewCalls: 0,
    hardBlockCalls: 0,
    modelReviewCalls: 0,
    capturedDenialCalls: 0,
    sampleCommands: [],
  };
}

function compareFrictionFamily(
  left: FrictionFamily,
  right: FrictionFamily,
): number {
  return (
    frictionScore(right) - frictionScore(left) ||
    right.calls - left.calls ||
    right.unique - left.unique ||
    left.executable.localeCompare(right.executable)
  );
}

function frictionScore(family: {
  readonly reviewCalls: number;
  readonly hardBlockCalls: number;
  readonly capturedDenialCalls: number;
}): number {
  return (
    family.reviewCalls + family.hardBlockCalls + family.capturedDenialCalls
  );
}

/**
 * Build the legacy unknown-tool tallies from the query model's per-occurrence records.
 * Unsupported records share the single `unknownToolPosture`, so
 * `record.replayed.status` is the posture-derived status for each unknown-tool call.
 * Analyzed Pi tools are intentionally excluded; they appear in normal command-family
 * summaries. `record.captured.label` is the pre-classified captured outcome, matching
 * the legacy `classifyCapturedOutcome(entry)`.
 */
function topUnknownToolsFromRecords(
  records: readonly CorpusRecord[],
): readonly UnknownToolTally[] {
  const tallies = new Map<string, MutableUnknownToolTally>();
  for (const record of records) {
    if (record.family.kind !== "unknown-tool") {
      continue;
    }

    const tally =
      tallies.get(record.toolName) ?? emptyUnknownToolTally(record.toolName);
    tally.calls += 1;
    switch (record.replayed.status) {
      case "review":
        tally.reviewCalls += 1;
        break;
      case "hard_block":
        tally.hardBlockCalls += 1;
        break;
      case "fast_path":
        tally.fastPathCalls += 1;
        break;
    }

    const label = record.captured.label;
    tally.capturedOutcomes.set(
      label,
      (tally.capturedOutcomes.get(label) ?? 0) + 1,
    );
    if (MODEL_OUTCOME_LABELS.has(label)) {
      tally.modelReviewCalls += 1;
    }
    if (DENIAL_OUTCOME_LABELS.has(label)) {
      tally.capturedDenialCalls += 1;
    }
    tallies.set(record.toolName, tally);
  }

  return [...tallies.values()]
    .sort(compareUnknownToolTally)
    .slice(0, DEFAULT_TOP_LIMIT)
    .map(finalizeUnknownToolTally);
}

interface MutableUnknownToolTally {
  toolName: string;
  calls: number;
  reviewCalls: number;
  hardBlockCalls: number;
  fastPathCalls: number;
  modelReviewCalls: number;
  capturedDenialCalls: number;
  capturedOutcomes: Map<CapturedOutcomeLabel, number>;
}

function emptyUnknownToolTally(toolName: string): MutableUnknownToolTally {
  return {
    toolName,
    calls: 0,
    reviewCalls: 0,
    hardBlockCalls: 0,
    fastPathCalls: 0,
    modelReviewCalls: 0,
    capturedDenialCalls: 0,
    capturedOutcomes: new Map(),
  };
}

function finalizeUnknownToolTally(
  tally: MutableUnknownToolTally,
): UnknownToolTally {
  return {
    ...tally,
    capturedOutcomes: sortCapturedOutcomeMap(tally.capturedOutcomes),
  };
}

function compareUnknownToolTally(
  left: UnknownToolTally,
  right: UnknownToolTally,
): number {
  return (
    unknownToolFrictionScore(right) - unknownToolFrictionScore(left) ||
    right.calls - left.calls ||
    left.toolName.localeCompare(right.toolName)
  );
}

function unknownToolFrictionScore(tally: {
  readonly modelReviewCalls: number;
  readonly capturedDenialCalls: number;
  readonly reviewCalls: number;
}): number {
  return tally.modelReviewCalls + tally.capturedDenialCalls + tally.reviewCalls;
}

function countLabels(
  outcomes: ReadonlyMap<CapturedOutcomeLabel, number>,
  labels: ReadonlySet<CapturedOutcomeLabel>,
): number {
  let count = 0;
  for (const [label, calls] of outcomes) {
    if (labels.has(label)) {
      count += calls;
    }
  }
  return count;
}

function behaviorsFromRuleId(ruleId: string | undefined): readonly string[] {
  if (ruleId === undefined) {
    return [];
  }

  const normalized = ruleId.toLowerCase();
  const behaviors = new Set<string>();
  for (const [needle, behavior] of BEHAVIOR_RULE_ID_PATTERNS) {
    if (normalized.includes(needle)) {
      behaviors.add(behavior);
    }
  }

  return [...behaviors].sort();
}

const BEHAVIOR_RULE_ID_PATTERNS = [
  ["destructive-git", "destructive-git"],
  ["force-push", "force-push"],
  ["review-git-push", "force-push"],
  ["review-git-branch-destructive", "branch-delete"],
  ["review-git-worktree-mutation", "worktree-remove"],
  ["review-git-stash-mutation", "destructive-git"],
  ["review-git-remote-mutation", "destructive-git"],
  ["review-git-reset", "hard-reset"],
  ["review-git-clean", "git-clean"],
  ["review-git-tag-destructive", "destructive-git"],
  ["review-git-checkout-destructive", "destructive-git"],
  ["review-git-switch-force", "destructive-git"],
  ["recursive-rm", "recursive-delete"],
  ["recursive-delete", "recursive-delete"],
  ["privilege-escalation", "privilege-escalation"],
  ["broad-chmod", "broad-chmod"],
  ["fork-bomb", "fork-bomb"],
  ["disk-destructive", "disk-destructive"],
  ["system-shutdown", "system-shutdown"],
  ["remote-shell", "remote-shell"],
] as const satisfies readonly (readonly [string, string])[];

function sortCapturedOutcomeMap(
  input: ReadonlyMap<CapturedOutcomeLabel, number>,
): ReadonlyMap<CapturedOutcomeLabel, number> {
  const sorted = new Map<CapturedOutcomeLabel, number>();
  for (const label of CAPTURED_OUTCOME_LABELS) {
    const count = input.get(label);
    if (count !== undefined && count > 0) {
      sorted.set(label, count);
    }
  }
  return sorted;
}

function sortOutcomeTallyMap(
  input: ReadonlyMap<CapturedOutcomeLabel, OutcomeTally>,
): ReadonlyMap<CapturedOutcomeLabel, OutcomeTally> {
  const sorted = new Map<CapturedOutcomeLabel, OutcomeTally>();
  for (const label of CAPTURED_OUTCOME_LABELS) {
    const tally = input.get(label);
    if (tally !== undefined) {
      sorted.set(label, tally);
    }
  }
  return sorted;
}

function optionalReportFields(
  report: Omit<RatchetReport, "repoRoot" | "sourcePath">,
  options: ReplayHistoryOptions | undefined,
): RatchetReport {
  return {
    ...report,
    ...(options?.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
    ...(options?.sourcePath === undefined
      ? {}
      : { sourcePath: options.sourcePath }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDecisionEffect(value: unknown): value is DecisionEffect {
  return value === "allow" || value === "deny" || value === "review";
}
