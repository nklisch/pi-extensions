/**
 * Stable corpus query model — the structured record surface later query,
 * family, replay, and rendering code reads instead of re-enumerating outcome
 * labels or scraping markdown reports.
 *
 * This module is the single source of truth for replay status, captured-outcome
 * classification, JSON-compatible count primitives, and the stable record types.
 * `ratchet.ts` re-exports the classifier/status symbols so existing imports
 * keep working; new consumers should import from here directly.
 *
 * Safety boundary (preserved): captured commands are parsed and evaluated, never
 * executed. Nothing in this module reads files, calls a model, or mutates config.
 */
import type { ReviewerMode } from "../audit/entry.ts";
import type {
  BashPathFacts,
  PiBuiltinToolOperation,
  ShapeDiagnostic,
  ToolPathFacts,
  ToolShape,
} from "../parse/shape.ts";
import type {
  Decision,
  DecisionEffect,
  DecisionProvenance,
} from "../policy/core.ts";
import type {
  CorpusEntry,
  CorpusExpectedLabel,
  CorpusFidelity,
  CorpusSource,
} from "./history.ts";

// ---------------------------------------------------------------------------
// Replay status + captured-outcome classification (moved from ratchet.ts)
// ---------------------------------------------------------------------------

/** Replayed status (REFERENCE_PATTERNS): allow→fast_path, review→review, deny→hard_block. */
export type ReplayStatus = "fast_path" | "review" | "hard_block";

/** Canonical replay-status order used by JSON summaries and sort primitives. */
export const REPLAY_STATUSES = [
  "fast_path",
  "review",
  "hard_block",
] as const satisfies readonly ReplayStatus[];

/** Captured-outcome classification: runtime evidence, never policy authority. */
export type CapturedOutcomeLabel =
  | "deterministic-allow"
  | "deterministic-deny"
  | "deterministic-review"
  | "model-allow"
  | "model-deny"
  | "model-review"
  | "human-allow"
  | "human-deny"
  | "block-and-log"
  | "fixture-fast-path"
  | "fixture-review"
  | "fixture-hard-block"
  | "no-captured-outcome";

/** Canonical captured-outcome label order used by JSON summaries and sort primitives. */
export const CAPTURED_OUTCOME_LABELS = [
  "deterministic-allow",
  "deterministic-deny",
  "deterministic-review",
  "model-allow",
  "model-deny",
  "model-review",
  "human-allow",
  "human-deny",
  "block-and-log",
  "fixture-fast-path",
  "fixture-review",
  "fixture-hard-block",
  "no-captured-outcome",
] as const satisfies readonly CapturedOutcomeLabel[];

export interface CapturedOutcome {
  readonly label: CapturedOutcomeLabel;
  readonly deterministicEffect?: DecisionEffect;
  readonly reviewer?: {
    readonly mode: ReviewerMode;
    readonly finalEffect: DecisionEffect;
  };
  readonly fixtureExpected?: CorpusExpectedLabel;
}

/** Bash parser used by replay; never executes commands. */
export type ReplayBashParser = (command: string) => Promise<ToolShape>;

/**
 * Derive the canonical captured-outcome label from a corpus entry (SSOT classifier).
 *
 * Priority: fixture label wins over reviewer outcome, reviewer outcome wins over
 * deterministic outcome, absent evidence becomes `no-captured-outcome`. Behavior is
 * byte-for-byte compatible with the previous `ratchet.ts` implementation —
 * `test/replay/ratchet-core.test.ts` remains the parity guard.
 */
export function classifyCapturedOutcome(entry: CorpusEntry): CapturedOutcome {
  if (entry.expectedLabel !== undefined) {
    return {
      label: fixtureLabel(entry.expectedLabel),
      fixtureExpected: entry.expectedLabel,
    };
  }

  if (entry.reviewerOutcome !== undefined) {
    const reviewer = entry.reviewerOutcome;
    return {
      label: reviewerLabel(reviewer.mode, reviewer.finalEffect),
      reviewer: {
        mode: reviewer.mode,
        finalEffect: reviewer.finalEffect,
      },
    };
  }

  if (entry.deterministicOutcome !== undefined) {
    return {
      label: deterministicLabel(entry.deterministicOutcome),
      deterministicEffect: entry.deterministicOutcome,
    };
  }

  return { label: "no-captured-outcome" };
}

/** Map a replayed DecisionEffect to the REFERENCE_PATTERNS status label. */
export function effectToStatus(effect: DecisionEffect): ReplayStatus {
  switch (effect) {
    case "allow":
      return "fast_path";
    case "deny":
      return "hard_block";
    case "review":
      return "review";
  }
}

