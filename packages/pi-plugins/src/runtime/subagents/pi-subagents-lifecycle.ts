import { loadVerifiedPiSubagentsService } from "./pi-subagents-package.js";
import type {
  SubagentLifecycleCompletionContext as NativeCompletionContext,
  SubagentLifecycleCompletionDecision as NativeCompletionDecision,
  SubagentLifecycleInterceptor as NativeInterceptor,
  SubagentLifecycleRegistration as NativeRegistration,
  SubagentLifecycleStartContext as NativeStartContext,
  SubagentLifecycleStartDecision as NativeStartDecision,
  SubagentsService,
} from "@nklisch/pi-subagents";
import {
  SUBAGENT_LIFECYCLE_CAPABILITY_ID,
  SUBAGENT_LIFECYCLE_CONFORMANCE_SUITE_VERSION,
  SUBAGENT_LIFECYCLE_CONTRACT_VERSION,
  SubagentCompletionDecisionSchemaV1,
  SubagentExecutionIdentitySchemaV1,
  SubagentExecutionPathSchemaV1,
  SubagentLifecycleCapabilitiesSchemaV1,
  SubagentLifecycleRegistrationEvidenceSchemaV1,
  SubagentStartDecisionSchemaV1,
  type SubagentCompletionRequest,
  type SubagentLifecycleCapabilities,
  type SubagentLifecycleInterceptor,
  type SubagentLifecyclePort,
  type SubagentLifecycleRegistration,
  type SubagentLifecycleRegistrationRequest,
  type SubagentStartRequest,
} from "../../application/ports/subagent-lifecycle.js";
import { BoundaryError, ErrorCodeRegistry } from "../../domain/errors.js";

const PACKAGE_NAME = "@nklisch/pi-subagents";
const PACKAGE_VERSION = "18.0.4-nklisch.0";
const PACKAGE_INTEGRITY =
  "sha512-33Q8JDffXUuiT1M3XjLXCI4If9p+3AOwsUp/b5f1+B7Y5JI8Z8SVU+Dncq0umAG2IjgVYKnT9FHToFHNoZGWoQ==";
const PACKAGE_RELEASE_TAG = "pi-subagents-v18.0.4-nklisch.0";
const PACKAGE_COMMIT = "43efffb459f64e2f5f9aaee50d8ae5afa564f4f3";
const PACKAGE_NODE_ENGINE = ">=22";
const PACKAGE_PI_PEER_RANGE = ">=0.75.0";
const PACKAGE_CONTINUATION_BUDGET = 3;

// This digest covers the three unchanged portable conformance vectors: the
// reusable trace contract, its negative controls, and its port integration.
const CONFORMANCE_SUITE_DIGEST =
  "sha256:10166fbb0d775c52a69e9d97c5cbfe0e7a3e4d73f625d19d00c9b30569ae9e5e";
// Canonical SHA-256 receipt over the package provenance, contract version, and
// complete vector manifest (without its self-referential receipt field).
const QUALIFICATION_DIGEST =
  "sha256:982e03c31c1b8dcbc96a167bf470df934713a2799565df380e82bfee78e39ed6";

const COMPLETE_SEMANTICS = {
  orderedAsync: true,
  exactStartPrompt: true,
  startReplacement: true,
  startAbortBeforePrompt: true,
  executionCancellation: true,
  proposedResultBeforeFinalization: true,
  resultReplacement: true,
  sameSessionContinuation: true,
  boundedContinuation: true,
  typedFailureOrdering: true,
  idempotentUnregister: true,
  disposeExactlyOnce: true,
  unchangedWithoutInterceptors: true,
} as const;

const COMPLETE_COVERAGE = {
  tool: true,
  service: true,
  foreground: true,
  background: true,
  queued: true,
  initial: true,
  resume: true,
  parentIdentityWhenPresent: true,
} as const;

