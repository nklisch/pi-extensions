import type {
  AgentToolResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { validateProjectScopeConfig } from "../../config/loader.ts";
import type { ProjectOverlayConfig } from "../../config/schema.ts";
import type { PathFactsResolvedConfig } from "../../parse/native-path-facts.ts";
import type { ReplayCorpus } from "../../replay/history.ts";
import {
  proposalNotRunReason,
  validationStatusForNotRunReason,
} from "../../replay/not-run-reasons.ts";
import { getStructuredProposal } from "../../replay/proposal-batch.ts";
import {
  replayStructuredProposal as defaultReplayStructuredProposal,
  type ReplayStructuredProposalResult,
} from "../../replay/proposal-replay-delta.ts";
import {
  assertStructuredProposal,
  type ProposalValidationCheck,
  type ProposalValidationStatus,
  proposalJsonRoundTrip,
  type ReplayDelta,
  type StructuredProposalBatch,
  type StructuredRatchetProposal,
  validateStructuredProposal,
  validateStructuredProposalBatch,
} from "../../replay/proposal-schema.ts";
import { materializeRatchetProposalWritePlan } from "../../replay/proposal-write-plan.ts";
import type { ResolvedPolicy } from "../policy-cache.ts";
import type { RatchetToolDefinition } from "../ratchet-mode.ts";
import { readRatchetReplayCorpus, resolveRatchetPolicy } from "./analysis.ts";
import type { RatchetBatchCache } from "./batch-cache.ts";
import { RATCHET_TOOL_IDS } from "./ids.ts";
import {
  packageAvailabilityValidationCheck,
  packageNotRunReplayDelta,
  resolvePackageCandidateForProposal,
} from "./package-candidates.ts";
import {
  formatRatchetToolError,
  formatRatchetToolResult,
  throwIfAborted,
} from "./result.ts";
import type { RatchetToolDependencies } from "./types.ts";

const STRICT = { additionalProperties: false } as const;

export const AutoReviewerReplayProposalParameters = Type.Object(
  {
    batchId: Type.String({
      minLength: 1,
      description: "Cached structured proposal batch id.",
    }),
    proposalId: Type.String({ minLength: 1, description: "Proposal id." }),
    includeFullShape: Type.Optional(
      Type.Boolean({
        description:
          "Retain full parsed command shape while replaying, for debugging-heavy ratchet passes.",
      }),
    ),
    sampleLimit: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Maximum sample commands per changed family.",
      }),
    ),
    changedRecordLimit: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Maximum changed replay records returned in the delta.",
      }),
    ),
  },
  STRICT,
);

export interface ReplayProposalEngines {
  readonly readCorpus?: (ctx: ExtensionContext) => ReplayCorpus;
  readonly replayStructuredProposal?: typeof defaultReplayStructuredProposal;
}

export interface ReplayProposalRunOptions {
  readonly includeFullShape?: boolean;
  readonly sampleLimit?: number;
  readonly changedRecordLimit?: number;
}

export interface ReplayProposalRunResult {
  readonly replayOk: boolean;
  readonly delta: ReplayDelta;
  readonly updatedProposal: StructuredRatchetProposal;
  readonly validationCheck: ProposalValidationCheck;
  readonly warnings: readonly string[];
  readonly reason?: string;
}

export type AutoReviewerReplayProposalDetails =
  | {
      readonly found: true;
      readonly batchId: string;
      readonly proposalId: string;
      readonly replay: {
        readonly computed: boolean;
        readonly status: ReplayDelta["status"];
        readonly reason?: string;
      };
      readonly delta: ReplayDelta;
      readonly replayOk: boolean;
      readonly updated: boolean;
      readonly updatedProposal: StructuredRatchetProposal;
      readonly validationCheck: ProposalValidationCheck;
      readonly warnings: readonly string[];
    }
  | {
      readonly found: false;
      readonly batchId: string;
      readonly proposalId: string;
      readonly reason:
        | "invalid-input"
        | "batch-not-found"
        | "proposal-not-found";
      readonly message: string;
      readonly knownProposalIds: readonly string[];
      readonly replay: null;
      readonly delta: null;
      readonly replayOk: false;
      readonly updated: false;
      readonly updatedProposal: null;
      readonly validationCheck: null;
      readonly warnings: readonly string[];
    };

interface ParsedReplayParameters extends ReplayProposalRunOptions {
  readonly batchId: string;
  readonly proposalId: string;
  readonly warnings: readonly string[];
  readonly valid: boolean;
}

