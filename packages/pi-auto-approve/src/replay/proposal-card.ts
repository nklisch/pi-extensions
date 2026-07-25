import {
  proposalRequiredAcknowledgementCodes,
  trustNoteRequiredAcknowledgements,
} from "./proposal-acknowledgements.ts";
import type {
  FileWriteDescription,
  ProposalValidation,
  ProposalValidationCheck,
  ReplayDelta,
  ReplayDeltaFamily,
  StructuredRatchetProposal,
} from "./proposal-schema.ts";
import {
  PROPOSAL_VALIDATION_CHECKS,
  proposalValidationCheckLabel,
} from "./proposal-validation-display.ts";
import {
  formatCount,
  markdownCodeBlock,
  markdownInlineCode,
  renderJsonPatchSummary,
  stableJson,
} from "./rendering-format.ts";

export type ProposalCardRoute = "writable-after-approval" | "design-input-only";

export interface WarningSummary {
  readonly total: number;
  readonly shown: readonly string[];
  readonly omitted: number;
}

export interface ProposalCardView {
  readonly proposalId: string;
  readonly title: string;
  readonly kind: StructuredRatchetProposal["kind"];
  readonly route: ProposalCardRoute;
  readonly target: {
    readonly label: string;
    readonly path?: string;
    readonly trustBoundary: string;
  };
  readonly summary: string;
  readonly exactChange: {
    readonly label: string;
    readonly text: string;
  };
  readonly impact: {
    readonly calls: number;
    readonly reviewCalls: number;
    readonly modelReviewCalls: number;
    readonly capturedDenialCalls: number;
    readonly sampleCommands: readonly string[];
    readonly replay?: ProposalCardReplayImpact;
  };
  readonly validation: readonly ProposalCardValidationLine[];
  readonly adversarial?: ProposalCardAdversarialSummary;
  readonly trustNotes: readonly {
    readonly severity: string;
    readonly message: string;
    readonly requiredAcknowledgementCode?: string;
  }[];
  readonly warnings: readonly string[];
  readonly warningSummary: WarningSummary;
  readonly attention: readonly string[];
  readonly approvalText: string;
  readonly requiredAcknowledgementCodes: readonly string[];
}

export interface ProposalCardReplayImpact {
  readonly status: "not-run" | "passed" | "regression";
  readonly reviewReductionPercent: number | null;
  readonly reviewToAllowCalls: number;
  readonly remainingReviewCalls: number;
  readonly regressionCount: number;
  readonly changedFamilies: readonly string[];
  readonly blockedSummary: readonly string[];
}

export interface ProposalCardAdversarialSummary {
  readonly status: "not-run" | "passed" | "failed";
  readonly generatedCaseCount: number;
  readonly evaluatedCaseCount: number;
  readonly failedCaseCount: number;
  readonly failedCases: readonly {
    readonly command: string;
    readonly category: string;
    readonly actualStatus?: string;
  }[];
}

export interface ProposalCardValidationLine {
  readonly name: keyof StructuredRatchetProposal["validation"];
  readonly status: ProposalValidationCheck["status"];
  readonly code: string;
  readonly message: string;
}

const EXPANSION_TRANSITION = "review->fast_path";
const DEFAULT_SAMPLE_LIMIT = 5;
const DEFAULT_CHANGED_FAMILY_LIMIT = 5;
const DEFAULT_WARNING_LIMIT = 5;

export function summarizeWarnings(
  values: readonly string[],
  limit = DEFAULT_WARNING_LIMIT,
): WarningSummary {
  const normalized = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of normalized) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  const shown = unique.slice(0, Math.max(0, limit));
  return {
    total: normalized.length,
    shown,
    omitted: Math.max(0, normalized.length - shown.length),
  };
}

