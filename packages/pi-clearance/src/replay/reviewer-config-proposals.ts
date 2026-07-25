import type { TSchema } from "@sinclair/typebox";

import type { ResolvedReviewerConfig } from "../config/loader.ts";
import type { ClearanceMode } from "../config/schema.ts";
import {
  GlobalConfigSchema,
  normalizeConfig,
  ProjectOverlaySchema,
  ReviewerConfigSchema,
} from "../config/schema.ts";
import {
  REVIEWER_BASE_CONTRACT,
  SHIPPED_REVIEWER_POSTURES,
  validatePromptOverride,
} from "../runtime/reviewer-prompts.ts";
import type {
  CapturedOutcomeLabel,
  FrictionFamily,
  OutcomeTally,
  PerCommandRow,
  RatchetReport,
  ReplaySummary,
} from "./ratchet.ts";

// TypeBox TObject carries a runtime .properties record whose keys are exactly
// the schema-valid reviewer config fields. Deriving this set once keeps future
// reviewer fields schema-driven rather than copied into proposal heuristics.
export const REVIEWER_SCHEMA_FIELDS: ReadonlySet<string> = new Set<string>(
  Object.keys(
    (ReviewerConfigSchema as unknown as { properties: Record<string, TSchema> })
      .properties,
  ),
);

/** True iff the loaded ReviewerConfigSchema can validate a field by this name. */
export function isReviewerFieldProposeable(field: string): boolean {
  return REVIEWER_SCHEMA_FIELDS.has(field);
}

export type ReviewerConfigTarget = "user-global" | "user-project";

export type ReviewerConfigChangeKind =
  | "global-append"
  | "project-append"
  | "override-set"
  | "override-clear"
  | "mode-change"
  | "token-budget"
  | "context-mode"
  | "recent-context"
  | "escalation-threshold";

export type ReviewerConfigDiffOp = "set" | "append-string" | "remove";

export interface ReviewerConfigDiff {
  readonly target: ReviewerConfigTarget;
  readonly pointer: string;
  readonly op: ReviewerConfigDiffOp;
  readonly before: unknown;
  readonly after: unknown;
  readonly rendered: string;
}

export interface ReviewerConfigValidation {
  readonly schemaOk: boolean;
  readonly schemaErrors: readonly string[];
  readonly overrideValid?: boolean;
  readonly overrideReason?: string;
}

export interface ReviewerProposalEvidence {
  readonly scope: "global" | "family";
  readonly executable?: string;
  readonly calls: number;
  readonly unique: number;
  readonly reviewCalls: number;
  readonly hardBlockCalls: number;
  readonly modelReviewCalls: number;
  readonly capturedDenialCalls: number;
  readonly behaviors: readonly string[];
  readonly sampleCommands: readonly string[];
  readonly capturedOutcomeBreakdown: ReadonlyMap<CapturedOutcomeLabel, number>;
  readonly modelReviewLoad?: OutcomeTally;
}

export interface ReviewerProposalExample {
  readonly command: string;
  readonly capturedOutcome?: CapturedOutcomeLabel;
  readonly note?: string;
}

export interface ReviewerApprovalFraming {
  readonly changesReviewPath: boolean;
  readonly requiresAcknowledgment: boolean;
  readonly consentRequired: boolean;
  readonly summary: string;
}

export interface ReviewerForwardCompat {
  readonly gatedField: string;
  readonly downstreamEpic: string;
}

export interface ReviewerConfigProposal {
  readonly id: string;
  readonly kind: ReviewerConfigChangeKind;
  readonly target: ReviewerConfigTarget;
  readonly diff: ReviewerConfigDiff;
  readonly reason: string;
  readonly evidence: ReviewerProposalEvidence;
  readonly examples: readonly ReviewerProposalExample[];
  readonly validation: ReviewerConfigValidation;
  readonly provenance: { readonly source: "generated" };
  readonly approvalFraming: ReviewerApprovalFraming;
  readonly forwardCompat?: ReviewerForwardCompat;
  readonly modelDrafted: boolean;
  readonly warnings: readonly string[];
}

/** A drafted change before proposal annotation and user approval. */
export interface DraftedChange {
  readonly kind: ReviewerConfigChangeKind;
  readonly target: ReviewerConfigTarget;
  readonly diff: ReviewerConfigDiff;
  /** Reviewer sub-object for global changes; project overlay object for project changes. */
  readonly merged: unknown;
  readonly overrideText?: string;
  readonly origin: "structural" | "model";
  readonly notes: readonly string[];
}

export interface ReviewerModelDraftContext {
  readonly signal: ReviewerFrictionSignal;
  readonly kind: ReviewerConfigChangeKind;
  readonly current: ResolvedReviewerConfig;
}

export interface ReviewerModelDraftResult {
  readonly text: string;
  readonly reason: string;
}

/** Optional model-drafting port for append/override text. Default: none. */
export type ReviewerModelDrafter = (
  context: ReviewerModelDraftContext,
) => Promise<ReviewerModelDraftResult | undefined>;

/** True iff `postureId` is one of the shipped reviewer posture fragments. */
export function isShippedReviewerPosture(postureId: string): boolean {
  return Object.hasOwn(SHIPPED_REVIEWER_POSTURES, postureId);
}

/**
 * Render an exact, user-visible config diff and assemble the post-change object
 * that will be validated before any proposal can be emitted. This function is
 * intentionally data-only: the apply skill owns filesystem writes.
 */
export function renderReviewerConfigDiff(
  kind: ReviewerConfigChangeKind,
  target: ReviewerConfigTarget,
  pointer: string,
  op: ReviewerConfigDiffOp,
  before: unknown,
  after: unknown,
  current: ResolvedReviewerConfig,
): DraftedChange {
  if (
    kind === "mode-change" &&
    (typeof after !== "string" || !isClearanceMode(after))
  ) {
    throw new Error(`mode-change target is invalid: ${String(after)}`);
  }

  const pathParts =
    kind === "mode-change"
      ? parseJsonPointer(pointer)
      : pointerPartsForTarget(target, pointer);
  const merged =
    kind === "mode-change"
      ? { version: 1, mode: after }
      : mergeDraftedChange(target, pathParts, op, after, current);
  const diff: ReviewerConfigDiff = {
    target,
    pointer,
    op,
    before,
    after,
    rendered: renderDiffLine(pointer, op, before, after),
  };

  const overrideText =
    kind === "override-set" && typeof after === "string" ? after : undefined;

  return {
    kind,
    target,
    diff,
    merged,
    ...(overrideText === undefined ? {} : { overrideText }),
    origin: "structural",
    notes: [],
  };
}

