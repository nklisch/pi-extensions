import type { RawPolicyPackRule } from "../../config/schema.ts";
import type {
  ProposalApprovalFraming,
  ProposalExample,
  ProposalFixtureSuggestion,
  ProposalTarget,
  RuleProposal,
} from "../../replay/proposals.ts";
import type {
  DeferredFrictionNote,
  ReviewerApprovalFraming,
  ReviewerConfigProposal,
  ReviewerProposalExample,
} from "../../replay/reviewer-config-proposals.ts";

const RATCHET_GENERATED_PACK_ID = "ratchet.generated";
const CORE_MATCHER_EPIC = "epic-parser-and-policy-core";

export type WriteRoute =
  | "write-overlay"
  | "write-reviewer"
  | "route-design-input"
  | "structured-writable-after-approval"
  | "structured-design-input-only";

export interface ApprovalFramingView {
  readonly writesExecutableCode: boolean;
  readonly touchesDsl: boolean;
  readonly routesAsDesignInput: boolean;
  readonly requiresAcknowledgment: boolean;
  readonly consentRequired: boolean;
  readonly summary: string;
}

export interface ApprovalPresentation {
  readonly proposalId: string;
  readonly kind: "rule" | "reviewer-config" | "structured-proposal";
  readonly route: WriteRoute;
  readonly title: string;
  readonly summary: string;
  readonly diffText: string;
  readonly effect?: "allow" | "deny" | "review";
  readonly framing: ApprovalFramingView;
  readonly evidence: {
    readonly calls: number;
    readonly reviewCalls: number;
    readonly modelReviewCalls: number;
    readonly capturedDenialCalls: number;
    readonly sampleCommands: readonly string[];
  };
  readonly examples: readonly {
    readonly command: string;
    readonly matches: boolean;
    readonly note?: string;
  }[];
  readonly fixtureSuggestions?: readonly {
    readonly command: string;
    readonly expected: string;
    readonly reason: string;
  }[];
  readonly warnings: readonly string[];
  readonly forwardCompat?: {
    readonly gatedField: string;
    readonly downstreamEpic: string;
  };
  readonly trustRequired: boolean;
}

/** Classify how an approved rule proposal is routed. Pure. */
export function routeRuleProposal(proposal: RuleProposal): WriteRoute {
  if (proposal.kind === "core-matcher") {
    return "route-design-input";
  }

  if (proposal.kind === "data" && isUserOwnedRuleTarget(proposal.target)) {
    return "write-overlay";
  }

  return "route-design-input";
}

/** Classify how an approved reviewer-config proposal is routed. Pure. */
export function routeReviewerProposal(
  _proposal: ReviewerConfigProposal,
): WriteRoute {
  return "write-reviewer";
}

/** Render a uniform approval presentation from a rule proposal. Pure. */
export function presentRuleProposal(
  proposal: RuleProposal,
  trustedProject: boolean,
): ApprovalPresentation {
  const route = routeRuleProposal(proposal);
  const trustRequired =
    route === "write-overlay" &&
    proposal.target === "user-project" &&
    !trustedProject;
  const fixtureSuggestions = proposal.fixtureSuggestions.map((fixture) => ({
    command: fixture.command,
    expected: fixture.expected,
    reason: fixture.reason,
  }));

  return {
    proposalId: proposal.id,
    kind: "rule",
    route,
    title: ruleTitle(proposal),
    summary: ruleSummary(proposal, route),
    diffText: ruleDiffText(proposal, route),
    effect: proposal.effect,
    framing: ruleFramingView(proposal.approvalFraming, route),
    evidence: evidenceView(proposal.evidence),
    examples: ruleExamplesView(proposal.examples),
    ...(fixtureSuggestions.length === 0 ? {} : { fixtureSuggestions }),
    warnings: approvalWarnings(proposal.warnings, trustRequired),
    trustRequired,
  };
}

/** Render a uniform approval presentation from a reviewer-config proposal. Pure. */
export function presentReviewerProposal(
  proposal: ReviewerConfigProposal,
  trustedProject: boolean,
): ApprovalPresentation {
  const route = routeReviewerProposal(proposal);
  const trustRequired =
    route === "write-reviewer" &&
    proposal.target === "user-project" &&
    !trustedProject;

  return {
    proposalId: proposal.id,
    kind: "reviewer-config",
    route,
    title: `Reviewer config proposal ${proposal.id}`,
    summary: proposal.reason,
    diffText: proposal.diff.rendered,
    framing: reviewerFramingView(proposal.approvalFraming),
    evidence: evidenceView(proposal.evidence),
    examples: reviewerExamplesView(proposal.examples),
    warnings: approvalWarnings(proposal.warnings, trustRequired),
    ...(proposal.forwardCompat === undefined
      ? {}
      : { forwardCompat: proposal.forwardCompat }),
    trustRequired,
  };
}

