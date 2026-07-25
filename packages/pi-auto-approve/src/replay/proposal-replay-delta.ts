/**
 * Proposal replay-delta bridges — connect the typed replay-delta engine
 * ({@link buildReplayDeltaForPolicies}) to structured proposals, and serialize
 * the legacy pack-validation {@link PackReplayImpactSummary} into the typed,
 * JSON-compatible {@link ReplayDelta} transport.
 *
 * This module is the THIN ADAPTER LAYER between proposal kinds and the
 * pure comparison engine. It owns no comparison math of its own: it compiles a
 * candidate pack from a data-pack proposal's raw rule/match data, forwards
 * baseline/candidate path-fact contexts for project-scope proposals, serializes
 * pack-validation replay impact, and reports `not-run` for proposal kinds that
 * cannot be deterministically replayed. Every typed delta it returns is raw
 * JSON (arrays, not `Map`s; no `ReplayCompare`, no `PolicyRule`, no compiled
 * matcher functions) so it can land directly on
 * `StructuredRatchetProposal.evidence.replayDelta`.
 *
 * Safety boundary (preserved): replay is dry-run. The bridge never executes
 * captured commands, reads files, calls a model, writes config, or loads/
 * executes policy source. A `package-pack-enablement` candidate pack used for
 * core replay must be supplied already-compiled by its caller; this module only
 * inspects the `PolicyPack` object. A
 * `reviewer-config` proposal is explicitly `not-run` — reviewer prompt changes
 * require model evaluation, which is outside deterministic policy replay, and
 * the bridge never calls a model to simulate them.
 *
 * See the parent feature `epic-structured-ratchet-engine-replay-delta` (Unit 4)
 * for the supported proposal kinds and the compatibility decisions.
 */

import type { PackReplayImpactSummary } from "../packs/validation.ts";
import type {
  DecisionEffect,
  EffectivePolicy,
  PolicyPack,
} from "../policy/core.ts";
import {
  CAPTURED_OUTCOME_LABELS,
  REPLAY_STATUSES,
  type ReplayStatus,
} from "./corpus-model.ts";
import type { ReplayCorpus } from "./history.ts";
import { notRunWarning, proposalNotRunReason } from "./not-run-reasons.ts";
import {
  buildCandidatePolicyWithPack,
  buildDataPackCandidatePolicy,
} from "./proposal-candidate-policy.ts";
import type {
  CorpusQuerySummarySnapshot,
  ProposalNotRunReason,
  ReplayDelta,
  ReplayDeltaRegression,
  ReplayDeltaTransition,
  StructuredRatchetProposal,
} from "./proposal-schema.ts";
import { REPLAY_DELTA_SCHEMA_VERSION } from "./proposal-schema.ts";
import type { ReplaySummary } from "./ratchet.ts";
import {
  buildReplayDeltaForPolicies,
  computeReviewReductionPercent,
  isReplayRegressionTransition,
  type ReplayDeltaPathFactsContext,
  replayRegressionKindForTransition,
} from "./replay-delta.ts";

// ---------------------------------------------------------------------------
// Public input / result types
// ---------------------------------------------------------------------------

/**
 * Input to {@link replayStructuredProposal}. `proposal.kind` selects the
 * replay strategy; the remaining fields feed the kind-specific path:
 *
 * - `data-pack-policy`: the bridge compiles a candidate pack from
 *   `proposal.change` raw rule/match data (or uses `candidatePack` when the
 *   caller already compiled one), appends it to `baselinePolicy.active`, and
 *   replays. `pathFacts` may be supplied so path-scoped candidate allows fire.
 * - `project-scope-config`: the proposal changes path scope, not policy.
 *   `candidatePolicy` equals `baselinePolicy`; the caller supplies distinct
 *   `pathFacts.baseline` / `pathFacts.candidate` contexts produced by config
 *   proposal validation. The bridge never invents contexts from the patch.
 * - `package-pack-enablement`: supply `packReplayImpact` to serialize an
 *   existing pack-validation summary, OR supply `candidatePack` (+ corpus +
 *   baseline policy) to replay the enabled pack through the core engine. The
 *   bridge never loads or executes policy source.
 * - `reviewer-config` / `pack-file-authoring`: deterministic replay is
 *   unsupported; the bridge returns `not-run` regardless of the other fields.
 *
 * `corpus` and `baselinePolicy` are required for any kind that runs the core
 * engine. They are ignored for `not-run` kinds (reviewer-config,
 * pack-file-authoring) but kept required on the shared input so callers build
 * one consistent context object per replay request.
 */
