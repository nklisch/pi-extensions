import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createReviewerDecisionEntry,
  type ReviewerDecisionEntry,
  type ReviewerMode,
} from "../audit/entry.ts";
import type { AuditLogger } from "../audit/logger.ts";
import type {
  ResolvedConfig,
  ResolvedReviewerConfig,
  ResolvedReviewNotePreference,
} from "../config/loader.ts";
import type { ClearanceMode } from "../config/schema.ts";
import { DEFAULT_REVIEW_NOTE_DISPLAY } from "../config/defaults.ts";
import type { ToolShape } from "../parse/shape.ts";
import type {
  Decision,
  DecisionEffect,
  DecisionProvenance,
} from "../policy/core.ts";
import { type EscalationTracker, escalationFamily } from "./escalation.ts";
import {
  buildCompactReviewSummary,
  type CompactReviewSummary,
  formatHumanReviewMessage,
  formatReviewDecisionNote,
  type ReviewDecisionNote,
} from "./review-visibility.ts";
import {
  gatherReviewerContext,
  isContextBundleEmpty,
  type ReviewerContextBundle,
  type ReviewerContextSources,
} from "./reviewer-context.ts";
import {
  formatReviewerModel,
  isHighCostReviewerModel,
  type ReviewerModelRegistry,
  resolveReviewerModel,
} from "./reviewer-model.ts";
import {
  assembleReviewPrompt,
  PromptOverrideError,
} from "./reviewer-prompts.ts";
import type { ReviewerTokenBudgetGate } from "./token-budget.ts";

