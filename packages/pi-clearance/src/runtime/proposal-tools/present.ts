import type {
  AgentToolResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
  type ProposalBatchCardView,
  proposalBatchCardView,
  renderBatchDetailCardMarkdown,
  renderBatchSummaryCardMarkdown,
} from "../../replay/batch-card.ts";
import { getStructuredProposal } from "../../replay/proposal-batch.ts";
import {
  groupProposals,
  type ProposalGroup,
} from "../../replay/proposal-grouping.ts";
import type {
  StructuredProposalBatch,
  StructuredRatchetProposal,
} from "../../replay/proposal-schema.ts";
import type { RatchetToolDefinition } from "../ratchet-mode.ts";
import {
  type RatchetProposalDecisionAuditResult,
  recordRatchetProposalDecision,
} from "../ratchet-tools/approval-audit.ts";
import type { RatchetBatchCache } from "../ratchet-tools/batch-cache.ts";
import {
  formatRatchetToolError,
  formatRatchetToolResult,
  throwIfAborted,
} from "../ratchet-tools/result.ts";
import type { RatchetToolDependencies } from "../ratchet-tools/types.ts";
import {
  fillRequiredApprovalEvidence,
  type ProposalApplyDetails,
  type ProposalPresentationDecision,
  type ProposalPresentationEngines,
  resolveApprovalAndApply,
} from "./apply-engine.ts";
import { PROPOSAL_TOOL_IDS } from "./ids.ts";

const STRICT = { additionalProperties: false } as const;
const SUMMARY_OPTIONS = [
  "approve all",
  "approve all without replay evidence",
  "choose groups",
  "view details",
  "reject",
] as const;
const GROUP_OPTIONS = ["accept", "reject", "skip", "details"] as const;

export const ClearancePresentParameters = Type.Object(
  {
    batchId: Type.String({
      minLength: 1,
      description: "Cached proposal batch id.",
    }),
  },
  STRICT,
);

export interface ProposalPresentationOutcome {
  readonly proposalId: string;
  readonly groupId: string;
  readonly decision: ProposalPresentationDecision;
  readonly apply: ProposalApplyDetails;
  readonly approval: Awaited<
    ReturnType<typeof resolveApprovalAndApply>
  >["approval"];
  readonly audit: RatchetProposalDecisionAuditResult;
  readonly warnings: readonly string[];
}

export interface ClearancePresentDetails {
  readonly ok: true;
  readonly batchId: string;
  readonly cardView: ProposalBatchCardView;
  readonly cardMarkdown: string;
  readonly detailModeUsed: boolean;
  readonly outcomes: readonly ProposalPresentationOutcome[];
  readonly warnings: readonly string[];
}

export interface ClearancePresentNotFoundDetails {
  readonly ok: false;
  readonly batchId: string;
  readonly reason: "invalid-input" | "batch-not-found" | "no-proposals";
  readonly message: string;
  readonly cardMarkdown: "";
  readonly warnings: readonly string[];
}

