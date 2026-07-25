import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
  validateStructuredProposalAdversarial as defaultValidateStructuredProposalAdversarial,
  proposalWithAdversarialReport,
} from "../../replay/adversarial.ts";
import { getStructuredProposal } from "../../replay/proposal-batch.ts";
import type {
  AdversarialValidationReport,
  ProposalValidationCheck,
  ProposalValidationStatus,
  ReplayDelta,
  StructuredRatchetProposal,
} from "../../replay/proposal-schema.ts";
import {
  PROPOSAL_VALIDATION_CHECKS,
  type ProposalValidationCheckName,
  proposalValidationCheckLabel,
} from "../../replay/proposal-validation-display.ts";
import type { ResolvedPolicy } from "../policy-cache.ts";
import type { RatchetToolDefinition } from "../ratchet-mode.ts";
import { resolveRatchetPolicy } from "./analysis.ts";
import type { RatchetBatchCache } from "./batch-cache.ts";
import { RATCHET_TOOL_IDS } from "./ids.ts";
import {
  packageAvailabilityValidationCheck,
  packageNotRunAdversarialReport,
  resolvePackageCandidateForProposal,
} from "./package-candidates.ts";
import {
  type ReplayProposalEngines,
  type ReplayProposalRunResult,
  replaceCachedProposal,
  runReplayProposal,
} from "./replay.ts";
import {
  formatRatchetToolError,
  formatRatchetToolResult,
  throwIfAborted,
} from "./result.ts";
import type { RatchetToolDependencies } from "./types.ts";

const STRICT = { additionalProperties: false } as const;

export const AutoReviewerValidatePackParameters = Type.Object(
  {
    batchId: Type.String({
      minLength: 1,
      description: "Cached structured proposal batch id.",
    }),
    proposalId: Type.String({ minLength: 1, description: "Proposal id." }),
    runReplay: Type.Optional(
      Type.Boolean({
        description:
          "Run replay first when replay evidence or validation is missing.",
      }),
    ),
    runAdversarial: Type.Optional(
      Type.Boolean({
        description:
          "Run adversarial validation first when adversarial evidence or validation is missing.",
      }),
    ),
  },
  STRICT,
);

export interface ValidatePackEngines extends ReplayProposalEngines {
  readonly validateStructuredProposalAdversarial?: typeof defaultValidateStructuredProposalAdversarial;
}