export interface ReplayStructuredProposalInput {
  readonly proposal: StructuredRatchetProposal;
  readonly corpus: ReplayCorpus;
  readonly baselinePolicy: EffectivePolicy;
  /** Replayed effect for non-bash records; defaults to `review`. */
  readonly unknownToolPosture?: DecisionEffect;
  readonly sampleLimit?: number;
  readonly changedRecordLimit?: number;
  readonly includeFullShape?: boolean;
  /**
   * data-pack-policy / package-pack-enablement: an already-compiled candidate
   * pack. For data-pack, skips compilation from `proposal.change`; for
   * package-pack-enablement, enables core replay through the new engine.
   */
  readonly candidatePack?: PolicyPack;
  /**
   * package-pack-enablement: an existing {@link PackReplayImpactSummary} from
   * pack validation. Serialized to a typed {@link ReplayDelta} without leaking
   * its `Map`/`ReplayCompare` runtime fields.
   */
  readonly packReplayImpact?: PackReplayImpactSummary;
  /**
   * data-pack-policy / project-scope-config: distinct baseline/candidate
   * path-fact contexts. For project-scope proposals the candidate context
   * reflects the proposed scope; baseline reflects the current scope.
   */
  readonly pathFacts?: ReplayDeltaPathFactsContext;
}

/**
 * Result of {@link replayStructuredProposal}. `ok` distinguishes "replay ran"
 * from "replay not-run" — a `regression` delta is a successful computation
 * (`ok: true`, `delta.status === "regression"`), not a failure. `ok: false`
 * carries a `not-run` delta plus a `reason` explaining why deterministic replay
 * was not possible (unsupported kind, missing inputs, compile failure).
 */
export type ReplayStructuredProposalResult =
  | {
      readonly ok: true;
      readonly proposal: StructuredRatchetProposal;
      readonly delta: ReplayDelta;
    }
  | {
      readonly ok: false;
      readonly proposal: StructuredRatchetProposal;
      readonly delta: ReplayDelta;
      readonly reason: string;
    };

// ---------------------------------------------------------------------------
// replayStructuredProposal — kind dispatch
// ---------------------------------------------------------------------------

/**
 * Replay a structured proposal into a typed {@link ReplayDelta} without
 * applying or writing any config. Dispatches on `proposal.kind`; see
 * {@link ReplayStructuredProposalInput} for the per-kind contract.
 *
 * Never executes commands, calls a model, or loads policy source. The
 * returned delta is raw JSON and may be attached directly to
 * `StructuredRatchetProposal.evidence.replayDelta`.
 */
export async function replayStructuredProposal(
  input: ReplayStructuredProposalInput,
): Promise<ReplayStructuredProposalResult> {
  const { proposal } = input;
  switch (proposal.kind) {
    case "data-pack-policy":
      return replayDataPackPolicyProposal(input);
    case "project-scope-config":
      return replayProjectScopeConfigProposal(input);
    case "package-pack-enablement":
      return replayPackagePackEnablementProposal(input);
    case "reviewer-config":
      return notRunResult(
        proposal,
        proposalNotRunReason({
          code: "model-evaluation-required",
          message:
            "reviewer-config proposals cannot be deterministically replayed; reviewer prompt changes require model evaluation outside dry-run policy replay",
        }),
      );
    case "pack-file-authoring":
      return notRunResult(
        proposal,
        proposalNotRunReason({
          code: "design-input-only",
          message:
            "pack-file-authoring proposals are design-input-only and cannot be deterministically replayed against captured corpus",
        }),
      );
    default:
      return notRunResult(
        proposal,
        proposalNotRunReason({
          code: "unsupported-kind",
          message: `unsupported proposal kind "${proposal.kind}" for deterministic replay`,
        }),
      );
  }
}

// ---------------------------------------------------------------------------
// data-pack-policy
// ---------------------------------------------------------------------------