export function proposalCardFromStructuredProposal(
  proposal: StructuredRatchetProposal,
): ProposalCardView {
  const route = proposalRoute(proposal);
  const replay = replayImpactFromDelta(proposal.evidence.replayDelta);
  const adversarial = adversarialSummaryFromProposal(proposal);
  const warnings = collectWarnings(proposal);
  const warningSummary = summarizeWarnings(warnings);
  const trustNoteAcknowledgementCodes = new Map(
    (proposal.change.kind === "package-pack-enablement"
      ? []
      : trustNoteRequiredAcknowledgements(proposal.trustNotes)
    ).map(
      (acknowledgement) =>
        [acknowledgement.index, acknowledgement.code] as const,
    ),
  );

  return {
    proposalId: proposal.id,
    title: proposal.title,
    kind: proposal.kind,
    route,
    target: targetView(proposal),
    summary: proposal.summary.length > 0 ? proposal.summary : proposal.reason,
    exactChange: exactChangeView(proposal),
    impact: {
      calls: proposal.evidence.calls,
      reviewCalls: proposal.evidence.reviewCalls,
      modelReviewCalls: proposal.evidence.modelReviewCalls,
      capturedDenialCalls: proposal.evidence.capturedDenialCalls,
      sampleCommands: collectSampleCommands(proposal),
      replay,
    },
    validation: validationLines(proposal.validation),
    adversarial,
    trustNotes: proposal.trustNotes.map((note, index) => {
      const requiredAcknowledgementCode =
        trustNoteAcknowledgementCodes.get(index);
      return {
        severity: note.severity ?? "info",
        message: `${note.kind} — ${note.message}`,
        ...(requiredAcknowledgementCode === undefined
          ? {}
          : { requiredAcknowledgementCode }),
      };
    }),
    warnings,
    warningSummary,
    attention: attentionLines({
      route,
      replay,
      adversarial,
      validation: validationLines(proposal.validation),
      trustNotes: proposal.trustNotes,
      warningSummary,
    }),
    approvalText: approvalTextForRoute(route),
    requiredAcknowledgementCodes:
      proposalRequiredAcknowledgementCodes(proposal),
  };
}

export function renderProposalCardMarkdown(card: ProposalCardView): string {
  const lines = [
    `# Proposal ${markdownInlineCode(card.proposalId)}: ${card.title}`,
    "",
    `- Kind: ${card.kind}`,
    `- Route: ${card.route}`,
    `- Target: ${card.target.label}${
      card.target.path === undefined
        ? ""
        : ` at ${markdownInlineCode(card.target.path)}`
    }`,
    `- Trust boundary: ${card.target.trustBoundary}`,
    `- Summary: ${card.summary}`,
    "",
    "## Approval boundary",
    "",
    card.approvalText,
    "",
    "### Required acknowledgement codes",
    "",
    ...renderRequiredAcknowledgementLines(card.requiredAcknowledgementCodes),
    "",
    "## Review before approval",
    "",
    ...renderPriorityReviewLines(card),
    "",
    "## Exact change",
    "",
    `### ${card.exactChange.label}`,
    "",
    card.exactChange.text,
    "",
    "## Impact",
    "",
    `- Calls represented: ${formatCount(card.impact.calls, "call")}`,
    `- Review calls: ${formatCount(card.impact.reviewCalls, "call")}`,
    `- Model-review calls: ${formatCount(card.impact.modelReviewCalls, "call")}`,
    `- Captured denials: ${formatCount(card.impact.capturedDenialCalls, "call")}`,
    "",
    "## Replay impact",
    "",
    ...renderReplayImpactLines(card.impact.replay),
    "",
    "## Adversarial validation",
    "",
    ...renderAdversarialLines(card.adversarial),
    "",
    "## Validation",
    "",
    ...renderValidationLines(card.validation),
    "",
    "## Trust notes",
    "",
    ...renderTrustNoteLines(card.trustNotes),
    "",
    "## Warnings",
    "",
    ...renderWarningLines(card.warnings),
    "",
    "## Routine examples and fixture-suggestion commands",
    "",
    ...renderSampleCommandLines(card.impact.sampleCommands),
  ];

  return `${lines.join("\n")}\n`;
}

export function renderStructuredProposalCardMarkdown(
  proposal: StructuredRatchetProposal,
): string {
  return renderProposalCardMarkdown(
    proposalCardFromStructuredProposal(proposal),
  );
}

function proposalRoute(proposal: StructuredRatchetProposal): ProposalCardRoute {
  if (
    proposal.applicationMode === "design-input-only" ||
    proposal.target.kind === "design-input"
  ) {
    return "design-input-only";
  }
  return "writable-after-approval";
}

