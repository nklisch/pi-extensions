import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
  validateStructuredProposalAdversarial as defaultValidateStructuredProposalAdversarial,
  proposalWithAdversarialReport,
} from "../../replay/adversarial.ts";
import { getStructuredProposal } from "../../replay/proposal-batch.ts";
import { summarizeWarnings } from "../../replay/proposal-card.ts";
import type {
  AdversarialValidationReport,
  ProposalValidationCheck,
  StructuredRatchetProposal,
} from "../../replay/proposal-schema.ts";
import type { RatchetToolDefinition } from "../ratchet-mode.ts";
import { resolveRatchetPolicy } from "./analysis.ts";
import type { RatchetBatchCache } from "./batch-cache.ts";
import { RATCHET_TOOL_IDS } from "./ids.ts";
import {
  packageAvailabilityValidationCheck,
  packageNotRunAdversarialReport,
  resolvePackageCandidateForProposal,
} from "./package-candidates.ts";
import { replaceCachedProposal } from "./replay.ts";
import {
  formatRatchetToolError,
  formatRatchetToolResult,
  throwIfAborted,
} from "./result.ts";
import type { RatchetToolDependencies } from "./types.ts";

const STRICT = { additionalProperties: false } as const;

export const AutoReviewerAdversarialCasesParameters = Type.Object(
  {
    batchId: Type.String({
      minLength: 1,
      description: "Cached structured proposal batch id.",
    }),
    proposalId: Type.String({ minLength: 1, description: "Proposal id." }),
    maxCases: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 100,
        description:
          "Maximum generated or supplied adversarial cases to evaluate.",
      }),
    ),
  },
  STRICT,
);

export interface AdversarialCasesEngines {
  readonly validateStructuredProposalAdversarial?: typeof defaultValidateStructuredProposalAdversarial;
}

export type AutoReviewerAdversarialCasesDetails =
  | {
      readonly found: true;
      readonly batchId: string;
      readonly proposalId: string;
      readonly report: AdversarialValidationReport;
      readonly updatedProposal: StructuredRatchetProposal;
      readonly validationCheck: ProposalValidationCheck;
      readonly updated: boolean;
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
      readonly report: null;
      readonly updatedProposal: null;
      readonly validationCheck: null;
      readonly updated: false;
      readonly warnings: readonly string[];
    };

interface ParsedAdversarialParameters {
  readonly batchId: string;
  readonly proposalId: string;
  readonly maxCases?: number;
  readonly warnings: readonly string[];
  readonly valid: boolean;
}

