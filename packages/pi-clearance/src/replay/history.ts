import type { AuditEntry, ReviewerMode } from "../audit/entry.ts";
import {
  type RedactionOptions,
  redactString,
  redactValue,
} from "../audit/redact.ts";
import type { DecisionEffect } from "../policy/core.ts";

export type DeterministicOutcome = DecisionEffect;
export type CorpusExpectedLabel = "fast_path" | "review" | "hard_block";
export type CorpusFidelity = "high" | "redacted";
export type CorpusSource = "session" | "audit" | "corpus";

export interface ReviewerOutcome {
  readonly mode: ReviewerMode;
  readonly finalEffect: DecisionEffect;
}

export interface CorpusEntry {
  readonly command: string;
  readonly toolName: string;
  /** Original structured Pi tool input when available. */
  readonly toolInput?: unknown;
  readonly toolCallId?: string;
  readonly sessionId?: string;
  readonly timestamp?: string;
  readonly source: CorpusSource;
  readonly sources: readonly CorpusSource[];
  readonly provenance: string;
  readonly deterministicOutcome?: DeterministicOutcome;
  readonly reviewerOutcome?: ReviewerOutcome;
  readonly expectedLabel?: CorpusExpectedLabel;
  readonly fidelity: CorpusFidelity;
}

export interface ReplayCorpus {
  readonly entries: readonly CorpusEntry[];
  readonly sourceSummary: ReadonlyMap<CorpusSource, number>;
  readonly unmatchedAuditEntries: number;
  readonly warnings: readonly string[];
}

export interface SessionToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly command: string;
  /** Original structured Pi tool-call arguments. */
  readonly toolInput?: unknown;
  readonly sessionId: string;
  readonly timestamp: string;
}

export interface CorpusFixtureRow {
  readonly command: string;
  readonly expected: CorpusExpectedLabel;
  readonly reason: string;
  /** Corpus file name; adapters fill this without embedding provenance in JSON rows. */
  readonly provenance: string;
}

export interface SourceReadResult<T> {
  readonly items: readonly T[];
  readonly warnings: readonly string[];
}

export interface HistoryBounds {
  readonly sessionId?: string;
  readonly since?: string;
  readonly maxToolCalls?: number;
  readonly leafBranchOnly?: boolean;
}

/** Complete captured history by default; user-facing flows may apply bounds. */
export const DEFAULT_HISTORY_BOUNDS = {} satisfies HistoryBounds;

export interface SessionHistorySource {
  readonly sessionId?: string;
  read(): SourceReadResult<SessionToolCall>;
}

export interface AuditLogSource {
  readonly path?: string;
  read(): SourceReadResult<AuditEntry>;
}

export interface CorpusFixtureSource {
  readonly path?: string;
  read(): SourceReadResult<CorpusFixtureRow>;
}

export interface BuildReplayCorpusSources {
  readonly session?: readonly SessionToolCall[];
  readonly audit?: readonly AuditEntry[];
  readonly corpus?: readonly CorpusFixtureRow[];
}

export interface BuildReplayCorpusOptions {
  readonly dropUnmatchedAudit?: boolean;
  readonly warnings?: readonly string[];
}

type OutcomeAuditEntry = Extract<
  AuditEntry,
  { readonly entryType: "policy.decision" | "reviewer.decision" }
>;

interface AuditOutcomeGroup {
  readonly key: string;
  readonly index: number;
  readonly timestamp?: string;
  readonly toolCallId?: string;
  readonly sessionId?: string;
  readonly toolName: string;
  readonly command?: string;
  readonly toolInput?: unknown;
  policy?: Extract<AuditEntry, { readonly entryType: "policy.decision" }>;
  reviewer?: Extract<AuditEntry, { readonly entryType: "reviewer.decision" }>;
  consumed: boolean;
}