function targetView(
  proposal: StructuredRatchetProposal,
): ProposalCardView["target"] {
  const { target } = proposal;
  switch (target.kind) {
    case "user-global-config":
      return {
        label: "User-global config",
        path: target.path,
        trustBoundary: "user-owned global config",
      };
    case "user-project-overlay":
      return {
        label: `User-project overlay for ${target.projectKey}`,
        path: target.path,
        trustBoundary: `user-owned project overlay for ${target.projectKey} (${target.projectRoot})`,
      };
    case "package-pack-config": {
      const packageLabel =
        target.packageName === undefined
          ? "package-contributed pack"
          : `${target.packageName}${
              target.packageVersion === undefined
                ? ""
                : `@${target.packageVersion}`
            }`;
      return {
        label: `Package pack config for ${target.packId}`,
        path: target.path,
        trustBoundary: `user-owned package-pack enablement for ${packageLabel}; installation is not enablement`,
      };
    }
    case "design-input":
      return {
        label: `Design input (${target.route})`,
        ...(target.suggestedPath === undefined
          ? {}
          : { path: target.suggestedPath }),
        trustBoundary:
          "design-input-only route; rendering this card does not write config",
      };
  }
}

function exactChangeView(
  proposal: StructuredRatchetProposal,
): ProposalCardView["exactChange"] {
  const { change } = proposal;
  switch (change.kind) {
    case "policy-pack":
      return {
        label: "Policy-pack rule change",
        text: renderPolicyPackChange(proposal),
      };
    case "reviewer-config":
      return {
        label: "Reviewer config diff",
        text: renderReviewerConfigChange(proposal),
      };
    case "project-scope-config":
      return {
        label: "Project-scope config patch",
        text: renderProjectScopeChange(proposal),
      };
    case "package-pack-enablement":
      return {
        label: "Package-pack enablement plan",
        text: renderPackagePackEnablementChange(change),
      };
    case "pack-file-authoring":
      return {
        label: "Pack-file authoring design input",
        text: renderPackFileAuthoringChange(proposal),
      };
  }
}

function renderPolicyPackChange(proposal: StructuredRatchetProposal): string {
  const change = proposal.change;
  if (change.kind !== "policy-pack") {
    return "Invalid policy-pack proposal: change kind does not match.";
  }
  const patchSummary = renderJsonPatchSummary(change.rawPackPatch);
  const acknowledgementCodes = proposalRequiredAcknowledgementCodes(proposal);
  const lines = [
    `- Pack id: ${markdownInlineCode(change.packId)}`,
    `- Rule id: ${markdownInlineCode(change.ruleId)}`,
    `- Effect: ${change.effect}`,
    `- Reason: ${change.reason}`,
    "",
    "#### Raw matcher JSON",
    "",
    jsonBlock(change.match),
    "",
    "#### Raw pack patch",
    "",
    ...renderPatchSummaryLines(patchSummary),
    jsonBlock(change.rawPackPatch),
  ];

  if (change.fileWrite !== undefined) {
    lines.push(
      "",
      "#### File-write description",
      "",
      renderFileWrite(change.fileWrite),
    );
  } else {
    lines.push(
      "",
      "#### File-write description",
      "",
      "No file-write preview is attached to this proposal.",
    );
  }

  lines.push(
    "",
    "#### Required acknowledgements",
    "",
    ...renderListOrNone(
      "Required acknowledgements",
      acknowledgementCodes.map(markdownInlineCode),
    ),
  );

  return lines.join("\n");
}

function renderReviewerConfigChange(
  proposal: StructuredRatchetProposal,
): string {
  const change = proposal.change;
  if (change.kind !== "reviewer-config") {
    return "Invalid reviewer-config proposal: change kind does not match.";
  }
  const acknowledgementCodes = proposalRequiredAcknowledgementCodes(proposal);
  return [
    `- Pointer: ${markdownInlineCode(change.pointer)}`,
    `- Operation: ${change.op}`,
    "",
    "#### Rendered diff",
    "",
    markdownCodeBlock(change.rendered, "diff"),
    "",
    "#### Before",
    "",
    jsonBlock(change.before),
    "",
    "#### After",
    "",
    jsonBlock(change.after),
    "",
    "#### Required acknowledgements",
    "",
    ...renderListOrNone(
      "Required acknowledgements",
      acknowledgementCodes.map(markdownInlineCode),
    ),
  ].join("\n");
}