export function createClearancePresentTool(
  deps: RatchetToolDependencies,
  batchCache: RatchetBatchCache,
  engines: ProposalPresentationEngines = {},
): RatchetToolDefinition {
  return {
    name: PROPOSAL_TOOL_IDS.present,
    label: "Present Clearance Proposals",
    description:
      "Fill proposal evidence, show one deterministic progressive-disclosure batch card, collect explicit user approval, and apply only accepted proposals through the validated writer pipeline.",
    promptSnippet:
      "Use clearance_present with a cached batchId to show the summary card and collect explicit per-group or approve-all decisions.",
    promptGuidelines: [
      "Use clearance_present after clearance_propose or Tune analysis; evidence is filled before the first card render.",
      "Approve-all is the normal batch path. Choose groups when only some family-level groups should proceed; no UI or rejection writes nothing.",
    ],
    parameters: ClearancePresentParameters,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      try {
        throwIfAborted(signal);
        const batchId = readBatchId(params);
        if (batchId === undefined) {
          return notFound(
            "",
            "invalid-input",
            "clearance_present requires a non-empty batchId.",
          );
        }
        const cachedBatch = batchCache.get(batchId);
        if (cachedBatch === undefined) {
          return notFound(
            batchId,
            "batch-not-found",
            `No cached proposal batch found for ${JSON.stringify(batchId)}.`,
          );
        }
        let batch: StructuredProposalBatch = cachedBatch;
        if (batch.proposals.length === 0) {
          return notFound(
            batchId,
            "no-proposals",
            "The cached proposal batch contains no valid proposals.",
          );
        }

        // Evidence is intentionally completed before constructing or displaying
        // the card so pending is never shown when a deterministic check can run.
        const evidenceWarnings: string[] = [];
        for (const proposal of batch.proposals) {
          throwIfAborted(signal);
          const latestBatch = batchCache.get(batchId);
          if (latestBatch === undefined)
            throw new Error("proposal batch disappeared during evidence fill");
          const latest = getStructuredProposal(latestBatch, proposal.id);
          if (latest === undefined) continue;
          const evidence = await fillRequiredApprovalEvidence({
            ctx,
            deps,
            batchCache,
            batchId,
            batch: latestBatch,
            proposal: latest,
            engines,
            signal,
          });
          evidenceWarnings.push(
            ...evidence.warnings,
            ...evidence.failures.map((failure) => failure.message),
          );
          const updatedBatch = batchCache.get(batchId);
          if (updatedBatch !== undefined) {
            batch = updatedBatch;
          }
        }

        const view = proposalBatchCardView(batchId, batch);
        const cardMarkdown = renderBatchSummaryCardMarkdown(view);
        const uiAvailable = hasUsableUi(ctx);
        if (!uiAvailable) {
          const outcomes = await recordNonInteractiveOutcomes({
            ctx,
            deps,
            batchId,
            batch,
            toolCallId,
            engines,
            signal,
          });
          const details: ClearancePresentDetails = {
            ok: true,
            batchId,
            cardView: view,
            cardMarkdown,
            detailModeUsed: false,
            outcomes,
            warnings: unique([
              ...batch.warnings,
              ...evidenceWarnings,
              "No Pi UI confirm/select interface is available; presentation aborted before any write.",
            ]),
          };
          return formatRatchetToolResult(
            details,
            formatPresentMarkdown(details),
          ) as unknown as AgentToolResult<ClearancePresentDetails>;
        }

        const interaction = await collectBatchDecisions(
          ctx,
          batch,
          view,
          cardMarkdown,
          signal,
        );
        const outcomes: ProposalPresentationOutcome[] = [];
        for (const selected of interaction.selections) {
          throwIfAborted(signal);
          const currentBatch = batchCache.get(batchId) ?? batch;
          const proposal = getStructuredProposal(
            currentBatch,
            selected.proposalId,
          );
          if (proposal === undefined) continue;
          const applied = await applyOne({
            ctx,
            deps,
            batchCache,
            batchId,
            batch: currentBatch,
            proposal,
            groupId: selected.groupId,
            decision: selected.decision,
            toolCallId,
            engines,
            signal,
          });
          outcomes.push(applied);
        }

        const details: ClearancePresentDetails = {
          ok: true,
          batchId,
          cardView: view,
          cardMarkdown,
          detailModeUsed: interaction.detailModeUsed,
          outcomes,
          warnings: unique([
            ...batch.warnings,
            ...evidenceWarnings,
            ...interaction.warnings,
            ...outcomes.flatMap((outcome) => outcome.warnings),
          ]),
        };
        return formatRatchetToolResult(
          details,
          formatPresentMarkdown(details),
        ) as unknown as AgentToolResult<ClearancePresentDetails>;
      } catch (error: unknown) {
        return formatRatchetToolError(
          PROPOSAL_TOOL_IDS.present,
          error,
        ) as unknown as AgentToolResult<ClearancePresentDetails>;
      }
    },
  };
}

