/**
 * Replay delta orchestration over an acquired corpus and two native policy handles.
 * TypeScript keeps the acquisition and proposal adapters; Rust owns parsing,
 * enrichment, decisions, alignment, and delta aggregation.
 *
 * Safety boundary: captured commands are analyzed, never executed. The native
 * kernel does not read files, call a model, or write config.
 *
 * Regression classification is identical to current pack-validation semantics (see
 * `src/packs/validation.ts` → `summarizeReplayCompare` / `REGRESSION_TRANSITIONS`):
 * - expansion: `review->fast_path` (desired ratchet outcome).
 * - safe tightening: `review->hard_block`.
 * - regression: `hard_block->fast_path`, `hard_block->review`, `fast_path->review`,
 *   `fast_path->hard_block`.
 * - unchanged: identity transitions.
 * The classifier and regression-kind helpers are exported here so pack validation can
 * adopt one source later without an API break in this story.
 *
 * Path-scope evidence is conditional: when a caller supplies a candidate path-fact
 * context, native replay enriches shapes before evaluating and reports unknown-path
 * calls. Without one, the result reports `unknownPathCalls: null` honestly.
 */
import type { PathFactsResolvedConfig } from "../parse/native-path-facts.ts";
import type { DecisionEffect, EffectivePolicy } from "../policy/core.ts";
import type { ReplayCorpus } from "./history.ts";
import {
  buildNativeReplayDelta,
  type NativeReplayKernelOptions,
} from "./native-kernels.ts";
import type {
  ReplayDelta,
  ReplayDeltaRegressionKind,
  ReplayDeltaRegressionTransition,
  ReplayDeltaTransition,
} from "./proposal-schema.ts";
import { REPLAY_DELTA_REGRESSION_TRANSITIONS } from "./proposal-schema.ts";

// ---------------------------------------------------------------------------
// Public options + input types
// ---------------------------------------------------------------------------

/**
 * Distinct baseline/candidate path-fact contexts for replay delta. Supplying a
 * candidate context enables path-fact enrichment of the candidate build so
 * path-scoped matchers see the same `shape.pathFacts` the runtime produces, and
 * `unknownPathCalls` is counted (number) instead of reported as `null`.
 *
 * Baseline and candidate contexts may differ so a `project-scope-config`
 * proposal — which changes the resolved project scope, not the policy object —
 * can be replayed accurately: the candidate context reflects the proposed scope
 * while the baseline reflects the current scope. Omit both to preserve the
 * no-context behavior (`unknownPathCalls: null` plus a warning).
 */
export interface ReplayDeltaPathFactsContext {
  readonly baseline?: PathFactsResolvedConfig;
  readonly candidate?: PathFactsResolvedConfig;
}

/** Build options shared by the policy-input entry point and direct model comparison. */
export interface ReplayDeltaBuildOptions {
  readonly sampleLimit?: number;
  readonly changedRecordLimit?: number;
  /** Replayed effect for unsupported tools; defaults to `review`. */
  readonly unknownToolPosture?: DecisionEffect;
  /**
   * Retain the full `ToolShape` on each record. The delta does not need it; forwarded
   * for future proposal-bridge consumers that read shapes. Default `false`.
   */
  readonly includeFullShape?: boolean;
  /** Native path-fact contexts for baseline and candidate replay lanes. */
  readonly pathFacts?: ReplayDeltaPathFactsContext;
}

/** Input to {@link buildReplayDeltaForPolicies}: one corpus, two policies. */
export interface ReplayDeltaPolicyInput extends ReplayDeltaBuildOptions {
  readonly corpus: ReplayCorpus;
  readonly baselinePolicy: EffectivePolicy;
  readonly candidatePolicy: EffectivePolicy;
}

/** Coarse classification of a single status transition. */
export type ReplayTransitionClass =
  | "expansion"
  | "safe-tightening"
  | "regression"
  | "unchanged";