function renderProjectScopeChange(proposal: StructuredRatchetProposal): string {
  const change = proposal.change;
  if (change.kind !== "project-scope-config") {
    return "Invalid project-scope proposal: change kind does not match.";
  }

  const target = targetView(proposal);
  const acknowledgementCodes = proposalRequiredAcknowledgementCodes(proposal);

  return [
    `- Target overlay: ${target.label}${
      target.path === undefined ? "" : ` at ${markdownInlineCode(target.path)}`
    }`,
    `- Patch operations: ${formatCount(change.patch.length, "operation")}`,
    "",
    "#### JSON patch summary",
    "",
    ...renderPatchSummaryLines(renderJsonPatchSummary(change.patch)),
    "",
    "#### Raw JSON patch",
    "",
    jsonBlock(change.patch),
    "",
    "#### Required acknowledgements",
    "",
    ...renderListOrNone(
      "Required acknowledgements",
      acknowledgementCodes.map(markdownInlineCode),
    ),
  ].join("\n");
}

function renderPackagePackEnablementChange(
  change: Extract<
    StructuredRatchetProposal["change"],
    { readonly kind: "package-pack-enablement" }
  >,
): string {
  const action = change.enable ? "enable" : "disable";
  const metadata = [
    `pack ${markdownInlineCode(change.packId)}`,
    change.packageName === undefined
      ? undefined
      : `package ${markdownInlineCode(change.packageName)}${
          change.packageVersion === undefined ? "" : `@${change.packageVersion}`
        }`,
    change.packagePath === undefined
      ? undefined
      : `package path ${markdownInlineCode(change.packagePath)}`,
  ].filter((part): part is string => part !== undefined);
  const planWarnings = change.plan.warnings.map(
    (warning) =>
      `${warning.level} ${markdownInlineCode(warning.code)} (${warning.source}) — ${warning.message}${
        warning.requiresAcknowledgement ? " [requires acknowledgement]" : ""
      }`,
  );

  return [
    `- Action: ${action}`,
    `- Pack metadata: ${metadata.join("; ")}`,
    `- Plan id: ${markdownInlineCode(change.plan.id)}`,
    `- Plan target: ${markdownInlineCode(change.plan.targetPath)}`,
    `- Plan request: ${change.plan.request.action} ${change.plan.request.subject} ${markdownInlineCode(change.plan.request.packId)} in ${change.plan.request.scope} scope`,
    "",
    "#### Plan patch",
    "",
    ...renderPatchSummaryLines(renderJsonPatchSummary(change.plan.patch)),
    jsonBlock(change.plan.patch),
    "",
    "#### Acknowledgement and trust warnings",
    "",
    ...renderListOrNone(
      "Required acknowledgements",
      change.plan.requiredAcknowledgementCodes.map(markdownInlineCode),
    ),
    ...renderListOrNone("Plan warnings", planWarnings),
    ...renderListOrNone("Metadata warnings", change.metadataWarnings),
  ].join("\n");
}