/** Validate a drafted change against the same schema contracts the loader uses. */
export function validateProposedChange(
  change: DraftedChange,
): ReviewerConfigValidation {
  const schemaResult = validateMergedConfig(change);
  const overrideResult = validateOverrideText(change);

  return {
    schemaOk: schemaResult.schemaOk,
    schemaErrors: schemaResult.schemaErrors,
    ...(overrideResult === undefined ? {} : overrideResult),
  };
}

/**
 * Validate model-drafted reviewer prompt text with the exact same diff and
 * schema path as structural drafts. A model failure is data to discard, never a
 * reason to lower the bar for prompt config or override safety.
 */
export async function validateModelDraftedText(
  draft: ReviewerModelDraftResult,
  kind: ReviewerConfigChangeKind,
  signal: ReviewerFrictionSignal,
  current: ResolvedReviewerConfig,
): Promise<DraftedChange | null> {
  try {
    const text = draft.text.trim();
    if (text.length === 0) {
      return null;
    }

    if (isDuplicateModelAppend(kind, text, current)) {
      return null;
    }

    const structural = renderModelDraftedDiff(kind, text, current);
    if (structural === null) {
      return null;
    }

    const modeled: DraftedChange = {
      ...structural,
      origin: "model",
      notes: modelDraftNotes(draft, signal),
    };
    const validation = validateProposedChange(modeled);
    if (!validation.schemaOk) {
      return null;
    }

    if (kind === "override-set" && validation.overrideValid !== true) {
      return null;
    }

    return modeled;
  } catch {
    return null;
  }
}

/** Friction the generator noticed that a future reviewer field would address. */
export interface DeferredFrictionNote {
  readonly wouldAddress: string;
  readonly downstreamEpic: string;
  readonly reason: string;
  readonly evidence: ReviewerProposalEvidence;
}

/** A friction signal the heuristics consume. */
export type ReviewerFrictionSignal =
  | {
      readonly scope: "global";
      readonly summary: ReplaySummary;
      readonly current: ResolvedReviewerConfig;
      readonly currentMode: ClearanceMode;
      readonly trustedProject: boolean;
    }
  | {
      readonly scope: "family";
      readonly family: FrictionFamily & {
        readonly behaviors: readonly string[];
        readonly capturedOutcomeBreakdown?: ReadonlyMap<
          CapturedOutcomeLabel,
          number
        >;
        readonly sources?: readonly string[];
      };
      readonly current: ResolvedReviewerConfig;
      readonly currentMode: ClearanceMode;
      readonly trustedProject: boolean;
    };

export interface ClusterReviewerFrictionOptions {
  /** default 50 (mirror report cap) */
  readonly maxFamilies?: number;
}

const DEFAULT_MAX_FAMILIES = 50;

/**
 * Read a replay report into friction signals. Pure and total: no file reads,
 * no model calls, and no command analysis. Valid reports produce one global
 * signal plus one family signal per capped contentious family; malformed
 * reports degrade to an empty signal list.
 */
export function clusterReviewerFriction(
  report: RatchetReport,
  currentReviewer: ResolvedReviewerConfig,
  trustedProject: boolean,
  options?: ClusterReviewerFrictionOptions,
  currentMode: ClearanceMode = "ask",
): readonly ReviewerFrictionSignal[] {
  if (!isRecord(report) || !isReplaySummary(report.summary)) {
    return [];
  }

  if (!Array.isArray(report.topContentiousFamilies)) {
    return [];
  }

  const perCommand = Array.isArray(report.perCommand)
    ? report.perCommand.filter(isPerCommandRow)
    : [];
  const maxFamilies = boundedLimit(options?.maxFamilies, DEFAULT_MAX_FAMILIES);
  const families = report.topContentiousFamilies
    .filter(isFrictionFamily)
    .slice(0, maxFamilies)
    .map((family) => ({
      ...family,
      behaviors: behaviorsForFamily(family, perCommand),
      capturedOutcomeBreakdown: outcomeBreakdownForFamily(family, perCommand),
      sources: sourcesForFamily(family, perCommand),
      sampleCommands: [...family.sampleCommands],
    }));

  return [
    {
      scope: "global",
      summary: report.summary,
      current: currentReviewer,
      currentMode,
      trustedProject,
    },
    ...families.map(
      (family): ReviewerFrictionSignal => ({
        scope: "family",
        family,
        current: currentReviewer,
        currentMode,
        trustedProject,
      }),
    ),
  ];
}

export interface ProposeReviewerConfigInput {
  readonly report: RatchetReport;
  readonly currentReviewer: ResolvedReviewerConfig;
  readonly currentMode?: ClearanceMode;
  readonly trustedProject: boolean;
}

export interface ProposeReviewerConfigOptions {
  readonly modelDrafter?: ReviewerModelDrafter;
  readonly clock?: () => Date;
  readonly maxProposals?: number;
  readonly maxFamilies?: number;
}

export interface ProposeReviewerConfigResult {
  readonly proposals: readonly ReviewerConfigProposal[];
  readonly deferred: readonly DeferredFrictionNote[];
  readonly warnings: readonly string[];
}

// Reviewer-config ratchet runs may surface several independent tuning changes,
// especially on an initial backlog. Approval and write validation remain per
// shown change; the generator is capped for readability, not because a run must
// produce only one proposal.
const DEFAULT_MAX_PROPOSALS = 20;
const DOWNSTREAM_REVIEWER_EPIC = "epic-reviewer-and-tool-expansion";
const HIGH_MODEL_REVIEW_CALLS = 3;
const HIGH_TOKEN_BUDGET_MODEL_REVIEW_CALLS = 10;
const OVERRIDE_REVIEW_CALLS = 12;
const HIGH_DENIAL_CALLS = 3;
const LOW_DENIAL_RATE = 0.2;
const HIGH_DENIAL_RATE = 0.5;
const DEFAULT_TOKEN_BUDGET_LIMIT = 100_000;
const RISKY_BEHAVIORS = [
  "destructive",
  "force-push",
  "recursive-delete",
  "secret",
  "privilege",
  "remote-exec",
  "pipe-to-shell",
  "parser-defeating",
] as const;
/**
 * Deterministic no-model drafter for reviewer-config proposal heuristics.
 * Returns `null` when the signal does not justify this kind, when the change
 * would duplicate current config, or when a forward-compatible field is absent.
 */