interface Selection {
  readonly proposalId: string;
  readonly groupId: string;
  readonly decision: ProposalPresentationDecision;
}

interface BatchInteraction {
  readonly selections: readonly Selection[];
  readonly detailModeUsed: boolean;
  readonly warnings: readonly string[];
}

async function collectBatchDecisions(
  ctx: ExtensionContext,
  batch: StructuredProposalBatch,
  view: ProposalBatchCardView,
  cardMarkdown: string,
  signal: AbortSignal | undefined,
): Promise<BatchInteraction> {
  const shown = await uiConfirm(ctx)(
    "Review clearance proposal batch",
    cardMarkdown,
  );
  if (shown !== true) {
    return {
      selections: batch.proposals.map((proposal) => ({
        proposalId: proposal.id,
        groupId: findGroup(view, proposal.id),
        decision: "aborted" as const,
      })),
      detailModeUsed: false,
      warnings: [
        "Proposal batch card was dismissed; all decisions aborted before any write.",
      ],
    };
  }

  let detailModeUsed = false;
  // The no-corpus human override is only offered when at least one proposal
  // in the batch is pending replay specifically because no captured corpus
  // exists — never for other pending reasons (compile-failed, missing facts).
  const noCorpusOverrideOffered = batch.proposals.some((proposal) =>
    isNoCorpusPendingReplayCheck(proposal.validation.replay),
  );
  const summaryOptions = SUMMARY_OPTIONS.filter(
    (option) =>
      option !== "approve all without replay evidence" ||
      noCorpusOverrideOffered,
  );
  while (true) {
    throwIfAborted(signal);
    const selection = await uiSelect(ctx)("Choose clearance proposal action", [
      ...summaryOptions,
    ]);
    if (selection === "view details") {
      detailModeUsed = true;
      await uiConfirm(ctx)(
        "Clearance proposal details",
        renderBatchDetailCardMarkdown(batch),
      );
      continue;
    }
    if (
      selection === "approve all" ||
      selection === "approve all without replay evidence"
    ) {
      const decision =
        selection === "approve all without replay evidence"
          ? "accept-without-replay"
          : "accept";
      return {
        selections: batch.proposals.map((proposal) => ({
          proposalId: proposal.id,
          groupId: findGroup(view, proposal.id),
          decision,
        })),
        detailModeUsed,
        warnings:
          selection === "approve all without replay evidence"
            ? [
                "Human selected approve all without replay evidence; every applicable allow rule carries a prominent warning.",
              ]
            : [],
      };
    }
    if (selection === "reject") {
      return {
        selections: batch.proposals.map((proposal) => ({
          proposalId: proposal.id,
          groupId: findGroup(view, proposal.id),
          decision: "reject" as const,
        })),
        detailModeUsed,
        warnings: [],
      };
    }
    if (selection === "choose groups") {
      return chooseGroups(ctx, batch, view, detailModeUsed, signal);
    }
    return {
      selections: batch.proposals.map((proposal) => ({
        proposalId: proposal.id,
        groupId: findGroup(view, proposal.id),
        decision: "aborted" as const,
      })),
      detailModeUsed,
      warnings: [
        "Unexpected or cancelled batch action; all decisions aborted before any write.",
      ],
    };
  }
}