export interface ReviewerHumanAdapter {
  readonly kind: "human";
  readonly isAvailable: () => boolean;
  readonly approve: (options: {
    readonly title: string;
    readonly message: string;
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly decision: "allow" | "deny" | "dismiss" }>;
}

export interface ReviewerModelAdapter {
  readonly kind: "model";
  readonly isAvailable: () => boolean;
  readonly review: (options: {
    readonly prompt: string;
    readonly shape: ToolShape;
    /** Required fact/data supplied separately from prompt fragment assembly. */
    readonly deterministicEvidence?: {
      readonly reason: string;
      readonly provenance: DecisionProvenance;
    };
    readonly signal?: AbortSignal;
  }) => Promise<ReviewerModelResponse>;
}

export interface TokenUsage {
  readonly totalTokens: number;
}

export interface ReviewerModelResponse {
  readonly effect: "allow" | "deny" | "review";
  readonly reason: string;
  /**
   * Token usage reported by the model call; absent when no call was made or
   * the adapter cannot report usage.
   */
  readonly usage?: TokenUsage;
  readonly resolvedModel?: { readonly provider: string; readonly id: string };
  readonly resolvedModelSource?: "configured" | "fallback";
  readonly resolvedModelNote?: string;
}

/**
 * Shared additive labels for reviewer-behavior features.
 *
 * Keeping one label channel avoids repeated sink-signature changes as context,
 * escalation, and budget features each annotate the same audit entry.
 */
type ReviewerDecisionLabels = Pick<
  ReviewerDecisionEntry,
  | "escalated"
  | "contextMode"
  | "recentContextAttached"
  | "budgetExhausted"
  | "decisionSource"
  | "reviewerModel"
  | "reviewerModelSource"
  | "reviewerModelNote"
>;

export interface ReviewVisibilityAdapter {
  readonly beginReview?: (summary: CompactReviewSummary) => void;
  readonly endReview?: () => void;
  readonly presentDecisionNote?: (
    note: ReviewDecisionNote,
    toolCallId: string,
  ) => void;
}

export interface ReviewDispatchRequest {
  readonly originalDecision: Decision;
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly shape: ToolShape;
  /** Current deterministic review reason/provenance; never derived from prompt text. */
  readonly deterministicEvidence?: {
    readonly reason: string;
    readonly provenance: DecisionProvenance;
  };
  readonly reviewerConfig: ResolvedReviewerConfig;
  /** Full resolved config supplies the global mode and display settings. */
  readonly resolvedConfig?: ResolvedConfig;
  readonly mode?: ClearanceMode;
  readonly humanAdapter: ReviewerHumanAdapter;
  readonly modelAdapter: ReviewerModelAdapter;
  readonly audit: AuditLogger;
  /** Escalation tracker; absent means no escalation gate is applied. */
  readonly escalationTracker?: EscalationTracker;
  /** Token-budget gate; absent means model auto-review is unlimited. */
  readonly tokenBudgetGate?: ReviewerTokenBudgetGate;
  /** Injected read ports for recentContext mode. Absent => no bundle (fail-open). */
  readonly contextSources?: ReviewerContextSources;
  readonly visibility?: ReviewVisibilityAdapter;
  readonly ctx?: ExtensionContext;
  readonly sessionId?: string;
  readonly toolCallId?: string;
}

const shownReviewerConfigSessionIds = new Set<string>();
const DEFAULT_REVIEW_NOTE_PREFERENCE =
  DEFAULT_REVIEW_NOTE_DISPLAY satisfies ResolvedReviewNotePreference;

export async function dispatchReview(
  request: ReviewDispatchRequest,
): Promise<Decision> {
  if (request.ctx !== undefined) {
    showReviewerConfigOnce(
      request.ctx,
      request.reviewerConfig,
      requestMode(request),
    );
  }

  const defaultContextLabels = contextLabels(request, false);
  const mayRunModel = modelReviewMayRun(request);

  if (requestMode(request) === "off") {
    return recordOutcome(
      request,
      "mode-off",
      decision(
        "allow",
        "Mode off passed through a deterministic review result",
        "default",
      ),
      { ...defaultContextLabels, decisionSource: "mode-off-passthrough" },
    );
  }

  try {
    if (!mayRunModel) {
      // Ask mode uses the human path first, then the unattended fallback for headless operation.
      // Keep this path inside the visibility finally: tryHumanReview may emit
      // beginReview when Pi UI is reachable.
      return await humanFirstFallback(request, defaultContextLabels);
    }

    if (requestMode(request) === "auto" && mayRunModel) {
      // Escalation remains a label/contention signal in model mode, not a
      // pre-model bypass: model review gets first chance whenever budget allows.
      const family = escalationFamily(request.shape, request.toolName);
      const escalated =
        request.escalationTracker?.isEscalated(
          family,
          request.reviewerConfig.escalation,
        ) ?? false;
      let budgetExhausted = false;
      let modelContextLabels = defaultContextLabels;

      // Model mode is model-first: temporary escalation can annotate contention
      // and affect fallback accounting, but it must not skip an available model
      // attempt. The only pre-model runtime gate is the explicit token budget.
      budgetExhausted =
        request.tokenBudgetGate?.isExhausted(
          request.reviewerConfig.tokenBudget,
        ) ?? false;

      if (!budgetExhausted) {
        const contextBundle = await gatherContextBundle(request);
        modelContextLabels = contextLabels(
          request,
          isContextAttachable(request, contextBundle),
        );
        const modelDecision = await tryModelReview(request, contextBundle);
        const modelAttemptLabels = modelDecision.labels ?? {};
        if (modelDecision.kind === "final") {
          const labels = {
            ...modelContextLabels,
            ...modelAttemptLabels,
            ...(escalated ? { escalated: true } : {}),
          };
          if (escalated && modelDecision.decision.effect === "deny") {
            const humanDecision = await tryHumanReview(request);
            if (humanDecision.kind === "final") {
              return recordOutcome(request, "human", humanDecision.decision, {
                ...labels,
                decisionSource: "human",
              });
            }

            return recordOutcome(
              request,
              "block-and-log",
              blockDecision(humanDecision.reason),
              { ...labels, decisionSource: "unattended-fallback" },
            );
          }

          return recordOutcome(request, "model", modelDecision.decision, {
            ...labels,
            decisionSource: "model",
          });
        }

        if (modelDecision.kind === "block") {
          return recordOutcome(
            request,
            "block-and-log",
            blockDecision(modelDecision.reason),
            {
              ...modelContextLabels,
              ...modelAttemptLabels,
              ...(escalated ? { escalated: true } : {}),
              decisionSource: "model",
            },
          );
        }

        modelContextLabels = { ...modelContextLabels, ...modelAttemptLabels };
      }

      const labels: Partial<ReviewerDecisionLabels> = {
        ...modelContextLabels,
        ...(escalated ? { escalated: true } : {}),
        ...(budgetExhausted ? { budgetExhausted: true } : {}),
      };
      const humanDecision = await tryHumanReview(request);
      if (humanDecision.kind === "final") {
        return recordOutcome(request, "human", humanDecision.decision, {
          ...labels,
          decisionSource: "human",
        });
      }

      return recordOutcome(
        request,
        "block-and-log",
        blockDecision(humanDecision.reason),
        { ...labels, decisionSource: "unattended-fallback" },
      );
    }

    const humanDecision = await tryHumanReview(request);
    if (humanDecision.kind === "final") {
      return recordOutcome(request, "human", humanDecision.decision, {
        ...defaultContextLabels,
        decisionSource: "human",
      });
    }

    return recordOutcome(
      request,
      "block-and-log",
      blockDecision(humanDecision.reason),
      { ...defaultContextLabels, decisionSource: "unattended-fallback" },
    );
  } finally {
    safeEndReview(request);
  }
}

export function createPiHumanAdapter(
  ctx: ExtensionContext,
): ReviewerHumanAdapter {
  return {
    kind: "human",
    isAvailable: () => ctx.hasUI === true,
    async approve(options) {
      if (!ctx.hasUI) return { decision: "dismiss" };

      try {
        const confirmed = await ctx.ui.confirm(
          options.title,
          options.message,
          dialogOptions(options.signal),
        );
        return { decision: confirmed ? "allow" : "deny" };
      } catch {
        return { decision: "dismiss" };
      }
    },
  };
}

export function showReviewerConfigOnce(
  ctx: ExtensionContext,
  config: ResolvedReviewerConfig,
  mode: ClearanceMode = "ask",
): void {
  if (!ctx.hasUI) return;

  const sessionId = getSessionId(ctx);
  if (sessionId === undefined) return;
  if (shownReviewerConfigSessionIds.has(sessionId)) return;
  shownReviewerConfigSessionIds.add(sessionId);

  const resolvedModel = resolveReviewerModel({
    registry: reviewerModelRegistry(ctx),
    spec: config.model,
    fallback: contextModel(ctx),
  });
  const modelLabel = formatReviewerModel(resolvedModel.model);
  const customizationLabel = promptCustomizationLabel(config);
  const trustLabel = safeProjectTrustLabel(ctx);

  const headline =
    mode === "auto"
      ? `Clearance: auto — ${modelLabel} reviews what policy doesn't recognize`
      : mode === "ask"
        ? "Clearance: ask — you'll be asked about anything policy doesn't recognize"
        : "Clearance: off — nothing is asked or reviewed; deny rules still block";
  const qualifiers = [
    ...(customizationLabel === "none" ? [] : [`prompt ${customizationLabel}`]),
    ...(resolvedModel.model !== undefined &&
    isHighCostReviewerModel(resolvedModel.model.id)
      ? ["high-cost model"]
      : []),
    ...(trustLabel === "untrusted" ? ["project untrusted"] : []),
  ];
  const suffix = qualifiers.length === 0 ? "" : ` (${qualifiers.join(" · ")})`;

  try {
    ctx.ui.notify(`${headline}${suffix}. Details: /clearance status`, "info");
  } catch {
    // Visibility should never change the runtime approval decision.
  }
}

function requestMode(request: ReviewDispatchRequest): ClearanceMode {
  return request.mode ?? request.resolvedConfig?.mode ?? "ask";
}

function modelReviewMayRun(request: ReviewDispatchRequest): boolean {
  return requestMode(request) === "auto";
}

async function humanFirstFallback(
  request: ReviewDispatchRequest,
  labels: Partial<ReviewerDecisionLabels>,
): Promise<Decision> {
  const humanDecision = await tryHumanReview(request);
  if (humanDecision.kind === "final") {
    return recordOutcome(request, "human", humanDecision.decision, {
      ...labels,
      decisionSource: "human",
    });
  }

  return recordOutcome(
    request,
    "block-and-log",
    blockDecision(humanDecision.reason),
    { ...labels, decisionSource: "unattended-fallback" },
  );
}

type DispatchAttempt =
  | {
      readonly kind: "final";
      readonly decision: Decision;
      readonly labels?: Partial<ReviewerDecisionLabels>;
    }
  | {
      readonly kind: "fallthrough";
      readonly reason: string;
      readonly labels?: Partial<ReviewerDecisionLabels>;
    }
  | {
      readonly kind: "block";
      readonly reason: string;
      readonly labels?: Partial<ReviewerDecisionLabels>;
    };

async function gatherContextBundle(
  request: ReviewDispatchRequest,
): Promise<ReviewerContextBundle | undefined> {
  if (request.reviewerConfig.contextMode !== "recentContext") {
    return undefined;
  }
  if (request.contextSources === undefined) return undefined;

  return gatherReviewerContext(request.contextSources, request.reviewerConfig, {
    now: new Date(),
  });
}

function isContextAttachable(
  request: ReviewDispatchRequest,
  bundle: ReviewerContextBundle | undefined,
): boolean {
  return (
    request.reviewerConfig.contextMode === "recentContext" &&
    request.reviewerConfig.promptOverride === null &&
    bundle !== undefined &&
    !isContextBundleEmpty(bundle)
  );
}

function contextLabels(
  request: ReviewDispatchRequest,
  recentContextAttached: boolean,
): Partial<ReviewerDecisionLabels> {
  return {
    contextMode: request.reviewerConfig.contextMode,
    recentContextAttached,
  };
}

async function tryModelReview(
  request: ReviewDispatchRequest,
  contextBundle?: ReviewerContextBundle,
): Promise<DispatchAttempt> {
  let prompt: string;
  try {
    prompt = assembleReviewPrompt(
      request.reviewerConfig,
      contextBundle,
    ).fullPrompt;
  } catch (error) {
    if (error instanceof PromptOverrideError) {
      return { kind: "block", reason: error.message };
    }

    return {
      kind: "block",
      reason: `reviewer prompt assembly failed: ${errorMessage(error)}`,
    };
  }

  let modelAvailable: boolean;
  try {
    modelAvailable = request.modelAdapter.isAvailable();
  } catch (error) {
    return {
      kind: "fallthrough",
      reason: `model auto-reviewer availability check failed: ${errorMessage(error)}`,
    };
  }

  if (!modelAvailable) {
    return {
      kind: "fallthrough",
      reason: "model auto-reviewer unavailable",
    };
  }

  safeBeginReview(request, "model");

  try {
    const response = await request.modelAdapter.review({
      prompt,
      shape: request.shape,
      deterministicEvidence: {
        reason:
          request.deterministicEvidence?.reason ??
          request.originalDecision.reason,
        provenance:
          request.deterministicEvidence?.provenance ??
          request.originalDecision.provenance,
      },
      ...signalOption(request),
    });
    if (response.usage !== undefined) {
      request.tokenBudgetGate?.record(
        response.usage,
        request.reviewerConfig.tokenBudget,
      );
    }
    const labels = reviewerModelLabels(response);
    if (response.effect === "allow" || response.effect === "deny") {
      return {
        kind: "final",
        decision: decision(
          response.effect,
          `Model auto-reviewer ${response.effect}${modelReasonSuffix(response)}: ${response.reason}`,
          "generated",
        ),
        labels,
      };
    }

    return {
      kind: "fallthrough",
      reason: `model auto-reviewer did not produce allow/deny: ${response.reason}`,
      labels,
    };
  } catch (error) {
    return {
      kind: "fallthrough",
      reason: `model auto-reviewer failed: ${errorMessage(error)}`,
    };
  }
}

function reviewerModelLabels(
  response: ReviewerModelResponse,
): Partial<ReviewerDecisionLabels> {
  return {
    ...(response.resolvedModel === undefined
      ? {}
      : { reviewerModel: response.resolvedModel }),
    ...(response.resolvedModelSource === undefined
      ? {}
      : { reviewerModelSource: response.resolvedModelSource }),
    ...(response.resolvedModelNote === undefined
      ? {}
      : { reviewerModelNote: response.resolvedModelNote }),
  };
}

function modelReasonSuffix(response: ReviewerModelResponse): string {
  return response.resolvedModel === undefined
    ? ""
    : ` (${response.resolvedModel.id})`;
}

async function tryHumanReview(
  request: ReviewDispatchRequest,
): Promise<DispatchAttempt> {
  let humanAvailable: boolean;
  try {
    humanAvailable = request.humanAdapter.isAvailable();
  } catch (error) {
    return {
      kind: "fallthrough",
      reason: `human reviewer availability check failed: ${errorMessage(error)}`,
    };
  }

  if (!humanAvailable) {
    return { kind: "fallthrough", reason: "human reviewer unavailable" };
  }

  try {
    const summary = compactReviewSummary(request, "human");
    safeBeginReview(request, "human");
    const response = await request.humanAdapter.approve({
      title: summary.title,
      message: formatHumanReviewMessage(summary),
      ...signalOption(request),
    });

    if (response.decision === "allow") {
      return {
        kind: "final",
        decision: decision(
          "allow",
          "Human reviewer approved the tool call",
          "user-global",
        ),
      };
    }

    if (response.decision === "deny") {
      return {
        kind: "final",
        decision: decision(
          "deny",
          "Human reviewer denied the tool call",
          "user-global",
        ),
      };
    }

    return { kind: "fallthrough", reason: "human reviewer dismissed" };
  } catch (error) {
    return {
      kind: "fallthrough",
      reason: `human reviewer failed: ${errorMessage(error)}`,
    };
  }
}

async function recordOutcome(
  request: ReviewDispatchRequest,
  reviewerMode: ReviewerMode,
  finalDecision: Decision,
  labels: Partial<ReviewerDecisionLabels>,
): Promise<Decision> {
  await logReviewerDecision(request, reviewerMode, finalDecision, labels);
  // Single-surface outcomes: an allow is carried by the decision note alone
  // (it honors display.reviewNote and falls back widget → notify). A deny is
  // carried by the tool-call block reason alone — no separate warning notify
  // and no duplicate note.
  if (finalDecision.effect === "allow") {
    presentDecisionNote(request, reviewerMode, finalDecision, labels);
  }

  if (
    finalDecision.effect !== "allow" &&
    request.escalationTracker !== undefined
  ) {
    const family = escalationFamily(request.shape, request.toolName);
    request.escalationTracker.recordContention(
      family,
      request.reviewerConfig.escalation,
    );
  }

  return finalDecision;
}

function blockDecision(reason: string): Decision {
  return decision("review", `Blocked pending review: ${reason}`, "default");
}

async function logReviewerDecision(
  request: ReviewDispatchRequest,
  reviewerMode: ReviewerMode,
  finalDecision: Decision,
  labels: Partial<ReviewerDecisionLabels> = {},
): Promise<void> {
  try {
    await request.audit.log(
      createReviewerDecisionEntry({
        entryType: "reviewer.decision",
        reviewerMode,
        toolName: request.toolName,
        toolInput: request.toolInput,
        originalDecision: request.originalDecision,
        finalDecision,
        ...labels,
        ...optionalProjectPath(request.ctx),
        ...optionalSessionId(request),
        ...optionalToolCallId(request),
      }),
    );
  } catch {
    // The runtime decision must remain fail-closed even if a test double or
    // downstream sink violates the AuditLogger best-effort contract.
  }
}

function decision(
  effect: DecisionEffect,
  reason: string,
  source: Decision["provenance"]["source"],
): Decision {
  return {
    effect,
    reason,
    provenance: { source },
  };
}

function compactReviewSummary(
  request: ReviewDispatchRequest,
  activeReviewerMode?: Extract<ReviewerMode, "model" | "human">,
): CompactReviewSummary {
  const summary = buildCompactReviewSummary({
    originalDecision: request.originalDecision,
    toolName: request.toolName,
    toolInput: request.toolInput,
    shape: request.shape,
    reviewerConfig: request.reviewerConfig,
  });
  return activeReviewerMode === undefined
    ? summary
    : { ...summary, reviewerModeLabel: activeReviewerMode };
}

function safeBeginReview(
  request: ReviewDispatchRequest,
  activeReviewerMode: Extract<ReviewerMode, "model" | "human">,
): void {
  try {
    request.visibility?.beginReview?.(
      compactReviewSummary(request, activeReviewerMode),
    );
  } catch {
    // Operator visibility is advisory. It must never alter approval behavior.
  }
}

function safeEndReview(request: ReviewDispatchRequest): void {
  try {
    request.visibility?.endReview?.();
  } catch {
    // Operator visibility is advisory. It must never alter approval behavior.
  }
}

function presentDecisionNote(
  request: ReviewDispatchRequest,
  reviewerMode: ReviewerMode,
  finalDecision: Decision,
  labels: Partial<ReviewerDecisionLabels>,
): void {
  const note = formatReviewDecisionNote({
    ...reviewNotePreference(request),
    reviewerMode,
    finalDecision,
    ...reviewerModelLabel(labels),
  });
  if (note === undefined) return;

  try {
    request.visibility?.presentDecisionNote?.(note, request.toolCallId ?? "");
  } catch {
    // Operator visibility is advisory. It must never alter approval behavior.
  }
}

function reviewNotePreference(
  request: ReviewDispatchRequest,
): ResolvedReviewNotePreference {
  return (
    request.resolvedConfig?.display.reviewNote ?? DEFAULT_REVIEW_NOTE_PREFERENCE
  );
}

function reviewerModelLabel(labels: Partial<ReviewerDecisionLabels>): {
  readonly reviewerModelLabel?: string;
} {
  return labels.reviewerModel === undefined
    ? {}
    : {
        reviewerModelLabel: `${labels.reviewerModel.provider}/${labels.reviewerModel.id}`,
      };
}

function promptCustomizationLabel(config: ResolvedReviewerConfig): string {
  if (config.promptOverride !== null) return "override active";

  const globalCount = config.promptAppends.length;
  const projectCount = config.projectPromptAppends.length;
  if (globalCount === 0 && projectCount === 0) return "none";
  return `appends global=${globalCount} project=${projectCount}`;
}

function reviewerModelRegistry(ctx: ExtensionContext): ReviewerModelRegistry {
  const registry = (ctx as { readonly modelRegistry?: unknown }).modelRegistry;
  if (!isReviewerModelRegistry(registry)) return EMPTY_REVIEWER_MODEL_REGISTRY;
  return registry;
}

function contextModel(ctx: ExtensionContext): Model<Api> | undefined {
  const model = (ctx as { readonly model?: unknown }).model;
  return isModelLike(model) ? model : undefined;
}

const EMPTY_REVIEWER_MODEL_REGISTRY: ReviewerModelRegistry = {
  find: () => undefined,
  getAll: () => [],
  hasConfiguredAuth: () => false,
};

function isReviewerModelRegistry(
  value: unknown,
): value is ReviewerModelRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { find?: unknown }).find === "function" &&
    typeof (value as { getAll?: unknown }).getAll === "function" &&
    typeof (value as { hasConfiguredAuth?: unknown }).hasConfiguredAuth ===
      "function"
  );
}