export function draftStructuralChange(
  signal: ReviewerFrictionSignal,
  kind: ReviewerConfigChangeKind,
  current: ResolvedReviewerConfig,
): DraftedChange | null {
  try {
    switch (kind) {
      case "global-append":
        return draftPromptAppend(signal, "user-global", current);
      case "project-append":
        return draftPromptAppend(signal, "user-project", current);
      case "override-set":
        return draftOverrideSet(signal, current);
      case "override-clear":
        return draftOverrideClear(signal, current);
      case "mode-change":
        return draftModeChange(signal, current);
      case "token-budget":
        return draftTokenBudget(signal, current);
      case "context-mode":
        return draftContextMode(signal, current);
      case "recent-context":
        return draftRecentContext(signal, current);
      case "escalation-threshold":
        return draftEscalationThreshold(signal, current);
    }
  } catch {
    return null;
  }
}

/**
 * Pure reviewer-config proposal generator. It writes no files, applies no
 * config, and treats model-drafted text as an optional validated draft only.
 * It may return an evidence-sized set of changes; the apply skill owns showing,
 * approval, sequencing, and verification.
 */
export async function proposeReviewerConfig(
  input: ProposeReviewerConfigInput,
  options: ProposeReviewerConfigOptions = {},
): Promise<ProposeReviewerConfigResult> {
  const warnings: string[] = [];
  try {
    if (!isRecord(input) || !isResolvedReviewerConfig(input.currentReviewer)) {
      return {
        proposals: [],
        deferred: [],
        warnings: [
          "Reviewer proposal input was malformed; no proposals generated.",
        ],
      };
    }

    const maxProposals = boundedLimit(
      options.maxProposals,
      DEFAULT_MAX_PROPOSALS,
    );
    const clusterOptions: ClusterReviewerFrictionOptions =
      options.maxFamilies === undefined
        ? {}
        : { maxFamilies: options.maxFamilies };
    const signals = clusterReviewerFriction(
      input.report,
      input.currentReviewer,
      input.trustedProject === true,
      clusterOptions,
      input.currentMode ?? "ask",
    );
    if (signals.length === 0) {
      return {
        proposals: [],
        deferred: [],
        warnings: ["Replay report did not contain reviewer friction signals."],
      };
    }

    const allSignals = signals;
    const deferred = dedupeDeferred(
      signals.flatMap((signal) => deferredNotesForSignal(signal, allSignals)),
    );
    const proposals: ReviewerConfigProposal[] = [];
    const proposalKeys = new Set<string>();

    for (const signal of signals) {
      for (const kind of candidateKindsForSignal(signal, allSignals)) {
        const proposal = await draftValidateAndAnnotate(
          signal,
          kind,
          input.currentReviewer,
          allSignals,
          options.modelDrafter,
          warnings,
        );
        if (proposal === null) {
          continue;
        }

        const dedupeKey = `${proposal.kind}\u0000${proposal.id}`;
        if (proposalKeys.has(dedupeKey)) {
          continue;
        }
        proposalKeys.add(dedupeKey);
        proposals.push(proposal);
      }
    }

    return {
      proposals: proposals
        .sort(compareReviewerConfigProposals)
        .slice(0, maxProposals),
      deferred,
      warnings: sortedUnique(warnings),
    };
  } catch (error) {
    return {
      proposals: [],
      deferred: [],
      warnings: [
        `Reviewer proposal generation failed safely: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
}

async function draftValidateAndAnnotate(
  signal: ReviewerFrictionSignal,
  kind: ReviewerConfigChangeKind,
  current: ResolvedReviewerConfig,
  allSignals: readonly ReviewerFrictionSignal[],
  modelDrafter: ReviewerModelDrafter | undefined,
  warnings: string[],
): Promise<ReviewerConfigProposal | null> {
  const modelDraft = await maybeDraftWithModel(
    signal,
    kind,
    current,
    modelDrafter,
    warnings,
  );
  const change = modelDraft ?? draftStructuralChange(signal, kind, current);
  if (
    change === null ||
    isCurrentDuplicate(change, current, signal.currentMode)
  ) {
    return null;
  }

  const validation = validateProposedChange(change);
  if (!validation.schemaOk) {
    warnings.push(
      `Rejected ${kind} proposal because schema validation failed: ${validation.schemaErrors.join("; ")}`,
    );
    return null;
  }
  if (kind === "override-set" && validation.overrideValid !== true) {
    warnings.push(
      `Rejected override proposal before approval: ${validation.overrideReason ?? "invalid prompt override"}`,
    );
    return null;
  }

  const reason = reasonForProposal(kind, signal);
  const evidence = evidenceForSignal(signal);
  const proposal = {
    id: proposalIdFor(kind, signal, change),
    kind,
    target: change.target,
    diff: change.diff,
    reason,
    evidence,
    examples: examplesForSignal(signal, allSignals),
    validation,
    provenance: { source: "generated" },
    approvalFraming: approvalFramingFor(kind, change.target),
    modelDrafted: change.origin === "model",
    warnings: change.notes,
  } satisfies Omit<ReviewerConfigProposal, "forwardCompat">;
  const forwardCompat = forwardCompatFor(kind);
  return forwardCompat === undefined
    ? proposal
    : { ...proposal, forwardCompat };
}

async function maybeDraftWithModel(
  signal: ReviewerFrictionSignal,
  kind: ReviewerConfigChangeKind,
  current: ResolvedReviewerConfig,
  modelDrafter: ReviewerModelDrafter | undefined,
  warnings: string[],
): Promise<DraftedChange | null> {
  if (modelDrafter === undefined || !isModelDraftableKind(kind)) {
    return null;
  }

  try {
    const draft = await modelDrafter({
      signal,
      kind,
      current,
    });
    if (draft === undefined) {
      return null;
    }

    const change = await validateModelDraftedText(draft, kind, signal, current);
    if (change === null) {
      warnings.push(`Discarded invalid model-drafted ${kind} text.`);
    }
    return change;
  } catch (error) {
    warnings.push(
      `Model drafter failed for ${kind}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function candidateKindsForSignal(
  signal: ReviewerFrictionSignal,
  allSignals: readonly ReviewerFrictionSignal[],
): readonly ReviewerConfigChangeKind[] {
  if (signal.scope === "global") {
    const riskyFamilies = hasRiskyFamilies(allSignals);
    const highDenial = denialRateForGlobal(signal.summary) >= HIGH_DENIAL_RATE;
    return [
      ...(riskyFamilies && !highDenial ? [] : (["mode-change"] as const)),
      "token-budget",
      "context-mode",
    ];
  }

  return [
    familyUsesMultipleSources(signal.family)
      ? "global-append"
      : "project-append",
    "override-set",
    "override-clear",
    "recent-context",
    "escalation-threshold",
  ];
}

function draftPromptAppend(
  signal: ReviewerFrictionSignal,
  target: ReviewerConfigTarget,
  current: ResolvedReviewerConfig,
): DraftedChange | null {
  if (signal.scope !== "family" || isRiskyFamily(signal.family)) {
    return null;
  }
  if (!isLowDenialFamily(signal.family) || signal.family.modelReviewCalls < 2) {
    return null;
  }

  const text = appendTextForFamily(signal.family, target);
  const existing =
    target === "user-global"
      ? current.promptAppends
      : current.projectPromptAppends;
  if (hasPromptAppend(existing, text)) {
    return null;
  }

  return renderReviewerConfigDiff(
    target === "user-global" ? "global-append" : "project-append",
    target,
    target === "user-global" ? "/reviewer/promptAppends/-" : "/promptAppends/-",
    "append-string",
    existing.length,
    text,
    current,
  );
}

function draftOverrideSet(
  signal: ReviewerFrictionSignal,
  current: ResolvedReviewerConfig,
): DraftedChange | null {
  if (
    signal.scope !== "family" ||
    current.promptOverride !== null ||
    isRiskyFamily(signal.family) ||
    signal.family.modelReviewCalls < OVERRIDE_REVIEW_CALLS ||
    !isLowDenialFamily(signal.family)
  ) {
    return null;
  }

  const postureFragments =
    SHIPPED_REVIEWER_POSTURES[
      isShippedReviewerPosture(current.promptPosture)
        ? (current.promptPosture as keyof typeof SHIPPED_REVIEWER_POSTURES)
        : "reviewer.default"
    ];
  const text = [
    REVIEWER_BASE_CONTRACT.text,
    ...postureFragments.map((fragment) => fragment.text),
    "Targeted ratchet guidance:",
    appendTextForFamily(signal.family, "user-global"),
    "Return JSON with decision and reason fields matching the required JSON response schema.",
  ].join("\n\n");

  return renderReviewerConfigDiff(
    "override-set",
    "user-global",
    "/reviewer/promptOverride",
    "set",
    current.promptOverride,
    text,
    current,
  );
}

function draftOverrideClear(
  signal: ReviewerFrictionSignal,
  current: ResolvedReviewerConfig,
): DraftedChange | null {
  if (
    current.promptOverride === null ||
    signal.scope !== "family" ||
    signal.family.modelReviewCalls < HIGH_MODEL_REVIEW_CALLS
  ) {
    return null;
  }

  return renderReviewerConfigDiff(
    "override-clear",
    "user-global",
    "/reviewer/promptOverride",
    "remove",
    current.promptOverride,
    null,
    current,
  );
}

function draftModeChange(
  signal: ReviewerFrictionSignal,
  current: ResolvedReviewerConfig,
): DraftedChange | null {
  if (signal.scope !== "global" || signal.currentMode !== "ask") {
    return null;
  }
  if (
    signal.summary.reviewCalls <= 0 &&
    signal.summary.modelReviewLoad.calls <= 0
  ) {
    return null;
  }

  return renderReviewerConfigDiff(
    "mode-change",
    "user-global",
    "/mode",
    "set",
    signal.currentMode,
    "auto",
    current,
  );
}

function draftTokenBudget(
  signal: ReviewerFrictionSignal,
  current: ResolvedReviewerConfig,
): DraftedChange | null {
  if (
    signal.scope !== "global" ||
    current.tokenBudget.limit !== null ||
    signal.summary.modelReviewLoad.calls < HIGH_TOKEN_BUDGET_MODEL_REVIEW_CALLS
  ) {
    return null;
  }

  return renderReviewerConfigDiff(
    "token-budget",
    "user-global",
    "/reviewer/tokenBudget/limit",
    "set",
    current.tokenBudget.limit,
    DEFAULT_TOKEN_BUDGET_LIMIT,
    current,
  );
}

function draftContextMode(
  signal: ReviewerFrictionSignal,
  current: ResolvedReviewerConfig,
): DraftedChange | null {
  if (
    signal.scope !== "global" ||
    !isReviewerFieldProposeable("contextMode") ||
    signal.summary.modelReviewLoad.calls < HIGH_MODEL_REVIEW_CALLS ||
    fieldValue(current, "contextMode") === "recentContext"
  ) {
    return null;
  }

  return renderReviewerConfigDiff(
    "context-mode",
    "user-global",
    "/reviewer/contextMode",
    "set",
    fieldValue(current, "contextMode") ?? "minimal",
    "recentContext",
    current,
  );
}

function draftRecentContext(
  signal: ReviewerFrictionSignal,
  current: ResolvedReviewerConfig,
): DraftedChange | null {
  if (
    signal.scope !== "family" ||
    !isReviewerFieldProposeable("recentContext") ||
    signal.family.modelReviewCalls < HIGH_MODEL_REVIEW_CALLS
  ) {
    return null;
  }

  return renderReviewerConfigDiff(
    "recent-context",
    "user-global",
    "/reviewer/recentContext/decisionLimit",
    "set",
    fieldValue(fieldValue(current, "recentContext"), "decisionLimit") ?? 25,
    50,
    current,
  );
}

function draftEscalationThreshold(
  signal: ReviewerFrictionSignal,
  current: ResolvedReviewerConfig,
): DraftedChange | null {
  if (
    signal.scope !== "family" ||
    !isReviewerFieldProposeable("escalation") ||
    signal.family.capturedDenialCalls < HIGH_DENIAL_CALLS
  ) {
    return null;
  }

  return renderReviewerConfigDiff(
    "escalation-threshold",
    "user-global",
    "/reviewer/escalation/denialLimit",
    "set",
    fieldValue(fieldValue(current, "escalation"), "denialLimit") ?? 3,
    2,
    current,
  );
}

function isModelDraftableKind(kind: ReviewerConfigChangeKind): boolean {
  return (
    kind === "global-append" ||
    kind === "project-append" ||
    kind === "override-set"
  );
}

function isCurrentDuplicate(
  change: DraftedChange,
  current: ResolvedReviewerConfig,
  currentMode: ClearanceMode,
): boolean {
  switch (change.kind) {
    case "global-append":
      return (
        typeof change.diff.after === "string" &&
        hasPromptAppend(current.promptAppends, change.diff.after)
      );
    case "project-append":
      return (
        typeof change.diff.after === "string" &&
        hasPromptAppend(current.projectPromptAppends, change.diff.after)
      );
    case "override-set":
      return current.promptOverride !== null;
    case "mode-change":
      return change.diff.after === currentMode;
    case "token-budget":
      return current.tokenBudget.limit !== null;
    case "override-clear":
      return current.promptOverride === null;
    case "context-mode":
    case "recent-context":
    case "escalation-threshold":
      return false;
  }
}

function reasonForProposal(
  kind: ReviewerConfigChangeKind,
  signal: ReviewerFrictionSignal,
): string {
  switch (kind) {
    case "global-append":
      return familyReason(
        signal,
        "Global reviewer guidance can reduce repeated model review for this workflow.",
      );
    case "project-append":
      return familyReason(
        signal,
        "Project-scoped reviewer guidance can reduce repeated model review without changing global policy.",
      );
    case "override-set":
      return familyReason(
        signal,
        "Repeated prompt miscalibration appears broad enough to justify a schema-valid full override proposal.",
      );
    case "override-clear":
      return familyReason(
        signal,
        "The active prompt override appears correlated with repeated reviewer friction; clearing it returns to assembled shipped guidance.",
      );
    case "mode-change":
      return "Observed review-path friction supports switching from ask mode to model-backed auto review.";
    case "token-budget":
      return "Model-review volume is high; this indirect evidence supports a conservative windowed token budget for cost control.";
    case "context-mode":
      return "Repeated model-review uncertainty suggests recent bounded context would help the reviewer decide.";
    case "recent-context":
      return familyReason(
        signal,
        "Uncertainty persists for this family even with recent-context support, so recent context limits may need tuning.",
      );
    case "escalation-threshold":
      return familyReason(
        signal,
        "Repeated denials for this family suggest temporary direct-user escalation should trigger sooner.",
      );
  }
}

function familyReason(
  signal: ReviewerFrictionSignal,
  fallback: string,
): string {
  return signal.scope === "family"
    ? `${fallback} Evidence: ${signal.family.modelReviewCalls} model-review calls and ${signal.family.capturedDenialCalls} captured denials for ${signal.family.executable}.`
    : fallback;
}

function evidenceForSignal(
  signal: ReviewerFrictionSignal,
): ReviewerProposalEvidence {
  if (signal.scope === "family") {
    return {
      scope: "family",
      executable: signal.family.executable,
      calls: signal.family.calls,
      unique: signal.family.unique,
      reviewCalls: signal.family.reviewCalls,
      hardBlockCalls: signal.family.hardBlockCalls,
      modelReviewCalls: signal.family.modelReviewCalls,
      capturedDenialCalls: signal.family.capturedDenialCalls,
      behaviors: signal.family.behaviors,
      sampleCommands: signal.family.sampleCommands,
      capturedOutcomeBreakdown:
        signal.family.capturedOutcomeBreakdown ??
        new Map<CapturedOutcomeLabel, number>(),
    };
  }

  const capturedDenialCalls = countDenialOutcomes(
    signal.summary.byCapturedOutcome,
  );
  return {
    scope: "global",
    calls: signal.summary.totalCalls,
    unique: signal.summary.totalUnique,
    reviewCalls: signal.summary.reviewCalls,
    hardBlockCalls: signal.summary.hardBlockCalls,
    modelReviewCalls: signal.summary.modelReviewLoad.calls,
    capturedDenialCalls,
    behaviors: [],
    sampleCommands: [],
    capturedOutcomeBreakdown: capturedOutcomeCounts(
      signal.summary.byCapturedOutcome,
    ),
    modelReviewLoad: signal.summary.modelReviewLoad,
  };
}

function examplesForSignal(
  signal: ReviewerFrictionSignal,
  allSignals: readonly ReviewerFrictionSignal[],
): readonly ReviewerProposalExample[] {
  const samples =
    signal.scope === "family"
      ? signal.family.sampleCommands
      : allSignals.flatMap((candidate) =>
          candidate.scope === "family" ? candidate.family.sampleCommands : [],
        );

  return sortedUnique(samples)
    .slice(0, 3)
    .map((command) => ({ command }));
}

function approvalFramingFor(
  kind: ReviewerConfigChangeKind,
  target: ReviewerConfigTarget,
): ReviewerApprovalFraming {
  switch (kind) {
    case "mode-change":
      return {
        changesReviewPath: true,
        requiresAcknowledgment: true,
        consentRequired: false,
        summary:
          "Changes the global Clearance mode so review-bucket calls use model review.",
      };
    case "override-set":
      return {
        changesReviewPath: true,
        requiresAcknowledgment: true,
        consentRequired: false,
        summary:
          "Replaces assembled reviewer prompt text with a schema-valid override.",
      };
    case "override-clear":
      return {
        changesReviewPath: true,
        requiresAcknowledgment: true,
        consentRequired: false,
        summary:
          "Clears the prompt override and returns to assembled reviewer guidance.",
      };
    case "token-budget":
      return {
        changesReviewPath: true,
        requiresAcknowledgment: true,
        consentRequired: false,
        summary:
          "Adds a windowed model-review token budget based on indirect volume evidence.",
      };
    case "context-mode":
    case "recent-context":
    case "escalation-threshold":
      return {
        changesReviewPath: true,
        requiresAcknowledgment: true,
        consentRequired: false,
        summary:
          "Changes future reviewer context or escalation behavior when supported by schema.",
      };
    case "project-append":
      return {
        changesReviewPath: false,
        requiresAcknowledgment: true,
        consentRequired: false,
        summary:
          "Adds project-scoped reviewer guidance that loads only for trusted projects.",
      };
    case "global-append":
      return {
        changesReviewPath: false,
        requiresAcknowledgment: false,
        consentRequired: false,
        summary:
          target === "user-global"
            ? "Adjusts global reviewer prompt guidance after user approval."
            : "Adjusts project reviewer prompt guidance after user approval.",
      };
  }
}

function forwardCompatFor(
  kind: ReviewerConfigChangeKind,
): ReviewerForwardCompat | undefined {
  switch (kind) {
    case "context-mode":
      return {
        gatedField: "contextMode",
        downstreamEpic: DOWNSTREAM_REVIEWER_EPIC,
      };
    case "recent-context":
      return {
        gatedField: "recentContext",
        downstreamEpic: DOWNSTREAM_REVIEWER_EPIC,
      };
    case "escalation-threshold":
      return {
        gatedField: "escalation",
        downstreamEpic: DOWNSTREAM_REVIEWER_EPIC,
      };
    default:
      return undefined;
  }
}

function proposalIdFor(
  kind: ReviewerConfigChangeKind,
  signal: ReviewerFrictionSignal,
  change: DraftedChange,
): string {
  const scope = signal.scope === "family" ? signal.family.executable : "global";
  return `revprop:${kind}:${slugify(scope)}:${slugify(String(change.diff.after))}`;
}

function compareReviewerConfigProposals(
  left: ReviewerConfigProposal,
  right: ReviewerConfigProposal,
): number {
  return (
    scoreForProposal(right) - scoreForProposal(left) ||
    right.evidence.calls - left.evidence.calls ||
    left.id.localeCompare(right.id)
  );
}

function scoreForProposal(proposal: ReviewerConfigProposal): number {
  if (proposal.evidence.scope === "family") {
    return (
      proposal.evidence.modelReviewCalls +
      proposal.evidence.capturedDenialCalls * 2 +
      proposal.evidence.hardBlockCalls
    );
  }

  return (
    proposal.evidence.modelReviewLoad?.calls ?? proposal.evidence.reviewCalls
  );
}

function deferredNotesForSignal(
  signal: ReviewerFrictionSignal,
  allSignals: readonly ReviewerFrictionSignal[],
): readonly DeferredFrictionNote[] {
  const notes: DeferredFrictionNote[] = [];
  if (
    signal.scope === "global" &&
    !isReviewerFieldProposeable("contextMode") &&
    signal.summary.modelReviewLoad.calls >= HIGH_MODEL_REVIEW_CALLS
  ) {
    notes.push(deferredNote("contextMode", signal, allSignals));
  }

  if (signal.scope === "family") {
    if (
      !isReviewerFieldProposeable("recentContext") &&
      signal.family.modelReviewCalls >= HIGH_MODEL_REVIEW_CALLS
    ) {
      notes.push(deferredNote("recentContext", signal, allSignals));
    }
    if (
      !isReviewerFieldProposeable("escalation") &&
      signal.family.capturedDenialCalls >= HIGH_DENIAL_CALLS
    ) {
      notes.push(deferredNote("escalation", signal, allSignals));
    }
  }

  return notes;
}

function deferredNote(
  wouldAddress: "contextMode" | "recentContext" | "escalation",
  signal: ReviewerFrictionSignal,
  _allSignals: readonly ReviewerFrictionSignal[],
): DeferredFrictionNote {
  return {
    wouldAddress,
    downstreamEpic: DOWNSTREAM_REVIEWER_EPIC,
    reason: deferredReason(wouldAddress, signal),
    evidence: evidenceForSignal(signal),
  };
}

function deferredReason(
  wouldAddress: string,
  signal: ReviewerFrictionSignal,
): string {
  if (wouldAddress === "contextMode") {
    return "Repeated model-review uncertainty would be better addressed by recent-context reviewer support once that schema field exists.";
  }
  if (wouldAddress === "recentContext") {
    return familyReason(
      signal,
      "This family would benefit from tuning recent-context limits once that schema field exists.",
    );
  }

  return familyReason(
    signal,
    "Repeated denials would benefit from escalation-threshold tuning once that schema field exists.",
  );
}

function dedupeDeferred(
  notes: readonly DeferredFrictionNote[],
): readonly DeferredFrictionNote[] {
  const seen = new Set<string>();
  const result: DeferredFrictionNote[] = [];
  for (const note of notes) {
    const key = `${note.wouldAddress}\u0000${note.evidence.executable ?? "global"}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(note);
  }

  return result.sort(
    (left, right) =>
      right.evidence.calls - left.evidence.calls ||
      left.wouldAddress.localeCompare(right.wouldAddress),
  );
}

function appendTextForFamily(
  family: FrictionFamily,
  target: ReviewerConfigTarget,
): string {
  const commandShape = commandSignatureForFamily(family);
  const scope =
    target === "user-project"
      ? "when this project is explicitly trusted"
      : "when project trust and command scope are clear";
  return `Treat \`${commandShape}\` as a known local workflow ${scope}; still deny sealed-floor behavior, secret exposure, broad destructive operations, and unclear shell structure.`;
}

function commandSignatureForFamily(family: FrictionFamily): string {
  const firstSample = family.sampleCommands[0]?.trim();
  if (firstSample === undefined || firstSample.length === 0) {
    return family.executable;
  }

  const [program, arg0] = firstSample.split(/\s+/u);
  return arg0 === undefined
    ? (program ?? family.executable)
    : `${program} ${arg0}`;
}

function isLowDenialFamily(family: FrictionFamily): boolean {
  return (
    denialRate(family.capturedDenialCalls, family.modelReviewCalls) <=
    LOW_DENIAL_RATE
  );
}

function familyUsesMultipleSources(
  family: FrictionFamily & { readonly sources?: readonly string[] },
): boolean {
  return (family.sources?.length ?? 0) > 1;
}

function isRiskyFamily(
  family: FrictionFamily & { readonly behaviors?: readonly string[] },
): boolean {
  return (family.behaviors ?? []).some((behavior) =>
    RISKY_BEHAVIORS.some((risky) => behavior.includes(risky)),
  );
}

function hasRiskyFamilies(signals: readonly ReviewerFrictionSignal[]): boolean {
  return signals.some(
    (signal) => signal.scope === "family" && isRiskyFamily(signal.family),
  );
}

function denialRateForGlobal(summary: ReplaySummary): number {
  return denialRate(
    countDenialOutcomes(summary.byCapturedOutcome),
    summary.modelReviewLoad.calls,
  );
}

function denialRate(denials: number, denominator: number): number {
  return denominator <= 0 ? 0 : denials / denominator;
}

function countDenialOutcomes(
  outcomes: ReadonlyMap<CapturedOutcomeLabel, OutcomeTally | number>,
): number {
  let total = 0;
  for (const label of [
    "deterministic-deny",
    "model-deny",
    "human-deny",
    "block-and-log",
    "fixture-hard-block",
  ] satisfies readonly CapturedOutcomeLabel[]) {
    const tally = outcomes.get(label);
    total += typeof tally === "number" ? tally : (tally?.calls ?? 0);
  }
  return total;
}

function capturedOutcomeCounts(
  outcomes: ReadonlyMap<CapturedOutcomeLabel, OutcomeTally>,
): ReadonlyMap<CapturedOutcomeLabel, number> {
  return new Map(
    [...outcomes.entries()].map(([label, tally]) => [label, tally.calls]),
  );
}

function fieldValue(source: unknown, field: string): unknown {
  return isRecord(source) ? source[field] : undefined;
}

function isResolvedReviewerConfig(
  value: unknown,
): value is ResolvedReviewerConfig {
  return (
    isRecord(value) &&
    typeof value.promptPosture === "string" &&
    Array.isArray(value.promptAppends) &&
    value.promptAppends.every((append) => typeof append === "string") &&
    Array.isArray(value.projectPromptAppends) &&
    value.projectPromptAppends.every((append) => typeof append === "string") &&
    (value.promptOverride === null ||
      typeof value.promptOverride === "string") &&
    (value.model === null || typeof value.model === "string") &&
    isRecord(value.tokenBudget) &&
    typeof value.tokenBudget.window === "string" &&
    (value.tokenBudget.limit === null ||
      typeof value.tokenBudget.limit === "number") &&
    (value.contextMode === "minimal" ||
      value.contextMode === "recentContext") &&
    isRecord(value.recentContext) &&
    typeof value.recentContext.decisionLimit === "number" &&
    typeof value.recentContext.decisionWindow === "string" &&
    typeof value.recentContext.conversationTurns === "number" &&
    typeof value.recentContext.conversationCharLimit === "number" &&
    isRecord(value.escalation) &&
    typeof value.escalation.enabled === "boolean" &&
    typeof value.escalation.denialLimit === "number" &&
    typeof value.escalation.window === "string"
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 80);
}

function renderModelDraftedDiff(
  kind: ReviewerConfigChangeKind,
  text: string,
  current: ResolvedReviewerConfig,
): DraftedChange | null {
  switch (kind) {
    case "global-append":
      return renderReviewerConfigDiff(
        kind,
        "user-global",
        "/reviewer/promptAppends/-",
        "append-string",
        current.promptAppends.length,
        text,
        current,
      );
    case "project-append":
      return renderReviewerConfigDiff(
        kind,
        "user-project",
        "/promptAppends/-",
        "append-string",
        current.projectPromptAppends.length,
        text,
        current,
      );
    case "override-set":
      return renderReviewerConfigDiff(
        kind,
        "user-global",
        "/reviewer/promptOverride",
        "set",
        current.promptOverride,
        text,
        current,
      );
    default:
      return null;
  }
}

function isDuplicateModelAppend(
  kind: ReviewerConfigChangeKind,
  text: string,
  current: ResolvedReviewerConfig,
): boolean {
  if (kind === "global-append") {
    return hasPromptAppend(current.promptAppends, text);
  }

  if (kind === "project-append") {
    return hasPromptAppend(current.projectPromptAppends, text);
  }

  return false;
}

function hasPromptAppend(
  existingAppends: readonly string[],
  text: string,
): boolean {
  return existingAppends.some((append) => append.trim() === text);
}

function modelDraftNotes(
  draft: ReviewerModelDraftResult,
  signal: ReviewerFrictionSignal,
): readonly string[] {
  const reason = draft.reason.trim();
  const scopeNote =
    signal.scope === "family"
      ? `model drafted for family: ${signal.family.executable}`
      : "model drafted for global reviewer friction";

  return reason.length === 0
    ? [scopeNote]
    : [`model reason: ${reason}`, scopeNote];
}

function pointerPartsForTarget(
  target: ReviewerConfigTarget,
  pointer: string,
): readonly string[] {
  const parts = parseJsonPointer(pointer);
  if (target === "user-global") {
    if (parts[0] !== "reviewer") {
      throw new Error(
        `global reviewer diff pointer must start with /reviewer: ${pointer}`,
      );
    }
    const field = parts[1];
    if (field !== undefined && !isReviewerFieldProposeable(field)) {
      throw new Error(`reviewer field is not schema-proposeable: ${field}`);
    }
    return parts.slice(1);
  }

  return parts;
}

function parseJsonPointer(pointer: string): readonly string[] {
  if (pointer === "") {
    return [];
  }
  if (!pointer.startsWith("/")) {
    throw new Error(`invalid JSON pointer: ${pointer}`);
  }

  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function mergeDraftedChange(
  target: ReviewerConfigTarget,
  pathParts: readonly string[],
  op: ReviewerConfigDiffOp,
  after: unknown,
  current: ResolvedReviewerConfig,
): unknown {
  if (target === "user-project") {
    return mergeOverlayDraft(pathParts, op, after);
  }

  const merged = schemaReviewerConfigFromResolved(current);
  applyChangeAtPath(merged, pathParts, op, after);
  return merged;
}

function schemaReviewerConfigFromResolved(
  current: ResolvedReviewerConfig,
): Record<string, unknown> {
  const clone = cloneJsonObject(current);
  const projected: Record<string, unknown> = {};
  for (const field of REVIEWER_SCHEMA_FIELDS) {
    if (Object.hasOwn(clone, field)) {
      projected[field] = clone[field];
    }
  }
  return projected;
}

function mergeOverlayDraft(
  pathParts: readonly string[],
  op: ReviewerConfigDiffOp,
  after: unknown,
): unknown {
  const merged: Record<string, unknown> = { version: 1 };
  applyChangeAtPath(merged, pathParts, op, after);
  return merged;
}

function applyChangeAtPath(
  root: Record<string, unknown>,
  pathParts: readonly string[],
  op: ReviewerConfigDiffOp,
  after: unknown,
): void {
  if (pathParts.length === 0) {
    throw new Error("diff pointer must address a field");
  }

  const leaf = pathParts.at(-1);
  if (leaf === undefined) {
    throw new Error("diff pointer must address a field");
  }

  if (op === "append-string") {
    if (leaf === "-") {
      const arrayKey = pathParts.at(-2);
      if (arrayKey === undefined) {
        throw new Error("append pointer must target an array field");
      }
      const parent = ensureContainer(root, pathParts.slice(0, -2));
      appendAt(parent, arrayKey, after);
      return;
    }

    const parent = ensureContainer(root, pathParts.slice(0, -1));
    appendAt(parent, leaf, after);
    return;
  }

  const parent = ensureContainer(root, pathParts.slice(0, -1));
  parent[leaf] = op === "remove" ? null : after;
}

function ensureContainer(
  root: Record<string, unknown>,
  pathParts: readonly string[],
): Record<string, unknown> {
  let cursor: Record<string, unknown> = root;
  for (const part of pathParts) {
    if (part === "-") {
      throw new Error("diff pointer cannot traverse through append marker");
    }

    const existing = cursor[part];
    if (isRecord(existing) && !Array.isArray(existing)) {
      cursor = existing;
      continue;
    }

    const next: Record<string, unknown> = {};
    cursor[part] = next;
    cursor = next;
  }
  return cursor;
}

function appendAt(
  parent: Record<string, unknown>,
  leaf: string,
  after: unknown,
): void {
  const existing = parent[leaf];
  parent[leaf] = Array.isArray(existing) ? [...existing, after] : [after];
}

function renderDiffLine(
  pointer: string,
  op: ReviewerConfigDiffOp,
  before: unknown,
  after: unknown,
): string {
  const parts = parseJsonPointer(pointer);
  const displayPath = pointerDisplayPath(parts);

  if (op === "append-string") {
    const index = typeof before === "number" ? before : "-";
    return `${displayPath}[${index}]: + ${formatDiffValue(after)}`;
  }

  return `${displayPath}: ${formatDiffValue(before)} → ${formatDiffValue(after)}`;
}

function pointerDisplayPath(parts: readonly string[]): string {
  return parts
    .map((part) => (part === "-" ? "" : part))
    .filter((part) => part.length > 0)
    .map((part, index) => (index === 0 ? part : `.${part}`))
    .join("");
}

function formatDiffValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function validateMergedConfig(change: DraftedChange): ReviewerConfigValidation {
  try {
    const result =
      change.kind === "mode-change"
        ? normalizeConfig(GlobalConfigSchema, change.merged, "$global")
        : change.target === "user-global"
          ? normalizeConfig(ReviewerConfigSchema, change.merged, "$.reviewer")
          : normalizeConfig(ProjectOverlaySchema, change.merged, "$project");

    if (result.ok) {
      return { schemaOk: true, schemaErrors: [] };
    }

    return {
      schemaOk: false,
      schemaErrors: result.errors.map(
        (error) => `${error.path}: ${error.message}`,
      ),
    };
  } catch (error) {
    return {
      schemaOk: false,
      schemaErrors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function validateOverrideText(
  change: DraftedChange,
):
  | Pick<ReviewerConfigValidation, "overrideValid" | "overrideReason">
  | undefined {
  if (change.kind !== "override-set") {
    return undefined;
  }

  const text =
    change.overrideText ??
    (typeof change.diff.after === "string" ? change.diff.after : "");
  const result = validatePromptOverride(text);
  if (result.ok) {
    return { overrideValid: true };
  }

  return { overrideValid: false, overrideReason: result.reason };
}

function cloneJsonObject(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    return {};
  }

  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function behaviorsForFamily(
  family: FrictionFamily,
  rows: readonly PerCommandRow[],
): readonly string[] {
  const sampleCommands = new Set(family.sampleCommands);
  const directBehaviors = isRecord(family) ? stringArray(family.behaviors) : [];
  const rowBehaviors = rows
    .filter(
      (row) =>
        row.executable === family.executable || sampleCommands.has(row.command),
    )
    .flatMap((row) => row.behaviors ?? []);

  return sortedUnique([...directBehaviors, ...rowBehaviors]);
}

function outcomeBreakdownForFamily(
  family: FrictionFamily,
  rows: readonly PerCommandRow[],
): ReadonlyMap<CapturedOutcomeLabel, number> {
  const sampleCommands = new Set(family.sampleCommands);
  const breakdown = new Map<CapturedOutcomeLabel, number>();
  for (const row of rows) {
    if (
      row.executable !== family.executable &&
      !sampleCommands.has(row.command)
    ) {
      continue;
    }

    for (const [label, count] of row.capturedOutcomes.entries()) {
      breakdown.set(label, (breakdown.get(label) ?? 0) + count);
    }
  }

  return breakdown;
}

function sourcesForFamily(
  family: FrictionFamily,
  rows: readonly PerCommandRow[],
): readonly string[] {
  const sampleCommands = new Set(family.sampleCommands);
  return sortedUnique(
    rows
      .filter(
        (row) =>
          row.executable === family.executable ||
          sampleCommands.has(row.command),
      )
      .flatMap((row) => row.sources),
  );
}

function isReplaySummary(value: unknown): value is ReplaySummary {
  return (
    isRecord(value) &&
    finiteNumber(value.totalCalls) &&
    finiteNumber(value.totalUnique) &&
    finiteNumber(value.fastPathCalls) &&
    finiteNumber(value.fastPathUnique) &&
    finiteNumber(value.reviewCalls) &&
    finiteNumber(value.reviewUnique) &&
    finiteNumber(value.hardBlockCalls) &&
    finiteNumber(value.hardBlockUnique) &&
    value.byCapturedOutcome instanceof Map &&
    isOutcomeTally(value.modelReviewLoad) &&
    finiteNumber(value.redactedCalls)
  );
}

function isFrictionFamily(value: unknown): value is FrictionFamily {
  return (
    isRecord(value) &&
    typeof value.executable === "string" &&
    finiteNumber(value.calls) &&
    finiteNumber(value.unique) &&
    finiteNumber(value.reviewCalls) &&
    finiteNumber(value.hardBlockCalls) &&
    finiteNumber(value.modelReviewCalls) &&
    finiteNumber(value.capturedDenialCalls) &&
    Array.isArray(value.sampleCommands) &&
    value.sampleCommands.every((command) => typeof command === "string")
  );
}

function isPerCommandRow(value: unknown): value is PerCommandRow {
  return (
    isRecord(value) &&
    typeof value.command === "string" &&
    (value.executable === undefined || typeof value.executable === "string") &&
    (value.behaviors === undefined ||
      (Array.isArray(value.behaviors) &&
        value.behaviors.every((behavior) => typeof behavior === "string")))
  );
}

function isOutcomeTally(value: unknown): value is OutcomeTally {
  return (
    isRecord(value) && finiteNumber(value.calls) && finiteNumber(value.unique)
  );
}

function boundedLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isClearanceMode(value: string): value is ClearanceMode {
  return value === "off" || value === "ask" || value === "auto";
}
