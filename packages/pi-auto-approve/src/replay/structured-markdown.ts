import type { CommandFamilySummary, CorpusQueryModel } from "./corpus-query.ts";
import type {
  ProposalValidationCheck,
  ReplayDelta,
  ReplayDeltaChangedRecord,
  ReplayDeltaFamily,
  ReplayDeltaRegression,
  ReplayDeltaTransition,
  ReplayDeltaTransitionCount,
  StructuredProposalBatch,
  StructuredRatchetProposal,
} from "./proposal-schema.ts";
import { REPLAY_DELTA_REGRESSION_TRANSITIONS } from "./proposal-schema.ts";
import { PROPOSAL_VALIDATION_CHECKS } from "./proposal-validation-display.ts";
import {
  findCount,
  formatCount,
  markdownInlineCode,
  renderJsonPatchSummary,
} from "./rendering-format.ts";

export interface StructuredRatchetMarkdownInput {
  readonly generatedAt: string;
  readonly repoRoot?: string;
  readonly sourcePath?: string;
  readonly corpus: CorpusQueryModel;
  readonly proposals?: StructuredProposalBatch;
  /** Extra deltas for verification/compare reports not attached to a proposal. */
  readonly replayDeltas?: readonly ReplayDelta[];
}

const EXPANSION_TRANSITION = "review->fast_path";
const DEFAULT_TOP_FAMILY_LIMIT = 5;
const DEFAULT_SAMPLE_COMMAND_LIMIT = 5;
const DEFAULT_CHANGED_RECORD_LIMIT = 10;

const REGRESSION_TRANSITIONS = new Set<string>(
  REPLAY_DELTA_REGRESSION_TRANSITIONS,
);

export function renderStructuredRatchetMarkdown(
  input: StructuredRatchetMarkdownInput,
): string {
  const sections = [
    renderStructuredHeader(input),
    renderCorpusSummaryMarkdown(input.corpus),
    renderReplayDeltasMarkdown(input.replayDeltas),
    renderProposalBatchMarkdown(input.proposals),
    renderReportWarnings(input),
  ].filter((section): section is string => section.length > 0);

  return `${sections.join("\n\n")}\n`;
}

export function renderCorpusSummaryMarkdown(model: CorpusQueryModel): string {
  const sections = [
    renderCorpusTotals(model),
    renderCapturedOutcomes(model),
    renderTopReviewedFamilies(model.families),
    renderTopContentiousFamilies(model.families),
    renderUnknownToolReviewLoad(model.families),
  ].filter((section): section is string => section.length > 0);

  return sections.join("\n\n");
}