/**
 * Replay a `data-pack-policy` proposal by delegating candidate-pack
 * construction to `proposal-candidate-policy`, then comparing baseline vs
 * candidate through the core engine. This keeps dry-run replay and adversarial
 * validation on the same raw proposal-to-pack behavior.
 *
 * Never applies or writes config: the shared helper allocates a fresh `active`
 * array and shares the floor by reference, so `baselinePolicy` is never
 * mutated, and no file write occurs. Compile failure yields a `not-run` delta
 * carrying the compiler errors.
 */
async function replayDataPackPolicyProposal(
  input: ReplayStructuredProposalInput,
): Promise<ReplayStructuredProposalResult> {
  const { proposal } = input;
  const candidate = buildDataPackCandidatePolicy({
    proposal,
    baselinePolicy: input.baselinePolicy,
    ...(input.candidatePack === undefined
      ? {}
      : { candidatePack: input.candidatePack }),
  });
  if (!candidate.ok) {
    return notRunResult(
      proposal,
      proposalNotRunReason({
        code: "compile-failed",
        message: candidate.reason,
      }),
    );
  }

  const delta = await buildReplayDeltaForPolicies(
    deltaBuildInput(input, candidate.candidatePolicy),
  );
  return { ok: true, proposal, delta };
}

// ---------------------------------------------------------------------------
// project-scope-config
// ---------------------------------------------------------------------------

/**
 * Replay a `project-scope-config` proposal with distinct baseline/candidate
 * path-fact contexts. The proposal changes the resolved project scope, not the
 * policy object, so `candidatePolicy` equals `baselinePolicy` and the delta
 * arises purely from the path-fact contexts the caller supplies.
 *
 * The bridge accepts ALREADY-RESOLVED baseline/candidate contexts (produced by
 * config proposal validation) and never invents config from the proposal's
 * unvalidated patch. When no candidate path-fact context is supplied, replay is
 * `not-run`: a project-scope proposal without a resolved candidate scope has no
 * deterministic replay inputs.
 */
async function replayProjectScopeConfigProposal(
  input: ReplayStructuredProposalInput,
): Promise<ReplayStructuredProposalResult> {
  const { proposal } = input;
  if (proposal.change.kind !== "project-scope-config") {
    return notRunResult(
      proposal,
      proposalNotRunReason({
        code: "unsupported-kind",
        message: `project-scope-config replay expected change kind "project-scope-config", got "${proposal.change.kind}"`,
      }),
    );
  }

  const pathFacts = input.pathFacts;
  if (pathFacts === undefined || pathFacts.candidate === undefined) {
    return notRunResult(
      proposal,
      proposalNotRunReason({
        code: "missing-path-facts",
        message:
          "project-scope-config replay requires a candidate path-fact context (baseline/candidate) produced by config proposal validation; none was supplied",
      }),
    );
  }

  // Policy is unchanged for a project-scope proposal; the candidate differs
  // from the baseline only in path-fact context. Forward both contexts so the
  // core engine enriches each build with its own scope.
  const delta = await buildReplayDeltaForPolicies(
    deltaBuildInput(input, input.baselinePolicy),
  );
  return { ok: true, proposal, delta };
}

// ---------------------------------------------------------------------------
// package-pack-enablement
// ---------------------------------------------------------------------------

/**
 * Replay a `package-pack-enablement` proposal.
 *
 * Two supported paths, in priority order:
 * 1. An existing {@link PackReplayImpactSummary} is supplied → serialize it to
 *    a typed {@link ReplayDelta} via {@link packReplayImpactToReplayDelta}.
 *    This preserves the acknowledgement/writer boundary: the impact is evidence
 *    only, and serializing it leaks no `Map` or `ReplayCompare` runtime field.
 * 2. A caller-supplied already-compiled `candidatePack` (+ corpus + baseline
 *    policy) → replay the enabled pack through the core engine
 *    ({@link buildReplayDeltaForPolicies}).
 *
 * The bridge never loads or executes policy source. An enablement candidate must
 * arrive as an already-compiled `PolicyPack` from its caller; this module only
 * inspects the object.
 * When neither path has its inputs, replay is `not-run`.
 */
