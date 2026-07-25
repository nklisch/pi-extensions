import { z } from "zod";
import {
  ContentDigestSchema,
  type ContentDigest,
} from "../../domain/content-manifest.js";
import { NpmIntegritySchema } from "../../domain/source.js";

export const SUBAGENT_LIFECYCLE_CAPABILITY_ID =
  "pi.subagents.lifecycle-interception" as const;
export const SUBAGENT_LIFECYCLE_CONTRACT_VERSION = 1 as const;
export const SUBAGENT_LIFECYCLE_CONFORMANCE_SUITE_VERSION = 1 as const;

export const SubagentExecutionIdentitySchemaV1 = z
  .object({
    schemaVersion: z.literal(1),
    agentId: z.string().min(1),
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    agentType: z.string().min(1),
    parentSessionId: z.string().min(1).optional(),
  })
  .strict()
  .readonly();
export type SubagentExecutionIdentity = z.infer<
  typeof SubagentExecutionIdentitySchemaV1
>;

export const SubagentExecutionPathSchemaV1 = z
  .object({
    phase: z.enum(["initial", "resume"]),
    origin: z.enum(["tool", "service"]),
    mode: z.enum(["foreground", "background"]),
    admission: z.enum(["immediate", "queued"]),
  })
  .strict()
  .readonly();
export type SubagentExecutionPath = z.infer<
  typeof SubagentExecutionPathSchemaV1
>;

export type SubagentStartRequest = Readonly<{
  identity: SubagentExecutionIdentity;
  execution: SubagentExecutionPath;
  /** Exact next value for the child session prompt call. */
  prompt: string;
  signal: AbortSignal;
}>;

export const SubagentStartDecisionSchemaV1 = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("continue"), prompt: z.string() })
    .strict()
    .readonly(),
  z
    .object({
      action: z.literal("abort"),
      code: z.enum(["hook-blocked", "hook-failed", "runtime-disposed"]),
      reason: z.string().min(1),
    })
    .strict()
    .readonly(),
]);
export type SubagentStartDecision = z.infer<
  typeof SubagentStartDecisionSchemaV1
>;

export type SubagentCompletionOutcome = "completed" | "steered" | "aborted";
export type SubagentCompletionRequest = Readonly<{
  identity: SubagentExecutionIdentity;
  execution: SubagentExecutionPath;
  /** Callback-lifetime candidate, before every finalization side effect. */
  proposedResult: string;
  outcome: SubagentCompletionOutcome;
  continuationRound: number;
  maxContinuationRounds: number;
  signal: AbortSignal;
}>;

export const SubagentCompletionDecisionSchemaV1 = z.discriminatedUnion(
  "action",
  [
    z
      .object({ action: z.literal("complete"), result: z.string() })
      .strict()
      .readonly(),
    z
      .object({ action: z.literal("continue"), prompt: z.string().min(1) })
      .strict()
      .readonly(),
    z
      .object({
        action: z.literal("abort"),
        code: z.enum([
          "hook-blocked",
          "hook-failed",
          "continuation-limit",
          "runtime-disposed",
        ]),
        reason: z.string().min(1),
      })
      .strict()
      .readonly(),
  ],
);
export type SubagentCompletionDecision = z.infer<
  typeof SubagentCompletionDecisionSchemaV1
>;

export const SubagentLifecycleSemanticsSchemaV1 = z
  .object({
    orderedAsync: z.boolean(),
    exactStartPrompt: z.boolean(),
    startReplacement: z.boolean(),
    startAbortBeforePrompt: z.boolean(),
    executionCancellation: z.boolean(),
    proposedResultBeforeFinalization: z.boolean(),
    resultReplacement: z.boolean(),
    sameSessionContinuation: z.boolean(),
    boundedContinuation: z.boolean(),
    typedFailureOrdering: z.boolean(),
    idempotentUnregister: z.boolean(),
    disposeExactlyOnce: z.boolean(),
    unchangedWithoutInterceptors: z.boolean(),
  })
  .strict()
  .readonly();
export type SubagentLifecycleSemantics = z.infer<
  typeof SubagentLifecycleSemanticsSchemaV1
>;

export const SubagentLifecycleCoverageSchemaV1 = z
  .object({
    tool: z.boolean(),
    service: z.boolean(),
    foreground: z.boolean(),
    background: z.boolean(),
    queued: z.boolean(),
    initial: z.boolean(),
    resume: z.boolean(),
    parentIdentityWhenPresent: z.boolean(),
  })
  .strict()
  .readonly();
export type SubagentLifecycleCoverage = z.infer<
  typeof SubagentLifecycleCoverageSchemaV1
>;

const requiredConformanceVectors = {
  orderedAsync: z.literal(true),
  exactStartPrompt: z.literal(true),
  startReplacement: z.literal(true),
  startAbortBeforePrompt: z.literal(true),
  executionCancellation: z.literal(true),
  proposedResultBeforeFinalization: z.literal(true),
  resultReplacement: z.literal(true),
  sameSessionContinuation: z.literal(true),
  boundedContinuation: z.literal(true),
  typedFailureOrdering: z.literal(true),
  idempotentUnregister: z.literal(true),
  disposeExactlyOnce: z.literal(true),
  unchangedWithoutInterceptors: z.literal(true),
  tool: z.literal(true),
  service: z.literal(true),
  foreground: z.literal(true),
  background: z.literal(true),
  queued: z.literal(true),
  initial: z.literal(true),
  resume: z.literal(true),
  parentIdentityWhenPresent: z.literal(true),
} as const;