const CAPABILITIES: SubagentLifecycleCapabilities =
  SubagentLifecycleCapabilitiesSchemaV1.parse({
    schemaVersion: 1,
    capabilityId: SUBAGENT_LIFECYCLE_CAPABILITY_ID,
    contractVersion: SUBAGENT_LIFECYCLE_CONTRACT_VERSION,
    qualificationDigest: QUALIFICATION_DIGEST,
    semantics: COMPLETE_SEMANTICS,
    coverage: COMPLETE_COVERAGE,
    provider: {
      kind: "published-package",
      packageName: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      integrity: PACKAGE_INTEGRITY,
      releaseTag: PACKAGE_RELEASE_TAG,
      commit: PACKAGE_COMMIT,
      license: "MIT",
      nodeEngine: PACKAGE_NODE_ENGINE,
      piPeerRange: PACKAGE_PI_PEER_RANGE,
      contractVersion: SUBAGENT_LIFECYCLE_CONTRACT_VERSION,
      conformance: {
        suiteVersion: SUBAGENT_LIFECYCLE_CONFORMANCE_SUITE_VERSION,
        suiteDigest: CONFORMANCE_SUITE_DIGEST,
        qualificationDigest: QUALIFICATION_DIGEST,
        vectors: { ...COMPLETE_SEMANTICS, ...COMPLETE_COVERAGE },
      },
    },
  });

function adapterFailure(operation: string, cause: unknown): BoundaryError {
  return new BoundaryError({
    code: ErrorCodeRegistry.adapterFailed,
    operation,
    message: "Published subagent lifecycle adapter failed",
    cause,
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function assertAbortSignal(value: unknown, label: string): asserts value is AbortSignal {
  if (!(value instanceof AbortSignal)) {
    throw new TypeError(`${label} must be an AbortSignal`);
  }
}

function assertService(value: unknown): asserts value is Pick<
  SubagentsService,
  "registerLifecycleInterceptor"
> {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { readonly registerLifecycleInterceptor?: unknown })
      .registerLifecycleInterceptor !== "function"
  ) {
    throw new TypeError("published subagent lifecycle service is unavailable");
  }
}

function assertRegistrationRequest(
  request: unknown,
): asserts request is SubagentLifecycleRegistrationRequest {
  if (
    request === null ||
    typeof request !== "object" ||
    typeof (request as { readonly expectedQualificationDigest?: unknown })
      .expectedQualificationDigest !== "string" ||
    (request as { readonly expectedQualificationDigest: string })
      .expectedQualificationDigest !== QUALIFICATION_DIGEST ||
    (request as { readonly maxContinuationRounds?: unknown })
      .maxContinuationRounds !== PACKAGE_CONTINUATION_BUDGET
  ) {
    throw new TypeError("subagent lifecycle registration does not match the qualification receipt");
  }
  const interceptor = (request as { readonly interceptor?: unknown }).interceptor;
  if (
    interceptor === null ||
    typeof interceptor !== "object" ||
    typeof (interceptor as { readonly beforeStart?: unknown }).beforeStart !==
      "function" ||
    typeof (interceptor as { readonly beforeComplete?: unknown })
      .beforeComplete !== "function"
  ) {
    throw new TypeError("subagent lifecycle registration interceptor is invalid");
  }
}

function awaitWithSignal<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    void value.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(abortReason(signal));
        else resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(signal.aborted ? abortReason(signal) : error);
      },
    );
  });
}

function parseNativeIdentity(value: unknown) {
  if (value === null || typeof value !== "object") {
    throw new TypeError("published lifecycle identity is invalid");
  }
  const identity = value as Record<string, unknown>;
  const allowed = new Set([
    "agentId",
    "sessionId",
    "runId",
    "agentType",
    "parentSessionId",
  ]);
  if (Object.keys(identity).some((key) => !allowed.has(key))) {
    throw new TypeError("published lifecycle identity contains unsupported fields");
  }
  return SubagentExecutionIdentitySchemaV1.parse({
    schemaVersion: 1,
    agentId: identity.agentId,
    sessionId: identity.sessionId,
    runId: identity.runId,
    agentType: identity.agentType,
    ...(identity.parentSessionId === undefined
      ? {}
      : { parentSessionId: identity.parentSessionId }),
  });
}