async function replayPackagePackEnablementProposal(
  input: ReplayStructuredProposalInput,
): Promise<ReplayStructuredProposalResult> {
  const { proposal } = input;
  if (proposal.change.kind !== "package-pack-enablement") {
    return notRunResult(
      proposal,
      proposalNotRunReason({
        code: "unsupported-kind",
        message: `package-pack-enablement replay expected change kind "package-pack-enablement", got "${proposal.change.kind}"`,
      }),
    );
  }

  const impact = input.packReplayImpact;
  if (impact !== undefined) {
    const delta = packReplayImpactToReplayDelta(impact);
    if (delta.status === "not-run") {
      return {
        ok: false,
        proposal,
        delta,
        reason:
          delta.notRun?.message ??
          "package-pack-enablement replay carried a not-run impact summary; no deterministic replay was performed",
      };
    }
    return { ok: true, proposal, delta };
  }

  const candidatePack = input.candidatePack;
  if (candidatePack !== undefined) {
    const candidatePolicy = buildCandidatePolicyWithPack(
      input.baselinePolicy,
      candidatePack,
    );
    const delta = await buildReplayDeltaForPolicies(
      deltaBuildInput(input, candidatePolicy),
    );
    return { ok: true, proposal, delta };
  }

  return notRunResult(
    proposal,
    proposalNotRunReason({
      code: "missing-candidate-pack",
      message:
        "package-pack-enablement replay requires either a PackReplayImpactSummary or a compiled candidate pack plus corpus/policy; none was supplied",
    }),
  );
}

// ---------------------------------------------------------------------------
// packReplayImpactToReplayDelta — bridge serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a legacy {@link PackReplayImpactSummary} into the typed,
 * JSON-compatible {@link ReplayDelta} transport.
 *
 * The summary carries runtime `Map` (`changedStatuses`) and a raw
 * {@link ReplayCompare} that must never cross into proposal transport. This
 * helper projects them into arrays and typed snapshots so the result can land
 * directly on `StructuredRatchetProposal.evidence.replayDelta` and survive
 * `proposalJsonRoundTrip` without a custom replacer.
 *
 * Regression classification and effect-direction prose match the core engine
 * ({@link isReplayRegressionTransition} / {@link replayRegressionKindForTransition})
 * and pack validation's `replay-impact-regression` wording: each regression
 * transition with calls > 0 becomes one {@link ReplayDeltaRegression} whose
 * message reuses the matching pack-validation issue message when present.
 *
 * `changedFamilies` and `changedRecords` are empty here: the legacy summary
 * groups by exact command string and does not carry per-family or per-record
 * detail, so the bridge emits the aggregate transition/regression/improvement
 * fields honestly and leaves the family/record arrays empty rather than
 * fabricating them.
 */
export function packReplayImpactToReplayDelta(
  impact: PackReplayImpactSummary,
): ReplayDelta {
  const compare = impact.compare;
  const baseline = summarySnapshot(compare?.beforeSummary);
  const candidate = summarySnapshot(compare?.afterSummary);
  const reviewToHardBlock =
    impact.changedStatuses.get("review->hard_block") ?? 0;
  const baselineReviewCalls = compare?.beforeSummary.reviewCalls ?? 0;
  const remainingReviewCalls = candidateStatusCalls(candidate, "review");
  const legacyHardBlockCalls = candidateStatusCalls(candidate, "hard_block");
  const reviewReductionPercent = computeReviewReductionPercent(
    baselineReviewCalls,
    remainingReviewCalls,
  );

  const notRun =
    impact.status === "not-run"
      ? proposalNotRunReason({
          code: "replay-impact-not-run",
          message: "replay impact was not run",
        })
      : undefined;

  return {
    version: REPLAY_DELTA_SCHEMA_VERSION,
    status: impact.status,
    ...(notRun === undefined ? {} : { notRun }),
    baseline,
    candidate,
    changedCalls: impact.changedCalls,
    changedUniqueCommands: impact.changedUnique,
    transitions: replayDeltaTransitionCounts(impact),
    improvement: {
      reviewToAllowCalls: impact.reviewToAllow,
      reviewToAllowUniqueCommands: uniqueCommandsForTransition(
        "review->fast_path",
        impact,
      ),
      reviewReductionPercent,
      remainingReviewCalls,
      unchangedReviewCalls: Math.max(
        0,
        baselineReviewCalls - impact.reviewToAllow - reviewToHardBlock,
      ),
    },
    blocked: {
      unknownToolCalls: 0,
      unknownPathCalls: null,
      sealedFloorBlockCalls: 0,
      activeDenyBlockCalls: 0,
      lowFidelityCalls: 0,
      redactedCalls: candidate.redactedCalls,
    },
    regressions: replayDeltaRegressions(impact),
    changedFamilies: [],
    changedRecords: [],
    warnings: replayDeltaWarnings(impact, legacyHardBlockCalls),
  };
}