export function createAutoReviewerReplayProposalTool(
  deps: RatchetToolDependencies,
  batchCache: RatchetBatchCache,
  engines: ReplayProposalEngines = {},
): RatchetToolDefinition {
  return {
    name: RATCHET_TOOL_IDS.replayProposal,
    label: "Replay Ratchet Proposal",
    description:
      "Replay a cached ratchet proposal across captured history without executing commands, then attach the structured replay delta to the in-memory proposal batch.",
    promptSnippet:
      "Dry-run one cached ratchet proposal across captured history without executing commands.",
    promptGuidelines: [
      "Use clearance_replay_proposal before recommending any proposal for approval; it updates only the in-memory proposal cache.",
    ],
    parameters: AutoReviewerReplayProposalParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        throwIfAborted(signal);
        const input = parseReplayParameters(params);

        if (!input.valid) {
          const details = replayNotFoundDetails({
            batchId: input.batchId,
            proposalId: input.proposalId,
            reason: "invalid-input",
            message:
              "Proposal replay requires non-empty batchId and proposalId strings.",
            knownProposalIds: [],
            warnings: input.warnings,
          });
          return formatRatchetToolResult(
            details,
            formatReplayNotFoundMarkdown(details),
          ) as unknown as AgentToolResult<AutoReviewerReplayProposalDetails>;
        }

        const batch = batchCache.get(input.batchId);
        if (batch === undefined) {
          const warning = `No cached ratchet proposal batch found for batchId ${JSON.stringify(input.batchId)}. Generate proposals again if the extension reloaded or the session changed.`;
          const details = replayNotFoundDetails({
            batchId: input.batchId,
            proposalId: input.proposalId,
            reason: "batch-not-found",
            message: warning,
            knownProposalIds: [],
            warnings: stableUnique([...input.warnings, warning]),
          });
          return formatRatchetToolResult(
            details,
            formatReplayNotFoundMarkdown(details),
          ) as unknown as AgentToolResult<AutoReviewerReplayProposalDetails>;
        }

        const proposal = getStructuredProposal(batch, input.proposalId);
        if (proposal === undefined) {
          const warning = `No proposal ${JSON.stringify(input.proposalId)} found in batch ${JSON.stringify(input.batchId)}.`;
          const details = replayNotFoundDetails({
            batchId: input.batchId,
            proposalId: input.proposalId,
            reason: "proposal-not-found",
            message: warning,
            knownProposalIds: batch.proposals.map((candidate) => candidate.id),
            warnings: stableUnique([
              ...input.warnings,
              ...batch.warnings,
              warning,
            ]),
          });
          return formatRatchetToolResult(
            details,
            formatReplayNotFoundMarkdown(details),
          ) as unknown as AgentToolResult<AutoReviewerReplayProposalDetails>;
        }

        throwIfAborted(signal);
        const run = await runReplayProposal({
          ctx,
          deps,
          proposal,
          options: input,
          engines,
        });
        throwIfAborted(signal);
        const replacement = replaceCachedProposal(
          batchCache,
          input.batchId,
          batch,
          run.updatedProposal,
        );
        const updatedProposal = replacement.proposal;
        const details: AutoReviewerReplayProposalDetails = {
          found: true,
          batchId: input.batchId,
          proposalId: input.proposalId,
          replay: replaySummary(run),
          delta: run.delta,
          replayOk: run.replayOk,
          updated: replacement.replaced,
          updatedProposal,
          validationCheck: run.validationCheck,
          warnings: stableUnique([
            ...input.warnings,
            ...replacement.batch.warnings,
            ...run.warnings,
          ]),
        };

        return formatRatchetToolResult(
          details,
          formatReplayMarkdown(details),
        ) as unknown as AgentToolResult<AutoReviewerReplayProposalDetails>;
      } catch (error: unknown) {
        return formatRatchetToolError(
          RATCHET_TOOL_IDS.replayProposal,
          error,
        ) as unknown as AgentToolResult<AutoReviewerReplayProposalDetails>;
      }
    },
  };
}