function parseStartRequest(context: unknown): SubagentStartRequest {
  if (context === null || typeof context !== "object") {
    throw new TypeError("published lifecycle start context is invalid");
  }
  const value = context as {
    readonly identity?: unknown;
    readonly execution?: unknown;
    readonly prompt?: unknown;
    readonly signal?: unknown;
  };
  assertAbortSignal(value.signal, "published lifecycle start signal");
  if (typeof value.prompt !== "string") {
    throw new TypeError("published lifecycle start prompt is invalid");
  }
  return Object.freeze({
    identity: parseNativeIdentity(value.identity),
    execution: SubagentExecutionPathSchemaV1.parse(value.execution),
    prompt: value.prompt,
    signal: value.signal,
  });
}

function parseCompletionRequest(context: unknown): SubagentCompletionRequest {
  if (context === null || typeof context !== "object") {
    throw new TypeError("published lifecycle completion context is invalid");
  }
  const value = context as {
    readonly identity?: unknown;
    readonly execution?: unknown;
    readonly proposedResult?: unknown;
    readonly outcome?: unknown;
    readonly continuationRound?: unknown;
    readonly maxContinuationRounds?: unknown;
    readonly signal?: unknown;
  };
  assertAbortSignal(value.signal, "published lifecycle completion signal");
  const continuationRound = value.continuationRound;
  if (
    typeof value.proposedResult !== "string" ||
    (value.outcome !== "completed" &&
      value.outcome !== "steered" &&
      value.outcome !== "aborted") ||
    typeof continuationRound !== "number" ||
    !Number.isInteger(continuationRound) ||
    continuationRound < 0 ||
    value.maxContinuationRounds !== PACKAGE_CONTINUATION_BUDGET
  ) {
    throw new TypeError("published lifecycle completion context is invalid");
  }
  return Object.freeze({
    identity: parseNativeIdentity(value.identity),
    execution: SubagentExecutionPathSchemaV1.parse(value.execution),
    proposedResult: value.proposedResult,
    outcome: value.outcome,
    continuationRound,
    maxContinuationRounds: value.maxContinuationRounds,
    signal: value.signal,
  });
}

async function beforeStart(
  interceptor: SubagentLifecycleInterceptor,
  context: NativeStartContext,
): Promise<NativeStartDecision | undefined> {
  let request: SubagentStartRequest;
  try {
    request = parseStartRequest(context);
    request.signal.throwIfAborted();
    const decision = SubagentStartDecisionSchemaV1.parse(
      await awaitWithSignal(interceptor.beforeStart(request), request.signal),
    );
    request.signal.throwIfAborted();
    if (decision.action === "abort") {
      return { action: "abort", reason: decision.reason };
    }
    // The package treats an omitted prompt as a true no-op, preserving its
    // released no-provider bytes/order whenever this aggregate is inactive.
    return decision.prompt === request.prompt
      ? undefined
      : { action: "continue", prompt: decision.prompt };
  } catch (cause) {
    if (context.signal instanceof AbortSignal && context.signal.aborted) {
      throw abortReason(context.signal);
    }
    if (cause instanceof BoundaryError) throw cause;
    throw adapterFailure("piSubagentsLifecycle.beforeStart", cause);
  }
}

async function beforeComplete(
  interceptor: SubagentLifecycleInterceptor,
  context: NativeCompletionContext,
): Promise<NativeCompletionDecision | undefined> {
  let request: SubagentCompletionRequest;
  try {
    request = parseCompletionRequest(context);
    request.signal.throwIfAborted();
    const decision = SubagentCompletionDecisionSchemaV1.parse(
      await awaitWithSignal(interceptor.beforeComplete(request), request.signal),
    );
    request.signal.throwIfAborted();
    if (decision.action === "abort") {
      return { action: "abort", reason: decision.reason };
    }
    if (decision.action === "continue") {
      if (request.continuationRound >= request.maxContinuationRounds) {
        return {
          action: "abort",
          reason: "Subagent lifecycle continuation limit is exhausted",
        };
      }
      return { action: "continue", prompt: decision.prompt };
    }
    return decision.result === request.proposedResult
      ? undefined
      : { action: "complete", result: decision.result };
  } catch (cause) {
    if (context.signal instanceof AbortSignal && context.signal.aborted) {
      throw abortReason(context.signal);
    }
    if (cause instanceof BoundaryError) throw cause;
    throw adapterFailure("piSubagentsLifecycle.beforeComplete", cause);
  }
}