export interface AutoReviewerValidationSlot {
  readonly name: ProposalValidationCheckName;
  readonly label: string;
  readonly present: boolean;
  readonly status: ProposalValidationStatus;
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export type AutoReviewerValidatePackDetails =
  | {
      readonly found: true;
      readonly batchId: string;
      readonly proposalId: string;
      readonly checks: readonly AutoReviewerValidationSlot[];
      readonly updated: {
        readonly replay: boolean;
        readonly adversarial: boolean;
        readonly cache: boolean;
      };
      readonly warnings: readonly string[];
      readonly replay?: {
        readonly delta: ReplayDelta;
        readonly replayOk: boolean;
        readonly validationCheck: ProposalValidationCheck;
        readonly reason?: string;
      };
      readonly adversarial?: {
        readonly report: AdversarialValidationReport;
        readonly validationCheck: ProposalValidationCheck;
      };
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
      readonly checks: readonly AutoReviewerValidationSlot[];
      readonly updated: {
        readonly replay: false;
        readonly adversarial: false;
        readonly cache: false;
      };
      readonly warnings: readonly string[];
    };

interface ParsedValidateParameters {
  readonly batchId: string;
  readonly proposalId: string;
  readonly runReplay: boolean;
  readonly runAdversarial: boolean;
  readonly warnings: readonly string[];
  readonly valid: boolean;
}

export function createAutoReviewerValidatePackTool(
  deps: RatchetToolDependencies,
  batchCache: RatchetBatchCache,
  engines: ValidatePackEngines = {},
): RatchetToolDefinition {
  return {
    name: RATCHET_TOOL_IDS.validatePack,
    label: "Validate Ratchet Proposal",
    description:
      "Return ordered structured validation slots for a cached ratchet proposal, optionally filling missing replay and adversarial evidence in the in-memory cache.",
    promptSnippet:
      "Validate a cached ratchet proposal before presentation or approval.",
    promptGuidelines: [
      "Use clearance_validate_pack after replay and before presenting proposals; it updates only missing in-memory validation evidence when requested.",
    ],
    parameters: AutoReviewerValidatePackParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        throwIfAborted(signal);
        const input = parseValidateParameters(params);

        if (!input.valid) {
          const details = validationNotFoundDetails({
            batchId: input.batchId,
            proposalId: input.proposalId,
            reason: "invalid-input",
            message:
              "Proposal validation requires non-empty batchId and proposalId strings.",
            knownProposalIds: [],
            warnings: input.warnings,
          });
          return formatRatchetToolResult(
            details,
            formatValidationNotFoundMarkdown(details),
          ) as unknown as AgentToolResult<AutoReviewerValidatePackDetails>;
        }

        let currentBatch = batchCache.get(input.batchId);
        if (currentBatch === undefined) {
          const warning = `No cached ratchet proposal batch found for batchId ${JSON.stringify(input.batchId)}. Generate proposals again if the extension reloaded or the session changed.`;
          const details = validationNotFoundDetails({
            batchId: input.batchId,
            proposalId: input.proposalId,
            reason: "batch-not-found",
            message: warning,
            knownProposalIds: [],
            warnings: stableUnique([...input.warnings, warning]),
          });
          return formatRatchetToolResult(
            details,
            formatValidationNotFoundMarkdown(details),
          ) as unknown as AgentToolResult<AutoReviewerValidatePackDetails>;
        }

        let currentProposal = getStructuredProposal(
          currentBatch,
          input.proposalId,
        );
        if (currentProposal === undefined) {
          const warning = `No proposal ${JSON.stringify(input.proposalId)} found in batch ${JSON.stringify(input.batchId)}.`;
          const details = validationNotFoundDetails({
            batchId: input.batchId,
            proposalId: input.proposalId,
            reason: "proposal-not-found",
            message: warning,
            knownProposalIds: currentBatch.proposals.map(
              (candidate) => candidate.id,
            ),
            warnings: stableUnique([
              ...input.warnings,
              ...currentBatch.warnings,
              warning,
            ]),
          });
          return formatRatchetToolResult(
            details,
            formatValidationNotFoundMarkdown(details),
          ) as unknown as AgentToolResult<AutoReviewerValidatePackDetails>;
        }

        let policy: ResolvedPolicy | undefined;
        const getPolicy = async (): Promise<ResolvedPolicy> => {
          policy ??= await resolveRatchetPolicy(ctx, deps);
          return policy;
        };

        let replayRun: ReplayProposalRunResult | undefined;
        let adversarialReport: AdversarialValidationReport | undefined;
        let replayUpdated = false;
        let adversarialUpdated = false;

        if (input.runReplay && lacksReplayEvidence(currentProposal)) {
          const resolved = await getPolicy();
          throwIfAborted(signal);
          replayRun = await runReplayProposal({
            ctx,
            deps,
            proposal: currentProposal,
            engines,
            policy: resolved,
          });
          const replacement = replaceCachedProposal(
            batchCache,
            input.batchId,
            currentBatch,
            replayRun.updatedProposal,
          );
          currentBatch = replacement.batch;
          currentProposal = replacement.proposal;
          replayUpdated = replacement.replaced;
        }

        if (input.runAdversarial && lacksAdversarialEvidence(currentProposal)) {
          const resolved = await getPolicy();
          const packageCandidate = resolvePackageCandidateForProposal({
            proposal: currentProposal,
            policy: resolved,
          });
          const validateAdversarial =
            engines.validateStructuredProposalAdversarial ??
            defaultValidateStructuredProposalAdversarial;
          throwIfAborted(signal);
          adversarialReport =
            packageCandidate?.ok === false
              ? packageNotRunAdversarialReport({
                  proposalId: currentProposal.id,
                  reason: packageCandidate.reason,
                })
              : await validateAdversarial({
                  proposal: currentProposal,
                  baselinePolicy: resolved.effectivePolicy,
                  ...(packageCandidate?.ok === true
                    ? { candidatePack: packageCandidate.candidatePack }
                    : {}),
                  pathFacts: {
                    cwd: resolved.config.cwd,
                    projectScope: resolved.config.projectScope,
                  },
                });
          const updatedProposal = withPackageAvailabilityCheck(
            proposalWithAdversarialReport(currentProposal, adversarialReport),
            packageAvailabilityValidationCheck(packageCandidate),
          );
          const replacement = replaceCachedProposal(
            batchCache,
            input.batchId,
            currentBatch,
            updatedProposal,
          );
          currentBatch = replacement.batch;
          currentProposal = replacement.proposal;
          adversarialUpdated = replacement.replaced;
        }

        const checks = validationSlots(currentProposal);
        const warnings = stableUnique([
          ...input.warnings,
          ...currentBatch.warnings,
          ...currentProposal.warnings,
          ...(replayRun?.warnings ?? []),
          ...(adversarialReport?.warnings ?? []),
        ]);
        const details = buildFoundDetails({
          batchId: input.batchId,
          proposalId: input.proposalId,
          checks,
          warnings,
          replayUpdated,
          adversarialUpdated,
          replayRun,
          proposal: currentProposal,
          adversarialReport,
        });

        return formatRatchetToolResult(
          details,
          formatValidationMarkdown(details),
        ) as unknown as AgentToolResult<AutoReviewerValidatePackDetails>;
      } catch (error: unknown) {
        return formatRatchetToolError(
          RATCHET_TOOL_IDS.validatePack,
          error,
        ) as unknown as AgentToolResult<AutoReviewerValidatePackDetails>;
      }
    },
  };
}

