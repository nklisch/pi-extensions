import type { ReviewerMode } from "../audit/entry.ts";
import type {
  ResolvedReviewerConfig,
  ResolvedReviewNotePreference,
} from "../config/loader.ts";
import type { ClearanceMode } from "../config/schema.ts";
import type { ToolShape } from "../parse/shape.ts";
import type { Decision } from "../policy/core.ts";
import type { AutoReviewerStatusView } from "./auto-reviewer-read-models.ts";
import { compoundRecoveryReason } from "./compound-recovery.ts";
import {
  buildHumanReviewCard,
  type HumanReviewCard,
} from "./human-review-card.ts";
import { markdownCodeSpan } from "./markdown.ts";

export type { ReviewNoteMode } from "../config/schema.ts";

export interface ReviewVisibilityInput {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly shape: ToolShape;
  readonly originalDecision: Decision;
  readonly reviewerConfig: ResolvedReviewerConfig;
}

export interface CompactReviewSummary {
  readonly title: string;
  readonly toolLabel: string;
  readonly commandPreview: string;
  readonly policyReason: string;
  readonly reviewerModeLabel: string;
  readonly promptPostureLabel: string;
  /** Plain-language card: what the call does and where it acts. Never JSON. */
  readonly card: HumanReviewCard;
}

export interface ReviewOutcomeNoticeInput {
  readonly reviewerMode: ReviewerMode;
  readonly finalDecision: Decision;
  readonly reviewerModelLabel?: string;
}

export interface ReviewDecisionNoteInput extends ResolvedReviewNotePreference {
  readonly reviewerMode: ReviewerMode;
  readonly finalDecision: Decision;
  readonly reviewerModelLabel?: string;
}

export interface ReviewDecisionNote {
  /** One-line stream text; omitted when the mode suppresses text. */
  readonly text?: string;
  /** Longer detail for tooltip/detail surfaces. Model labels live here, never in text. */
  readonly detail?: string;
  /** Accent intent; adapter decides whether the runtime can render it. */
  readonly accent: false | "clearance-gold";
}

const COMMAND_PREVIEW_LIMIT = 180;
const STATUS_LINE_LIMIT = 240;
const NOTICE_REASON_LIMIT = 220;
const NOTE_DETAIL_MODEL_LABEL_LIMIT = 80;

/** Theme color names understood by Pi's `theme.fg`; kept structural so tests can fake it. */
export type StatusLineFg = (color: string, text: string) => string;

/**
 * Mode-token accent for the footer status line. The mode word is the only
 * colored segment: off reads inactive (muted), ask reads "you will be
 * prompted" (warning), auto reads "active coverage" (success). Applied after
 * plain-text truncation so ANSI escapes never interfere with the length cap.
 */
export function styleStatusLineMode(
  label: string,
  mode: ClearanceMode,
  fg: StatusLineFg,
): string {
  const prefix = `clearance: ${mode}`;
  if (!label.startsWith(prefix)) return label;
  const color =
    mode === "off" ? "muted" : mode === "ask" ? "warning" : "success";
  return `clearance: ${fg(color, mode)}${label.slice(prefix.length)}`;
}

export function formatStatusLine(view: AutoReviewerStatusView): string {
  // The status line says what the operator will experience; configuration
  // detail (prompt posture, context mode, budgets) lives in /clearance status.
  return truncateOneLine(
    [
      `clearance: ${view.mode}`,
      ...(view.mode === "auto"
        ? [`reviewer ${reviewerStatusLabel(view.reviewer)}`]
        : []),
      ...(view.ratchet.active ? ["tune on"] : []),
      ...(view.warnings.length === 0
        ? []
        : [`warnings ${view.warnings.length}`]),
    ].join(" · "),
    STATUS_LINE_LIMIT,
  );
}

