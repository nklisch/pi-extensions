import {
  proposalCardFromStructuredProposal,
  renderStructuredProposalCardMarkdown,
} from "../../replay/proposal-card.ts";
import type { StructuredRatchetProposal } from "../../replay/proposal-schema.ts";
import { validateStructuredProposal } from "../../replay/proposal-schema.ts";
import type { ApprovalPresentation } from "./presentation.ts";

/**
 * Runtime guard for proposal artifacts that have already been migrated to the
 * strict structured proposal schema. This is display-only; writers keep their
 * existing legacy proposal contracts until a later migration explicitly moves
 * the approval/apply boundary.
 */
export function isStructuredRatchetProposalLike(
  value: unknown,
): value is StructuredRatchetProposal {
  return validateStructuredProposal(value).ok;
}

/**
 * Adapt a structured proposal into the existing helper-facing presentation
 * shape without parsing markdown or invoking writer/runtime code.
 */
export function presentStructuredProposal(
  proposal: StructuredRatchetProposal,
): ApprovalPresentation {
  const card = proposalCardFromStructuredProposal(proposal);
  const fixtureSuggestions = proposal.fixtureSuggestions.map((fixture) => ({
    command: fixture.command,
    expected: fixture.expected,
    reason: fixture.reason,
  }));

  return {
    proposalId: card.proposalId,
    kind: "structured-proposal",
    route:
      card.route === "design-input-only"
        ? "structured-design-input-only"
        : "structured-writable-after-approval",
    title: card.title,
    summary: card.summary,
    diffText: card.exactChange.text,
    ...(proposal.change.kind === "policy-pack"
      ? { effect: proposal.change.effect }
      : {}),
    framing: {
      writesExecutableCode: false,
      touchesDsl: touchesPolicyDsl(proposal),
      routesAsDesignInput: card.route === "design-input-only",
      requiresAcknowledgment:
        card.warnings.length > 0 || structuredProposalTrustRequired(proposal),
      consentRequired: card.route === "writable-after-approval",
      summary: card.approvalText,
    },
    evidence: {
      calls: card.impact.calls,
      reviewCalls: card.impact.reviewCalls,
      modelReviewCalls: card.impact.modelReviewCalls,
      capturedDenialCalls: card.impact.capturedDenialCalls,
      sampleCommands: card.impact.sampleCommands,
    },
    examples: proposal.examples.map((example) => ({
      command: example.command,
      matches: example.matches,
      ...(example.note === undefined ? {} : { note: example.note }),
    })),
    ...(fixtureSuggestions.length === 0 ? {} : { fixtureSuggestions }),
    warnings: card.warnings,
    trustRequired: structuredProposalTrustRequired(proposal),
  };
}

/** Render the structured proposal card markdown through the helper seam. */
export function renderStructuredProposalPresentationMarkdown(
  proposal: StructuredRatchetProposal,
): string {
  return renderStructuredProposalCardMarkdown(proposal);
}

function touchesPolicyDsl(proposal: StructuredRatchetProposal): boolean {
  return (
    proposal.kind === "data-pack-policy" ||
    proposal.kind === "package-pack-enablement" ||
    (proposal.change.kind === "pack-file-authoring" &&
      ["core-matcher", "shipped-pack-source"].includes(
        proposal.change.authoringKind,
      ))
  );
}

function structuredProposalTrustRequired(
  proposal: StructuredRatchetProposal,
): boolean {
  const hasTrustWarning = proposal.trustNotes.some(
    (note) => note.severity !== undefined && note.severity !== "info",
  );
  if (hasTrustWarning) {
    return true;
  }
  return (
    proposal.applicationMode === "writable-after-approval" &&
    proposal.target.kind !== "user-global-config"
  );
}