/** Render a design-input markdown artifact for a routed proposal. Pure. */
export function renderDesignInputArtifact(
  proposal: RuleProposal | ReviewerConfigProposal,
  deferred: readonly DeferredFrictionNote[] = [],
): string {
  const lines = [
    "# Ratchet Design Input",
    "",
    `Proposal: ${proposal.id}`,
    `Proposal kind: ${proposal.kind}`,
    `Route: ${isRuleProposal(proposal) ? routeRuleProposal(proposal) : routeReviewerProposal(proposal)}`,
    "",
  ];

  if (isRuleProposal(proposal)) {
    lines.push(...ruleDesignInputLines(proposal));
  } else {
    lines.push(
      "## Reviewer config proposal",
      "",
      "Reviewer-config proposals are user-owned writes and normally route through `write-reviewer`; this artifact is emitted only when a caller explicitly asks for design-input text.",
      "",
      "## Proposed diff",
      "",
      "```text",
      proposal.diff.rendered,
      "```",
      "",
    );
  }

  if (deferred.length > 0) {
    lines.push("## Deferred reviewer friction", "");
    for (const note of deferred) {
      lines.push(
        `- ${note.wouldAddress} → ${note.downstreamEpic}: ${note.reason} (${note.evidence.calls} calls)`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function isUserOwnedRuleTarget(target: ProposalTarget): boolean {
  return target === "user-global" || target === "user-project";
}

function isRuleProposal(
  proposal: RuleProposal | ReviewerConfigProposal,
): proposal is RuleProposal {
  return "ruleId" in proposal && "effect" in proposal;
}

function ruleTitle(proposal: RuleProposal): string {
  return `Rule proposal ${proposal.ruleId}`;
}

function ruleSummary(proposal: RuleProposal, route: WriteRoute): string {
  if (route === "write-overlay") {
    return `Merge ${proposal.effect} rule ${proposal.ruleId} into ${RATCHET_GENERATED_PACK_ID} for ${proposal.target}.`;
  }

  return `Route ${proposal.kind} proposal ${proposal.ruleId} as design input for ${proposal.target}.`;
}

function ruleDiffText(proposal: RuleProposal, route: WriteRoute): string {
  if (route !== "write-overlay") {
    return [
      "No user-owned config write will be performed.",
      `Route: ${route}`,
      `Target: ${proposal.target}`,
      `Reason: ${designInputReason(proposal)}`,
    ].join("\n");
  }

  return [
    `Merge pack: ${RATCHET_GENERATED_PACK_ID}`,
    `Replaces existing rule: ${replacementDisplay(proposal)}`,
    "Rule JSON:",
    stableJson(rawPolicyPackRule(proposal)),
  ].join("\n");
}

function rawPolicyPackRule(proposal: RuleProposal): RawPolicyPackRule {
  return {
    id: proposal.ruleId,
    effect: proposal.effect,
    match: proposal.match,
    reason: proposal.reason,
    provenance: { source: proposal.intendedProvenance },
  } as RawPolicyPackRule;
}

function replacementDisplay(proposal: RuleProposal): string {
  return proposal.warnings.some((warning) => /replac/i.test(warning))
    ? "yes"
    : `by rule id if ${proposal.ruleId} already exists`;
}

function ruleFramingView(
  framing: ProposalApprovalFraming,
  route: WriteRoute,
): ApprovalFramingView {
  return {
    writesExecutableCode: framing.writesExecutableCode,
    touchesDsl: framing.touchesDsl,
    routesAsDesignInput:
      framing.routesAsDesignInput || route === "route-design-input",
    requiresAcknowledgment: framing.requiresAcknowledgment,
    consentRequired: false,
    summary: framing.summary,
  };
}

function reviewerFramingView(
  framing: ReviewerApprovalFraming,
): ApprovalFramingView {
  return {
    writesExecutableCode: false,
    touchesDsl: false,
    routesAsDesignInput: false,
    requiresAcknowledgment: framing.requiresAcknowledgment,
    consentRequired: framing.consentRequired,
    summary: framing.summary,
  };
}

function evidenceView(evidence: {
  readonly calls: number;
  readonly reviewCalls: number;
  readonly modelReviewCalls: number;
  readonly capturedDenialCalls: number;
  readonly sampleCommands: readonly string[];
}): ApprovalPresentation["evidence"] {
  return {
    calls: evidence.calls,
    reviewCalls: evidence.reviewCalls,
    modelReviewCalls: evidence.modelReviewCalls,
    capturedDenialCalls: evidence.capturedDenialCalls,
    sampleCommands: evidence.sampleCommands,
  };
}

function ruleExamplesView(
  examples: readonly ProposalExample[],
): ApprovalPresentation["examples"] {
  return examples.map((example) => ({
    command: example.command,
    matches: example.matches,
    ...(example.note === undefined ? {} : { note: example.note }),
  }));
}

function reviewerExamplesView(
  examples: readonly ReviewerProposalExample[],
): ApprovalPresentation["examples"] {
  return examples.map((example) => ({
    command: example.command,
    matches: true,
    ...(example.note === undefined ? {} : { note: example.note }),
  }));
}

function approvalWarnings(
  warnings: readonly string[],
  trustRequired: boolean,
): readonly string[] {
  if (!trustRequired) {
    return warnings;
  }

  return [
    ...warnings,
    "Project-targeted write requires explicit project trust before project-local prompt appends or trusted policy can take effect (PRINCIPLES §7).",
  ];
}

function ruleDesignInputLines(proposal: RuleProposal): readonly string[] {
  const lines = [
    "## Suggested home",
    "",
    suggestedHome(proposal),
    "",
    "## Reason",
    "",
    designInputReason(proposal),
    "",
    "## Evidence",
    "",
    `- Calls: ${proposal.evidence.calls}`,
    `- Review calls: ${proposal.evidence.reviewCalls}`,
    `- Model-review calls: ${proposal.evidence.modelReviewCalls}`,
    `- Captured denial calls: ${proposal.evidence.capturedDenialCalls}`,
    `- Sample commands: ${proposal.evidence.sampleCommands.join(", ") || "none"}`,
    "",
    "## Examples",
    "",
    ...exampleLines(proposal.examples),
    "",
  ];

  if (proposal.coreMatcher !== undefined) {
    lines.push(
      "## Core matcher design input",
      "",
      `- Name: ${proposal.coreMatcher.name}`,
      `- Signature: ${proposal.coreMatcher.signature}`,
      `- Gap: ${proposal.coreMatcher.gap}`,
      `- Rationale: ${proposal.coreMatcher.rationale}`,
      "",
    );
  }

  if (proposal.fixtureSuggestions.length > 0) {
    lines.push(
      "## Fixture suggestions",
      "",
      ...fixtureSuggestionLines(proposal.fixtureSuggestions),
      "",
    );
  }

  return lines;
}

function suggestedHome(proposal: RuleProposal): string {
  if (proposal.target === "core-matcher") {
    return `Suggested home epic: ${CORE_MATCHER_EPIC}`;
  }

  if (proposal.target === "shipped-pack") {
    return `Target shipped pack: ${proposal.packId ?? "unspecified shipped pack"}`;
  }

  return `Target: ${proposal.target}`;
}

function designInputReason(proposal: RuleProposal): string {
  if (proposal.target === "core-matcher") {
    return `Core matcher proposal belongs under ${CORE_MATCHER_EPIC}.`;
  }

  if (proposal.target === "shipped-pack") {
    return `Shipped pack proposal targets ${proposal.packId ?? "an unspecified shipped pack"}; shipped code is not written by the apply skill.`;
  }

  return proposal.reason;
}

function exampleLines(examples: readonly ProposalExample[]): readonly string[] {
  if (examples.length === 0) {
    return ["- none"];
  }

  return examples.map((example) => {
    const note = example.note === undefined ? "" : ` — ${example.note}`;
    return `- ${example.matches ? "matches" : "does not match"}: \`${example.command}\`${note}`;
  });
}

function fixtureSuggestionLines(
  suggestions: readonly ProposalFixtureSuggestion[],
): readonly string[] {
  return suggestions.map(
    (suggestion) =>
      `- \`${suggestion.command}\` → ${suggestion.expected}: ${suggestion.reason}`,
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
