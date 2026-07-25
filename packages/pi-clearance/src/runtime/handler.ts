import type {
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { createPolicyDecisionEntry } from "../audit/log.ts";
import type { AuditLogger } from "../audit/logger.ts";
import type { ResolvedReviewerConfig } from "../config/loader.ts";
import { enrichToolShapeWithPathFacts } from "../parse/native-path-facts.ts";
import type { ToolAnalyzerRegistry } from "../parse/registry.ts";
import type { ToolShape } from "../parse/shape.ts";
import type { Decision } from "../policy/core.ts";
import { decide, decideNativePolicy } from "../policy/core.ts";
import type { CommandTransformStore } from "./command-transforms.ts";
import type { EscalationTracker } from "./escalation.ts";
import type { OperatorStatusController } from "./operator-status.ts";
import type { PolicyResolver, ResolvedPolicy } from "./policy-cache.ts";
import {
  createReviewDecisionDisplay,
  type ReviewDecisionDisplay,
} from "./review-decision-display.ts";
import { formatDenyBlockReason } from "./review-visibility.ts";
import {
  dispatchReview,
  type ReviewerHumanAdapter,
  type ReviewerModelAdapter,
  type ReviewVisibilityAdapter,
  showReviewerConfigOnce,
} from "./reviewer.ts";
import type { ReviewerContextSources } from "./reviewer-context.ts";
import type { ReviewerTokenBudgetGate } from "./token-budget.ts";

export interface HandlerDependencies {
  readonly analyzerRegistry: ToolAnalyzerRegistry;
  readonly audit: AuditLogger;
  readonly policyResolver: PolicyResolver;
  readonly createAdapters: (
    ctx: ExtensionContext,
    reviewer: ResolvedReviewerConfig,
  ) => {
    readonly humanAdapter: ReviewerHumanAdapter;
    readonly modelAdapter: ReviewerModelAdapter;
  };
  /** Process-wide escalation tracker; absent keeps legacy/test behavior unchanged. */
  readonly escalationTracker?: EscalationTracker;
  /** Process-wide token-budget gate; absent keeps legacy/test behavior unlimited. */
  readonly tokenBudgetGate?: ReviewerTokenBudgetGate;
  readonly createContextSources?: (
    ctx: ExtensionContext,
  ) => ReviewerContextSources | undefined;
  readonly operatorStatus?: OperatorStatusController;
  /**
   * Optional command-transform store. When present, approved `bash` commands are
   * run through collected transforms and the final command is written back to
   * `event.input.command`. The reviewer always sees the ORIGINAL command
   * because transforms run only after an allow decision. Absent keeps legacy
   * behavior (no transforms).
   */
  readonly transformStore?: CommandTransformStore;
}

export function createHandleToolCall(
  deps: HandlerDependencies,
): (
  event: ToolCallEvent,
  ctx: ExtensionContext,
) => Promise<ToolCallEventResult> {
  return async (event, ctx) => {
    // Capture the original bash command up front. The reviewer (deterministic
    // decision + dispatchReview) always sees THIS command; command transforms
    // (e.g. RTK output compression) run only after an allow decision and write
    // their result back to event.input.command for execution. This is the
    // load-order-independent coordination that lets a rewriter register via
    // pi.events instead of racing on tool_call.
    const originalCommand =
      event.toolName === "bash" ? readBashCommand(event.input) : undefined;
    // Snapshot the tool input for audit/review. The audit log must record what
    // was actually reviewed (the original command), but `event.input` is the
    // live object the executor reads and transforms mutate in place — so a
    // shallow clone here keeps the audit immutable even after transforms run.
    const inputSnapshot = snapshotInput(event.input);

    try {
      const resolved = await deps.policyResolver.resolve(ctx);
      if (!resolved.ok) {
        const decision = reviewDecision(
          policyResolutionFailureReason(resolved.reason),
        );
        await logPolicyDecision(
          deps.audit,
          inputSnapshot,
          event,
          ctx,
          decision,
        );
        return block(decision.reason);
      }

      deps.operatorStatus?.refresh(ctx, resolved.policy);

      const rawShape = await deps.analyzerRegistry.analyze(
        event.toolName,
        event.input,
      );
      const shape = enrichToolShapeWithPathFacts(
        rawShape,
        resolved.policy.config,
      );
      const decision = deterministicDecision(shape, resolved.policy, event);
      await logPolicyDecision(
        deps.audit,
        inputSnapshot,
        event,
        ctx,
        decision,
        shape,
      );

      if (hasAnalyzerError(shape)) {
        return block(decision.reason);
      }

      return await mapDecisionToResult({
        deps,
        event,
        inputSnapshot,
        ctx,
        shape,
        decision,
        resolvedPolicy: resolved.policy,
        originalCommand,
      });
    } catch (error: unknown) {
      const decision = reviewDecision(
        `pi-clearance handler error: ${errorMessage(error)}`,
      );
      await logPolicyDecision(deps.audit, inputSnapshot, event, ctx, decision);
      return block(decision.reason);
    }
  };
}

export function createHandleSessionStart(deps: {
  readonly policyResolver: PolicyResolver;
  readonly operatorStatus?: OperatorStatusController;
  readonly beforeResolve?: (
    event: SessionStartEvent,
    ctx: ExtensionContext,
  ) => void | Promise<void>;
}): (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void> {
  return async (event, ctx) => {
    try {
      await deps.beforeResolve?.(event, ctx);
      const resolved = await deps.policyResolver.resolve(ctx);
      if (resolved.ok) {
        deps.operatorStatus?.refresh(ctx, resolved.policy);
        if (ctx.hasUI) {
          showReviewerConfigOnce(
            ctx,
            resolved.policy.config.reviewer,
            resolved.policy.config.mode,
          );
        }
      }
    } catch {
      // Session-start visibility is advisory; config failures surface on tool calls.
    }
  };
}

interface ResultMappingInput {
  readonly deps: HandlerDependencies;
  readonly event: ToolCallEvent;
  /** Immutable snapshot of event.input captured before transforms. */
  readonly inputSnapshot: unknown;
  readonly ctx: ExtensionContext;
  readonly shape: ToolShape;
  readonly decision: Decision;
  readonly resolvedPolicy: ResolvedPolicy;
  /** Original bash command captured before any transform; undefined for non-bash. */
  readonly originalCommand: string | undefined;
}

async function mapDecisionToResult(
  input: ResultMappingInput,
): Promise<ToolCallEventResult> {
  if (input.decision.effect === "allow") {
    await applyTransforms(input);
    return {};
  }
  if (input.decision.effect === "deny") {
    return block(formatDenyBlockReason(input.decision));
  }

  const adapters = input.deps.createAdapters(
    input.ctx,
    input.resolvedPolicy.config.reviewer,
  );
  const display = createReviewDecisionDisplay(
    input.ctx,
    input.resolvedPolicy.config.display.reviewNote,
  );
  const finalDecision = await dispatchReview({
    originalDecision: input.decision,
    toolName: input.event.toolName,
    // Pass the snapshot, not event.input: the reviewer must judge the original
    // command. event.input may be mutated by transforms after the allow below.
    toolInput: input.inputSnapshot,
    shape: input.shape,
    reviewerConfig: input.resolvedPolicy.config.reviewer,
    resolvedConfig: input.resolvedPolicy.config,
    humanAdapter: adapters.humanAdapter,
    modelAdapter: adapters.modelAdapter,
    audit: input.deps.audit,
    ...(input.deps.escalationTracker === undefined
      ? {}
      : { escalationTracker: input.deps.escalationTracker }),
    ...(input.deps.tokenBudgetGate === undefined
      ? {}
      : { tokenBudgetGate: input.deps.tokenBudgetGate }),
    ...optionalContextSources(input.deps, input.ctx),
    visibility: reviewVisibilityAdapter(
      input.deps.operatorStatus,
      display,
      input.ctx,
    ),
    ctx: input.ctx,
    mode: input.resolvedPolicy.config.mode,
    ...optionalSessionId(input.ctx),
    toolCallId: input.event.toolCallId,
  });

  if (finalDecision.effect === "allow") {
    await applyTransforms(input);
    return {};
  }
  return block(formatDenyBlockReason(finalDecision));
}

/**
 * Run registered command transforms against the ORIGINAL bash command and
 * write the result back to `event.input.command` for execution. No-op for
 * non-bash tools, when no transforms are registered, or when the store is
 * absent. Fail-open: a transform error never blocks an allowed command.
 *
 * This runs strictly AFTER the allow decision, so the reviewer has already
 * judged the original command. The rewriter never gets to corrupt what was
 * reviewed.
 */
async function applyTransforms(input: ResultMappingInput): Promise<void> {
  const { deps, event, ctx, originalCommand } = input;
  if (originalCommand === undefined) return;
  if (deps.transformStore === undefined) return;

  const result = await deps.transformStore.runTransforms(originalCommand, ctx);
  if (
    result.changed &&
    typeof (event.input as { command?: unknown }).command === "string"
  ) {
    (event.input as { command: string }).command = result.command;
  }
}

function reviewVisibilityAdapter(
  operatorStatus: OperatorStatusController | undefined,
  display: ReviewDecisionDisplay | undefined,
  ctx: ExtensionContext,
): ReviewVisibilityAdapter {
  return {
    beginReview: (summary) => operatorStatus?.beginReview(ctx, summary),
    endReview: () => operatorStatus?.endReview(ctx),
    ...(display === undefined
      ? {}
      : {
          presentDecisionNote: (note, toolCallId) =>
            display.present(note, toolCallId),
        }),
  };
}

function deterministicDecision(
  shape: ToolShape,
  resolvedPolicy: ResolvedPolicy,
  event: ToolCallEvent,
): Decision {
  if (hasAnalyzerError(shape)) {
    return reviewDecision(analyzerErrorReason(shape));
  }

  if (shape.kind === "unknown") {
    return {
      effect: resolvedPolicy.config.unknownToolPosture,
      reason: `unknown tool: ${event.toolName}`,
      provenance: { source: "default" },
    };
  }

  return resolvedPolicy.nativePolicy === undefined
    ? decide(shape, resolvedPolicy.effectivePolicy)
    : decideNativePolicy(resolvedPolicy.nativePolicy, shape);
}

async function logPolicyDecision(
  audit: AuditLogger,
  toolInput: unknown,
  event: ToolCallEvent,
  ctx: ExtensionContext,
  decision: Decision,
  shape?: ToolShape,
): Promise<void> {
  try {
    await audit.log(
      createPolicyDecisionEntry({
        entryType: "policy.decision",
        toolName: event.toolName,
        // Snapshot, not event.input: the audit records what was reviewed, not
        // what eventually runs after transforms mutate event.input.command.
        toolInput,
        decision,
        projectPath: ctx.cwd,
        ...optionalSessionId(ctx),
        toolCallId: event.toolCallId,
        ...(shape === undefined ? {} : { shape }),
      }),
    );
  } catch {
    // Runtime decisions must remain fail-closed even if an injected logger misbehaves.
  }
}

function reviewDecision(reason: string): Decision {
  return {
    effect: "review",
    reason,
    provenance: { source: "default" },
  };
}

function policyResolutionFailureReason(reason: string): string {
  return reason.startsWith("policy resolution failed:")
    ? reason
    : `policy resolution failed: ${reason}`;
}

function block(reason: string): ToolCallEventResult {
  return { block: true, reason };
}

function hasAnalyzerError(shape: ToolShape): boolean {
  return shape.diagnostics.some(
    (diagnostic) => diagnostic.code === "tool:analyzer-error",
  );
}

function analyzerErrorReason(shape: ToolShape): string {
  const diagnostic = shape.diagnostics.find(
    (entry) => entry.code === "tool:analyzer-error",
  );
  return diagnostic?.message ?? "tool analyzer failed closed";
}

function optionalContextSources(
  deps: HandlerDependencies,
  ctx: ExtensionContext,
): { readonly contextSources?: ReviewerContextSources } {
  try {
    const contextSources = deps.createContextSources?.(ctx);
    return contextSources === undefined ? {} : { contextSources };
  } catch {
    return {};
  }
}

function optionalSessionId(ctx: ExtensionContext): {
  readonly sessionId?: string;
} {
  const sessionManager = ctx.sessionManager as {
    readonly getSessionId?: () => string;
  };

  try {
    const sessionId = sessionManager.getSessionId?.();
    return sessionId === undefined ? {} : { sessionId };
  } catch {
    return {};
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read the `command` field from a bash tool-call input; undefined for non-bash. */
function readBashCommand(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("command" in input)) {
    return undefined;
  }
  const command = (input as { readonly command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

/**
 * Shallow-clone the tool-call input for immutable audit/review. The clone is
 * one level deep: it isolates the `command` field (the only field transforms
 * mutate) from later in-place mutation. Nested values are shared, which is fine
 * — transforms only reassign the top-level `command` string.
 */
function snapshotInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null) return input;
  return { ...(input as Record<string, unknown>) };
}