// ---------------------------------------------------------------------------
// packReplayImpactToReplayDelta helpers (moved from pack-enablement-proposal.ts;
// regression classification delegates to the exported replay-delta helpers)
// ---------------------------------------------------------------------------

function summarySnapshot(
  summary: ReplaySummary | undefined,
): CorpusQuerySummarySnapshot {
  if (summary === undefined) {
    return {
      totalRecords: 0,
      totalUniqueCommands: 0,
      replayStatusCounts: [],
      capturedOutcomeCounts: [],
      sourceCounts: [],
      modelReviewLoad: { calls: 0, uniqueCommands: 0 },
      lowFidelityCalls: 0,
      redactedCalls: 0,
      unmatchedAuditEntries: 0,
    };
  }

  const statusCalls = {
    fast_path: {
      calls: summary.fastPathCalls,
      uniqueCommands: summary.fastPathUnique,
    },
    review: {
      calls: summary.reviewCalls,
      uniqueCommands: summary.reviewUnique,
    },
    hard_block: {
      calls: summary.hardBlockCalls,
      uniqueCommands: summary.hardBlockUnique,
    },
  };

  return {
    totalRecords: summary.totalCalls,
    totalUniqueCommands: summary.totalUnique,
    replayStatusCounts: REPLAY_STATUSES.flatMap((label) => {
      const count = statusCalls[label];
      return count.calls > 0 ? [{ label, ...count }] : [];
    }),
    capturedOutcomeCounts: CAPTURED_OUTCOME_LABELS.flatMap((label) => {
      const tally = summary.byCapturedOutcome.get(label);
      return tally === undefined || tally.calls <= 0
        ? []
        : [
            {
              label,
              calls: tally.calls,
              uniqueCommands: tally.unique,
            },
          ];
    }),
    sourceCounts: [],
    modelReviewLoad: {
      calls: summary.modelReviewLoad.calls,
      uniqueCommands: summary.modelReviewLoad.unique,
    },
    lowFidelityCalls: 0,
    redactedCalls: summary.redactedCalls,
    unmatchedAuditEntries: 0,
  };
}

function replayDeltaTransitionCounts(
  impact: PackReplayImpactSummary,
): ReplayDelta["transitions"] {
  // The summary's changedStatuses Map preserves its own (count-sorted) order;
  // the bridge preserves that order rather than re-canonicalizing so the
  // serialized transitions match what pack validation already surfaced.
  return [...impact.changedStatuses.entries()].map(([transition, calls]) => ({
    transition,
    calls,
    uniqueCommands: uniqueCommandsForTransition(transition, impact),
  }));
}

function replayDeltaRegressions(
  impact: PackReplayImpactSummary,
): readonly ReplayDeltaRegression[] {
  return [...impact.changedStatuses.entries()].flatMap(
    ([transition, calls]) => {
      if (calls <= 0 || !isReplayRegressionTransition(transition)) {
        return [];
      }

      return [
        {
          transition,
          kind: replayRegressionKindForTransition(transition),
          calls,
          uniqueCommands: uniqueCommandsForTransition(transition, impact),
          message:
            impact.issues.find((issue) => issue.message.includes(transition))
              ?.message ??
            `replay regression: candidate would shift ${calls} command call(s) ${transition}`,
        },
      ];
    },
  );
}

function replayDeltaWarnings(
  impact: PackReplayImpactSummary,
  legacyHardBlockCalls: number,
): readonly string[] {
  const warnings = impact.issues.map((issue) => issue.message);
  if (impact.status === "not-run") {
    warnings.push("replay impact was not run");
  }
  if (legacyHardBlockCalls > 0) {
    warnings.push(
      "legacy pack replay impact does not expose sealed-floor vs active-deny block attribution; sealedFloorBlockCalls and activeDenyBlockCalls are reported as 0",
    );
  }
  return warnings;
}