export const SubagentLifecycleConformanceReceiptSchemaV1 = z
  .object({
    suiteVersion: z.literal(SUBAGENT_LIFECYCLE_CONFORMANCE_SUITE_VERSION),
    suiteDigest: ContentDigestSchema,
    /** Digest of the exact package metadata and complete behavioral receipt. */
    qualificationDigest: ContentDigestSchema,
    vectors: z.object(requiredConformanceVectors).strict().readonly(),
  })
  .strict()
  .readonly();
export type SubagentLifecycleConformanceReceipt = z.infer<
  typeof SubagentLifecycleConformanceReceiptSchemaV1
>;

const TestLifecycleProviderSchemaV1 = z
  .object({
    kind: z.literal("test"),
    name: z.string().min(1),
    suiteVersion: z.literal(SUBAGENT_LIFECYCLE_CONFORMANCE_SUITE_VERSION),
    suiteDigest: ContentDigestSchema,
  })
  .strict()
  .readonly();

const PublishedPackageLifecycleProviderSchemaV1 = z
  .object({
    kind: z.literal("published-package"),
    packageName: z
      .string()
      .min(1)
      .regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/),
    version: z
      .string()
      .regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
    integrity: NpmIntegritySchema,
    releaseTag: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    license: z.literal("MIT"),
    nodeEngine: z.string().min(1),
    piPeerRange: z.string().min(1),
    contractVersion: z.literal(SUBAGENT_LIFECYCLE_CONTRACT_VERSION),
    conformance: SubagentLifecycleConformanceReceiptSchemaV1,
  })
  .strict()
  .readonly();

export const SubagentLifecycleProviderSchemaV1 = z.discriminatedUnion("kind", [
  TestLifecycleProviderSchemaV1,
  PublishedPackageLifecycleProviderSchemaV1,
]);
export type SubagentLifecycleProvider = z.infer<
  typeof SubagentLifecycleProviderSchemaV1
>;

export const SubagentLifecycleCapabilitiesSchemaV1 = z
  .object({
    schemaVersion: z.literal(1),
    capabilityId: z.literal(SUBAGENT_LIFECYCLE_CAPABILITY_ID),
    contractVersion: z.literal(SUBAGENT_LIFECYCLE_CONTRACT_VERSION),
    qualificationDigest: ContentDigestSchema,
    semantics: SubagentLifecycleSemanticsSchemaV1,
    coverage: SubagentLifecycleCoverageSchemaV1,
    provider: SubagentLifecycleProviderSchemaV1,
  })
  .strict()
  .readonly()
  .superRefine((capabilities, context) => {
    if (
      capabilities.provider.kind === "published-package" &&
      capabilities.provider.conformance.qualificationDigest !==
        capabilities.qualificationDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["qualificationDigest"],
        message: "qualification digest does not match the conformance receipt",
      });
    }
  });
export type SubagentLifecycleCapabilities = z.infer<
  typeof SubagentLifecycleCapabilitiesSchemaV1
>;

export const SubagentLifecycleRegistrationEvidenceSchemaV1 = z
  .object({
    schemaVersion: z.literal(1),
    contractVersion: z.literal(SUBAGENT_LIFECYCLE_CONTRACT_VERSION),
    capabilityId: z.literal(SUBAGENT_LIFECYCLE_CAPABILITY_ID),
    qualificationDigest: ContentDigestSchema,
    orderedAsync: z.literal(true),
    maxContinuationRounds: z.number().int().positive(),
    state: z.literal("registered"),
  })
  .strict()
  .readonly();
export type SubagentLifecycleRegistrationEvidence = z.infer<
  typeof SubagentLifecycleRegistrationEvidenceSchemaV1
>;

export interface SubagentLifecycleInterceptor {
  beforeStart(request: SubagentStartRequest): Promise<SubagentStartDecision>;
  beforeComplete(
    request: SubagentCompletionRequest,
  ): Promise<SubagentCompletionDecision>;
}

export type SubagentLifecycleRegistrationRequest = Readonly<{
  interceptor: SubagentLifecycleInterceptor;
  expectedQualificationDigest: ContentDigest;
  maxContinuationRounds: number;
}>;

export interface SubagentLifecycleRegistration {
  readonly evidence: SubagentLifecycleRegistrationEvidence;
  /** Idempotent; an in-flight callback may finish unless its signal aborts. */
  dispose(): Promise<void>;
}

/** Package-neutral lifecycle boundary. Concrete package types terminate at adapters. */
export interface SubagentLifecyclePort {
  capabilities(signal: AbortSignal): Promise<SubagentLifecycleCapabilities>;
  register(
    request: SubagentLifecycleRegistrationRequest,
    signal: AbortSignal,
  ): Promise<SubagentLifecycleRegistration>;
}
