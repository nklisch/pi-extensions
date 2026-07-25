import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RecentDecisionEntry } from "../reviewer-context.ts";
import { createAuditLogRecentDecisionSource } from "../reviewer-context-adapter.ts";
import {
  type AutoReviewerCommandDependencies,
  type CommandReport,
  usageReport,
} from "./types.ts";

const MAX_DEBRIEF_DECISIONS = 5;
const NOT_RECORDED = "not recorded";

export interface WhyCommandDetails {
  readonly count: number;
  readonly requestedCount: number;
  readonly cappedAt: number;
  readonly decisions: readonly RecentDecisionEntry[];
  readonly warnings: readonly string[];
}

export function handleWhyCommand(
  rest: readonly string[],
  _ctx: ExtensionCommandContext,
  _deps: AutoReviewerCommandDependencies,
): CommandReport<
  WhyCommandDetails | { readonly usage: true; readonly reason?: string }
> {
  const parsed = parseWhyArgs(rest);
  if (!parsed.ok) {
    return usageReport(parsed.reason);
  }

  const source = createAuditLogRecentDecisionSource();
  const result = source.readRecent();
  const decisions = result.items.slice(0, parsed.count);

  if (decisions.length === 0) {
    return {
      title: "Debrief",
      summary: "No clearance decisions recorded yet.",
      markdown: ["# Debrief", "", "No clearance decisions recorded yet."].join(
        "\n",
      ),
      details: {
        count: 0,
        requestedCount: parsed.requestedCount,
        cappedAt: MAX_DEBRIEF_DECISIONS,
        decisions,
        warnings: result.warnings,
      },
      level: result.warnings.length === 0 ? "info" : "warning",
    };
  }

  return {
    title: "Debrief",
    summary:
      decisions.length === 1
        ? `Most recent clearance decision: ${decisions[0]?.effect ?? NOT_RECORDED} ${decisions[0]?.toolName ?? NOT_RECORDED}.`
        : `Last ${decisions.length} clearance decisions.`,
    markdown: renderDebriefMarkdown(decisions, result.warnings),
    details: {
      count: decisions.length,
      requestedCount: parsed.requestedCount,
      cappedAt: MAX_DEBRIEF_DECISIONS,
      decisions,
      warnings: result.warnings,
    },
    level: result.warnings.length === 0 ? "info" : "warning",
  };
}

function parseWhyArgs(tokens: readonly string[]):
  | {
      readonly ok: true;
      readonly count: number;
      readonly requestedCount: number;
    }
  | { readonly ok: false; readonly reason: string } {
  if (tokens.length === 0) {
    return { ok: true, count: 1, requestedCount: 1 };
  }

  if (tokens.length !== 1) {
    return { ok: false, reason: "Expected `why` or `why <count>`." };
  }

  const [countText] = tokens;
  if (countText === undefined || !/^\d+$/.test(countText)) {
    return { ok: false, reason: "Expected `why` or `why <count>`." };
  }

  const requestedCount = Number(countText);
  if (!Number.isSafeInteger(requestedCount) || requestedCount < 1) {
    return { ok: false, reason: "Expected `why` or `why <count>`." };
  }

  return {
    ok: true,
    requestedCount,
    count: Math.min(requestedCount, MAX_DEBRIEF_DECISIONS),
  };
}

function renderDebriefMarkdown(
  decisions: readonly RecentDecisionEntry[],
  warnings: readonly string[],
): string {
  const lines = ["# Debrief", ""];

  decisions.forEach((decision, index) => {
    if (index > 0) lines.push("");
    lines.push(
      `## ${decision.timestamp} — ${valueOrNotRecorded(decision.toolName)}`,
    );
    lines.push(...renderDecisionLines(decision));
  });

  if (warnings.length > 0) {
    lines.push("", "## Audit source warnings");
    for (const warning of warnings) {
      lines.push(`- ${warning}`);
    }
  }

  return lines.join("\n");
}

function renderDecisionLines(decision: RecentDecisionEntry): readonly string[] {
  const lines = [
    `- Tool: ${inlineCodeOrNotRecorded(decision.toolName)}`,
    ...renderInputLines(decision),
    `- Effect: ${inlineCodeOrNotRecorded(decision.effect)}`,
    `- Reason: ${valueOrNotRecorded(decision.reason)}`,
    `- Rule id: ${inlineCodeOrNotRecorded(decision.provenance?.ruleId)}`,
    `- Pack: ${inlineCodeOrNotRecorded(decision.provenance?.packId)}`,
    `- Provenance: ${inlineCodeOrNotRecorded(decision.provenance?.source)}`,
    `- Reviewer original outcome: ${formatOutcome(
      decision.originalEffect,
      decision.originalReason,
    )}`,
    `- Reviewer final outcome: ${formatOutcome(
      decision.finalEffect,
      decision.finalReason,
    )}`,
    `- Reviewer source: ${inlineCodeOrNotRecorded(
      decision.reviewerDecisionSource,
    )}`,
    `- Reviewer model: ${formatReviewerModel(decision)}`,
  ];

  if (decision.reviewerModelSource !== undefined) {
    lines.push(
      `- Reviewer model source: ${inlineCodeOrNotRecorded(
        decision.reviewerModelSource,
      )}`,
    );
  }
  if (decision.reviewerModelNote !== undefined) {
    lines.push(
      `- Reviewer model note: ${valueOrNotRecorded(decision.reviewerModelNote)}`,
    );
  }
  if (decision.reviewerMode !== undefined) {
    lines.push(
      `- Reviewer path: ${inlineCodeOrNotRecorded(decision.reviewerMode)}`,
    );
  }

  // Debug surface: the parsed shape lives here, never in approval cards.
  if (decision.shape !== undefined) {
    lines.push(
      "",
      "### Parsed shape (debug)",
      "",
      markdownJsonBlock(formatJsonBlock(decision.shape)),
    );
  }

  return lines;
}

function formatJsonBlock(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

function markdownJsonBlock(value: string): string {
  const longestFence = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/gu), (match) => match[0]?.length ?? 0),
  );
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return [`${fence}json`, value, fence].join("\n");
}

function renderInputLines(decision: RecentDecisionEntry): readonly string[] {
  if (decision.command !== undefined) {
    return [`- Command: ${inlineCode(decision.command)}`];
  }

  if (decision.toolInput !== undefined) {
    return [`- Tool input: ${inlineCode(formatToolInput(decision.toolInput))}`];
  }

  return ["- Command/input: not recorded"];
}

function formatOutcome(
  effect: string | undefined,
  reason: string | undefined,
): string {
  if (effect === undefined) return NOT_RECORDED;
  const effectText = inlineCode(effect);
  return reason === undefined
    ? effectText
    : `${effectText} — ${valueOrNotRecorded(reason)}`;
}

function formatReviewerModel(decision: RecentDecisionEntry): string {
  if (decision.reviewerModel === undefined) return NOT_RECORDED;
  return inlineCode(
    `${decision.reviewerModel.provider}/${decision.reviewerModel.id}`,
  );
}

function valueOrNotRecorded(value: string | undefined): string {
  return value === undefined || value.length === 0 ? NOT_RECORDED : value;
}

function inlineCodeOrNotRecorded(value: string | undefined): string {
  return value === undefined || value.length === 0
    ? NOT_RECORDED
    : inlineCode(value);
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function formatToolInput(value: unknown): string {
  if (typeof value === "string") return value;

  try {
    const text = JSON.stringify(value);
    return text === undefined ? NOT_RECORDED : text;
  } catch {
    return NOT_RECORDED;
  }
}