function fixtureLabel(expected: CorpusExpectedLabel): CapturedOutcomeLabel {
  switch (expected) {
    case "fast_path":
      return "fixture-fast-path";
    case "review":
      return "fixture-review";
    case "hard_block":
      return "fixture-hard-block";
  }
}

function reviewerLabel(
  mode: ReviewerMode,
  finalEffect: DecisionEffect,
): CapturedOutcomeLabel {
  if (mode === "block-and-log") {
    return "block-and-log";
  }

  if (mode === "model") {
    switch (finalEffect) {
      case "allow":
        return "model-allow";
      case "deny":
        return "model-deny";
      case "review":
        return "model-review";
    }
  }

  if (finalEffect === "allow") {
    return "human-allow";
  }

  // A human `review` final effect is not an approval, so it is denial evidence.
  return "human-deny";
}

function deterministicLabel(effect: DecisionEffect): CapturedOutcomeLabel {
  switch (effect) {
    case "allow":
      return "deterministic-allow";
    case "deny":
      return "deterministic-deny";
    case "review":
      return "deterministic-review";
  }
}

// ---------------------------------------------------------------------------
// JSON-compatible count primitives
// ---------------------------------------------------------------------------
//
// New summaries use arrays of { label, calls, uniqueCommands? } rather than
// `ReadonlyMap` so Pi ratchet tools can return structured data directly and
// `JSON.stringify` works without custom Map handling. Legacy `RatchetReport`
// adapts these arrays back to `ReadonlyMap` until downstream consumers migrate.

export interface CountByLabel<TLabel extends string> {
  readonly label: TLabel;
  readonly calls: number;
  /** Distinct-command count; optional and computed by family summaries, not by `countByLabel`. */
  readonly uniqueCommands?: number;
}

/**
 * Count occurrences of each label in `values`. Returns one `CountByLabel` per
 * label in `labels` order, omitting zero-count labels so JSON summaries stay
 * compact and parity with the legacy sorted-outcome map holds.
 */
export function countByLabel<TLabel extends string>(
  labels: readonly TLabel[],
  values: readonly TLabel[],
): readonly CountByLabel<TLabel>[] {
  const counts = new Map<TLabel, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const result: CountByLabel<TLabel>[] = [];
  for (const label of labels) {
    const calls = counts.get(label);
    if (calls !== undefined && calls > 0) {
      result.push({ label, calls });
    }
  }
  return result;
}

/**
 * Re-sort an arbitrary counts array into the canonical `order`, dropping labels
 * not present in `order` and omitting zero-call entries. Preserves
 * `uniqueCommands` (and any other fields) by carrying the whole entry through,
 * so family summaries that pre-compute distinct-command counts are not lossy.
 *
 * Duplicate labels (unexpected for canonical enumerations) are last-wins. This is
 * a deterministic normalizer, not a merger — callers should not rely on summing.
 */
