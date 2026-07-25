import type {
  AgentToolResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
  proposalBatchCardView,
  renderBatchSummaryCardMarkdown,
} from "../../replay/batch-card.ts";
import { createStructuredProposalBatch } from "../../replay/proposal-batch.ts";
import {
  draftToStructuredProposal,
  ProposalDraftSchema,
  validateProposalDraft,
} from "../../replay/proposal-draft.ts";
import type {
  StructuredProposalBatch,
  StructuredRatchetProposal,
} from "../../replay/proposal-schema.ts";
import type { RatchetToolDefinition } from "../ratchet-mode.ts";
import type { RatchetBatchCache } from "../ratchet-tools/batch-cache.ts";
import {
  formatRatchetToolError,
  formatRatchetToolResult,
  throwIfAborted,
} from "../ratchet-tools/result.ts";
import type { RatchetToolDependencies } from "../ratchet-tools/types.ts";
import { PROPOSAL_TOOL_IDS } from "./ids.ts";

const STRICT = { additionalProperties: false } as const;

export const ClearanceProposeParameters = Type.Object(
  {
    drafts: Type.Array(ProposalDraftSchema, {
      minItems: 1,
      description: "Agent-authored proposal drafts to validate and batch.",
    }),
  },
  STRICT,
);

export interface ProposalDraftValidationStatus {
  readonly index: number;
  readonly ok: boolean;
  readonly proposalId?: string;
  readonly errors: readonly string[];
}

export type ClearanceProposeDetails =
  | {
      readonly ok: true;
      readonly batchId: string;
      readonly proposalCount: number;
      readonly proposals: readonly ProposalDraftValidationStatus[];
      readonly summary: string;
      readonly batch: StructuredProposalBatch;
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly batchId?: string;
      readonly proposalCount: 0;
      readonly proposals: readonly ProposalDraftValidationStatus[];
      readonly summary: string;
      readonly warnings: readonly string[];
    };

export function createClearanceProposeTool(
  _deps: RatchetToolDependencies,
  batchCache: RatchetBatchCache,
  clock: () => Date = () => new Date(),
): RatchetToolDefinition {
  return {
    name: PROPOSAL_TOOL_IDS.propose,
    label: "Propose Clearance Rules",
    description:
      "Validate agent-authored proposal drafts and cache a deterministic, approval-gated batch. Read-only: this tool never writes files or policy.",
    promptSnippet:
      "Use clearance_propose to submit one or more plain-language policy proposal drafts; then use clearance_present for user approval.",
    promptGuidelines: [
      "Call clearance_propose for agent-authored proposals at any time; it only validates and caches drafts.",
      "Call clearance_present with the returned batchId to show the user the summary card; never write policy directly.",
    ],
    parameters: ClearanceProposeParameters,
    async execute(
      _toolCallId,
      params,
      signal,
      _onUpdate,
      _ctx: ExtensionContext,
    ) {
      try {
        throwIfAborted(signal);
        const rawDrafts = readDrafts(params);
        if (rawDrafts === undefined || rawDrafts.length === 0) {
          const details: ClearanceProposeDetails = {
            ok: false,
            proposalCount: 0,
            proposals: [],
            summary: "No proposal drafts were supplied.",
            warnings: [
              "clearance_propose requires at least one valid agent-authored draft; no batch was cached.",
            ],
          };
          return formatRatchetToolResult(
            details,
            formatProposeMarkdown(details),
          ) as unknown as AgentToolResult<ClearanceProposeDetails>;
        }

        const generatedAt = clock().toISOString();
        const statuses: ProposalDraftValidationStatus[] = [];
        const proposals: StructuredRatchetProposal[] = [];
        for (const [index, draft] of rawDrafts.entries()) {
          throwIfAborted(signal);
          const validation = validateProposalDraft(draft);
          if (!validation.ok || validation.draft === undefined) {
            statuses.push({ index, ok: false, errors: validation.errors });
            continue;
          }
          try {
            const proposal = draftToStructuredProposal(
              validation.draft,
              index,
              {
                createdAt: generatedAt,
              },
            );
            proposals.push(proposal);
            statuses.push({
              index,
              ok: true,
              proposalId: proposal.id,
              errors: [],
            });
          } catch (error: unknown) {
            const errors =
              error instanceof Error ? [error.message] : [String(error)];
            statuses.push({ index, ok: false, errors });
          }
        }

        const warnings = statuses.flatMap((status) =>
          status.ok
            ? []
            : status.errors.map(
                (error) =>
                  `Skipped malformed proposal draft at index ${status.index}: ${error}`,
              ),
        );
        if (proposals.length === 0) {
          const details: ClearanceProposeDetails = {
            ok: false,
            proposalCount: 0,
            proposals: statuses,
            summary: "No valid proposal drafts remained after validation.",
            warnings,
          };
          return formatRatchetToolResult(
            details,
            formatProposeMarkdown(details),
          ) as unknown as AgentToolResult<ClearanceProposeDetails>;
        }

        const batch = createStructuredProposalBatch({
          generatedAt,
          proposals,
          warnings,
        });
        const batchId = batchCache.store(batch);
        const summary = renderBatchSummaryCardMarkdown(
          proposalBatchCardView(batchId, batch),
        );
        const details: ClearanceProposeDetails = {
          ok: true,
          batchId,
          proposalCount: batch.proposals.length,
          proposals: statuses,
          summary,
          batch,
          warnings: batch.warnings,
        };
        return formatRatchetToolResult(
          details,
          summary,
        ) as unknown as AgentToolResult<ClearanceProposeDetails>;
      } catch (error: unknown) {
        return formatRatchetToolError(
          PROPOSAL_TOOL_IDS.propose,
          error,
        ) as unknown as AgentToolResult<ClearanceProposeDetails>;
      }
    },
  };
}

function readDrafts(params: unknown): readonly unknown[] | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const drafts = (params as { readonly drafts?: unknown }).drafts;
  return Array.isArray(drafts) ? drafts : undefined;
}

function formatProposeMarkdown(details: ClearanceProposeDetails): string {
  const lines = [
    "# Clearance proposal draft validation",
    "",
    `- Valid batch: ${details.ok}`,
    `- Proposals: ${details.proposalCount}`,
    `- Summary: ${details.summary}`,
  ];
  if (details.warnings.length > 0) {
    lines.push(
      "",
      "## Warnings",
      "",
      ...details.warnings.map((warning) => `- ${warning}`),
    );
  }
  return lines.join("\n");
}