function withPackageAvailabilityCheck(
  proposal: StructuredRatchetProposal,
  check: ProposalValidationCheck | undefined,
): StructuredRatchetProposal {
  if (check === undefined) {
    return proposal;
  }
  return {
    ...proposal,
    validation: {
      ...proposal.validation,
      packageAvailability: check,
    },
  };
}

function buildFoundDetails(input: {
  readonly batchId: string;
  readonly proposalId: string;
  readonly checks: readonly AutoReviewerValidationSlot[];
  readonly warnings: readonly string[];
  readonly replayUpdated: boolean;
  readonly adversarialUpdated: boolean;
  readonly replayRun: ReplayProposalRunResult | undefined;
  readonly proposal: StructuredRatchetProposal;
  readonly adversarialReport: AdversarialValidationReport | undefined;
}): Extract<AutoReviewerValidatePackDetails, { readonly found: true }> {
  return {
    found: true,
    batchId: input.batchId,
    proposalId: input.proposalId,
    checks: input.checks,
    updated: {
      replay: input.replayUpdated,
      adversarial: input.adversarialUpdated,
      cache: input.replayUpdated || input.adversarialUpdated,
    },
    warnings: input.warnings,
    ...(input.replayRun === undefined
      ? {}
      : { replay: replayReportDetails(input.replayRun) }),
    ...(input.adversarialReport === undefined
      ? {}
      : {
          adversarial: {
            report: input.adversarialReport,
            validationCheck: requireValidationCheck(
              input.proposal,
              "adversarial",
            ),
          },
        }),
  };
}

function replayReportDetails(run: ReplayProposalRunResult): {
  readonly delta: ReplayDelta;
  readonly replayOk: boolean;
  readonly validationCheck: ProposalValidationCheck;
  readonly reason?: string;
} {
  const base = {
    delta: run.delta,
    replayOk: run.replayOk,
    validationCheck: run.validationCheck,
  } as const;
  return run.reason === undefined ? base : { ...base, reason: run.reason };
}

function requireValidationCheck(
  proposal: StructuredRatchetProposal,
  name: ProposalValidationCheckName,
): ProposalValidationCheck {
  const check = proposal.validation[name];
  if (check === undefined) {
    throw new Error(
      `expected proposal ${JSON.stringify(proposal.id)} to contain ${name} validation after update`,
    );
  }
  return check;
}

function lacksReplayEvidence(proposal: StructuredRatchetProposal): boolean {
  return (
    proposal.evidence.replayDelta === undefined ||
    proposal.validation.replay === undefined
  );
}