/**
 * Unique-command count for one transition. The legacy summary carries a single
 * `changedUnique` total and a per-expansion `expansions.unique`; when only one
 * transition occurred it equals the total, and for `review->fast_path` the
 * expansion unique is available. All other transitions report `0` unique
 * commands honestly (the summary does not partition unique counts per
 * transition).
 */
function uniqueCommandsForTransition(
  transition: ReplayDeltaTransition,
  impact: PackReplayImpactSummary,
): number {
  if (impact.changedStatuses.size === 1) {
    return impact.changedUnique;
  }

  if (transition === "review->fast_path") {
    return impact.compare?.expansions.unique ?? 0;
  }

  return 0;
}

function candidateStatusCalls(
  snapshot: CorpusQuerySummarySnapshot,
  status: ReplayStatus,
): number {
  return (
    snapshot.replayStatusCounts.find((count) => count.label === status)
      ?.calls ?? 0
  );
}

// ---------------------------------------------------------------------------
// Shared build-option + not-run helpers
// ---------------------------------------------------------------------------

/**
 * Forward the shared build options to {@link buildReplayDeltaForPolicies}.
 * Optional fields are omitted when absent so the core engine's own defaults
 * apply (unknownToolPosture, pathFacts, sample/record limits).
 */
function deltaBuildInput(
  input: ReplayStructuredProposalInput,
  candidatePolicy: EffectivePolicy,
) {
  return {
    corpus: input.corpus,
    baselinePolicy: input.baselinePolicy,
    candidatePolicy,
    ...(input.unknownToolPosture === undefined
      ? {}
      : { unknownToolPosture: input.unknownToolPosture }),
    ...(input.sampleLimit === undefined
      ? {}
      : { sampleLimit: input.sampleLimit }),
    ...(input.changedRecordLimit === undefined
      ? {}
      : { changedRecordLimit: input.changedRecordLimit }),
    ...(input.includeFullShape === undefined
      ? {}
      : { includeFullShape: input.includeFullShape }),
    ...(input.pathFacts === undefined ? {} : { pathFacts: input.pathFacts }),
  };
}

/**
 * Build a `not-run` {@link ReplayDelta} with zero tallies and a warning per
 * supplied message. Used for unsupported proposal kinds, missing inputs, and
 * compile failures. The delta is schema-valid and JSON-compatible.
 */
function notRunReplayDelta(reason: ProposalNotRunReason): ReplayDelta {
  const empty = emptySummarySnapshot();
  return {
    version: REPLAY_DELTA_SCHEMA_VERSION,
    status: "not-run",
    notRun: reason,
    baseline: empty,
    candidate: empty,
    changedCalls: 0,
    changedUniqueCommands: 0,
    transitions: [],
    improvement: {
      reviewToAllowCalls: 0,
      reviewToAllowUniqueCommands: 0,
      reviewReductionPercent: null,
      remainingReviewCalls: 0,
      unchangedReviewCalls: 0,
    },
    blocked: {
      unknownToolCalls: 0,
      unknownPathCalls: null,
      sealedFloorBlockCalls: 0,
      activeDenyBlockCalls: 0,
      lowFidelityCalls: 0,
      redactedCalls: 0,
    },
    regressions: [],
    changedFamilies: [],
    changedRecords: [],
    warnings: [notRunWarning(reason)],
  };
}

function emptySummarySnapshot(): CorpusQuerySummarySnapshot {
  return {
    totalRecords: 0,
    totalUniqueCommands: 0,
    replayStatusCounts: [],
    capturedOutcomeCounts: [],
    sourceCounts: [],
    modelReviewLoad: { calls: 0, uniqueCommands: 0 },
    lowFidelityCalls: 0,
    redactedCalls: 0,
    unmatchedAuditEntries: 0,
  };
}

function notRunResult(
  proposal: StructuredRatchetProposal,
  reason: ProposalNotRunReason,
): ReplayStructuredProposalResult {
  return {
    ok: false,
    proposal,
    delta: notRunReplayDelta(reason),
    reason: reason.message,
  };
}