export function createAutoReviewerAdversarialCasesTool(
  deps: RatchetToolDependencies,
  batchCache: RatchetBatchCache,
  engines: AdversarialCasesEngines = {},
): RatchetToolDefinition {
  return {
    name: RATCHET_TOOL_IDS.adversarialCases,
    label: "Ratchet Adversarial Cases",
    description:
      "Generate and evaluate adversarial near-miss cases for a cached ratchet proposal, then attach the structured report to the in-memory proposal batch. Read-only outside the cache: never writes config or policy.",
    promptSnippet:
      "Stress-test one cached proposal with adversarial near-miss cases before presentation.",
    promptGuidelines: [
      "Use clearance_adversarial_cases for candidate allow rules before clearance_present; it updates only the in-memory proposal cache.",
    ],
    parameters: AutoReviewerAdversarialCasesParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        throwIfAborted(signal);
        const input = parseAdversarialParameters(params);

        if (!input.valid) {
          const details = adversarialNotFoundDetails({
            batchId: input.batchId,
            proposalId: input.proposalId,
            reason: "invalid-input",
            message:
              "Adversarial validation requires non-empty batchId and proposalId strings.",
            knownProposalIds: [],
            warnings: input.warnings,
          });
          return formatRatchetToolResult(
            details,
            formatAdversarialNotFoundMarkdown(details),
          ) as unknown as AgentToolResult<AutoReviewerAdversarialCasesDetails>;
        }

        const batch = batchCache.get(input.batchId);
        if (batch === undefined) {
          const warning = `No cached ratchet proposal batch found for batchId ${JSON.stringify(input.batchId)}. Generate proposals again if the extension reloaded or the session changed.`;
          const details = adversarialNotFoundDetails({
            batchId: input.batchId,
            proposalId: input.proposalId,
            reason: "batch-not-found",
            message: warning,
            knownProposalIds: [],
            warnings: stableUnique([...input.warnings, warning]),
          });
          return formatRatchetToolResult(
            details,
            formatAdversarialNotFoundMarkdown(details),
          ) as unknown as AgentToolResult<AutoReviewerAdversarialCasesDetails>;
        }

        const proposal = getStructuredProposal(batch, input.proposalId);
        if (proposal === undefined) {
          const warning = `No proposal ${JSON.stringify(input.proposalId)} found in batch ${JSON.stringify(input.batchId)}.`;
          const details = adversarialNotFoundDetails({
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
            formatAdversarialNotFoundMarkdown(details),
          ) as unknown as AgentToolResult<AutoReviewerAdversarialCasesDetails>;
        }

        const policy = await resolveRatchetPolicy(ctx, deps);
        const packageCandidate = resolvePackageCandidateForProposal({
          proposal,
          policy,
        });
        const validateAdversarial =
          engines.validateStructuredProposalAdversarial ??
          defaultValidateStructuredProposalAdversarial;
        throwIfAborted(signal);
        const report =
          packageCandidate?.ok === false
            ? packageNotRunAdversarialReport({
                proposalId: proposal.id,
                reason: packageCandidate.reason,
              })
            : await validateAdversarial({
                proposal,
                baselinePolicy: policy.effectivePolicy,
                ...(input.maxCases === undefined
                  ? {}
                  : { maxCases: input.maxCases }),
                ...(packageCandidate?.ok === true
                  ? { candidatePack: packageCandidate.candidatePack }
                  : {}),
                pathFacts: {
                  cwd: policy.config.cwd,
                  projectScope: policy.config.projectScope,
                },
              });
        const proposalWithReport = withPackageAvailabilityCheck(
          proposalWithAdversarialReport(proposal, report),
          packageAvailabilityValidationCheck(packageCandidate),
        );
        const replacement = replaceCachedProposal(
          batchCache,
          input.batchId,
          batch,
          proposalWithReport,
        );
        const updatedProposal = replacement.proposal;
        const validationCheck =
          requireAdversarialValidationCheck(updatedProposal);
        const details: AutoReviewerAdversarialCasesDetails = {
          found: true,
          batchId: input.batchId,
          proposalId: input.proposalId,
          report,
          updatedProposal,
          validationCheck,
          updated: replacement.replaced,
          warnings: stableUnique([
            ...input.warnings,
            ...replacement.batch.warnings,
            ...updatedProposal.warnings,
            ...report.warnings,
          ]),
        };

        return formatRatchetToolResult(
          details,
          formatAdversarialMarkdown(details),
        ) as unknown as AgentToolResult<AutoReviewerAdversarialCasesDetails>;
      } catch (error: unknown) {
        return formatRatchetToolError(
          RATCHET_TOOL_IDS.adversarialCases,
          error,
        ) as unknown as AgentToolResult<AutoReviewerAdversarialCasesDetails>;
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

function requireAdversarialValidationCheck(
  proposal: StructuredRatchetProposal,
): ProposalValidationCheck {
  const check = proposal.validation.adversarial;
  if (check === undefined) {
    throw new Error(
      `expected proposal ${JSON.stringify(proposal.id)} to contain adversarial validation after update`,
    );
  }
  return check;
}

function parseAdversarialParameters(
  params: unknown,
): ParsedAdversarialParameters {
  const record = asRecord(params);
  const warnings: string[] = [];
  const batchId = readNonEmptyString(record, "batchId", warnings);
  const proposalId = readNonEmptyString(record, "proposalId", warnings);
  const maxCases = readOptionalBoundedInteger(
    record,
    "maxCases",
    { min: 0, max: 100 },
    warnings,
  );

  return {
    batchId: batchId ?? "",
    proposalId: proposalId ?? "",
    ...(maxCases === undefined ? {} : { maxCases }),
    warnings,
    valid: batchId !== undefined && proposalId !== undefined,
  };
}

function adversarialNotFoundDetails(input: {
  readonly batchId: string;
  readonly proposalId: string;
  readonly reason: Extract<
    AutoReviewerAdversarialCasesDetails,
    { found: false }
  >["reason"];
  readonly message: string;
  readonly knownProposalIds: readonly string[];
  readonly warnings: readonly string[];
}): Extract<AutoReviewerAdversarialCasesDetails, { readonly found: false }> {
  return {
    found: false,
    batchId: input.batchId,
    proposalId: input.proposalId,
    reason: input.reason,
    message: input.message,
    knownProposalIds: input.knownProposalIds,
    report: null,
    updatedProposal: null,
    validationCheck: null,
    updated: false,
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

function readOptionalBoundedInteger(
  record: Record<string, unknown>,
  key: string,
  bounds: { readonly min: number; readonly max: number },
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
    value <= bounds.max
  ) {
    return value;
  }

  warnings.push(
    `Ignoring ${key} because it must be an integer between ${bounds.min} and ${bounds.max}.`,
  );
  return undefined;
}

function formatAdversarialMarkdown(
  details: Extract<
    AutoReviewerAdversarialCasesDetails,
    { readonly found: true }
  >,
): string {
  const lines = [
    "# Clearance adversarial validation",
    "",
    `- Batch id: \`${details.batchId}\``,
    `- Proposal id: \`${details.proposalId}\``,
    `- Status: ${details.report.status}`,
    `- Cases: generated ${details.report.generatedCaseCount}; evaluated ${details.report.evaluatedCaseCount}; failed ${details.report.failedCaseCount}; skipped ${details.report.skippedCaseCount}`,
    `- Updated cache: ${details.updated}`,
    `- Validation check: ${details.validationCheck.status} (${details.validationCheck.code})`,
    `- Warnings: ${details.warnings.length}`,
  ];

  const warningSummary = summarizeWarnings(details.warnings);
  if (warningSummary.total > 0) {
    lines.push("", "## Warnings");
    for (const warning of warningSummary.shown) {
      lines.push(`- ${warning}`);
    }
    if (warningSummary.omitted > 0) {
      lines.push(
        `- … ${warningSummary.omitted} more warning(s) in structured details`,
      );
    }
  }

  return lines.join("\n");
}

function formatAdversarialNotFoundMarkdown(
  details: Extract<
    AutoReviewerAdversarialCasesDetails,
    { readonly found: false }
  >,
): string {
  const lines = [
    "# Clearance adversarial validation",
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

function stableUnique(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}