function renderPackFileAuthoringChange(
  proposal: StructuredRatchetProposal,
): string {
  const change = proposal.change;
  if (change.kind !== "pack-file-authoring") {
    return "Invalid pack-file-authoring proposal: change kind does not match.";
  }

  const target = proposal.target;
  const route =
    target.kind === "design-input" ? target.route : proposal.applicationMode;
  const suggestedPath =
    target.kind === "design-input" ? target.suggestedPath : undefined;

  const details = [
    `- Route: design-input-only (${route})`,
    `- Authoring kind: ${change.authoringKind}`,
    change.moduleId === undefined
      ? undefined
      : `- Module id: ${markdownInlineCode(change.moduleId)}`,
    change.packId === undefined
      ? undefined
      : `- Pack id: ${markdownInlineCode(change.packId)}`,
    change.ruleId === undefined
      ? undefined
      : `- Rule id: ${markdownInlineCode(change.ruleId)}`,
    change.matcherName === undefined
      ? undefined
      : `- Matcher name: ${markdownInlineCode(change.matcherName)}`,
    change.matcherSignature === undefined
      ? undefined
      : `- Matcher signature: ${markdownInlineCode(change.matcherSignature)}`,
    suggestedPath === undefined
      ? undefined
      : `- Suggested path: ${markdownInlineCode(suggestedPath)}`,
    `- Rationale: ${change.rationale}`,
  ].filter((line): line is string => line !== undefined);

  const lines = [...details];
  if (change.fileWrite !== undefined) {
    lines.push(
      "",
      "#### Suggested file write",
      "",
      renderFileWrite(change.fileWrite),
    );
  } else {
    lines.push(
      "",
      "#### Suggested file write",
      "",
      "No concrete file-write draft is attached.",
    );
  }
  if (change.rawRule !== undefined) {
    lines.push(
      "",
      "#### Raw rule/module/core matcher details",
      "",
      jsonBlock(change.rawRule),
    );
  } else {
    lines.push(
      "",
      "#### Raw rule/module/core matcher details",
      "",
      "No raw rule details are attached.",
    );
  }

  return lines.join("\n");
}

function renderFileWrite(fileWrite: FileWriteDescription): string {
  const lines = [
    `- Path: ${markdownInlineCode(fileWrite.path)}`,
    `- Format: ${fileWrite.format}`,
    `- Mode: ${fileWrite.mode}`,
    `- Atomic write: ${fileWrite.atomic ? "yes" : "no"}`,
    `- Backup required: ${fileWrite.backupRequired ? "yes" : "no"}`,
  ];

  if (fileWrite.patch !== undefined) {
    lines.push(
      "",
      "Patch summary:",
      ...renderPatchSummaryLines(renderJsonPatchSummary(fileWrite.patch)),
      "",
      jsonBlock(fileWrite.patch),
    );
  }
  if (fileWrite.contents !== undefined) {
    lines.push(
      "",
      "Contents:",
      markdownCodeBlock(
        fileWrite.contents,
        fileWriteLanguage(fileWrite.format),
      ),
    );
  }

  return lines.join("\n");
}

function replayImpactFromDelta(
  delta: ReplayDelta | undefined,
): ProposalCardReplayImpact {
  if (delta === undefined) {
    return {
      status: "not-run",
      reviewReductionPercent: null,
      reviewToAllowCalls: 0,
      remainingReviewCalls: 0,
      regressionCount: 0,
      changedFamilies: [],
      blockedSummary: ["Replay delta not attached"],
    };
  }

  return {
    status: delta.status,
    reviewReductionPercent: delta.improvement.reviewReductionPercent,
    reviewToAllowCalls: delta.improvement.reviewToAllowCalls,
    remainingReviewCalls: delta.improvement.remainingReviewCalls,
    regressionCount: regressionCallCount(delta),
    changedFamilies: delta.changedFamilies
      .slice(0, DEFAULT_CHANGED_FAMILY_LIMIT)
      .map(changedFamilySummary),
    blockedSummary: blockedSummary(delta),
  };
}

function adversarialSummaryFromProposal(
  proposal: StructuredRatchetProposal,
): ProposalCardAdversarialSummary {
  const report = proposal.evidence.adversarial;
  const validation = proposal.validation.adversarial;
  if (report === undefined) {
    return {
      status: validation?.status === "fail" ? "failed" : "not-run",
      generatedCaseCount: 0,
      evaluatedCaseCount: 0,
      failedCaseCount: 0,
      failedCases: [],
    };
  }

  const failedOrErroredResults = report.results.filter(
    (result) => result.outcome === "failed" || result.outcome === "errored",
  );
  const failedCases = failedOrErroredResults
    .slice(0, DEFAULT_SAMPLE_LIMIT)
    .map((result) => ({
      command: result.command,
      category: result.category,
      ...(result.actualStatus === undefined
        ? {}
        : { actualStatus: result.actualStatus }),
    }));

  return {
    status: validation?.status === "fail" ? "failed" : report.status,
    generatedCaseCount: report.generatedCaseCount,
    evaluatedCaseCount: report.evaluatedCaseCount,
    failedCaseCount: Math.max(
      report.failedCaseCount,
      failedOrErroredResults.length,
    ),
    failedCases,
  };
}