export async function runReplayProposal(input: {
  readonly ctx: ExtensionContext;
  readonly deps: RatchetToolDependencies;
  readonly proposal: StructuredRatchetProposal;
  readonly options?: ReplayProposalRunOptions;
  readonly engines?: ReplayProposalEngines;
  readonly policy?: ResolvedPolicy;
  readonly corpus?: ReplayCorpus;
}): Promise<ReplayProposalRunResult> {
  const policy =
    input.policy ?? (await resolveRatchetPolicy(input.ctx, input.deps));
  const readCorpus = input.engines?.readCorpus ?? readRatchetReplayCorpus;
  const corpus = input.corpus ?? readCorpus(input.ctx);
  const pathFacts = proposalReplayPathFacts(input.proposal, policy);
  const packageCandidate = resolvePackageCandidateForProposal({
    proposal: input.proposal,
    policy,
  });
  const replayResult =
    packageCandidate?.ok === false
      ? {
          ok: false as const,
          proposal: input.proposal,
          delta: packageNotRunReplayDelta(packageCandidate.reason),
          reason: packageCandidate.reason.message,
        }
      : await (
          input.engines?.replayStructuredProposal ??
          defaultReplayStructuredProposal
        )({
          proposal: input.proposal,
          corpus,
          baselinePolicy: policy.effectivePolicy,
          unknownToolPosture: policy.config.unknownToolPosture,
          ...(input.options?.sampleLimit === undefined
            ? {}
            : { sampleLimit: input.options.sampleLimit }),
          ...(input.options?.changedRecordLimit === undefined
            ? {}
            : { changedRecordLimit: input.options.changedRecordLimit }),
          ...(input.options?.includeFullShape === undefined
            ? {}
            : { includeFullShape: input.options.includeFullShape }),
          ...(packageCandidate?.ok === true
            ? { candidatePack: packageCandidate.candidatePack }
            : {}),
          pathFacts: pathFacts.context,
        });
  const replay =
    corpus.entries.length === 0 &&
    input.engines?.replayStructuredProposal === undefined &&
    replayResult.delta.status !== "not-run"
      ? emptyCorpusReplayResult(input.proposal, replayResult.delta)
      : replayResult;

  const validationCheck = replayValidationCheck(replay);
  const warnings = stableUnique([
    ...pathFacts.warnings,
    ...replayProposalWarnings(input.proposal, replay),
  ]);
  const updatedProposal = attachReplayResult(
    input.proposal,
    replay.delta,
    validationCheck,
    warnings,
    packageAvailabilityValidationCheck(packageCandidate),
  );
  const base = {
    replayOk: replay.delta.status === "passed",
    delta: replay.delta,
    updatedProposal,
    validationCheck,
    warnings: updatedProposal.warnings,
  } as const;

  return replay.ok ? base : { ...base, reason: replay.reason };
}

function proposalReplayPathFacts(
  proposal: StructuredRatchetProposal,
  policy: ResolvedPolicy,
): {
  readonly context: {
    readonly baseline: PathFactsResolvedConfig;
    readonly candidate?: PathFactsResolvedConfig;
  };
  readonly warnings: readonly string[];
} {
  const baseline = {
    cwd: policy.config.cwd,
    projectScope: policy.config.projectScope,
  };

  if (proposal.kind !== "project-scope-config") {
    return { context: { baseline, candidate: baseline }, warnings: [] };
  }

  const candidate = candidateProjectScopePathFacts(proposal, policy);
  if (candidate.ok) {
    return {
      context: { baseline, candidate: candidate.pathFacts },
      warnings: [],
    };
  }

  return {
    context: { baseline },
    warnings: [candidate.reason],
  };
}

function candidateProjectScopePathFacts(
  proposal: StructuredRatchetProposal,
  policy: ResolvedPolicy,
):
  | { readonly ok: true; readonly pathFacts: PathFactsResolvedConfig }
  | { readonly ok: false; readonly reason: string } {
  const plan = materializeRatchetProposalWritePlan({
    proposal,
    resolvedConfig: policy.config,
    cwd: policy.config.cwd,
  });
  if (!plan.ok) {
    return {
      ok: false,
      reason: `project-scope replay candidate could not be materialized: ${plan.errors.join("; ")}`,
    };
  }
  if (plan.writePlan.kind !== "config-command") {
    return {
      ok: false,
      reason: "project-scope replay candidate was not a config-command plan",
    };
  }
  const after = plan.writePlan.plan.after;
  if (!isResolvedProjectOverlay(after)) {
    return {
      ok: false,
      reason:
        "project-scope replay candidate did not produce a project overlay",
    };
  }

  const validation = validateProjectScopeConfig({
    cwd: policy.config.cwd,
    projectScope: after.projectScope,
    pathForErrors: plan.writePlan.plan.target.path,
  });
  if (validation.errors.length > 0) {
    return {
      ok: false,
      reason: `project-scope replay candidate failed semantic validation: ${validation.errors.map((error) => error.message).join("; ")}`,
    };
  }

  return {
    ok: true,
    pathFacts: {
      cwd: policy.config.cwd,
      projectScope: validation.scope,
    },
  };
}