export function renderReplayDeltaMarkdown(delta: ReplayDelta): string {
  const lines = [
    "## Replay delta",
    "",
    `- Status: ${replayStatusLabel(delta.status)}`,
    `- Baseline: ${formatCount(delta.baseline.totalRecords, "call")} / ${formatCount(delta.baseline.totalUniqueCommands, "unique command")} (${formatCounts(delta.baseline.replayStatusCounts)})`,
    `- Candidate: ${formatCount(delta.candidate.totalRecords, "call")} / ${formatCount(delta.candidate.totalUniqueCommands, "unique command")} (${formatCounts(delta.candidate.replayStatusCounts)})`,
    `- Changed: ${formatCount(delta.changedCalls, "call")} / ${formatCount(delta.changedUniqueCommands, "unique command")}`,
    `- Review reductions: ${formatCount(delta.improvement.reviewToAllowCalls, "call")} / ${formatCount(delta.improvement.reviewToAllowUniqueCommands, "unique command")} moved ${markdownInlineCode(EXPANSION_TRANSITION)}; reduction ${formatReviewReduction(delta.improvement.reviewReductionPercent)}`,
    `- Remaining review load: ${formatCount(delta.improvement.remainingReviewCalls, "call")}; unchanged reviews: ${formatCount(delta.improvement.unchangedReviewCalls, "call")}`,
    `- Blocks: sealed-floor ${formatCount(delta.blocked.sealedFloorBlockCalls, "call")}; active-deny ${formatCount(delta.blocked.activeDenyBlockCalls, "call")}; unknown-tool ${formatCount(delta.blocked.unknownToolCalls, "call")}; unknown-path ${formatUnknownPathCalls(delta.blocked.unknownPathCalls)}`,
    `- Evidence quality: low-fidelity rows ${formatCount(delta.blocked.lowFidelityCalls, "call")}; redactions ${formatCount(delta.blocked.redactedCalls, "call")}`,
  ];

  if (delta.regressions.length > 0) {
    lines.push("", "### Regressions");
    for (const regression of delta.regressions) {
      lines.push(renderRegressionLine(regression));
    }
  }

  if (delta.transitions.length > 0) {
    lines.push("", "### Transitions");
    for (const transition of orderedTransitions(delta.transitions)) {
      lines.push(renderTransitionLine(transition));
    }
  }

  if (delta.changedFamilies.length > 0) {
    lines.push("", "### Changed families");
    for (const family of delta.changedFamilies) {
      lines.push(...renderChangedFamilyLines(family));
    }
  }

  if (delta.changedRecords.length > 0) {
    lines.push("", "### Changed records");
    for (const record of orderedChangedRecords(delta.changedRecords)) {
      lines.push(renderChangedRecordLine(record));
    }
  }

  if (delta.warnings.length > 0) {
    lines.push("", "### Replay warnings");
    for (const warning of delta.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join("\n");
}

export function renderStructuredProposalSummaryMarkdown(
  proposal: StructuredRatchetProposal,
): string {
  return renderProposalSummaryAtLevel(proposal, 2);
}

function renderStructuredHeader(input: StructuredRatchetMarkdownInput): string {
  const lines = [
    "# Structured ratchet report",
    "",
    `Generated: ${input.generatedAt}`,
  ];
  if (input.repoRoot !== undefined) {
    lines.push(`Repository: ${input.repoRoot}`);
  }
  if (input.sourcePath !== undefined) {
    lines.push(`Source: ${input.sourcePath}`);
  }
  return lines.join("\n");
}

function renderCorpusTotals(model: CorpusQueryModel): string {
  const { summary } = model;
  return [
    "## Summary",
    "",
    `- Total: ${formatCount(summary.totalRecords, "call")} / ${formatCount(summary.totalUniqueCommands, "unique command")}`,
    `- Replay statuses: ${formatCounts(summary.replayStatusCounts)}`,
    `- Sources: ${formatCounts(summary.sourceCounts)}`,
    `- Model-review load: ${formatCount(summary.modelReviewLoad.calls, "call")} / ${formatCount(summary.modelReviewLoad.uniqueCommands, "unique command")}`,
    `- Evidence quality: ${formatCount(summary.lowFidelityCalls, "low-fidelity row")}; ${formatCount(summary.redactedCalls, "redacted row")}`,
    `- Unmatched audit entries: ${formatCount(summary.unmatchedAuditEntries, "audit row")}`,
    `- Warnings: ${formatCount(model.warnings.length, "warning")}`,
  ].join("\n");
}

function renderCapturedOutcomes(model: CorpusQueryModel): string {
  const { summary } = model;
  if (
    summary.capturedOutcomeCounts.length === 0 &&
    summary.modelReviewLoad.calls === 0 &&
    summary.redactedCalls === 0 &&
    summary.lowFidelityCalls === 0
  ) {
    return "";
  }

  const lines = ["## Captured outcomes", ""];
  if (summary.capturedOutcomeCounts.length === 0) {
    lines.push("- No captured outcome labels recorded.");
  } else {
    for (const count of summary.capturedOutcomeCounts) {
      lines.push(`- ${count.label}: ${formatCountWithUnique(count)}`);
    }
  }
  lines.push(
    `- Model-review load: ${formatCount(summary.modelReviewLoad.calls, "call")} / ${formatCount(summary.modelReviewLoad.uniqueCommands, "unique command")}`,
    `- Low-fidelity rows: ${formatCount(summary.lowFidelityCalls, "call")}`,
    `- Redacted rows: ${formatCount(summary.redactedCalls, "call")}`,
  );
  return lines.join("\n");
}

function renderTopReviewedFamilies(
  families: readonly CommandFamilySummary[],
): string {
  const rows = families
    .filter((family) => replayStatusCalls(family, "review") > 0)
    .slice(0, DEFAULT_TOP_FAMILY_LIMIT);
  if (rows.length === 0) {
    return "";
  }

  const lines = ["## Top reviewed families", ""];
  for (const family of rows) {
    const reviewCalls = replayStatusCalls(family, "review");
    lines.push(
      `- ${familyLabel(family)} — review ${formatCount(reviewCalls, "call")} / ${formatCount(family.uniqueCommands, "unique command")} (model-reviewed: ${family.modelReviewCalls}; captured denials: ${family.capturedDenialCalls})`,
    );
    appendSampleCommands(lines, family.sampleCommands, 2);
  }
  return lines.join("\n");
}

function renderTopContentiousFamilies(
  families: readonly CommandFamilySummary[],
): string {
  const rows = families
    .filter((family) => familyContentionScore(family) > 0)
    .slice(0, DEFAULT_TOP_FAMILY_LIMIT);
  if (rows.length === 0) {
    return "";
  }

  const lines = ["## Top contentious families", ""];
  for (const family of rows) {
    lines.push(
      `- ${familyLabel(family)} — ${formatCount(family.calls, "call")} / ${formatCount(family.uniqueCommands, "unique command")} (review: ${replayStatusCalls(family, "review")}; hard-block: ${replayStatusCalls(family, "hard_block")}; model-reviewed: ${family.modelReviewCalls}; captured denials: ${family.capturedDenialCalls}; low-fidelity: ${family.lowFidelityCalls}; redacted: ${family.redactedCalls})`,
    );
    appendSampleCommands(lines, family.sampleCommands, 2);
  }
  return lines.join("\n");
}

function renderUnknownToolReviewLoad(
  families: readonly CommandFamilySummary[],
): string {
  const rows = families
    .filter((family) => family.family.kind === "unknown-tool")
    .filter((family) => replayStatusCalls(family, "review") > 0)
    .slice(0, DEFAULT_TOP_FAMILY_LIMIT);
  if (rows.length === 0) {
    return "";
  }

  const lines = [
    "## Top unknown-tool review load",
    "",
    "_Unsupported tools have no analyzer here; analyzed Pi built-ins and extension tools appear in their own command families._",
    "",
  ];
  for (const family of rows) {
    lines.push(
      `- ${markdownInlineCode(family.family.toolName)} — ${formatCount(family.calls, "call")} (review: ${replayStatusCalls(family, "review")}; hard-block: ${replayStatusCalls(family, "hard_block")}; model-reviewed: ${family.modelReviewCalls}; captured denials: ${family.capturedDenialCalls})`,
    );
    appendSampleCommands(lines, family.sampleCommands, 2);
  }
  return lines.join("\n");
}

function renderReplayDeltasMarkdown(
  replayDeltas: readonly ReplayDelta[] | undefined,
): string {
  if (replayDeltas === undefined || replayDeltas.length === 0) {
    return "";
  }
  return replayDeltas.map(renderReplayDeltaMarkdown).join("\n\n");
}

function renderProposalBatchMarkdown(
  batch: StructuredProposalBatch | undefined,
): string {
  if (batch === undefined || batch.proposals.length === 0) {
    return "";
  }

  const lines = [
    "## Proposal summaries",
    "",
    `- Batch generated: ${batch.generatedAt}`,
    `- Proposals: ${formatCount(batch.proposals.length, "proposal")}`,
  ];
  if (batch.source.corpusSummary !== undefined) {
    lines.push(
      `- Source corpus: ${formatCount(batch.source.corpusSummary.totalRecords, "call")} / ${formatCount(batch.source.corpusSummary.totalUniqueCommands, "unique command")}`,
    );
  }
  if (batch.source.warnings.length > 0 || batch.warnings.length > 0) {
    lines.push(
      `- Batch warnings: ${formatCount(batch.source.warnings.length + batch.warnings.length, "warning")}`,
    );
  }

  for (const proposal of batch.proposals) {
    lines.push("", renderProposalSummaryAtLevel(proposal, 3));
  }
  return lines.join("\n");
}

function renderProposalSummaryAtLevel(
  proposal: StructuredRatchetProposal,
  level: 2 | 3,
): string {
  const lines = [
    `${"#".repeat(level)} Proposal ${markdownInlineCode(proposal.id)}: ${proposal.title}`,
    "",
    `- ID: ${markdownInlineCode(proposal.id)}`,
    `- Kind: ${proposal.kind}`,
    `- Target: ${targetSummary(proposal)}`,
    `- Application mode: ${proposal.applicationMode}`,
    `- Summary: ${proposal.summary.length > 0 ? proposal.summary : proposal.reason}`,
    `- Change: ${changeSummary(proposal)}`,
    "",
    `${"#".repeat(level + 1)} Evidence`,
    `- Calls: ${formatCount(proposal.evidence.calls, "call")} / ${formatCount(proposal.evidence.uniqueCommands, "unique command")}`,
    `- Review calls: ${formatCount(proposal.evidence.reviewCalls, "call")}; hard-block calls: ${formatCount(proposal.evidence.hardBlockCalls, "call")}`,
    `- Model-review calls: ${formatCount(proposal.evidence.modelReviewCalls, "call")}; captured denials: ${formatCount(proposal.evidence.capturedDenialCalls, "call")}`,
    `- Families: ${formatInlineList(proposal.evidence.familyIds)}`,
    `- Records: ${formatCount(proposal.evidence.recordIds.length, "record")}`,
    `- Replay statuses: ${formatCounts(proposal.evidence.replayStatusCounts)}`,
    `- Captured outcomes: ${formatCounts(proposal.evidence.capturedOutcomeCounts)}`,
  ];
  appendProposalSampleCommands(lines, proposal);

  lines.push(
    "",
    `${"#".repeat(level + 1)} Validation`,
    ...renderProposalValidationLines(proposal),
    "",
    `${"#".repeat(level + 1)} Replay status`,
    ...renderProposalReplayLines(proposal),
    "",
    `${"#".repeat(level + 1)} Adversarial status`,
    ...renderProposalAdversarialLines(proposal),
  );

  if (proposal.trustNotes.length > 0) {
    lines.push("", `${"#".repeat(level + 1)} Trust notes`);
    for (const note of proposal.trustNotes) {
      lines.push(
        `- ${note.severity ?? "info"} ${markdownInlineCode(note.kind)} — ${note.message}`,
      );
    }
  }

  if (proposal.warnings.length > 0) {
    lines.push("", `${"#".repeat(level + 1)} Proposal warnings`);
    for (const warning of proposal.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join("\n");
}

function renderReportWarnings(input: StructuredRatchetMarkdownInput): string {
  const warnings = collectReportWarnings(input);
  if (warnings.length === 0) {
    return "";
  }
  return ["## Warnings", "", ...warnings.map((warning) => `- ${warning}`)].join(
    "\n",
  );
}

function collectReportWarnings(
  input: StructuredRatchetMarkdownInput,
): readonly string[] {
  const warnings: string[] = [];
  for (const warning of input.corpus.warnings) {
    warnings.push(`corpus: ${warning}`);
  }
  for (const delta of input.replayDeltas ?? []) {
    for (const warning of delta.warnings) {
      warnings.push(`replay: ${warning}`);
    }
  }
  const batch = input.proposals;
  if (batch !== undefined) {
    for (const warning of batch.source.warnings) {
      warnings.push(`proposal source: ${warning}`);
    }
    for (const warning of batch.warnings) {
      warnings.push(`proposal batch: ${warning}`);
    }
    for (const proposal of batch.proposals) {
      for (const warning of proposal.warnings) {
        warnings.push(`proposal ${proposal.id}: ${warning}`);
      }
      const replayDelta = proposal.evidence.replayDelta;
      if (replayDelta !== undefined) {
        for (const warning of replayDelta.warnings) {
          warnings.push(`proposal ${proposal.id} replay: ${warning}`);
        }
      }
      const adversarial = proposal.evidence.adversarial;
      if (adversarial !== undefined) {
        for (const warning of adversarial.warnings) {
          warnings.push(`proposal ${proposal.id} adversarial: ${warning}`);
        }
      }
    }
  }
  return dedupe(warnings);
}

function renderProposalValidationLines(
  proposal: StructuredRatchetProposal,
): readonly string[] {
  const lines: string[] = [];
  for (const [key, label] of PROPOSAL_VALIDATION_CHECKS) {
    const check = proposal.validation[key];
    if (check !== undefined) {
      lines.push(`- ${label}: ${validationCheckSummary(check)}`);
      continue;
    }
    if (key === "replay") {
      lines.push(
        "- Replay: pending (replay-not-attached) — no replay validation check attached",
      );
    } else if (key === "adversarial") {
      lines.push(
        "- Adversarial: skipped (adversarial-not-attached) — no adversarial validation check attached",
      );
    }
  }
  return lines;
}

function renderProposalReplayLines(
  proposal: StructuredRatchetProposal,
): readonly string[] {
  const delta = proposal.evidence.replayDelta;
  if (delta === undefined) {
    return ["- Replay evidence: pending — no replay delta attached"];
  }
  const lines = [
    `- Replay evidence: ${replayStatusLabel(delta.status)}`,
    `- Changed: ${formatCount(delta.changedCalls, "call")} / ${formatCount(delta.changedUniqueCommands, "unique command")}`,
    `- Review reductions: ${formatCount(delta.improvement.reviewToAllowCalls, "call")} moved ${markdownInlineCode(EXPANSION_TRANSITION)}; reduction ${formatReviewReduction(delta.improvement.reviewReductionPercent)}`,
    `- Remaining review load: ${formatCount(delta.improvement.remainingReviewCalls, "call")}; unchanged reviews: ${formatCount(delta.improvement.unchangedReviewCalls, "call")}`,
    `- Blocks: sealed-floor ${formatCount(delta.blocked.sealedFloorBlockCalls, "call")}; active-deny ${formatCount(delta.blocked.activeDenyBlockCalls, "call")}; unknown-tool ${formatCount(delta.blocked.unknownToolCalls, "call")}; unknown-path ${formatUnknownPathCalls(delta.blocked.unknownPathCalls)}`,
  ];
  if (delta.regressions.length > 0) {
    lines.push(
      `- Regressions: ${delta.regressions
        .map(
          (regression) =>
            `${markdownInlineCode(regression.transition)} (${formatCount(regression.calls, "call")})`,
        )
        .join("; ")}`,
    );
  }
  return lines;
}

function renderProposalAdversarialLines(
  proposal: StructuredRatchetProposal,
): readonly string[] {
  const report = proposal.evidence.adversarial;
  if (report === undefined) {
    return ["- Adversarial evidence: skipped — no adversarial report attached"];
  }

  const failedOrErrored = report.results.filter((result) =>
    ["failed", "errored"].includes(result.outcome),
  );
  const displayedFailedOrErroredCount = Math.max(
    report.failedCaseCount,
    failedOrErrored.length,
  );
  const lines = [
    `- Adversarial evidence: ${report.status}`,
    `- Cases: generated ${report.generatedCaseCount}; evaluated ${report.evaluatedCaseCount}; failed/errored ${displayedFailedOrErroredCount}; skipped ${report.skippedCaseCount}`,
  ];
  for (const result of failedOrErrored.slice(0, DEFAULT_SAMPLE_COMMAND_LIMIT)) {
    lines.push(
      `- Failed/errored case ${markdownInlineCode(result.caseId)} (${result.category}, ${result.outcome}) — ${markdownInlineCode(result.command)}${
        result.actualStatus === undefined
          ? ""
          : ` → actual ${result.actualStatus}`
      }`,
    );
  }
  for (const warning of report.warnings.slice(
    0,
    DEFAULT_SAMPLE_COMMAND_LIMIT,
  )) {
    lines.push(`- Warning: ${warning}`);
  }
  return lines;
}

function appendProposalSampleCommands(
  lines: string[],
  proposal: StructuredRatchetProposal,
): void {
  const commands = dedupe([
    ...proposal.evidence.sampleCommands,
    ...proposal.examples.map((example) => example.command),
  ]).slice(0, DEFAULT_SAMPLE_COMMAND_LIMIT);
  if (commands.length === 0) {
    lines.push("- Sample commands: none");
    return;
  }
  lines.push("- Sample commands:");
  for (const command of commands) {
    lines.push(`  - ${markdownInlineCode(command)}`);
  }
}

function targetSummary(proposal: StructuredRatchetProposal): string {
  const { target } = proposal;
  switch (target.kind) {
    case "user-global-config":
      return `user-global config ${markdownInlineCode(target.path)}`;
    case "user-project-overlay":
      return `user-project overlay ${markdownInlineCode(target.path)} for ${markdownInlineCode(target.projectKey)} (${markdownInlineCode(target.projectRoot)})`;
    case "package-pack-config": {
      const packageLabel =
        target.packageName === undefined
          ? ""
          : `; package ${markdownInlineCode(target.packageName)}${
              target.packageVersion === undefined
                ? ""
                : `@${target.packageVersion}`
            }`;
      return `package-pack config ${markdownInlineCode(target.path)} for pack ${markdownInlineCode(target.packId)}${packageLabel}`;
    }
    case "design-input":
      return `design input (${target.route})${
        target.suggestedPath === undefined
          ? ""
          : ` at ${markdownInlineCode(target.suggestedPath)}`
      }`;
  }
}

function changeSummary(proposal: StructuredRatchetProposal): string {
  const { change } = proposal;
  switch (change.kind) {
    case "policy-pack": {
      const patchSummary = renderJsonPatchSummary(change.rawPackPatch).join(
        "; ",
      );
      const writePath =
        change.fileWrite === undefined
          ? ""
          : `; file write ${markdownInlineCode(change.fileWrite.path)} (${change.fileWrite.mode})`;
      return `${change.effect} rule ${markdownInlineCode(change.packId)}/${markdownInlineCode(change.ruleId)}${
        patchSummary.length === 0 ? "" : `; patch ${patchSummary}`
      }${writePath}`;
    }
    case "reviewer-config":
      return `${change.op} reviewer pointer ${markdownInlineCode(change.pointer)}`;
    case "project-scope-config": {
      const patchSummary = renderJsonPatchSummary(change.patch).join("; ");
      return `project-scope patch${
        patchSummary.length === 0 ? " (empty)" : ` ${patchSummary}`
      }`;
    }
    case "package-pack-enablement":
      return `${change.enable ? "enable" : "disable"} package pack ${markdownInlineCode(change.packId)} via plan ${markdownInlineCode(change.plan.id)}`;
    case "pack-file-authoring": {
      const parts = [`${change.authoringKind} design input`];
      if (change.moduleId !== undefined) {
        parts.push(`module ${markdownInlineCode(change.moduleId)}`);
      }
      if (change.packId !== undefined) {
        parts.push(`pack ${markdownInlineCode(change.packId)}`);
      }
      if (change.ruleId !== undefined) {
        parts.push(`rule ${markdownInlineCode(change.ruleId)}`);
      }
      if (change.fileWrite !== undefined) {
        parts.push(`file ${markdownInlineCode(change.fileWrite.path)}`);
      }
      return parts.join("; ");
    }
  }
}

function renderRegressionLine(regression: ReplayDeltaRegression): string {
  return `- REGRESSION ${markdownInlineCode(regression.transition)} (${regression.kind}) — ${formatCount(regression.calls, "call")} / ${formatCount(regression.uniqueCommands, "unique command")} — ${regression.message}`;
}

function renderTransitionLine(transition: ReplayDeltaTransitionCount): string {
  return `- ${transitionMarker(transition.transition)}${markdownInlineCode(transition.transition)} — ${formatCount(transition.calls, "call")} / ${formatCount(transition.uniqueCommands, "unique command")}`;
}

function renderChangedFamilyLines(
  family: ReplayDeltaFamily,
): readonly string[] {
  const lines = [
    `- ${changedFamilyLabel(family)} — ${formatCount(family.calls, "call")} / ${formatCount(family.uniqueCommands, "unique command")} (review→fast-path: ${family.reviewToAllowCalls}; unchanged reviews: ${family.unchangedReviewCalls}; sealed-floor: ${family.sealedFloorBlockCalls}; unknown-tool: ${family.unknownToolCalls}; unknown-path: ${formatUnknownPathCalls(family.unknownPathCalls)})`,
    `  - Transitions: ${formatTransitions(family.transitions)}`,
  ];
  if (family.regressions.length > 0) {
    lines.push(
      `  - Regressions: ${family.regressions
        .map(
          (regression) =>
            `${markdownInlineCode(regression.transition)} (${formatCount(regression.calls, "call")})`,
        )
        .join("; ")}`,
    );
  }
  appendSampleCommands(lines, family.sampleCommands, 2);
  return lines;
}

function renderChangedRecordLine(record: ReplayDeltaChangedRecord): string {
  const redacted = record.fidelity === "redacted" ? " (redacted)" : "";
  const baselineRule =
    record.baselineRuleId === undefined
      ? ""
      : `; baseline rule ${markdownInlineCode(record.baselineRuleId)}`;
  const candidateRule =
    record.candidateRuleId === undefined
      ? ""
      : `; candidate rule ${markdownInlineCode(record.candidateRuleId)}`;
  return `- ${transitionMarker(record.transition)}${markdownInlineCode(record.command)}${redacted} — ${markdownInlineCode(record.transition)} in ${markdownInlineCode(record.familyId)}${baselineRule}${candidateRule}; baseline: ${record.baselineReason}; candidate: ${record.candidateReason}`;
}

function orderedTransitions(
  transitions: readonly ReplayDeltaTransitionCount[],
): readonly ReplayDeltaTransitionCount[] {
  return [...transitions].sort((left, right) => {
    const classOrder =
      transitionSortRank(left.transition) -
      transitionSortRank(right.transition);
    return (
      classOrder ||
      right.calls - left.calls ||
      left.transition.localeCompare(right.transition)
    );
  });
}

function orderedChangedRecords(
  records: readonly ReplayDeltaChangedRecord[],
): readonly ReplayDeltaChangedRecord[] {
  return [...records]
    .sort((left, right) => {
      const classOrder =
        transitionSortRank(left.transition) -
        transitionSortRank(right.transition);
      return (
        classOrder ||
        left.familyId.localeCompare(right.familyId) ||
        left.command.localeCompare(right.command) ||
        left.recordId.localeCompare(right.recordId)
      );
    })
    .slice(0, DEFAULT_CHANGED_RECORD_LIMIT);
}

function transitionSortRank(transition: ReplayDeltaTransition): number {
  if (REGRESSION_TRANSITIONS.has(transition)) {
    return 0;
  }
  if (transition === EXPANSION_TRANSITION) {
    return 1;
  }
  if (transition === "review->hard_block") {
    return 2;
  }
  const [baseline, candidate] = transition.split("->");
  if (baseline === candidate) {
    return 4;
  }
  return 3;
}

function transitionMarker(transition: ReplayDeltaTransition): string {
  if (REGRESSION_TRANSITIONS.has(transition)) {
    return "REGRESSION ";
  }
  if (transition === EXPANSION_TRANSITION) {
    return "EXPANSION ";
  }
  if (transition === "review->review") {
    return "UNCHANGED REVIEW ";
  }
  if (transition === "review->hard_block") {
    return "SAFE TIGHTENING ";
  }
  const [baseline, candidate] = transition.split("->");
  if (baseline === candidate) {
    return "UNCHANGED ";
  }
  return "";
}

function familyLabel(family: CommandFamilySummary): string {
  const executable = family.family.executable;
  return executable === undefined
    ? markdownInlineCode(family.family.id)
    : `${markdownInlineCode(executable)} (${markdownInlineCode(family.family.id)})`;
}

function changedFamilyLabel(family: ReplayDeltaFamily): string {
  return family.executable === undefined
    ? markdownInlineCode(family.familyId)
    : `${markdownInlineCode(family.executable)} (${markdownInlineCode(family.familyId)})`;
}

function replayStatusCalls(
  family: CommandFamilySummary,
  status: "fast_path" | "review" | "hard_block",
): number {
  return findCount(family.replayStatusCounts, status);
}

function familyContentionScore(family: CommandFamilySummary): number {
  return (
    replayStatusCalls(family, "review") +
    replayStatusCalls(family, "hard_block") * 2 +
    family.modelReviewCalls +
    family.capturedDenialCalls * 2 +
    family.lowFidelityCalls +
    family.redactedCalls
  );
}

function appendSampleCommands(
  lines: string[],
  commands: readonly string[],
  indentSpaces: number,
): void {
  for (const command of commands.slice(0, DEFAULT_SAMPLE_COMMAND_LIMIT)) {
    lines.push(`${" ".repeat(indentSpaces)}- ${markdownInlineCode(command)}`);
  }
}

function formatCounts(
  counts: readonly {
    readonly label: unknown;
    readonly calls: number;
    readonly uniqueCommands?: number;
  }[],
): string {
  if (counts.length === 0) {
    return "none";
  }
  return counts
    .map((count) => `${String(count.label)}: ${formatCountWithUnique(count)}`)
    .join("; ");
}

function formatCountWithUnique(count: {
  readonly calls: number;
  readonly uniqueCommands?: number;
}): string {
  if (count.uniqueCommands === undefined) {
    return formatCount(count.calls, "call");
  }
  return `${formatCount(count.calls, "call")} / ${formatCount(count.uniqueCommands, "unique command")}`;
}

function formatTransitions(
  transitions: readonly ReplayDeltaTransitionCount[],
): string {
  if (transitions.length === 0) {
    return "none";
  }
  return orderedTransitions(transitions)
    .map(
      (transition) =>
        `${transitionMarker(transition.transition)}${markdownInlineCode(transition.transition)} (${formatCount(transition.calls, "call")})`,
    )
    .join("; ");
}

function formatUnknownPathCalls(value: number | null): string {
  return value === null ? "not computed" : formatCount(value, "call");
}

function formatReviewReduction(value: number | null): string {
  return value === null ? "not computed" : `${value}%`;
}

function replayStatusLabel(status: ReplayDelta["status"]): string {
  switch (status) {
    case "regression":
      return "REGRESSION";
    case "passed":
      return "passed";
    case "not-run":
      return "not-run";
  }
}

function validationCheckSummary(check: ProposalValidationCheck): string {
  return `${check.status} (${check.code}) — ${check.message}`;
}

function formatInlineList(values: readonly string[]): string {
  if (values.length === 0) {
    return "none";
  }
  return values.map(markdownInlineCode).join(", ");
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