// ---------------------------------------------------------------------------
// Transition / regression helpers (shared; usable later by pack validation)
// ---------------------------------------------------------------------------

/**
 * Classify a status transition into a coarse bucket. Matches current pack-validation
 * semantics exactly: `review->fast_path` is the desired expansion,
 * `review->hard_block` is a safe tightening, the four
 * {@link REPLAY_DELTA_REGRESSION_TRANSITIONS} are regressions, and identity
 * transitions are unchanged.
 */
export function classifyReplayTransition(
  transition: ReplayDeltaTransition,
): ReplayTransitionClass {
  if (isReplayRegressionTransition(transition)) {
    return "regression";
  }
  if (transition === "review->fast_path") {
    return "expansion";
  }
  if (transition === "review->hard_block") {
    return "safe-tightening";
  }
  return "unchanged";
}

/**
 * Type guard for the four regression transitions. Exported so pack validation can
 * reuse one source instead of re-declaring the literal set.
 */
export function isReplayRegressionTransition(
  transition: string,
): transition is ReplayDeltaRegressionTransition {
  return (REPLAY_DELTA_REGRESSION_TRANSITIONS as readonly string[]).includes(
    transition,
  );
}

/**
 * Map a regression transition to its effect-direction kind. Mirrors the
 * `deny-to-allow` / `deny-to-review` / `allow-to-review` / `allow-to-deny` prose used
 * by pack-validation regression messages.
 */
export function replayRegressionKindForTransition(
  transition: ReplayDeltaRegressionTransition,
): ReplayDeltaRegressionKind {
  switch (transition) {
    case "hard_block->fast_path":
      return "deny-to-allow";
    case "hard_block->review":
      return "deny-to-review";
    case "fast_path->review":
      return "allow-to-review";
    case "fast_path->hard_block":
      return "allow-to-deny";
  }
}

// ---------------------------------------------------------------------------
// buildReplayDeltaForPolicies
// ---------------------------------------------------------------------------

/**
 * Build a {@link ReplayDelta} through the native replay kernel. Corpus acquisition
 * remains TypeScript; parsing, enrichment, decisions, and delta aggregation stay
 * inside the Rust core so no comparator implementation remains in production.
 */
export async function buildReplayDeltaForPolicies(
  input: ReplayDeltaPolicyInput,
): Promise<ReplayDelta> {
  return buildNativeReplayDelta({
    corpus: input.corpus,
    baselinePolicy: input.baselinePolicy,
    candidatePolicy: input.candidatePolicy,
    options: nativeDeltaOptions(input),
  });
}

function nativeDeltaOptions(
  input: ReplayDeltaPolicyInput,
): NativeReplayKernelOptions {
  return {
    ...(input.unknownToolPosture === undefined
      ? {}
      : { unknownToolPosture: input.unknownToolPosture }),
    ...(input.includeFullShape === undefined
      ? {}
      : { includeFullShape: input.includeFullShape }),
    ...(input.sampleLimit === undefined
      ? {}
      : { sampleLimit: input.sampleLimit }),
    ...(input.changedRecordLimit === undefined
      ? {}
      : { changedRecordLimit: input.changedRecordLimit }),
    ...(input.pathFacts === undefined ? {} : { pathFacts: input.pathFacts }),
  };
}

/**
 * Review-load reduction as a percentage of the baseline review-call denominator.
 * Returns `null` when the baseline had no review calls (no meaningful denominator),
 * clamped to `[0, 100]`. Computed by calls over the id-aligned set; unique counts
 * sit beside it in `reviewToAllowUniqueCommands`.
 */
export function computeReviewReductionPercent(
  baselineReview: number,
  candidateReview: number,
): number | null {
  if (baselineReview === 0) {
    return null;
  }
  const percent = Math.round(
    ((baselineReview - candidateReview) / baselineReview) * 100,
  );
  if (percent < 0) {
    return 0;
  }
  if (percent > 100) {
    return 100;
  }
  return percent;
}