function isResolvedProjectOverlay(
  value: unknown,
): value is ProjectOverlayConfig {
  return isRecord(value) && isRecord(value.projectScope);
}

export function replaceCachedProposal(
  batchCache: RatchetBatchCache,
  batchId: string,
  _batch: StructuredProposalBatch,
  proposal: StructuredRatchetProposal,
): {
  readonly batch: StructuredProposalBatch;
  readonly proposal: StructuredRatchetProposal;
  readonly replaced: boolean;
} {
  const currentBatch = batchCache.get(batchId);
  if (currentBatch === undefined) {
    throw new Error(
      `cached ratchet proposal batch ${JSON.stringify(batchId)} disappeared before replacement`,
    );
  }

  const currentProposal = getStructuredProposal(currentBatch, proposal.id);
  if (currentProposal === undefined) {
    throw new Error(
      `proposal ${JSON.stringify(proposal.id)} is not present in latest cached batch`,
    );
  }

  const mergedProposal = mergeProposalUpdate(currentProposal, proposal);
  const nextBatch = validatedBatchWithProposal(currentBatch, mergedProposal);
  const nextProposal = getStructuredProposal(nextBatch, mergedProposal.id);
  if (nextProposal === undefined) {
    throw new Error(
      `validated batch lost proposal ${JSON.stringify(proposal.id)} during cache replacement`,
    );
  }
  const replaced = batchCache.replace(batchId, nextBatch);
  if (!replaced) {
    throw new Error(
      `cached ratchet proposal batch ${JSON.stringify(batchId)} disappeared before replacement`,
    );
  }
  return { batch: nextBatch, proposal: nextProposal, replaced };
}

function mergeProposalUpdate(
  latest: StructuredRatchetProposal,
  updated: StructuredRatchetProposal,
): StructuredRatchetProposal {
  const validation = validateStructuredProposal({
    ...updated,
    evidence: {
      ...latest.evidence,
      ...updated.evidence,
    },
    validation: {
      ...latest.validation,
      ...updated.validation,
    },
    warnings: stableUnique([...latest.warnings, ...updated.warnings]),
  });
  if (!validation.ok) {
    throw new Error(
      `merged structured proposal failed validation: ${validation.errors.join("; ")}`,
    );
  }
  return validation.proposal;
}

function validatedBatchWithProposal(
  batch: StructuredProposalBatch,
  proposal: StructuredRatchetProposal,
): StructuredProposalBatch {
  const proposalValidation = validateStructuredProposal(proposal);
  if (!proposalValidation.ok) {
    throw new Error(
      `updated structured proposal failed validation: ${proposalValidation.errors.join("; ")}`,
    );
  }

  let found = false;
  const proposals = batch.proposals.map((candidate) => {
    if (candidate.id !== proposal.id) {
      return candidate;
    }
    found = true;
    return proposalValidation.proposal;
  });
  if (!found) {
    throw new Error(
      `proposal ${JSON.stringify(proposal.id)} is not present in cached batch`,
    );
  }

  const batchValidation = validateStructuredProposalBatch({
    ...batch,
    proposals,
  });
  if (!batchValidation.ok) {
    throw new Error(
      `updated structured proposal batch failed validation: ${batchValidation.errors.join("; ")}`,
    );
  }

  return batchValidation.batch;
}

function attachReplayResult(
  proposal: StructuredRatchetProposal,
  delta: ReplayDelta,
  validationCheck: ProposalValidationCheck,
  warnings: readonly string[],
  packageAvailabilityCheck?: ProposalValidationCheck,
): StructuredRatchetProposal {
  const attached = {
    ...proposal,
    evidence: {
      ...proposal.evidence,
      replayDelta: delta,
    },
    validation: {
      ...proposal.validation,
      ...(packageAvailabilityCheck === undefined
        ? {}
        : { packageAvailability: packageAvailabilityCheck }),
      replay: validationCheck,
    },
    warnings: stableUnique([...proposal.warnings, ...warnings]),
  };

  return proposalJsonRoundTrip(assertStructuredProposal(attached));
}