function validationLines(
  validation: ProposalValidation,
): readonly ProposalCardValidationLine[] {
  const lines: ProposalCardValidationLine[] = [];
  for (const [name] of PROPOSAL_VALIDATION_CHECKS) {
    const check = validation[name];
    if (check !== undefined) {
      lines.push({
        name,
        status: check.status,
        code: check.code,
        message: check.message,
      });
      continue;
    }
    if (name === "replay") {
      lines.push({
        name,
        status: "pending",
        code: "replay-not-attached",
        message: "no replay validation check attached",
      });
    }
    if (name === "adversarial") {
      lines.push({
        name,
        status: "skipped",
        code: "adversarial-not-attached",
        message: "no adversarial validation check attached",
      });
    }
  }
  return lines;
}

function collectWarnings(
  proposal: StructuredRatchetProposal,
): readonly string[] {
  const warnings = [...proposal.warnings];
  const replayDelta = proposal.evidence.replayDelta;
  if (replayDelta !== undefined) {
    warnings.push(
      ...replayDelta.warnings.map((warning) => `replay: ${warning}`),
    );
  }
  const adversarial = proposal.evidence.adversarial;
  if (adversarial !== undefined) {
    warnings.push(
      ...adversarial.warnings.map((warning) => `adversarial: ${warning}`),
    );
  }
  if (proposal.change.kind === "package-pack-enablement") {
    warnings.push(
      ...proposal.change.metadataWarnings.map(
        (warning) => `package metadata: ${warning}`,
      ),
      ...proposal.change.plan.warnings.map(
        (warning) =>
          `package plan ${warning.level} ${warning.code}: ${warning.message}`,
      ),
    );
  }
  return warnings.filter((warning) => warning.trim().length > 0);
}

function collectSampleCommands(
  proposal: StructuredRatchetProposal,
): readonly string[] {
  return dedupe([
    ...proposal.evidence.sampleCommands,
    ...proposal.examples.map((example) => example.command),
    ...proposal.fixtureSuggestions.map((fixture) => fixture.command),
  ]).slice(0, DEFAULT_SAMPLE_LIMIT);
}

function approvalTextForRoute(route: ProposalCardRoute): string {
  if (route === "design-input-only") {
    return "Generation/rendering is not approval. This card is design input only: it does not write config or enable packs; any later writable change needs a separate explicit approval path.";
  }
  return "Generation/rendering is not approval. This writable proposal still requires explicit Pi/user approval plus writer validation, schema/provenance checks, and post-write validation before any user-owned config changes.";
}

function renderPriorityReviewLines(card: ProposalCardView): readonly string[] {
  return card.attention.length === 0
    ? [
        "- No replay regressions, adversarial failures, failed validation checks, trust warnings, or proposal warnings are present in this card view.",
      ]
    : card.attention;
}

