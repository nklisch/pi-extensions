import {
  proposalCardFromStructuredProposal,
  renderStructuredProposalCardMarkdown,
} from "./proposal-card.ts";
import { groupProposals, type ProposalGroup } from "./proposal-grouping.ts";
import type {
  StructuredProposalBatch,
  StructuredRatchetProposal,
} from "./proposal-schema.ts";

export interface ProposalBatchCardGroup {
  readonly groupId: string;
  readonly label: string;
  readonly plainSummary: string;
  readonly ruleCount: number;
  readonly proposalIds: readonly string[];
  readonly effect: string;
  readonly targetLabel: string;
  readonly evidenceLine: string;
  readonly safetyWarnings: readonly string[];
}

export interface ProposalBatchCardView {
  readonly batchId: string;
  readonly headline: string;
  readonly evidenceStatusLine: string;
  readonly safetyWarnings: readonly string[];
  readonly groups: readonly ProposalBatchCardGroup[];
  readonly counts: {
    readonly proposals: number;
    readonly groups: number;
    readonly designInputOnly: number;
  };
}

/** Build the JSON-safe, summary-first card model. */
export function proposalBatchCardView(
  batchId: string,
  batch: StructuredProposalBatch,
): ProposalBatchCardView {
  const grouped = groupProposals(batch);
  const groups = grouped.map(cardGroup);
  const summaries = groups.map((group) => group.plainSummary);
  const effect = commonEffect(batch.proposals);
  const verb =
    effect === "allow" ? "allow" : effect === "mixed" ? "propose" : effect;
  const headline = `These ${batch.proposals.length} rules ${verb}: ${summaries.join(", ") || "no changes"}`;
  const safetyWarnings = dedupe([
    ...batch.warnings,
    ...groups.flatMap((group) => group.safetyWarnings),
  ]);

  return {
    batchId,
    headline,
    evidenceStatusLine: renderBatchEvidenceStatusLine(batch),
    safetyWarnings,
    groups,
    counts: {
      proposals: batch.proposals.length,
      groups: groups.length,
      designInputOnly: batch.proposals.filter(isDesignInput).length,
    },
  };
}

/** Render only the dense default view. Raw matcher JSON and replay tables stay out. */
export function renderBatchSummaryCardMarkdown(
  view: ProposalBatchCardView,
): string;
export function renderBatchSummaryCardMarkdown(
  batch: StructuredProposalBatch,
  batchId?: string,
): string;
export function renderBatchSummaryCardMarkdown(
  input: ProposalBatchCardView | StructuredProposalBatch,
  batchId = "batch",
): string {
  const view = isBatchCardView(input)
    ? input
    : proposalBatchCardView(batchId, input);
  const lines = [
    "# Clearance proposal batch",
    "",
    `- ${view.headline}`,
    `- Evidence: ${view.evidenceStatusLine}`,
    "",
    "## Groups",
    "",
  ];

  if (view.groups.length === 0) {
    lines.push("- No valid proposals are available.");
  } else {
    for (const group of view.groups) {
      lines.push(
        `- **${group.label}** — ${group.plainSummary} (${group.ruleCount} rule${group.ruleCount === 1 ? "" : "s"}; ${group.evidenceLine})`,
      );
    }
  }

  lines.push("", "## Safety warnings", "");
  if (view.safetyWarnings.length === 0) {
    lines.push("- none");
  } else {
    lines.push(
      ...view.safetyWarnings.map((warning) => `- **Warning:** ${warning}`),
    );
  }

  lines.push(
    "",
    "## Target",
    "",
    "- Writes only to user-owned global config or the user-owned project overlay shown in the selected details.",
    "",
    "## Approval boundary",
    "",
    "Generation and presentation never approve a proposal. Only an explicit user approval from this card can invoke the validated writer; reject, skip, abort, and design-input proposals do not write.",
    "",
    "Select **view details** to inspect exact diffs, matcher JSON, replay deltas, and adversarial cases.",
    "",
  );
  return lines.join("\n");
}

/** Render the one-line aggregate evidence status used by the default card. */
export function renderBatchEvidenceStatusLine(
  batch: StructuredProposalBatch,
): string;
export function renderBatchEvidenceStatusLine(
  proposals: readonly StructuredRatchetProposal[],
): string;
export function renderBatchEvidenceStatusLine(
  input: StructuredProposalBatch | readonly StructuredRatchetProposal[],
): string {
  const proposals = Array.isArray(input)
    ? input
    : (input as StructuredProposalBatch).proposals;
  const replay = replayEvidence(proposals);
  const adversarial = adversarialEvidence(proposals);
  return `replay: ${replay} · adversarial: ${adversarial}`;
}

/** Full detail mode intentionally delegates to the established proposal card renderer. */
export function renderBatchDetailCardMarkdown(
  batch: StructuredProposalBatch,
  groupId?: string,
): string {
  const groups = groupProposals(batch).filter(
    (group) => groupId === undefined || group.groupId === groupId,
  );
  if (groups.length === 0) {
    return renderBatchSummaryCardMarkdown(
      proposalBatchCardView(groupId ?? "", batch),
    );
  }
  return groups
    .flatMap((group) => [
      `## ${groupLabel(group)}`,
      "",
      ...group.proposals.map(renderStructuredProposalCardMarkdown),
    ])
    .join("\n");
}