export function buildCompactReviewSummary(
  input: ReviewVisibilityInput,
): CompactReviewSummary {
  const policyReason = input.originalDecision.reason.trim();
  const basePolicyReason =
    policyReason.length === 0
      ? "deterministic policy requested review"
      : policyReason;
  const typedPolicyReason = appendTypedMutationReviewReason(
    basePolicyReason,
    input.shape,
  );
  const resolvedPolicyReason = appendCompoundRecoveryReason(
    typedPolicyReason,
    input.shape,
    input.originalDecision,
  );
  const commandPreview = commandPreviewFor(input);

  return {
    title: "Review Pi tool call",
    toolLabel: toolLabel(input.toolName, input.shape),
    commandPreview,
    policyReason: resolvedPolicyReason,
    reviewerModeLabel: reviewerConfigLabel(input.reviewerConfig),
    promptPostureLabel: `prompt profile ${input.reviewerConfig.promptPosture} · ctx ${input.reviewerConfig.contextMode}`,
    card: buildHumanReviewCard(input.shape),
  };
}

export function formatHumanReviewMessage(
  summary: CompactReviewSummary,
): string {
  // Approval surfaces are prose-only. The raw tool input and parsed shape are
  // debug material reachable through /clearance why, never dumped here.
  const sections = [
    markdownCodeSpan(summary.commandPreview),
    "",
    "**What it does**",
    ...summary.card.whatItDoes.map((line) => `- ${line}`),
  ];
  if (summary.card.whereItActs.length > 0) {
    sections.push(
      "",
      "**Where it acts**",
      ...summary.card.whereItActs.map((line) => `- ${line}`),
    );
  }
  sections.push("", "**Why you're being asked**", `- ${summary.policyReason}`);
  return sections.join("\n");
}

/**
 * Block-reason presentation for denied calls. Deterministic denies point at
 * the debrief; reviewer-sourced denies also point at the family-allow path.
 * Sealed-floor and pack deny rules stay hint-free about widening because a
 * deny rule can outrank a newly authored allow.
 */
export function formatDenyBlockReason(decision: Decision): string {
  // Blocked-pending-review outcomes (unattended fallback) get the debrief
  // hint too; every blocked call should point somewhere useful.
  if (decision.effect === "review") {
    return decision.reason.includes("/clearance why")
      ? decision.reason
      : `${decision.reason} — /clearance why for details`;
  }
  if (decision.effect !== "deny") return decision.reason;
  const reason = decision.reason;
  // The allow-family hint applies only to reviewer-sourced denies: a model
  // decision (generated provenance with no pack/rule identity, fixed prefix)
  // or the human reviewer's own verdict (fixed reason text). Deterministic
  // pack/floor denies get only the debrief hint — a deny rule can outrank a
  // newly authored allow, so promising the family path would mislead.
  const reviewerSourced =
    (decision.provenance.source === "generated" &&
      decision.provenance.packId === undefined &&
      decision.provenance.ruleId === undefined &&
      reason.startsWith("Model auto-reviewer deny")) ||
    reason === "Human reviewer denied the tool call";
  return reviewerSourced
    ? `${reason} — /clearance why for details; /clearance allow <plain language> to permit this family`
    : `${reason} — /clearance why for details`;
}

export function formatModelOutcomeNotice(
  input: ReviewOutcomeNoticeInput,
): string | undefined {
  if (input.reviewerMode !== "model") return undefined;
  if (
    input.finalDecision.effect !== "allow" &&
    input.finalDecision.effect !== "deny"
  ) {
    return undefined;
  }

  const verb = input.finalDecision.effect === "allow" ? "allowed" : "denied";
  const modelLabel =
    input.reviewerModelLabel === undefined
      ? ""
      : ` by ${input.reviewerModelLabel}`;
  const reason = truncateOneLine(
    modelReasonFromDecision(input.finalDecision.reason),
    NOTICE_REASON_LIMIT,
  );
  return `Auto-reviewer: model ${verb}${modelLabel} — ${reason}`;
}

