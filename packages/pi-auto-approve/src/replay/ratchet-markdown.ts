import type {
  CapturedOutcomeLabel,
  ExecutableTally,
  FrictionFamily,
  OutcomeTally,
  PerCommandRow,
  RatchetReport,
  UnknownToolTally,
} from "./ratchet.ts";
import {
  formatCount,
  formatPercent,
  markdownInlineCode,
} from "./rendering-format.ts";

const EXPANSION_TRANSITION = "review->fast_path";
const EXPANSION_MARKER = "↗ EXPANSION:";

const CAPTURED_OUTCOME_GROUPS = [
  {
    title: "Deterministic",
    labels: [
      "deterministic-allow",
      "deterministic-review",
      "deterministic-deny",
    ],
  },
  {
    title: "Model",
    labels: ["model-allow", "model-review", "model-deny"],
  },
  {
    title: "Human",
    labels: ["human-allow", "human-deny"],
  },
  {
    title: "Block",
    labels: ["block-and-log"],
  },
  {
    title: "Fixture",
    labels: ["fixture-fast-path", "fixture-review", "fixture-hard-block"],
  },
  {
    title: "Unmatched",
    labels: ["no-captured-outcome"],
  },
] as const satisfies readonly {
  readonly title: string;
  readonly labels: readonly CapturedOutcomeLabel[];
}[];

/** Render the report as Markdown in REFERENCE_PATTERNS section order, §8-aware. */
export function renderRatchetMarkdown(report: RatchetReport): string {
  const sections = [
    renderHeader(report),
    renderSummary(report),
    renderCapturedOutcomes(report),
    renderCompare(report),
    renderTopReviewedExecutables(report.topReviewedExecutables),
    renderTopReviewedCommands(report.topReviewedCommands),
    renderTopHardBlockedCommands(report.topHardBlockedCommands),
    renderTopContentiousFamilies(report.topContentiousFamilies),
    renderTopUnknownTools(report.topUnknownTools),
  ].filter((section): section is string => section.length > 0);

  return `${sections.join("\n\n")}\n`;
}

function renderHeader(report: RatchetReport): string {
  const lines = [
    "# Ratchet replay report",
    "",
    `Generated: ${report.generatedAt}`,
  ];
  if (report.repoRoot !== undefined) {
    lines.push(`Repository: ${report.repoRoot}`);
  }
  if (report.sourcePath !== undefined) {
    lines.push(`Source: ${report.sourcePath}`);
  }
  return lines.join("\n");
}

function renderSummary(report: RatchetReport): string {
  const summary = report.summary;
  return [
    "## Summary",
    "",
    `- Total: ${formatCount(summary.totalCalls, "call")} / ${formatCount(summary.totalUnique, "unique command")}`,
    `- Fast path: ${formatOutcome(summary.fastPathCalls, summary.fastPathUnique, summary.totalCalls, summary.totalUnique)}`,
    `- Review: ${formatOutcome(summary.reviewCalls, summary.reviewUnique, summary.totalCalls, summary.totalUnique)}`,
    `- Hard block: ${formatOutcome(summary.hardBlockCalls, summary.hardBlockUnique, summary.totalCalls, summary.totalUnique)}`,
  ].join("\n");
}

function renderCapturedOutcomes(report: RatchetReport): string {
  const summary = report.summary;
  const hasCapturedOutcomes = summary.byCapturedOutcome.size > 0;
  const hasModelLoad = summary.modelReviewLoad.calls > 0;
  const hasRedactions = summary.redactedCalls > 0;
  if (!hasCapturedOutcomes && !hasModelLoad && !hasRedactions) {
    return "";
  }

  const lines = ["## Captured outcomes", ""];
  for (const group of CAPTURED_OUTCOME_GROUPS) {
    const rendered = group.labels
      .map((label) =>
        renderCapturedOutcome(label, summary.byCapturedOutcome.get(label)),
      )
      .filter((line): line is string => line !== undefined);
    if (rendered.length > 0) {
      lines.push(`- ${group.title}: ${rendered.join("; ")}`);
    }
  }

  lines.push(
    `- Model-review load: ${formatCount(summary.modelReviewLoad.calls, "call")} / ${formatCount(summary.modelReviewLoad.unique, "unique command")}`,
  );
  if (hasRedactions) {
    lines.push(
      `- Redacted rows: ${formatCount(summary.redactedCalls, "call")} (commands may be audit-truncated; affected rows are tagged \`(redacted)\`)`,
    );
  }

  return lines.join("\n");
}

function renderCapturedOutcome(
  label: CapturedOutcomeLabel,
  tally: OutcomeTally | undefined,
): string | undefined {
  if (tally === undefined || tally.calls === 0) {
    return undefined;
  }
  return `${label}: ${formatCount(tally.calls, "call")} / ${formatCount(tally.unique, "unique command")}`;
}