async function chooseGroups(
  ctx: ExtensionContext,
  batch: StructuredProposalBatch,
  _view: ProposalBatchCardView,
  detailModeUsed: boolean,
  signal: AbortSignal | undefined,
): Promise<BatchInteraction> {
  const selections: Selection[] = [];
  let usedDetails = detailModeUsed;
  const groups = groupProposals(batch);
  for (const group of groups) {
    while (true) {
      throwIfAborted(signal);
      const selected = await uiSelect(ctx)(
        `Choose group: ${groupLabel(group)}`,
        [...GROUP_OPTIONS],
      );
      if (selected === "details") {
        usedDetails = true;
        await uiConfirm(ctx)(
          `Details: ${groupLabel(group)}`,
          renderBatchDetailCardMarkdown(batch, group.groupId),
        );
        continue;
      }
      const decision: ProposalPresentationDecision =
        selected === "accept"
          ? "accept"
          : selected === "reject"
            ? "reject"
            : selected === "skip"
              ? "skip"
              : "aborted";
      selections.push(
        ...group.proposals.map((proposal) => ({
          proposalId: proposal.id,
          groupId: group.groupId,
          decision,
        })),
      );
      break;
    }
  }
  return { selections, detailModeUsed: usedDetails, warnings: [] };
}

async function applyOne(input: {
  readonly ctx: ExtensionContext;
  readonly deps: RatchetToolDependencies;
  readonly batchCache: RatchetBatchCache;
  readonly batchId: string;
  readonly batch: StructuredProposalBatch;
  readonly proposal: StructuredRatchetProposal;
  readonly groupId: string;
  readonly decision: ProposalPresentationDecision;
  readonly toolCallId: string;
  readonly engines: ProposalPresentationEngines;
  readonly signal: AbortSignal | undefined;
}): Promise<ProposalPresentationOutcome> {
  const result = await resolveApprovalAndApply(input);
  const audit = await recordRatchetProposalDecision({
    ctx: input.ctx,
    deps: input.deps,
    batchId: input.batchId,
    proposal: result.proposal,
    decision: auditDecision(input.decision),
    write: auditWrite(result.apply),
    postWriteReplay: result.postWriteReplay,
    toolCallId: input.toolCallId,
  });
  return {
    proposalId: result.proposal.id,
    groupId: input.groupId,
    decision: input.decision,
    apply: result.apply,
    approval: result.approval,
    audit,
    warnings: unique([
      ...result.batchWarnings,
      ...result.proposal.warnings,
      ...result.approvalWarnings,
      ...result.apply.warnings,
      ...result.postWriteReplay.warnings,
      ...(audit.ok || audit.error === undefined
        ? []
        : [`proposal decision audit failed: ${audit.error}`]),
    ]),
  };
}

async function recordNonInteractiveOutcomes(input: {
  readonly ctx: ExtensionContext;
  readonly deps: RatchetToolDependencies;
  readonly batchId: string;
  readonly batch: StructuredProposalBatch;
  readonly toolCallId: string;
  readonly engines: ProposalPresentationEngines;
  readonly signal: AbortSignal | undefined;
}): Promise<readonly ProposalPresentationOutcome[]> {
  const outcomes: ProposalPresentationOutcome[] = [];
  for (const proposal of input.batch.proposals) {
    outcomes.push(
      await applyOne({
        ...input,
        batchCache: {
          get: () => input.batch,
          replace: () => false,
          store: () => input.batchId,
        },
        groupId: findGroup(
          proposalBatchCardView(input.batchId, input.batch),
          proposal.id,
        ),
        proposal,
        decision: "aborted",
      }),
    );
  }
  return outcomes;
}

function notFound(
  batchId: string,
  reason: ClearancePresentNotFoundDetails["reason"],
  message: string,
): AgentToolResult<ClearancePresentNotFoundDetails> {
  const details: ClearancePresentNotFoundDetails = {
    ok: false,
    batchId,
    reason,
    message,
    cardMarkdown: "",
    warnings: [message],
  };
  return formatRatchetToolResult(
    details,
    `# Clearance proposal presentation\n\n- ${message}`,
  ) as unknown as AgentToolResult<ClearancePresentNotFoundDetails>;
}

function readBatchId(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params))
    return undefined;
  const value = (params as { readonly batchId?: unknown }).batchId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Mirror of the approval gate's no-corpus marker: the human override is only
 * meaningful when replay could not run because no captured corpus exists.
 */
