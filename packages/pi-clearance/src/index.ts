import type {
  ExtensionAPI,
  ExtensionFactory,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { createAuditLogger } from "./audit/logger.ts";
import {
  CLEARANCE_ALLOW_REQUEST_CUSTOM_TYPE,
  renderClearanceAllowRequest,
} from "./runtime/allow-request-message.ts";
import { requireNativeEngine } from "./native/loader.ts";
import { createPackageRegistrationStore } from "./packs/package-registration.ts";
import { createDefaultAnalyzerRegistry } from "./parse/registry.ts";
import { registerClearanceCommands } from "./runtime/command-registry.ts";
import { createCommandTransformStore } from "./runtime/command-transforms.ts";
import { parseDurationToMs } from "./runtime/duration.ts";
import { createInProcessEscalationTracker } from "./runtime/escalation.ts";
import {
  createHandleSessionStart,
  createHandleToolCall,
} from "./runtime/handler.ts";
import { createRatchetModePromptInjector } from "./runtime/mode-prompt.ts";
import { createPiModelAdapter } from "./runtime/model-adapter.ts";
import { createOperatorStatusController } from "./runtime/operator-status.ts";
import { createCachingPolicyResolver } from "./runtime/policy-cache.ts";
import { registerProposalTools } from "./runtime/proposal-tools/index.ts";
import { createRatchetModeManager } from "./runtime/ratchet-mode.ts";
import { createRatchetBatchCache } from "./runtime/ratchet-tools/batch-cache.ts";
import { registerRatchetAnalysisTools } from "./runtime/ratchet-tools/index.ts";
import { createPiHumanAdapter } from "./runtime/reviewer.ts";
import {
  createAuditLogRecentDecisionSource,
  createSessionConversationTurnSource,
} from "./runtime/reviewer-context-adapter.ts";
import { createDefaultAuditSink } from "./runtime/sink.ts";
import { createReviewerTokenBudgetGate } from "./runtime/token-budget.ts";

/**
 * Map a Pi `session_start` reason to a package-registration collect reason.
 *
 * `startup` is passed through. Every other session_start reason (`reload`,
 * `new`, `resume`, `fork`) re-binds the extension instance and its in-memory
 * store, so the closest contract meaning - "recollect current responses" -
 * is `reload`. The contract has no `new`/`resume`/`fork` reason; collecting on
 * those ensures a freshly bound instance discovers packages rather than
 * staying empty until the next startup.
 */
function toPackageCollectReason(
  reason: SessionStartEvent["reason"],
): "startup" | "reload" {
  return reason === "startup" ? "startup" : "reload";
}

/**
 * Pi extension composition root.
 *
 * Keep Pi-specific adapter construction here so the parser, policy, config, and
 * handler modules remain pure-core surfaces that can be tested without Pi.
 */
const piAutoApprove: ExtensionFactory = (pi: ExtensionAPI) => {
  // The health call is the first native use during activation. A missing or
  // malformed prebuild refuses to arm the extension rather than leaving a
  // partially initialized clearance runtime in place.
  const nativeHealth = requireNativeEngine().health();
  const audit = createAuditLogger({ sink: createDefaultAuditSink() });
  const registerMessageRenderer = (
    pi as unknown as {
      registerMessageRenderer?: (
        customType: string,
        renderer: typeof renderClearanceAllowRequest,
      ) => void;
    }
  ).registerMessageRenderer;
  if (typeof registerMessageRenderer === "function") {
    registerMessageRenderer.call(
      pi,
      CLEARANCE_ALLOW_REQUEST_CUSTOM_TYPE,
      renderClearanceAllowRequest,
    );
  }
  let invalidatePolicyCache: (cwd?: string) => void = () => {
    /* resolver not constructed yet */
  };
  const analyzerRegistry = createDefaultAnalyzerRegistry();
  const escalationTracker = createInProcessEscalationTracker();
  const tokenBudgetGate = createReviewerTokenBudgetGate({
    parseDuration: parseDurationToMs,
  });
  const recentDecisionSource = createAuditLogRecentDecisionSource();
  const ratchetModeManager = createRatchetModeManager();
  const proposalBatchCache = createRatchetBatchCache();
  const operatorStatus = createOperatorStatusController({
    ratchetModeManager,
    nativeHealth,
  });

  pi.on(
    "before_agent_start",
    createRatchetModePromptInjector(ratchetModeManager),
  );

  // Construct the package registration store up front so its register-event
  // listener is installed before any collection request. Out-of-band package
  // registrations invalidate the policy/registry cache; session_start also
  // invalidates the current cwd after collecting the fresh snapshot.
  const packageRegistration = createPackageRegistrationStore({
    events: pi.events,
    onChange: () => invalidatePolicyCache(),
  });
  // Construct the command-transform store up front so its register-event
  // listener is installed before any collection request. Approved bash
  // commands are run through collected transforms (e.g. RTK output
  // compression) AFTER the allow decision, so the reviewer always sees the
  // original command. Transforms register via pi.events (load-order-
  // independent) rather than racing on tool_call.
  const transformStore = createCommandTransformStore({
    events: pi.events,
  });
  const policyResolver = createCachingPolicyResolver({
    audit,
    packageRegistration: packageRegistration.snapshot,
    registeredToolNames: () => registeredToolNames(pi),
  });
  invalidatePolicyCache = policyResolver.invalidate;
  registerClearanceCommands(pi, {
    manager: ratchetModeManager,
    policyResolver,
    packageRegistration: packageRegistration.snapshot,
    audit,
    recentDecisionSource,
    analyzerRegistry,
    toolMetadata: () => toolMetadata(pi),
    refreshOperatorStatus: (ctx, policy) => operatorStatus.refresh(ctx, policy),
  });
  registerProposalTools(
    pi,
    {
      policyResolver,
      packageRegistration: packageRegistration.snapshot,
      audit,
      refreshOperatorStatus: (ctx, policy) => operatorStatus.refresh(ctx, policy),
    },
    proposalBatchCache,
  );
  registerRatchetAnalysisTools(
    ratchetModeManager,
    {
      policyResolver,
      packageRegistration: packageRegistration.snapshot,
      audit,
      refreshOperatorStatus: (ctx, policy) => operatorStatus.refresh(ctx, policy),
    },
    proposalBatchCache,
  );

  // Collect package registrations on session_start BEFORE the first policy
  // resolution so the registry snapshot is current when policy is composed.
  const handleSessionStart = createHandleSessionStart({
    policyResolver,
    operatorStatus,
    beforeResolve: (event, ctx) => {
      packageRegistration.collect(toPackageCollectReason(event.reason));
      transformStore.collect(toPackageCollectReason(event.reason));
      // collect() normally fires onChange and clears the whole cache. Keep the
      // cwd invalidate as an explicit safety belt for inert/older event-bus
      // paths where collect is a no-op and no onChange notification fires.
      policyResolver.invalidate(ctx.cwd);
    },
  });
  pi.on("session_start", handleSessionStart);
  pi.on("session_shutdown", (_event, ctx) => {
    operatorStatus.clear(ctx);
    packageRegistration.dispose();
    transformStore.dispose();
  });

  pi.on(
    "tool_call",
    createHandleToolCall({
      analyzerRegistry,
      audit,
      policyResolver,
      transformStore,
      createAdapters: (ctx, reviewer) => ({
        humanAdapter: createPiHumanAdapter(ctx),
        modelAdapter: createPiModelAdapter(ctx, {
          modelSpec: () => reviewer.model,
        }),
      }),
      createContextSources: (ctx) => ({
        decisions: recentDecisionSource,
        conversation: createSessionConversationTurnSource({
          sessionManager: ctx.sessionManager,
        }),
      }),
      escalationTracker,
      tokenBudgetGate,
      operatorStatus,
    }),
  );
};

function registeredToolNames(pi: ExtensionAPI): readonly string[] {
  return toolMetadata(pi).allToolNames;
}

function toolMetadata(pi: ExtensionAPI): {
  readonly activeToolNames: readonly string[];
  readonly allToolNames: readonly string[];
} {
  try {
    const allToolNames = pi
      .getAllTools()
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string");
    return {
      activeToolNames: pi.getActiveTools(),
      allToolNames,
    };
  } catch {
    return { activeToolNames: [], allToolNames: [] };
  }
}

export default piAutoApprove;