function replayValidationCheck(
  replay: ReplayStructuredProposalResult,
): ProposalValidationCheck {
  const delta = replay.delta;
  const details = replayValidationDetails(replay);
  switch (delta.status) {
    case "passed":
      return {
        status: "pass",
        code: "replay-delta-passed",
        message: `replay passed with ${delta.changedCalls} changed call(s) and ${delta.regressions.length} regression(s)`,
        details,
      };
    case "regression":
      return {
        status: "fail",
        code: "replay-delta-regression",
        message: `replay found ${delta.regressions.length} regression(s) across ${delta.changedCalls} changed call(s)`,
        details,
      };
    case "not-run": {
      const status = replayNotRunValidationStatus(replay);
      return {
        status,
        code:
          status === "skipped"
            ? "replay-delta-not-run-skipped"
            : "replay-delta-not-run-pending",
        message: `replay was not run: ${replayNotRunReason(replay)}`,
        details,
      };
    }
  }
}

function replayValidationDetails(
  replay: ReplayStructuredProposalResult,
): Record<string, unknown> {
  const delta = replay.delta;
  return {
    deltaStatus: delta.status,
    changedCalls: delta.changedCalls,
    changedUniqueCommands: delta.changedUniqueCommands,
    reviewToAllowCalls: delta.improvement.reviewToAllowCalls,
    reviewToAllowUniqueCommands: delta.improvement.reviewToAllowUniqueCommands,
    remainingReviewCalls: delta.improvement.remainingReviewCalls,
    regressions: delta.regressions,
    transitions: delta.transitions,
    warnings: delta.warnings,
    ...(delta.notRun === undefined ? {} : { notRun: delta.notRun }),
    ...(replay.ok ? {} : { reason: replay.reason }),
  };
}

function replayNotRunValidationStatus(
  replay: ReplayStructuredProposalResult,
): ProposalValidationStatus {
  if (replay.delta.status !== "not-run") {
    return "pending";
  }
  if (replay.delta.notRun !== undefined) {
    return validationStatusForNotRunReason(replay.delta.notRun);
  }
  if (replay.ok) {
    return "pending";
  }

  // Back-compat for cached batches produced before structured reason codes.
  // New not-run deltas carry `notRun`; absent structured evidence falls back to
  // the old reason text while preserving the same skipped/pending intent where
  // those legacy strings are distinguishable.
  const reason = replay.reason.toLowerCase();
  if (
    reason.includes("model evaluation") ||
    reason.includes("model-prompt evaluation") ||
    reason.includes("design input") ||
    reason.includes("unsupported") ||
    reason.includes("not supported")
  ) {
    return "skipped";
  }
  if (
    reason.includes("candidate pack") ||
    reason.includes("failed") ||
    reason.includes("none was supplied") ||
    reason.includes("compile") ||
    reason.includes("path-fact") ||
    reason.includes("requires")
  ) {
    return "pending";
  }
  return "skipped";
}

function replayNotRunReason(replay: ReplayStructuredProposalResult): string {
  if (replay.delta.notRun !== undefined) {
    return replay.delta.notRun.message;
  }
  if (!replay.ok) {
    return replay.reason;
  }
  return (
    replay.delta.warnings.find((warning) => warning.trim().length > 0) ??
    "no local replay result is available"
  );
}

function replayProposalWarnings(
  proposal: StructuredRatchetProposal,
  replay: ReplayStructuredProposalResult,
): readonly string[] {
  const warnings: string[] = [...proposal.warnings, ...replay.delta.warnings];
  switch (replay.delta.status) {
    case "passed":
      break;
    case "regression":
      warnings.push(
        `replay regression: ${replay.delta.regressions.length} regression(s) across ${replay.delta.changedCalls} changed call(s)`,
      );
      break;
    case "not-run":
      warnings.push(`replay not run: ${replayNotRunReason(replay)}`);
      break;
  }
  return stableUnique(warnings);
}

function emptyCorpusReplayResult(
  proposal: StructuredRatchetProposal,
  delta: ReplayDelta,
): ReplayStructuredProposalResult {
  const reason = proposalNotRunReason({
    code: "no-captured-corpus",
    message:
      "replay was not run because no captured corpus records are available",
  });
  return {
    ok: false,
    proposal,
    delta: {
      ...delta,
      status: "not-run",
      notRun: reason,
      warnings: [...delta.warnings, reason.message],
    },
    reason: reason.message,
  };
}

function replaySummary(run: ReplayProposalRunResult): {
  readonly computed: boolean;
  readonly status: ReplayDelta["status"];
  readonly reason?: string;
} {
  const base = {
    computed: run.delta.status !== "not-run" || run.reason === undefined,
    status: run.delta.status,
  } as const;
  return run.reason === undefined ? base : { ...base, reason: run.reason };
}