function nativeInterceptor(interceptor: SubagentLifecycleInterceptor): NativeInterceptor {
  return Object.freeze({
    beforeStart: (context: NativeStartContext) => beforeStart(interceptor, context),
    beforeComplete: (context: NativeCompletionContext) => beforeComplete(interceptor, context),
  });
}

function parseNativeRegistration(value: unknown): NativeRegistration {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { readonly dispose?: unknown }).dispose !== "function"
  ) {
    throw new TypeError("published subagent lifecycle registration is invalid");
  }
  return value as NativeRegistration;
}

/**
 * Translate the documented root export of the qualifying published package.
 * This is the sole production package boundary: host code sees only its own
 * port and never a manager, session, record, queue, or package decision type.
 */
export function createPiSubagentsLifecyclePort(input: Readonly<{
  service: Pick<SubagentsService, "registerLifecycleInterceptor">;
}>): SubagentLifecyclePort {
  try {
    if (input === null || typeof input !== "object") {
      throw new TypeError("published subagent lifecycle adapter input is required");
    }
    assertService(input.service);
  } catch (cause) {
    throw adapterFailure("createPiSubagentsLifecyclePort", cause);
  }

  return Object.freeze({
    async capabilities(signal: AbortSignal): Promise<SubagentLifecycleCapabilities> {
      try {
        assertAbortSignal(signal, "subagent lifecycle capability signal");
        signal.throwIfAborted();
        return CAPABILITIES;
      } catch (cause) {
        if (signal instanceof AbortSignal && signal.aborted) throw abortReason(signal);
        if (cause instanceof BoundaryError) throw cause;
        throw adapterFailure("piSubagentsLifecycle.capabilities", cause);
      }
    },

    async register(
      request: SubagentLifecycleRegistrationRequest,
      signal: AbortSignal,
    ): Promise<SubagentLifecycleRegistration> {
      let native: NativeRegistration;
      try {
        assertAbortSignal(signal, "subagent lifecycle registration signal");
        signal.throwIfAborted();
        assertRegistrationRequest(request);
        native = parseNativeRegistration(
          input.service.registerLifecycleInterceptor(nativeInterceptor(request.interceptor)),
        );
        if (signal.aborted) {
          await native.dispose();
          throw abortReason(signal);
        }
      } catch (cause) {
        if (signal instanceof AbortSignal && signal.aborted) throw abortReason(signal);
        if (cause instanceof BoundaryError) throw cause;
        throw adapterFailure("piSubagentsLifecycle.register", cause);
      }

      let disposePromise: Promise<void> | undefined;
      const dispose = (): Promise<void> => {
        disposePromise ??= Promise.resolve().then(async () => {
          try {
            await native.dispose();
          } catch (cause) {
            throw adapterFailure("piSubagentsLifecycle.dispose", cause);
          }
        });
        return disposePromise;
      };

      return Object.freeze({
        evidence: SubagentLifecycleRegistrationEvidenceSchemaV1.parse({
          schemaVersion: 1,
          contractVersion: SUBAGENT_LIFECYCLE_CONTRACT_VERSION,
          capabilityId: SUBAGENT_LIFECYCLE_CAPABILITY_ID,
          qualificationDigest: QUALIFICATION_DIGEST,
          orderedAsync: true,
          maxContinuationRounds: PACKAGE_CONTINUATION_BUDGET,
          state: "registered",
        }),
        dispose,
      });
    },
  });
}

/** Resolve the selected package through its receipt-gated documented root export only. */
export async function createPublishedPiSubagentsLifecyclePort(): Promise<
  SubagentLifecyclePort | undefined
> {
  const service = await loadVerifiedPiSubagentsService();
  return service === undefined ? undefined : createPiSubagentsLifecyclePort({ service });
}
