import {
  SubagentLifecycleCapabilitiesSchemaV1,
  SubagentLifecycleRegistrationEvidenceSchemaV1,
  type SubagentLifecycleCapabilities,
  type SubagentLifecycleInterceptor,
  type SubagentLifecyclePort,
  type SubagentLifecycleRegistration,
  type SubagentLifecycleRegistrationEvidence,
} from "./ports/subagent-lifecycle.js";
import { HOOK_SUBAGENT_CONTINUATION_BUDGET } from "../domain/hook-runtime-limits.js";
import { BoundaryError, ErrorCodeRegistry } from "../domain/errors.js";

const OPERATION = "registerSubagentHookRuntime";

export type RegisteredSubagentHookRuntime = Readonly<{
  evidence: SubagentLifecycleRegistrationEvidence;
  dispose(): Promise<void>;
}>;

function adapterFailure(cause: unknown): BoundaryError {
  return new BoundaryError({
    code: ErrorCodeRegistry.adapterFailed,
    operation: OPERATION,
    message: "Subagent hook runtime registration failed",
    cause,
  });
}

function validInterceptor(value: unknown): value is SubagentLifecycleInterceptor {
  return value !== null && typeof value === "object" &&
    typeof (value as { readonly beforeStart?: unknown }).beforeStart === "function" &&
    typeof (value as { readonly beforeComplete?: unknown }).beforeComplete === "function";
}

function validLifecycle(value: unknown): value is SubagentLifecyclePort {
  return value !== null && typeof value === "object" &&
    typeof (value as { readonly capabilities?: unknown }).capabilities === "function" &&
    typeof (value as { readonly register?: unknown }).register === "function";
}

/**
 * Register exactly one aggregate Plugin Host interceptor against an already
 * qualified package-neutral lifecycle port. Compatibility qualification and
 * activation evidence must carry the same digest; registration success cannot
 * upgrade an unavailable capability fact.
 */
export async function registerSubagentHookRuntime(input: Readonly<{
  lifecycle: SubagentLifecyclePort;
  qualification: SubagentLifecycleCapabilities;
  coordinator: SubagentLifecycleInterceptor;
  runtimeSignal: AbortSignal;
  continuationBudget?: number;
}>): Promise<RegisteredSubagentHookRuntime> {
  if (
    input === null ||
    typeof input !== "object" ||
    !validLifecycle(input.lifecycle) ||
    !validInterceptor(input.coordinator) ||
    !(input.runtimeSignal instanceof AbortSignal)
  ) {
    throw new TypeError("subagent hook runtime registration dependencies are invalid");
  }
  const budget = input.continuationBudget ?? HOOK_SUBAGENT_CONTINUATION_BUDGET;
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new TypeError("subagent hook continuation budget must be positive");
  }
  input.runtimeSignal.throwIfAborted();

  let qualification: SubagentLifecycleCapabilities;
  try {
    qualification = SubagentLifecycleCapabilitiesSchemaV1.parse(input.qualification);
  } catch (cause) {
    throw adapterFailure(cause);
  }

  let rawRegistration: SubagentLifecycleRegistration | undefined;
  try {
    rawRegistration = await input.lifecycle.register({
      interceptor: input.coordinator,
      expectedQualificationDigest: qualification.qualificationDigest,
      maxContinuationRounds: budget,
    }, input.runtimeSignal);
  } catch (cause) {
    if (input.runtimeSignal.aborted) throw input.runtimeSignal.reason;
    throw adapterFailure(cause);
  }

  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    disposePromise ??= Promise.resolve().then(async () => {
      input.runtimeSignal.removeEventListener("abort", onRuntimeAbort);
      if (
        rawRegistration !== undefined &&
        typeof rawRegistration.dispose === "function"
      ) {
        await rawRegistration.dispose();
      }
    });
    return disposePromise;
  };
  const onRuntimeAbort = (): void => {
    void dispose();
  };
  input.runtimeSignal.addEventListener("abort", onRuntimeAbort, { once: true });

  let evidence: SubagentLifecycleRegistrationEvidence;
  try {
    if (
      rawRegistration === null ||
      typeof rawRegistration !== "object" ||
      typeof rawRegistration.dispose !== "function"
    ) {
      throw new TypeError("lifecycle registration handle is malformed");
    }
    evidence = SubagentLifecycleRegistrationEvidenceSchemaV1.parse(
      rawRegistration.evidence,
    );
    if (
      evidence.qualificationDigest !== qualification.qualificationDigest ||
      evidence.contractVersion !== qualification.contractVersion ||
      evidence.maxContinuationRounds !== budget
    ) {
      throw new TypeError("lifecycle activation evidence disagrees with qualification");
    }
    if (input.runtimeSignal.aborted) {
      await dispose();
      throw input.runtimeSignal.reason;
    }
  } catch (cause) {
    try {
      await dispose();
    } catch (cleanupCause) {
      if (input.runtimeSignal.aborted) throw input.runtimeSignal.reason;
      throw adapterFailure(cleanupCause);
    }
    if (input.runtimeSignal.aborted) throw input.runtimeSignal.reason;
    throw adapterFailure(cause);
  }

  return Object.freeze({ evidence, dispose });
}