const CORPUS_SOURCES: readonly CorpusSource[] = ["session", "audit", "corpus"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isDecisionEffect(value: unknown): value is DecisionEffect {
  return value === "allow" || value === "deny" || value === "review";
}

function isReviewerMode(value: unknown): value is ReviewerMode {
  return value === "model" || value === "human" || value === "block-and-log";
}

function isDecisionRecord(
  value: unknown,
): value is { readonly effect: DecisionEffect } {
  return isRecord(value) && isDecisionEffect(value.effect);
}

function isCorpusExpectedLabel(value: unknown): value is CorpusExpectedLabel {
  return value === "fast_path" || value === "review" || value === "hard_block";
}

function asArray<T>(
  value: readonly T[] | undefined,
  label: string,
  warnings: string[],
): readonly T[] {
  if (value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  warnings.push(`${label} source was not an array; skipped`);
  return [];
}

function isOutcomeAuditEntry(entry: unknown): entry is OutcomeAuditEntry {
  if (!isRecord(entry)) {
    return false;
  }

  if (
    typeof entry.timestamp !== "string" ||
    typeof entry.toolName !== "string" ||
    !isOptionalString(entry.sessionId) ||
    !isOptionalString(entry.toolCallId)
  ) {
    return false;
  }

  if (entry.entryType === "policy.decision") {
    return isDecisionRecord(entry.decision);
  }

  if (entry.entryType === "reviewer.decision") {
    return (
      isReviewerMode(entry.reviewerMode) &&
      isDecisionRecord(entry.finalDecision)
    );
  }

  return false;
}

function isSessionToolCall(value: unknown): value is SessionToolCall {
  return (
    isRecord(value) &&
    typeof value.toolCallId === "string" &&
    typeof value.toolName === "string" &&
    typeof value.command === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.timestamp === "string"
  );
}

function isCorpusFixtureRow(value: unknown): value is CorpusFixtureRow {
  return (
    isRecord(value) &&
    typeof value.command === "string" &&
    isCorpusExpectedLabel(value.expected) &&
    typeof value.reason === "string" &&
    typeof value.provenance === "string"
  );
}

function validSessionCalls(
  values: readonly unknown[],
  warnings: string[],
): readonly SessionToolCall[] {
  return values.filter((value, index): value is SessionToolCall => {
    if (isSessionToolCall(value)) {
      return true;
    }

    warnings.push(`session entry at index ${index} was malformed; skipped`);
    return false;
  });
}

function validCorpusRows(
  values: readonly unknown[],
  warnings: string[],
): readonly CorpusFixtureRow[] {
  return values.filter((value, index): value is CorpusFixtureRow => {
    if (isCorpusFixtureRow(value)) {
      return true;
    }

    warnings.push(`corpus row at index ${index} was malformed; skipped`);
    return false;
  });
}

function commandFromToolInput(toolInput: unknown): string | undefined {
  if (isRecord(toolInput)) {
    const command = toolInput.command;
    if (typeof command === "string") {
      return command;
    }
  }

  return stableJsonForDisplay(toolInput);
}

function stableJsonForDisplay(value: unknown): string | undefined {
  try {
    return JSON.stringify(sortJson(value));
  } catch {
    return undefined;
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortJson(value[key]);
  }
  return out;
}

function signatureKey(input: {
  readonly sessionId?: string;
  readonly toolName?: string;
  readonly command?: string;
}): string | undefined {
  if (
    input.sessionId === undefined ||
    input.toolName === undefined ||
    input.command === undefined
  ) {
    return undefined;
  }

  return `signature:${input.sessionId}\u0000${input.toolName}\u0000${input.command}`;
}

function keyForOutcome(entry: OutcomeAuditEntry): string | undefined {
  if (entry.toolCallId !== undefined) {
    return `toolCallId:${entry.toolCallId}`;
  }

  const command = commandFromToolInput(entry.toolInput);
  if (entry.sessionId === undefined || command === undefined) {
    return undefined;
  }

  return signatureKey({
    sessionId: entry.sessionId,
    toolName: entry.toolName,
    command,
  });
}

function keyForSessionCall(call: SessionToolCall): string {
  return `toolCallId:${call.toolCallId}`;
}

function fallbackKeyForSessionCall(call: SessionToolCall): string | undefined {
  return signatureKey({
    sessionId: call.sessionId,
    toolName: call.toolName,
    command: call.command,
  });
}

function dedupeKeyForOutcome(entry: OutcomeAuditEntry): string {
  return [
    entry.entryType,
    entry.toolCallId ?? keyForOutcome(entry) ?? "no-correlation-key",
    entry.timestamp,
  ].join("\u0000");
}

function appendOutcomeToGroup(
  group: AuditOutcomeGroup,
  entry: OutcomeAuditEntry,
  warnings: string[],
): void {
  if (entry.entryType === "policy.decision") {
    if (group.policy !== undefined) {
      warnings.push(
        `multiple policy.decision audit entries matched ${group.key}; kept the first`,
      );
      return;
    }
    group.policy = entry;
    return;
  }

  if (group.reviewer !== undefined) {
    warnings.push(
      `multiple reviewer.decision audit entries matched ${group.key}; kept the first`,
    );
    return;
  }
  group.reviewer = entry;
}

function indexAuditOutcomes(
  auditEntries: readonly AuditEntry[],
  warnings: string[],
): Map<string, AuditOutcomeGroup> {
  const groups = new Map<string, AuditOutcomeGroup>();
  const deduped = new Set<string>();

  for (const [index, entry] of auditEntries.entries()) {
    const candidate: unknown = entry;
    if (!isOutcomeAuditEntry(candidate)) {
      if (
        isRecord(candidate) &&
        (candidate.entryType === "policy.decision" ||
          candidate.entryType === "reviewer.decision")
      ) {
        warnings.push(
          `${candidate.entryType} audit entry at index ${index} was malformed; skipped`,
        );
      }
      continue;
    }

    const dedupeKey = dedupeKeyForOutcome(candidate);
    if (deduped.has(dedupeKey)) {
      continue;
    }
    deduped.add(dedupeKey);

    const key = keyForOutcome(candidate);
    const command = commandFromToolInput(candidate.toolInput);
    const groupKey = key ?? `audit-index:${index}`;
    const existing = groups.get(groupKey);

    if (existing !== undefined) {
      appendOutcomeToGroup(existing, candidate, warnings);
      continue;
    }

    const group: AuditOutcomeGroup = {
      key: groupKey,
      index,
      ...(candidate.timestamp === undefined
        ? {}
        : { timestamp: candidate.timestamp }),
      ...(candidate.toolCallId === undefined
        ? {}
        : { toolCallId: candidate.toolCallId }),
      ...(candidate.sessionId === undefined
        ? {}
        : { sessionId: candidate.sessionId }),
      toolName: candidate.toolName,
      ...(command === undefined ? {} : { command }),
      ...(candidate.toolInput === undefined
        ? {}
        : { toolInput: candidate.toolInput }),
      consumed: false,
    };
    appendOutcomeToGroup(group, candidate, warnings);
    groups.set(groupKey, group);
  }

  return groups;
}

function findAuditGroupForSessionCall(
  call: SessionToolCall,
  groups: Map<string, AuditOutcomeGroup>,
): AuditOutcomeGroup | undefined {
  const byToolCallId = groups.get(keyForSessionCall(call));
  if (byToolCallId !== undefined) {
    return byToolCallId;
  }

  const fallbackKey = fallbackKeyForSessionCall(call);
  if (fallbackKey === undefined) {
    return undefined;
  }

  return groups.get(fallbackKey);
}

function outcomeSources(
  group: AuditOutcomeGroup | undefined,
): readonly CorpusSource[] {
  return group === undefined ? ["session"] : ["session", "audit"];
}

function reviewerOutcome(
  entry: Extract<AuditEntry, { readonly entryType: "reviewer.decision" }>,
): ReviewerOutcome {
  return {
    mode: entry.reviewerMode,
    finalEffect: entry.finalDecision.effect,
  };
}

function sessionEntryFromCall(
  call: SessionToolCall,
  group: AuditOutcomeGroup | undefined,
): CorpusEntry {
  if (group !== undefined) {
    group.consumed = true;
  }

  return {
    command: call.command,
    toolName: call.toolName,
    ...(call.toolInput === undefined ? {} : { toolInput: call.toolInput }),
    toolCallId: call.toolCallId,
    sessionId: call.sessionId,
    timestamp: call.timestamp,
    source: "session",
    sources: outcomeSources(group),
    provenance: `session:${call.sessionId}:${call.toolCallId}`,
    ...(group?.policy === undefined
      ? {}
      : { deterministicOutcome: group.policy.decision.effect }),
    ...(group?.reviewer === undefined
      ? {}
      : { reviewerOutcome: reviewerOutcome(group.reviewer) }),
    fidelity: "high",
  };
}

function auditEntryFromGroup(
  group: AuditOutcomeGroup,
): CorpusEntry | undefined {
  if (group.command === undefined) {
    return undefined;
  }

  return {
    command: group.command,
    toolName: group.toolName,
    ...(group.toolInput === undefined ? {} : { toolInput: group.toolInput }),
    ...(group.toolCallId === undefined ? {} : { toolCallId: group.toolCallId }),
    ...(group.sessionId === undefined ? {} : { sessionId: group.sessionId }),
    ...(group.timestamp === undefined ? {} : { timestamp: group.timestamp }),
    source: "audit",
    sources: ["audit"],
    provenance: `audit:${group.timestamp ?? `index:${group.index}`}`,
    ...(group.policy === undefined
      ? {}
      : { deterministicOutcome: group.policy.decision.effect }),
    ...(group.reviewer === undefined
      ? {}
      : { reviewerOutcome: reviewerOutcome(group.reviewer) }),
    fidelity: "redacted",
  };
}

function sortAuditGroups(
  groups: readonly AuditOutcomeGroup[],
): readonly AuditOutcomeGroup[] {
  return [...groups].sort((left, right) => {
    const timestampOrder = (left.timestamp ?? "").localeCompare(
      right.timestamp ?? "",
    );
    if (timestampOrder !== 0) {
      return timestampOrder;
    }

    return left.index - right.index;
  });
}

function corpusEntryFromRow(row: CorpusFixtureRow): CorpusEntry {
  return {
    command: row.command,
    toolName: "bash",
    source: "corpus",
    sources: ["corpus"],
    provenance: row.provenance,
    expectedLabel: row.expected,
    fidelity: "high",
  };
}

function corpusEntries(
  rows: readonly CorpusFixtureRow[],
): readonly CorpusEntry[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const provenanceOrder = left.row.provenance.localeCompare(
        right.row.provenance,
      );
      if (provenanceOrder !== 0) {
        return provenanceOrder;
      }

      return left.index - right.index;
    })
    .map(({ row }) => corpusEntryFromRow(row));
}