function parseReplayParameters(params: unknown): ParsedReplayParameters {
  const record = asRecord(params);
  const warnings: string[] = [];
  const batchId = readNonEmptyString(record, "batchId", warnings);
  const proposalId = readNonEmptyString(record, "proposalId", warnings);
  const includeFullShape = readOptionalBoolean(
    record,
    "includeFullShape",
    undefined,
    warnings,
  );
  const sampleLimit = readOptionalNonNegativeInteger(
    record,
    "sampleLimit",
    warnings,
  );
  const changedRecordLimit = readOptionalNonNegativeInteger(
    record,
    "changedRecordLimit",
    warnings,
  );

  return {
    batchId: batchId ?? "",
    proposalId: proposalId ?? "",
    ...(includeFullShape === undefined ? {} : { includeFullShape }),
    ...(sampleLimit === undefined ? {} : { sampleLimit }),
    ...(changedRecordLimit === undefined ? {} : { changedRecordLimit }),
    warnings,
    valid: batchId !== undefined && proposalId !== undefined,
  };
}

function replayNotFoundDetails(input: {
  readonly batchId: string;
  readonly proposalId: string;
  readonly reason: Extract<
    AutoReviewerReplayProposalDetails,
    { found: false }
  >["reason"];
  readonly message: string;
  readonly knownProposalIds: readonly string[];
  readonly warnings: readonly string[];
}): Extract<AutoReviewerReplayProposalDetails, { readonly found: false }> {
  return {
    found: false,
    batchId: input.batchId,
    proposalId: input.proposalId,
    reason: input.reason,
    message: input.message,
    knownProposalIds: input.knownProposalIds,
    replay: null,
    delta: null,
    replayOk: false,
    updated: false,
    updatedProposal: null,
    validationCheck: null,
    warnings: input.warnings,
  };
}

function asRecord(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function readNonEmptyString(
  record: Record<string, unknown>,
  key: string,
  warnings: string[],
): string | undefined {
  const value = record[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  warnings.push(`Ignoring ${key} because it must be a non-empty string.`);
  return undefined;
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  defaultValue: boolean | undefined,
  warnings: string[],
): boolean | undefined {
  if (!hasOwn(record, key)) {
    return defaultValue;
  }

  const value = record[key];
  if (typeof value === "boolean") {
    return value;
  }

  warnings.push(`Ignoring ${key} because it must be a boolean.`);
  return defaultValue;
}

function readOptionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  warnings: string[],
): number | undefined {
  if (!hasOwn(record, key)) {
    return undefined;
  }

  const value = record[key];
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  warnings.push(`Ignoring ${key} because it must be an integer >= 0.`);
  return undefined;
}

function formatReplayMarkdown(
  details: Extract<AutoReviewerReplayProposalDetails, { readonly found: true }>,
): string {
  const regressionCalls = details.delta.regressions.reduce(
    (total, regression) => total + regression.calls,
    0,
  );
  const lines = [
    "# Clearance proposal replay",
    "",
    `- Batch id: \`${details.batchId}\``,
    `- Proposal id: \`${details.proposalId}\``,
    `- Replay status: ${details.delta.status}`,
    `- Replay OK: ${details.replayOk}`,
    `- Changed calls: ${details.delta.changedCalls} (${details.delta.changedUniqueCommands} unique)`,
    `- Review → fast-path calls: ${details.delta.improvement.reviewToAllowCalls} (${details.delta.improvement.reviewToAllowUniqueCommands} unique)`,
    `- Regressions: ${details.delta.regressions.length} (${regressionCalls} calls)`,
    `- Warnings: ${details.warnings.length}`,
  ];

  if (details.delta.transitions.length > 0) {
    lines.push(
      `- Transitions: ${details.delta.transitions
        .map((transition) => `${transition.transition}:${transition.calls}`)
        .join(", ")}`,
    );
  }

  return lines.join("\n");
}

function formatReplayNotFoundMarkdown(
  details: Extract<
    AutoReviewerReplayProposalDetails,
    { readonly found: false }
  >,
): string {
  const lines = [
    "# Clearance proposal replay",
    "",
    "- Found: false",
    `- Reason: ${details.reason}`,
    `- Batch id: \`${details.batchId}\``,
    `- Proposal id: \`${details.proposalId}\``,
    `- Message: ${details.message}`,
  ];
  if (details.knownProposalIds.length > 0) {
    lines.push(
      `- Known proposal ids: ${details.knownProposalIds
        .map((id) => `\`${id}\``)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