export function sortCountsByOrder<TLabel extends string>(
  counts: readonly CountByLabel<TLabel>[],
  order: readonly TLabel[],
): readonly CountByLabel<TLabel>[] {
  const byLabel = new Map<TLabel, CountByLabel<TLabel>>();
  for (const entry of counts) {
    if (entry.calls > 0) {
      byLabel.set(entry.label, entry);
    }
  }

  const result: CountByLabel<TLabel>[] = [];
  for (const label of order) {
    const entry = byLabel.get(label);
    if (entry !== undefined) {
      result.push(entry);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Stable corpus record model types
// ---------------------------------------------------------------------------

/** Deterministic identifier for a single corpus occurrence within a build. */
export type CorpusRecordId = string;

/** Per-occurrence tool-call identity, preserved when the report groups by command. */
export interface ToolCallIdentity {
  readonly recordId: CorpusRecordId;
  readonly toolName: string;
  readonly command: string;
  /** Original structured tool input when available; replay analyzers use it for non-bash tools. */
  readonly toolInput?: unknown;
  readonly toolCallId?: string;
  readonly sessionId?: string;
  readonly timestamp?: string;
}

/**
 * Source provenance AND quality, kept together so ratchet tools can answer
 * "which calls remain noisy because evidence is redacted or low fidelity?"
 *
 * `redacted` mirrors `fidelity === "redacted"`; `lowFidelityReasons` explains why
 * (e.g. an audit-only entry recovered without a matching session call).
 */
export interface SourceFidelity {
  readonly source: CorpusSource;
  readonly sources: readonly CorpusSource[];
  readonly provenance: string;
  readonly fidelity: CorpusFidelity;
  readonly redacted: boolean;
  readonly lowFidelityReasons: readonly string[];
}

/** Compact, JSON-compatible summary of a parsed command shape (see command-family story). */
export interface ParsedShapeSummary {
  readonly toolKind: ToolShape["kind"] | "parser-error";
  readonly primaryExecutable?: string;
  readonly toolOperation?: PiBuiltinToolOperation;
  readonly arguments: readonly string[];
  readonly flags: readonly string[];
  readonly operatorShape: readonly string[];
  readonly hasSubstitution: boolean;
  readonly hasStdoutRedirect: boolean;
  readonly diagnosticCodes: readonly string[];
  readonly parseError?: string;
}

/**
 * Parsed evidence retained per occurrence; `shape` is the full parsed structure.
 *
 * `pathFacts` is stamped when path-fact enrichment ran for this record's bash or
 * typed Pi-tool shape (see `buildCorpusQueryModel`'s `pathFacts` option). It
 * decouples the unknown-path signal — which replay-delta counts separately from
 * unknown-tool records — from `includeFullShape` debug retention: a lean build
 * with a path-fact context still carries `pathFacts` without the full `shape`.
 * Absent for unknown-tool records, parser-error records, and un-enriched builds.
 * JSON-serializable: no functions, Sets, or Maps.
 */
export interface ParsedEvidence {
  readonly shape?: ToolShape;
  readonly summary: ParsedShapeSummary;
  readonly diagnostics: readonly ShapeDiagnostic[];
  readonly pathFacts?: BashPathFacts | ToolPathFacts;
}

/** What current effective policy says now after parsing and `decide()`. */
export interface ReplayedDecision {
  readonly decision: Decision;
  readonly status: ReplayStatus;
  readonly provenance: DecisionProvenance;
  readonly ruleId?: string;
}

/**
 * Deterministic analysis label that groups friction such as `bash/git/status`
 * or `bash/pnpm/test`. A lossy label only — never the safety predicate for an
 * allow rule. Family derivation lives in the command-family story; this story
 * only names the shape.
 */
export interface CommandFamilyKey {
  readonly id: string;
  readonly toolName: string;
  readonly kind: "bash" | "pi-tool" | "unknown-tool" | "parser-error";
  readonly executable?: string;
  readonly semanticArgument?: string;
  readonly operation?: PiBuiltinToolOperation;
  readonly operatorShape: readonly string[];
  readonly hasSubstitution: boolean;
  readonly hasStdoutRedirect: boolean;
  readonly hasParseDiagnostics: boolean;
}

/** Stable per-occurrence corpus record consumed by query, proposal, and render code. */
export interface CorpusRecord {
  readonly id: CorpusRecordId;
  readonly identity: ToolCallIdentity;
  readonly source: SourceFidelity;
  readonly command: string;
  readonly toolName: string;
  readonly captured: CapturedOutcome;
  readonly parsed: ParsedEvidence;
  readonly replayed: ReplayedDecision;
  readonly family: CommandFamilyKey;
  /** Original ingest entry retained for adapters, not for mutation. */
  readonly originalEntry: CorpusEntry;
}

// ---------------------------------------------------------------------------
// Record-id + source-fidelity builders
// ---------------------------------------------------------------------------

/**
 * Deterministic record id for a corpus occurrence. The content component is a
 * non-cryptographic hash of the entry's identity fields (toolName, command,
 * provenance, toolCallId, sessionId, timestamp) so the id is stable across
 * rebuilds and self-describing without embedding raw commands or paths. The
 * `index` is the collision-safe suffix: the query-model builder passes the
 * occurrence index, guaranteeing uniqueness within a build even when two
 * entries share every identity field (e.g. repeated fixture rows).
 */
export function recordIdForEntry(
  entry: CorpusEntry,
  index: number,
): CorpusRecordId {
  const identity = [
    entry.toolName,
    entry.command,
    entry.provenance,
    entry.toolCallId ?? "",
    entry.sessionId ?? "",
    entry.timestamp ?? "",
  ].join("\u0000");
  return `rec-${fnv1a32(identity)}-${index}`;
}

/**
 * Build a `SourceFidelity` from a corpus entry. `redacted` mirrors the entry's
 * fidelity; `lowFidelityReasons` surfaces why an occurrence is low fidelity so
 * ratchet tools can query noisy evidence without scraping reports.
 */
export function sourceFidelityForEntry(entry: CorpusEntry): SourceFidelity {
  return {
    source: entry.source,
    sources: entry.sources,
    provenance: entry.provenance,
    fidelity: entry.fidelity,
    redacted: entry.fidelity === "redacted",
    lowFidelityReasons: lowFidelityReasonsFor(entry),
  };
}

function lowFidelityReasonsFor(entry: CorpusEntry): readonly string[] {
  if (entry.fidelity !== "redacted") {
    return [];
  }

  if (entry.source === "audit" && !entry.sources.includes("session")) {
    return ["audit-only: command recovered without a matching session call"];
  }

  return ["redacted"];
}

/** FNV-1a 32-bit over a string, base-36 encoded. Deterministic and dependency-free. */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