function cardGroup(group: ProposalGroup): ProposalBatchCardGroup {
  const cards = group.proposals.map(proposalCardFromStructuredProposal);
  const first = cards[0];
  const proposal = group.proposals[0];
  if (first === undefined || proposal === undefined) {
    throw new Error(`proposal group ${group.groupId} has no members`);
  }
  const summaries = dedupe(
    group.proposals.map((member) =>
      member.summary.trim().length > 0 ? member.summary.trim() : member.reason,
    ),
  );
  const plainSummary = boundedSummary(summaries);
  const effects = dedupe(
    group.proposals.map((member) =>
      member.change.kind === "policy-pack" ? member.change.effect : member.kind,
    ),
  );
  return {
    groupId: group.groupId,
    label: groupLabel(group),
    plainSummary,
    ruleCount: group.proposals.length,
    proposalIds: group.proposals.map((member) => member.id),
    effect: effects.length === 1 ? (effects[0] ?? "proposal") : "mixed",
    targetLabel:
      first.target.path === undefined
        ? first.target.label
        : `${first.target.label} at ${first.target.path}`,
    evidenceLine: groupEvidenceLine(group.proposals),
    safetyWarnings: dedupe(
      group.proposals.flatMap((member, index) => {
        const card = cards[index];
        return card === undefined ? member.warnings : card.attention;
      }),
    ),
  };
}

function groupLabel(group: ProposalGroup): string {
  const first = group.proposals[0];
  if (first === undefined) return group.groupId;
  if (group.proposals.length === 1) return first.title;
  return `${first.kind} family (${group.proposals.length} rules)`;
}

function groupEvidenceLine(
  proposals: readonly StructuredRatchetProposal[],
): string {
  const calls = proposals.reduce(
    (total, proposal) => total + proposal.evidence.calls,
    0,
  );
  const replayStatuses = proposals.map(
    (proposal) => proposal.validation.replay?.status,
  );
  const replay = replayStatuses.every((status) => status === "pass")
    ? "replay passed"
    : replayStatuses.some((status) => status === "fail")
      ? "replay failed"
      : replayStatuses.some((status) => status === "pending")
        ? "replay pending"
        : "replay not run";
  return `${calls} captured call${calls === 1 ? "" : "s"}; ${replay}`;
}

function replayEvidence(
  proposals: readonly StructuredRatchetProposal[],
): string {
  const checks = proposals.map((proposal) => proposal.validation.replay);
  if (checks.some((check) => check?.status === "fail")) {
    return "regressions or failures found";
  }
  if (checks.every((check) => check?.status === "pass")) {
    // Each proposal replays the same captured corpus; use the largest snapshot
    // instead of multiplying the corpus count by the number of proposals.
    const total = proposals.reduce(
      (maximum, proposal) =>
        Math.max(
          maximum,
          proposal.evidence.replayDelta?.baseline.totalRecords ?? 0,
        ),
      0,
    );
    const regressions = proposals.reduce(
      (sum, proposal) =>
        sum + (proposal.evidence.replayDelta?.regressions.length ?? 0),
      0,
    );
    return regressions === 0
      ? `no regressions across ${formatNumber(total)} captured calls`
      : `${formatNumber(regressions)} regression${regressions === 1 ? "" : "s"}`;
  }
  const noCorpus = proposals.some(
    (proposal) =>
      proposal.evidence.replayDelta?.notRun?.code === "no-cases" ||
      proposal.evidence.replayDelta?.notRun?.message
        .toLowerCase()
        .includes("no captured") ||
      proposal.warnings.some((warning) =>
        warning.toLowerCase().includes("no captured corpus"),
      ),
  );
  return noCorpus ? "not run (no captured corpus)" : "pending";
}

function adversarialEvidence(
  proposals: readonly StructuredRatchetProposal[],
): string {
  const checks = proposals.map((proposal) => proposal.validation.adversarial);
  if (checks.some((check) => check?.status === "fail")) {
    return "failures found";
  }
  if (checks.every((check) => check?.status === "pass")) {
    const cases = proposals.reduce(
      (sum, proposal) =>
        sum + (proposal.evidence.adversarial?.evaluatedCaseCount ?? 0),
      0,
    );
    return `${formatNumber(cases)} near-misses denied`;
  }
  return checks.some((check) => check?.status === "pending")
    ? "pending"
    : "not run";
}

function boundedSummary(values: readonly string[]): string {
  const joined = values.slice(0, 3).join("; ");
  const omitted = values.length - Math.min(values.length, 3);
  return omitted > 0 ? `${joined} …and ${omitted} more` : joined;
}

function commonEffect(
  proposals: readonly StructuredRatchetProposal[],
): "allow" | "deny" | "review" | "mixed" {
  const effects = dedupe(
    proposals.flatMap((proposal) =>
      proposal.change.kind === "policy-pack" ? [proposal.change.effect] : [],
    ),
  );
  return effects.length === 1
    ? (effects[0] as "allow" | "deny" | "review")
    : effects.length === 0
      ? "mixed"
      : "mixed";
}

function isBatchCardView(
  input: ProposalBatchCardView | StructuredProposalBatch,
): input is ProposalBatchCardView {
  return "headline" in input && "evidenceStatusLine" in input;
}

function isDesignInput(proposal: StructuredRatchetProposal): boolean {
  return (
    proposal.applicationMode === "design-input-only" ||
    proposal.target.kind === "design-input"
  );
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