export function formatReviewDecisionNote(
  input: ReviewDecisionNoteInput,
): ReviewDecisionNote | undefined {
  const reason = modelOutcomeReasonForNote(input);
  if (reason === undefined) return undefined;

  const accent = reviewDecisionNoteAccent(input);
  const detail = reviewDecisionNoteDetail(input);

  switch (input.mode) {
    case "reason+accent":
      return addOptionalDetail({ text: reason, accent }, detail);
    case "accent-only":
      return addOptionalDetail({ accent }, detail);
    case "reason+model":
      return addOptionalDetail({ text: reason, accent }, detail);
    case "off":
      // A defined empty note distinguishes "suppressed by preference" from
      // non-model/non-final paths, which return undefined and should stay quiet.
      return { accent: false };
    default:
      return assertNeverReviewNoteMode(input.mode);
  }
}

function modelOutcomeReasonForNote(
  input: ReviewDecisionNoteInput,
): string | undefined {
  // The stream text must stay model-free by default. Model identity is an
  // optional detail field so adapters can choose where/how to render it.
  const notice = formatModelOutcomeNotice({
    reviewerMode: input.reviewerMode,
    finalDecision: input.finalDecision,
  });
  if (notice === undefined) return undefined;

  return stripModelOutcomeNoticePrefix(notice, input.finalDecision.effect);
}

function stripModelOutcomeNoticePrefix(
  notice: string,
  effect: Decision["effect"],
): string {
  const prefix =
    effect === "allow"
      ? "Auto-reviewer: model allowed — "
      : "Auto-reviewer: model denied — ";
  return notice.startsWith(prefix) ? notice.slice(prefix.length) : notice;
}

function reviewDecisionNoteAccent(
  input: ReviewDecisionNoteInput,
): ReviewDecisionNote["accent"] {
  return input.accent && input.finalDecision.effect === "allow"
    ? "clearance-gold"
    : false;
}

function reviewDecisionNoteDetail(
  input: ReviewDecisionNoteInput,
): string | undefined {
  const shouldShowModelLabel =
    input.mode === "reason+model" || input.showModelLabel;
  if (!shouldShowModelLabel || input.reviewerModelLabel === undefined) {
    return undefined;
  }

  const detail = truncateOneLine(
    input.reviewerModelLabel,
    NOTE_DETAIL_MODEL_LABEL_LIMIT,
  );
  return detail.length === 0 ? undefined : detail;
}

function addOptionalDetail(
  note: ReviewDecisionNote,
  detail: string | undefined,
): ReviewDecisionNote {
  return detail === undefined ? note : { ...note, detail };
}

function assertNeverReviewNoteMode(mode: never): never {
  throw new Error(`Unhandled review note mode: ${mode}`);
}

function reviewerStatusLabel(
  reviewer: AutoReviewerStatusView["reviewer"],
): string {
  if (reviewer.path === "passthrough") return "mode off passthrough";
  if (reviewer.path !== "model") return reviewer.path;
  if (reviewer.resolvedModel === null) return "model";
  return `model ${reviewer.resolvedModel}`;
}

function reviewerConfigLabel(_config: ResolvedReviewerConfig): string {
  return "configured reviewer";
}

function commandPreviewFor(input: ReviewVisibilityInput): string {
  const candidate =
    commandFromToolInput(input.toolInput) ??
    commandFromShape(input.shape) ??
    prosePreviewForTool(input.toolName, input.toolInput, input.shape);
  return truncateOneLine(candidate, COMMAND_PREVIEW_LIMIT);
}

/**
 * Non-bash preview fallback. Approval surfaces never dump raw JSON input —
 * a write/edit input would leak entire file contents into the card. Prose
 * names the tool and its primary path instead.
 */
function prosePreviewForTool(
  toolName: string,
  toolInput: unknown,
  shape: ToolShape,
): string {
  const target = primaryPathFromInput(toolInput) ?? primaryPathFromShape(shape);
  return target === undefined ? toolName : `${toolName} ${target}`;
}