function lacksAdversarialEvidence(
  proposal: StructuredRatchetProposal,
): boolean {
  return (
    proposal.evidence.adversarial === undefined ||
    proposal.validation.adversarial === undefined
  );
}

function validationSlots(
  proposal: StructuredRatchetProposal,
): readonly AutoReviewerValidationSlot[] {
  return PROPOSAL_VALIDATION_CHECKS.map(([name, label]) => {
    const check = proposal.validation[name];
    if (check === undefined) {
      return missingValidationSlot(name, label);
    }
    return validationSlot(name, label, check);
  });
}

function validationSlot(
  name: ProposalValidationCheckName,
  label: string,
  check: ProposalValidationCheck,
): AutoReviewerValidationSlot {
  return {
    name,
    label,
    present: true,
    status: check.status,
    code: check.code,
    message: check.message,
    ...(check.details === undefined ? {} : { details: check.details }),
  };
}

function missingValidationSlot(
  name: ProposalValidationCheckName,
  label: string,
): AutoReviewerValidationSlot {
  return {
    name,
    label,
    present: false,
    status: "pending",
    code: `${name}-not-present`,
    message: `${label} validation is not present on this proposal yet.`,
  };
}

function parseValidateParameters(params: unknown): ParsedValidateParameters {
  const record = asRecord(params);
  const warnings: string[] = [];
  const batchId = readNonEmptyString(record, "batchId", warnings);
  const proposalId = readNonEmptyString(record, "proposalId", warnings);
  return {
    batchId: batchId ?? "",
    proposalId: proposalId ?? "",
    runReplay: readOptionalBoolean(record, "runReplay", false, warnings),
    runAdversarial: readOptionalBoolean(
      record,
      "runAdversarial",
      false,
      warnings,
    ),
    warnings,
    valid: batchId !== undefined && proposalId !== undefined,
  };
}

function validationNotFoundDetails(input: {
  readonly batchId: string;
  readonly proposalId: string;
  readonly reason: Extract<
    AutoReviewerValidatePackDetails,
    { found: false }
  >["reason"];
  readonly message: string;
  readonly knownProposalIds: readonly string[];
  readonly warnings: readonly string[];
}): Extract<AutoReviewerValidatePackDetails, { readonly found: false }> {
  return {
    found: false,
    batchId: input.batchId,
    proposalId: input.proposalId,
    reason: input.reason,
    message: input.message,
    knownProposalIds: input.knownProposalIds,
    checks: [],
    updated: { replay: false, adversarial: false, cache: false },
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
  defaultValue: boolean,
  warnings: string[],
): boolean {
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

function formatValidationMarkdown(
  details: Extract<AutoReviewerValidatePackDetails, { readonly found: true }>,
): string {
  const counts = countStatuses(details.checks);
  const lines = [
    "# Clearance proposal validation",
    "",
    `- Batch id: \`${details.batchId}\``,
    `- Proposal id: \`${details.proposalId}\``,
    `- Checks: pass ${counts.pass}, fail ${counts.fail}, pending ${counts.pending}, skipped ${counts.skipped}`,
    `- Updated cache: ${details.updated.cache}`,
    `- Replay updated: ${details.updated.replay}`,
    `- Adversarial updated: ${details.updated.adversarial}`,
    `- Warnings: ${details.warnings.length}`,
    "",
    "## Checks",
  ];

  for (const check of details.checks) {
    lines.push(
      `- ${proposalValidationCheckLabel(check.name)}: ${check.status} (${check.present ? check.code : "not present"})`,
    );
  }

  return lines.join("\n");
}

function formatValidationNotFoundMarkdown(
  details: Extract<AutoReviewerValidatePackDetails, { readonly found: false }>,
): string {
  const lines = [
    "# Clearance proposal validation",
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

function countStatuses(
  checks: readonly AutoReviewerValidationSlot[],
): Readonly<Record<ProposalValidationStatus, number>> {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    fail: checks.filter((check) => check.status === "fail").length,
    skipped: checks.filter((check) => check.status === "skipped").length,
    pending: checks.filter((check) => check.status === "pending").length,
  };
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