export function attentionLines(input: {
  readonly route: ProposalCardRoute;
  readonly replay: ProposalCardReplayImpact | undefined;
  readonly adversarial: ProposalCardAdversarialSummary | undefined;
  readonly validation: readonly ProposalCardValidationLine[];
  readonly trustNotes: StructuredRatchetProposal["trustNotes"];
  readonly warningSummary: WarningSummary;
}): readonly string[] {
  const lines: string[] = [];
  if (input.route === "design-input-only") {
    lines.push(
      "- **Design input only:** this proposal is a draft/design artifact and will not write config from this card.",
    );
  }

  const replay = input.replay;
  if (replay?.status === "regression") {
    lines.push(
      `- **Replay regressions:** ${formatCount(replay.regressionCount, "call")} regressed; review-to-fast-path expansions: ${formatCount(replay.reviewToAllowCalls, "call")}.`,
    );
  }

  if (input.adversarial?.status === "failed") {
    if (input.adversarial.failedCaseCount === 0) {
      lines.push(
        "- **Adversarial validation failed:** no per-case adversarial report is attached; inspect the validation checks before approval.",
      );
    } else {
      lines.push(
        `- **Adversarial failed/errored cases:** ${formatCount(input.adversarial.failedCaseCount, "case")} failed or errored.`,
      );
    }
    for (const failedCase of input.adversarial.failedCases) {
      lines.push(
        `  - ${markdownInlineCode(failedCase.command)} (${failedCase.category})${
          failedCase.actualStatus === undefined
            ? ""
            : ` → actual ${failedCase.actualStatus}`
        }`,
      );
    }
  }

  const failedValidation = input.validation.filter(
    (line) => line.status === "fail",
  );
  if (failedValidation.length > 0) {
    lines.push("- **Failed validation checks:**");
    for (const line of failedValidation) {
      lines.push(
        `  - ${validationNameLabel(line.name)}: ${line.code} — ${line.message}`,
      );
    }
  }

  const trustWarnings = input.trustNotes.filter((note) =>
    ["danger", "warning"].includes(note.severity ?? "info"),
  );
  if (trustWarnings.length > 0) {
    lines.push("- **Trust warnings:**");
    for (const note of trustWarnings) {
      lines.push(
        `  - ${renderTrustNoteLine({ severity: note.severity ?? "info", message: `${note.kind} — ${note.message}` })}`,
      );
    }
  }

  if (input.warningSummary.total > 0) {
    lines.push("- **Warnings:**");
    for (const warning of input.warningSummary.shown) {
      lines.push(`  - ${warning}`);
    }
    if (input.warningSummary.omitted > 0) {
      lines.push(
        `  - … ${input.warningSummary.omitted} more warning(s) in structured details`,
      );
    }
  }

  return lines;
}

function renderReplayImpactLines(
  replay: ProposalCardReplayImpact | undefined,
): readonly string[] {
  if (replay === undefined) {
    return ["- Status: not-run", "- Replay delta not attached."];
  }

  const lines = [
    `- Status: ${replay.status}`,
    `- Review reduction: ${formatReviewReduction(replay.reviewReductionPercent)}`,
    `- ${markdownInlineCode(EXPANSION_TRANSITION)} expansions: ${formatCount(replay.reviewToAllowCalls, "call")}`,
    `- Remaining review calls: ${formatCount(replay.remainingReviewCalls, "call")}`,
    `- Regressions: ${formatCount(replay.regressionCount, "call")}`,
  ];

  lines.push("- Changed-family samples:");
  if (replay.changedFamilies.length === 0) {
    lines.push("  - none");
  } else {
    for (const family of replay.changedFamilies) {
      lines.push(`  - ${family}`);
    }
  }

  lines.push("- Blocked/unknown counts:");
  for (const summary of replay.blockedSummary) {
    lines.push(`  - ${summary}`);
  }

  return lines;
}

function renderAdversarialLines(
  adversarial: ProposalCardAdversarialSummary | undefined,
): readonly string[] {
  if (adversarial === undefined) {
    return ["- Status: not-run", "- No adversarial summary is attached."];
  }

  const lines = [
    `- Status: ${adversarial.status}`,
    `- Cases: generated ${adversarial.generatedCaseCount}; evaluated ${adversarial.evaluatedCaseCount}; failed/errored ${adversarial.failedCaseCount}`,
  ];

  if (adversarial.failedCases.length > 0) {
    lines.push("- Failed cases:");
    for (const failedCase of adversarial.failedCases) {
      lines.push(
        `  - ${markdownInlineCode(failedCase.command)} — category ${failedCase.category}${
          failedCase.actualStatus === undefined
            ? ""
            : `; actual ${failedCase.actualStatus}`
        }`,
      );
    }
  }

  return lines;
}

function renderValidationLines(
  validation: readonly ProposalCardValidationLine[],
): readonly string[] {
  return validation.map(
    (line) =>
      `- ${validationNameLabel(line.name)}: ${line.status} (${line.code}) — ${line.message}`,
  );
}

function renderRequiredAcknowledgementLines(
  codes: readonly string[],
): readonly string[] {
  if (codes.length === 0) {
    return ["- none"];
  }
  return codes.map((code) => `- ${markdownInlineCode(code)}`);
}

function renderTrustNoteLines(
  notes: ProposalCardView["trustNotes"],
): readonly string[] {
  if (notes.length === 0) {
    return ["- none"];
  }
  return notes.map((note) => `- ${renderTrustNoteLine(note)}`);
}