function primaryPathFromInput(toolInput: unknown): string | undefined {
  if (typeof toolInput !== "object" || toolInput === null) return undefined;
  const path = (toolInput as { readonly path?: unknown }).path;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

function primaryPathFromShape(shape: ToolShape): string | undefined {
  if (shape.kind === "unknown") return undefined;
  const facts = shape.pathFacts?.facts ?? [];
  return facts[0]?.raw;
}

function commandFromToolInput(toolInput: unknown): string | undefined {
  if (typeof toolInput === "string") return toolInput;
  if (typeof toolInput !== "object" || toolInput === null) return undefined;

  const command = (toolInput as { readonly command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

function commandFromShape(shape: ToolShape): string | undefined {
  if (shape.kind === "bash") return shape.rawCommand;
  return undefined;
}

function toolLabel(toolName: string, shape: ToolShape): string {
  if (shape.kind === "unknown") return `${toolName} (unanalyzed)`;
  return toolName;
}

function appendCompoundRecoveryReason(
  baseReason: string,
  shape: ToolShape,
  decision: Decision,
): string {
  const compoundReason = compoundRecoveryReason(shape, decision);
  if (compoundReason === undefined) return baseReason;
  if (baseReason.includes(compoundReason)) return baseReason;
  return `${baseReason}; ${compoundReason}`;
}

function appendTypedMutationReviewReason(
  baseReason: string,
  shape: ToolShape,
): string {
  const typedReason = typedMutationReviewReason(shape);
  if (typedReason === undefined) return baseReason;
  if (baseReason.includes(typedReason)) return baseReason;
  return `${baseReason}; ${typedReason}`;
}

function typedMutationReviewReason(shape: ToolShape): string | undefined {
  if (!isFileMutationShape(shape)) return undefined;

  if (shape.mutationFacts === undefined) {
    return "missing mutation facts for typed edit/write";
  }

  const firstPathFact = shape.pathFacts?.facts[0];
  if (shape.pathFacts === undefined || firstPathFact === undefined) {
    return "missing path facts for typed edit/write";
  }
  if (
    shape.pathFacts.hasUnknown ||
    firstPathFact.dynamic ||
    firstPathFact.scope === "unknown"
  ) {
    const reason = firstPathFact.unknownReason ?? "unknown path";
    return `dynamic or missing path facts for typed edit/write (${firstPathFact.raw}: ${reason})`;
  }
  if (
    firstPathFact.scope !== "writable-project" &&
    firstPathFact.scope !== "project"
  ) {
    return `path scope is not project-scoped for typed edit/write: ${firstPathFact.scope}`;
  }

  if (shape.trustBoundary === undefined) {
    return "missing trust-boundary facts for typed edit/write";
  }
  if (shape.trustBoundary.kind !== "none") {
    const overwriteNote =
      shape.mutationFacts.kind === "write" &&
      shape.mutationFacts.overwrites === "unknown"
        ? '; overwrites: "unknown"'
        : "";
    return `trust-boundary target: ${shape.trustBoundary.kind}${overwriteNote}`;
  }

  if (
    shape.mutationFacts.kind === "write" &&
    shape.mutationFacts.overwrites === "unknown"
  ) {
    return 'write overwrite state is unknown (overwrites: "unknown")';
  }

  return undefined;
}

function isFileMutationShape(shape: ToolShape): shape is Extract<
  ToolShape,
  { readonly kind: "pi-tool" }
> & {
  readonly toolName: "edit" | "write";
  readonly operation: "mutation";
} {
  return (
    shape.kind === "pi-tool" &&
    shape.operation === "mutation" &&
    (shape.toolName === "edit" || shape.toolName === "write")
  );
}

function modelReasonFromDecision(reason: string): string {
  const separator = ": ";
  const separatorIndex = reason.indexOf(separator);
  if (
    separatorIndex >= 0 &&
    reason
      .slice(0, separatorIndex)
      .toLowerCase()
      .startsWith("model auto-reviewer")
  ) {
    return reason.slice(separatorIndex + separator.length);
  }

  return reason;
}

function truncateOneLine(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}