function isNoCorpusPendingReplayCheck(
  status:
    | {
        readonly status: string;
        readonly details?: unknown;
      }
    | undefined,
): boolean {
  if (status === undefined || status.status !== "pending") return false;
  const details = status.details;
  if (typeof details !== "object" || details === null) return false;
  const notRun = (details as { readonly notRun?: unknown }).notRun;
  if (typeof notRun !== "object" || notRun === null) return false;
  return (notRun as { readonly code?: unknown }).code === "no-captured-corpus";
}

function hasUsableUi(ctx: ExtensionContext): boolean {
  const candidate = ctx as ExtensionContext & UiContext;
  return (
    candidate.hasUI === true &&
    typeof candidate.ui?.confirm === "function" &&
    typeof candidate.ui?.select === "function"
  );
}

type UiConfirm = (
  title: string,
  markdown: string,
  options?: unknown,
) => Promise<boolean | undefined> | boolean | undefined;
type UiSelect = (
  title: string,
  options: string[],
  optionsObject?: unknown,
) => Promise<string | undefined> | string | undefined;
interface UiContext {
  readonly hasUI?: boolean;
  readonly ui?: { readonly confirm?: UiConfirm; readonly select?: UiSelect };
}

function uiConfirm(ctx: ExtensionContext): UiConfirm {
  const ui = (ctx as ExtensionContext & UiContext).ui;
  if (typeof ui?.confirm !== "function")
    throw new Error("Pi UI confirm is not available");
  return ui.confirm.bind(ui);
}

function uiSelect(ctx: ExtensionContext): UiSelect {
  const ui = (ctx as ExtensionContext & UiContext).ui;
  if (typeof ui?.select !== "function")
    throw new Error("Pi UI select is not available");
  return ui.select.bind(ui);
}

function findGroup(view: ProposalBatchCardView, proposalId: string): string {
  return (
    view.groups.find((group) => group.proposalIds.includes(proposalId))
      ?.groupId ?? "unknown"
  );
}

function groupLabel(group: ProposalGroup): string {
  return group.proposals.length === 1
    ? (group.proposals[0]?.title ?? group.groupId)
    : `${group.groupId} (${group.proposals.length} rules)`;
}

function auditDecision(
  decision: ProposalPresentationDecision,
):
  | "accept"
  | "reject"
  | "revise"
  | "skip"
  | "aborted"
  | "accept-without-replay" {
  return decision;
}

function auditWrite(apply: ProposalApplyDetails): {
  readonly attempted: boolean;
  readonly ok?: boolean;
  readonly changed?: boolean;
  readonly planId?: string;
  readonly backupPath?: string;
  readonly reason?: string;
} {
  const attempted = apply.writerKind !== undefined;
  return {
    attempted,
    ...(attempted
      ? { ok: apply.status === "applied" || apply.status === "no-op" }
      : {}),
    ...(apply.changed === undefined ? {} : { changed: apply.changed }),
    ...(apply.planId === undefined ? {} : { planId: apply.planId }),
    ...(apply.backupPath === undefined ? {} : { backupPath: apply.backupPath }),
    ...(apply.reason === undefined ? {} : { reason: apply.reason }),
  };
}

function formatPresentMarkdown(details: ClearancePresentDetails): string {
  const applied = details.outcomes.filter(
    (outcome) => outcome.apply.status === "applied",
  ).length;
  const failed = details.outcomes.filter(
    (outcome) =>
      outcome.apply.status === "failed" || outcome.approval.ok === false,
  ).length;
  return [
    "# Clearance proposal presentation",
    "",
    `- Batch id: ${details.batchId}`,
    `- Proposals: ${details.cardView.counts.proposals}`,
    `- Groups: ${details.cardView.counts.groups}`,
    `- Detail mode used: ${details.detailModeUsed}`,
    `- Applied: ${applied}`,
    `- Failed/refused: ${failed}`,
    ...details.outcomes.map(
      (outcome) =>
        `- ${outcome.proposalId}: ${outcome.decision} (${outcome.apply.status})`,
    ),
  ].join("\n");
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