function renderCompare(report: RatchetReport): string {
  if (report.compare === undefined) {
    return "";
  }

  const compare = report.compare;
  const lines = [
    "## Compare",
    "",
    `- Changed: ${formatCount(compare.changedCalls, "call")} / ${formatCount(compare.changedUnique, "unique command")}`,
    `- Expansions: ${formatCount(compare.expansions.calls, "call")} / ${formatCount(compare.expansions.unique, "unique command")}`,
  ];

  const transitions = orderedTransitions(compare.transitions);
  if (transitions.length > 0) {
    lines.push("", "### Transitions");
    for (const [transition, calls] of transitions) {
      const prefix =
        transition === EXPANSION_TRANSITION ? `${EXPANSION_MARKER} ` : "";
      lines.push(
        `- ${prefix}${markdownInlineCode(transition)} — ${formatCount(calls, "call")}`,
      );
    }
  }

  if (compare.changedCommands.length > 0) {
    const beforeRows = new Map(
      report.perCommand.map((row) => [row.command, row] as const),
    );
    const changedRows = [...compare.changedCommands].sort((left, right) =>
      compareChangedRows(left, right, beforeRows),
    );
    lines.push("", "### Changed commands");
    for (const row of changedRows) {
      const beforeStatus = beforeRows.get(row.command)?.status;
      const transition =
        beforeStatus === undefined
          ? row.status
          : `${beforeStatus}->${row.status}`;
      const prefix =
        transition === EXPANSION_TRANSITION ? `${EXPANSION_MARKER} ` : "";
      lines.push(
        `- ${prefix}${formatCommand(row)} — ${markdownInlineCode(transition)}; ${formatCount(row.count, "call")} — ${row.reason}`,
      );
    }
  }

  return lines.join("\n");
}

function renderTopReviewedExecutables(
  rows: readonly ExecutableTally[],
): string {
  if (rows.length === 0) {
    return "";
  }

  return [
    "## Top reviewed executables",
    "",
    ...rows.map(
      (row) =>
        `- ${markdownInlineCode(row.executable)} — ${formatCount(row.reviewCalls, "review call")} / ${formatCount(row.unique, "unique command")} (model-reviewed: ${row.modelReviewCalls}; captured denials: ${row.capturedDenialCalls})`,
    ),
  ].join("\n");
}

function renderTopReviewedCommands(rows: readonly PerCommandRow[]): string {
  return renderCommandRows("## Top reviewed commands", rows);
}

function renderTopHardBlockedCommands(rows: readonly PerCommandRow[]): string {
  return renderCommandRows("## Top hard-blocked commands", rows);
}

function renderCommandRows(
  title: string,
  rows: readonly PerCommandRow[],
): string {
  if (rows.length === 0) {
    return "";
  }

  return [
    title,
    "",
    ...rows.map(
      (row) =>
        `- ${formatCommand(row)} — ${formatCount(row.count, "call")} — ${row.reason}`,
    ),
  ].join("\n");
}

function renderTopContentiousFamilies(rows: readonly FrictionFamily[]): string {
  if (rows.length === 0) {
    return "";
  }

  const lines = ["## Top contentious families", ""];
  for (const row of rows) {
    lines.push(
      `- ${markdownInlineCode(row.executable)} — ${formatCount(row.calls, "call")} / ${formatCount(row.unique, "unique command")} (review: ${row.reviewCalls}; hard-block: ${row.hardBlockCalls}; model-reviewed: ${row.modelReviewCalls}; captured denials: ${row.capturedDenialCalls})`,
    );
    for (const command of row.sampleCommands) {
      lines.push(`  - ${markdownInlineCode(command)}`);
    }
  }
  return lines.join("\n");
}

function renderTopUnknownTools(rows: readonly UnknownToolTally[]): string {
  if (rows.length === 0) {
    return "";
  }

  const lines = [
    "## Top unknown-tool review load",
    "",
    "_Non-bash tools have no registered analyzer; they bypass the bash sealed floor and " +
      "structural matcher. `unknownToolPosture` (default `review`) is the only gate. A tool " +
      "earns a dedicated analyzer only when it clears the evidence threshold (PRINCIPLES §11)._",
    "",
  ];
  for (const row of rows) {
    const outcomes = [...row.capturedOutcomes.entries()]
      .map(([label, count]) => `${label}: ${count}`)
      .join("; ");
    lines.push(
      `- ${markdownInlineCode(row.toolName)} — ${formatCount(row.calls, "call")} ` +
        `(review: ${row.reviewCalls}; hard-block: ${row.hardBlockCalls}; ` +
        `model-reviewed: ${row.modelReviewCalls}; captured denials: ${row.capturedDenialCalls})` +
        (outcomes.length ? ` — ${outcomes}` : ""),
    );
  }
  return lines.join("\n");
}

function orderedTransitions(
  transitions: ReadonlyMap<string, number>,
): readonly (readonly [string, number])[] {
  return [...transitions.entries()].sort(
    ([leftTransition, leftCalls], [rightTransition, rightCalls]) => {
      if (leftTransition === EXPANSION_TRANSITION) {
        return -1;
      }
      if (rightTransition === EXPANSION_TRANSITION) {
        return 1;
      }
      return (
        rightCalls - leftCalls || leftTransition.localeCompare(rightTransition)
      );
    },
  );
}

function compareChangedRows(
  left: PerCommandRow,
  right: PerCommandRow,
  beforeRows: ReadonlyMap<string, PerCommandRow>,
): number {
  const leftExpansion = isExpansion(left, beforeRows);
  const rightExpansion = isExpansion(right, beforeRows);
  if (leftExpansion !== rightExpansion) {
    return leftExpansion ? -1 : 1;
  }
  return right.count - left.count || left.command.localeCompare(right.command);
}

function isExpansion(
  row: PerCommandRow,
  beforeRows: ReadonlyMap<string, PerCommandRow>,
): boolean {
  return (
    beforeRows.get(row.command)?.status === "review" &&
    row.status === "fast_path"
  );
}

function formatOutcome(
  calls: number,
  unique: number,
  totalCalls: number,
  totalUnique: number,
): string {
  return `${formatCount(calls, "call")} (${formatPercent(calls, totalCalls)}), ${formatCount(unique, "unique command")} (${formatPercent(unique, totalUnique)})`;
}

function formatCommand(row: PerCommandRow): string {
  const tag = row.fidelity === "redacted" ? " (redacted)" : "";
  return `${markdownInlineCode(row.command)}${tag}`;
}