function sourceSummary(
  entries: readonly CorpusEntry[],
): ReadonlyMap<CorpusSource, number> {
  const summary = new Map<CorpusSource, number>();
  for (const source of CORPUS_SOURCES) {
    summary.set(source, 0);
  }

  for (const entry of entries) {
    summary.set(entry.source, (summary.get(entry.source) ?? 0) + 1);
  }

  return summary;
}

function countAuditGroupEntries(group: AuditOutcomeGroup): number {
  return (
    (group.policy === undefined ? 0 : 1) +
    (group.reviewer === undefined ? 0 : 1)
  );
}

export function buildReplayCorpus(
  sources: BuildReplayCorpusSources,
  options?: BuildReplayCorpusOptions,
): ReplayCorpus {
  const warnings = [...(options?.warnings ?? [])];
  const sessionCalls = validSessionCalls(
    asArray(sources.session, "session", warnings),
    warnings,
  );
  const auditEntries = asArray(sources.audit, "audit", warnings);
  const corpusRows = validCorpusRows(
    asArray(sources.corpus, "corpus", warnings),
    warnings,
  );
  const auditGroups = indexAuditOutcomes(auditEntries, warnings);

  const sessionEntries = sessionCalls.map((call) =>
    sessionEntryFromCall(call, findAuditGroupForSessionCall(call, auditGroups)),
  );

  const auditOnlyEntries: CorpusEntry[] = [];
  let unmatchedAuditEntries = 0;

  for (const group of sortAuditGroups([...auditGroups.values()])) {
    if (group.consumed) {
      continue;
    }

    const entry = auditEntryFromGroup(group);
    if (entry === undefined) {
      unmatchedAuditEntries += countAuditGroupEntries(group);
      if (options?.dropUnmatchedAudit !== true) {
        warnings.push(
          `audit outcome group ${group.key} had no recoverable command; skipped`,
        );
      }
      continue;
    }

    auditOnlyEntries.push(entry);
  }

  const entries = [
    ...sessionEntries,
    ...auditOnlyEntries,
    ...corpusEntries(corpusRows),
  ];

  return {
    entries,
    sourceSummary: sourceSummary(entries),
    unmatchedAuditEntries,
    warnings,
  };
}

export function redactForExport(
  entries: readonly CorpusEntry[],
  options?: RedactionOptions,
): readonly CorpusEntry[] {
  return entries.map((entry) => {
    let command = "[redaction-failed]";
    try {
      command = redactString(entry.command, options);
    } catch {
      // Export is a privacy boundary. If caller-provided redaction options are
      // malformed, fail closed rather than copying the original command.
    }

    return {
      ...entry,
      sources: [...entry.sources],
      command,
      ...(entry.toolInput === undefined
        ? {}
        : { toolInput: redactValue(entry.toolInput, options) }),
      ...(entry.reviewerOutcome === undefined
        ? {}
        : { reviewerOutcome: { ...entry.reviewerOutcome } }),
    };
  });
}