function renderTrustNoteLine(
  note: ProposalCardView["trustNotes"][number],
): string {
  return `${note.severity}: ${note.message}${
    note.requiredAcknowledgementCode === undefined
      ? ""
      : ` [requires acknowledgement: ${markdownInlineCode(note.requiredAcknowledgementCode)}]`
  }`;
}

function renderWarningLines(warnings: readonly string[]): readonly string[] {
  const summary = summarizeWarnings(warnings);
  if (summary.total === 0) {
    return ["- none"];
  }
  const lines = summary.shown.map((warning) => `- ${warning}`);
  if (summary.omitted > 0) {
    lines.push(`- … ${summary.omitted} more warning(s) in structured details`);
  }
  return lines;
}

function renderSampleCommandLines(
  commands: readonly string[],
): readonly string[] {
  if (commands.length === 0) {
    return ["- none"];
  }
  return commands.map((command) => `- ${markdownInlineCode(command)}`);
}

function regressionCallCount(delta: ReplayDelta): number {
  return delta.regressions.reduce(
    (total, regression) => total + regression.calls,
    0,
  );
}

function changedFamilySummary(family: ReplayDeltaFamily): string {
  const label =
    family.executable === undefined
      ? markdownInlineCode(family.familyId)
      : `${markdownInlineCode(family.executable)} (${markdownInlineCode(family.familyId)})`;
  const sample =
    family.sampleCommands.length === 0
      ? "no sample commands"
      : `samples ${family.sampleCommands
          .slice(0, 2)
          .map(markdownInlineCode)
          .join(", ")}`;
  return `${label}: ${formatCount(family.calls, "call")}; review-to-fast-path ${formatCount(family.reviewToAllowCalls, "call")}; regressions ${formatCount(regressionCountForFamily(family), "call")}; unchanged review ${formatCount(family.unchangedReviewCalls, "call")}; unknown-tool ${formatCount(family.unknownToolCalls, "call")}; unknown-path ${formatUnknownPathCalls(family.unknownPathCalls)}; ${sample}`;
}

function regressionCountForFamily(family: ReplayDeltaFamily): number {
  return family.regressions.reduce(
    (total, regression) => total + regression.calls,
    0,
  );
}

function blockedSummary(delta: ReplayDelta): readonly string[] {
  return [
    `sealed-floor: ${formatCount(delta.blocked.sealedFloorBlockCalls, "call")}`,
    `active-deny: ${formatCount(delta.blocked.activeDenyBlockCalls, "call")}`,
    `unknown-tool: ${formatCount(delta.blocked.unknownToolCalls, "call")}`,
    `unknown-path: ${formatUnknownPathCalls(delta.blocked.unknownPathCalls)}`,
    `low-fidelity rows: ${formatCount(delta.blocked.lowFidelityCalls, "call")}`,
    `redactions: ${formatCount(delta.blocked.redactedCalls, "call")}`,
  ];
}

function renderPatchSummaryLines(
  summary: readonly string[],
): readonly string[] {
  if (summary.length === 0) {
    return ["- none"];
  }
  return summary.map((line) => `- ${line}`);
}

function renderListOrNone(
  label: string,
  values: readonly string[],
): readonly string[] {
  if (values.length === 0) {
    return [`- ${label}: none`];
  }
  return [`- ${label}:`, ...values.map((value) => `  - ${value}`)];
}

function jsonBlock(value: unknown): string {
  return markdownCodeBlock(renderJson(value), "json");
}

function renderJson(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  const rendered = stableJson(value);
  return typeof rendered === "string" ? rendered : String(rendered);
}

function fileWriteLanguage(format: FileWriteDescription["format"]): string {
  switch (format) {
    case "json":
      return "json";
    case "typescript":
      return "ts";
    case "text":
      return "";
  }
}

function formatReviewReduction(value: number | null): string {
  return value === null ? "not computed" : `${value}%`;
}

function formatUnknownPathCalls(value: number | null): string {
  return value === null ? "not computed" : formatCount(value, "call");
}

function validationNameLabel(name: ProposalCardValidationLine["name"]): string {
  return proposalValidationCheckLabel(name);
}

function dedupe(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output;
}