function isModelLike(value: unknown): value is Model<Api> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { provider?: unknown }).provider === "string"
  );
}

function safeProjectTrustLabel(ctx: ExtensionContext): "trusted" | "untrusted" {
  try {
    return ctx.isProjectTrusted() ? "trusted" : "untrusted";
  } catch {
    return "untrusted";
  }
}

function getSessionId(ctx: ExtensionContext): string | undefined {
  const sessionManager = ctx.sessionManager as {
    readonly getSessionId?: () => string;
  };
  try {
    return sessionManager.getSessionId?.();
  } catch {
    return undefined;
  }
}

function optionalProjectPath(ctx: ExtensionContext | undefined): {
  readonly projectPath?: string;
} {
  return ctx === undefined ? {} : { projectPath: ctx.cwd };
}

function optionalSessionId(request: ReviewDispatchRequest): {
  readonly sessionId?: string;
} {
  const sessionId =
    request.sessionId ?? getSessionIdFromRequestContext(request);
  return sessionId === undefined ? {} : { sessionId };
}

function getSessionIdFromRequestContext(
  request: ReviewDispatchRequest,
): string | undefined {
  return request.ctx === undefined ? undefined : getSessionId(request.ctx);
}

function optionalToolCallId(request: ReviewDispatchRequest): {
  readonly toolCallId?: string;
} {
  return request.toolCallId === undefined
    ? {}
    : { toolCallId: request.toolCallId };
}

function signalOption(request: ReviewDispatchRequest): {
  readonly signal?: AbortSignal;
} {
  const signal = request.ctx?.signal;
  return signal === undefined ? {} : { signal };
}

function dialogOptions(
  signal: AbortSignal | undefined,
): { readonly signal?: AbortSignal } | undefined {
  return signal === undefined ? undefined : { signal };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
