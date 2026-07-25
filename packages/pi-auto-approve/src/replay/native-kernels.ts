import { requireNativeEngine } from "../native/loader.ts";
import type {
  EffectivePolicy,
  NativePolicyHandle,
  PolicyRule,
} from "../policy/core.ts";
import { createNativePolicyHandle } from "../policy/core.ts";
import type { CorpusQueryModel } from "./corpus-query.ts";
import type { ReplayCorpus } from "./history.ts";
import type {
  AdversarialCase,
  AdversarialValidationReport,
  ReplayDelta,
  StructuredRatchetProposal,
} from "./proposal-schema.ts";

/** Options understood by the native replay kernels. */
export interface NativeReplayKernelOptions {
  readonly unknownToolPosture?: "allow" | "deny" | "review";
  readonly includeFullShape?: boolean;
  readonly pathFacts?: unknown;
  readonly pathFactsEnriched?: boolean;
  readonly sampleLimit?: number;
  readonly changedRecordLimit?: number;
  readonly maxCases?: number;
  readonly sampleCommands?: readonly string[];
  readonly cases?: readonly AdversarialCase[];
  readonly blockRuleIds?: {
    readonly floor?: readonly string[];
    readonly activeDeny?: readonly string[];
  };
}

/** Convert the acquisition-layer Map into the JSON boundary contract. */
export function serializeReplayCorpus(corpus: ReplayCorpus): unknown {
  if (corpus === null || typeof corpus !== "object") {
    return corpus;
  }
  const value = corpus as unknown as Record<string, unknown>;
  const sourceSummary = value.sourceSummary;
  return {
    ...value,
    ...(sourceSummary instanceof Map
      ? {
          sourceSummary: [...sourceSummary.entries()].map(([label, calls]) => ({
            label,
            calls,
          })),
        }
      : {}),
  };
}

export function buildNativeCorpusModel(input: {
  readonly corpus: ReplayCorpus;
  readonly policy: EffectivePolicy;
  readonly options?: NativeReplayKernelOptions;
  readonly nativePolicy?: NativePolicyHandle;
}): CorpusQueryModel {
  return withPolicyHandle(input.policy, input.nativePolicy, (handle) => {
    const model = requireNativeEngine().buildCorpusModel(
      serializeReplayCorpus(input.corpus),
      handle.handle,
      nativeOptions(input.options),
    ) as CorpusQueryModel & {
      readonly summary: CorpusQueryModel["summary"] & {
        readonly modelReviewCalls?: number;
        readonly modelReviewUniqueCommands?: number;
      };
    };
    const summary = model.summary;
    return {
      ...model,
      summary: {
        ...summary,
        modelReviewLoad: {
          calls:
            summary.modelReviewLoad?.calls ?? summary.modelReviewCalls ?? 0,
          uniqueCommands:
            summary.modelReviewLoad?.uniqueCommands ??
            summary.modelReviewUniqueCommands ??
            0,
        },
      },
    } as CorpusQueryModel;
  });
}

export function buildNativeReplayDelta(input: {
  readonly corpus: ReplayCorpus;
  readonly baselinePolicy: EffectivePolicy;
  readonly candidatePolicy: EffectivePolicy;
  readonly options?: NativeReplayKernelOptions;
}): ReplayDelta {
  const baseline = createNativePolicyHandle(input.baselinePolicy);
  const candidate = createNativePolicyHandle(input.candidatePolicy);
  try {
    const options = input.options;
    const floor = input.candidatePolicy.floor ?? [];
    const active =
      input.candidatePolicy.active ?? input.candidatePolicy.rules ?? [];
    return requireNativeEngine().replayDelta(
      serializeReplayCorpus(input.corpus),
      baseline.handle,
      candidate.handle,
      nativeOptions({
        ...options,
        pathFactsEnriched:
          options?.pathFacts !== undefined &&
          (options.pathFacts as { readonly candidate?: unknown }).candidate !==
            undefined,
        blockRuleIds: {
          floor: floor.map((rule) => rule.id),
          activeDeny: active
            .filter((rule) => rule.effect === "deny")
            .map((rule) => rule.id),
        },
      }),
    ) as ReplayDelta;
  } finally {
    baseline.free();
    candidate.free();
  }
}

export function buildNativeAdversarialReport(input: {
  readonly proposal: StructuredRatchetProposal;
  readonly baselinePolicy: EffectivePolicy;
  readonly candidatePolicy?: EffectivePolicy;
  readonly options?: NativeReplayKernelOptions;
}): AdversarialValidationReport {
  const baseline = createNativePolicyHandle(input.baselinePolicy);
  const candidate =
    input.candidatePolicy === undefined
      ? undefined
      : createNativePolicyHandle(input.candidatePolicy);
  try {
    return requireNativeEngine().adversarialValidate(
      input.proposal,
      baseline.handle,
      candidate?.handle,
      nativeOptions(input.options),
    ) as AdversarialValidationReport;
  } finally {
    baseline.free();
    candidate?.free();
  }
}

/** Native generation is exposed through adversarialValidate's pure generator. */
export function generateNativeAdversarialCases(input: {
  readonly proposal: StructuredRatchetProposal;
  readonly sampleCommands?: readonly string[];
  readonly maxCases?: number;
}): readonly AdversarialCase[] {
  const handle = createNativePolicyHandle({});
  try {
    const report = requireNativeEngine().adversarialValidate(
      input.proposal,
      handle.handle,
      undefined,
      nativeOptions({
        ...(input.sampleCommands === undefined
          ? {}
          : { sampleCommands: input.sampleCommands }),
        ...(input.maxCases === undefined ? {} : { maxCases: input.maxCases }),
      }),
    ) as AdversarialValidationReport;
    return report.cases;
  } finally {
    handle.free();
  }
}

function nativeOptions(
  options: NativeReplayKernelOptions | undefined,
): unknown {
  if (options === undefined) return {};
  return {
    ...options,
    ...(options.pathFacts === undefined
      ? {}
      : { pathFacts: options.pathFacts }),
    ...(options.cases === undefined ? {} : { cases: options.cases }),
  };
}

function withPolicyHandle<T>(
  policy: EffectivePolicy,
  existing: NativePolicyHandle | undefined,
  fn: (handle: NativePolicyHandle) => T,
): T {
  if (existing !== undefined) return fn(existing);
  const handle = createNativePolicyHandle(policy);
  try {
    return fn(handle);
  } finally {
    handle.free();
  }
}

/** Rule-id helper retained here so native callers do not inspect policy internals. */
export function policyRuleIds(
  rules: readonly PolicyRule[] | undefined,
): readonly string[] {
  return rules?.map((rule) => rule.id) ?? [];
}
