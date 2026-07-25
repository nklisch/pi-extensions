import { Buffer } from "node:buffer";
import { describe, expect, expectTypeOf, it } from "vitest";
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
  type SubagentExecutionIdentity,
  type SubagentLifecycleCapabilities,
  type SubagentLifecyclePort,
} from "../../src/application/ports/subagent-lifecycle.js";

const digest = `sha256:${"a".repeat(64)}`;
const fullSemantics = {
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
const fullCoverage = {
  tool: true,
  service: true,
  foreground: true,
  background: true,
  queued: true,
  initial: true,
  resume: true,
  parentIdentityWhenPresent: true,
} as const;

export function publishedCapabilities(
  overrides: Partial<SubagentLifecycleCapabilities> = {},
): SubagentLifecycleCapabilities {
  return SubagentLifecycleCapabilitiesSchemaV1.parse({
    schemaVersion: 1,
    capabilityId: SUBAGENT_LIFECYCLE_CAPABILITY_ID,
    contractVersion: SUBAGENT_LIFECYCLE_CONTRACT_VERSION,
    qualificationDigest: digest,
    semantics: fullSemantics,
    coverage: fullCoverage,
    provider: {
      kind: "published-package",
      packageName: "@example/qualified-subagents",
      version: "1.2.3",
      integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}`,
      releaseTag: "qualified-subagents-v1.2.3",
      commit: "b".repeat(40),
      license: "MIT",
      nodeEngine: ">=24",
      piPeerRange: ">=0.80.0",
      contractVersion: SUBAGENT_LIFECYCLE_CONTRACT_VERSION,
      conformance: {
        suiteVersion: SUBAGENT_LIFECYCLE_CONFORMANCE_SUITE_VERSION,
        suiteDigest: `sha256:${"c".repeat(64)}`,
        qualificationDigest: digest,
        vectors: { ...fullSemantics, ...fullCoverage },
      },
    },
    ...overrides,
  });
}

export function testCapabilities(): SubagentLifecycleCapabilities {
  return SubagentLifecycleCapabilitiesSchemaV1.parse({
    schemaVersion: 1,
    capabilityId: SUBAGENT_LIFECYCLE_CAPABILITY_ID,
    contractVersion: SUBAGENT_LIFECYCLE_CONTRACT_VERSION,
    qualificationDigest: `sha256:${"d".repeat(64)}`,
    semantics: fullSemantics,
    coverage: fullCoverage,
    provider: {
      kind: "test",
      name: "deterministic-lifecycle-fake",
      suiteVersion: SUBAGENT_LIFECYCLE_CONFORMANCE_SUITE_VERSION,
      suiteDigest: `sha256:${"e".repeat(64)}`,
    },
  });
}

describe("subagent lifecycle public contract", () => {
  it("strictly parses and freezes exact identity and execution evidence", () => {
    const identity = SubagentExecutionIdentitySchemaV1.parse({
      schemaVersion: 1,
      agentId: "agent-1",
      sessionId: "child-session-1",
      runId: "run-initial-1",
      agentType: "implementor",
      parentSessionId: "parent-session-1",
    });
    const execution = SubagentExecutionPathSchemaV1.parse({
      phase: "initial",
      origin: "tool",
      mode: "foreground",
      admission: "immediate",
    });

    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(execution)).toBe(true);
    expect(() => SubagentExecutionIdentitySchemaV1.parse({ ...identity, extra: true })).toThrow();
    expect(() => SubagentExecutionPathSchemaV1.parse({ ...execution, phase: "retry" })).toThrow();
    expectTypeOf<SubagentExecutionIdentity>().toEqualTypeOf<
      typeof identity
    >();
  });

  it("rejects extra or incomplete decisions and registration evidence", () => {
    expect(SubagentStartDecisionSchemaV1.parse({ action: "continue", prompt: "exact" }))
      .toEqual({ action: "continue", prompt: "exact" });
    expect(SubagentCompletionDecisionSchemaV1.parse({ action: "continue", prompt: "same session" }))
      .toEqual({ action: "continue", prompt: "same session" });
    expect(() => SubagentStartDecisionSchemaV1.parse({ action: "continue", prompt: "x", result: "leak" })).toThrow();
    expect(() => SubagentCompletionDecisionSchemaV1.parse({ action: "abort", code: "other", reason: "x" })).toThrow();
    expect(() => SubagentLifecycleRegistrationEvidenceSchemaV1.parse({
      schemaVersion: 1,
      contractVersion: 1,
      capabilityId: SUBAGENT_LIFECYCLE_CAPABILITY_ID,
      qualificationDigest: digest,
      orderedAsync: true,
      maxContinuationRounds: 3,
      state: "registered",
      packagePath: "/secret/package",
    })).toThrow();
  });

  it("accepts complete test and published receipts but rejects missing vectors and digest disagreement", () => {
    expect(testCapabilities().provider.kind).toBe("test");
    expect(publishedCapabilities().provider.kind).toBe("published-package");

    const complete = publishedCapabilities();
    expect(() => SubagentLifecycleCapabilitiesSchemaV1.parse({
      ...complete,
      semantics: { ...complete.semantics, orderedAsync: undefined },
    })).toThrow();
    expect(() => SubagentLifecycleCapabilitiesSchemaV1.parse({
      ...complete,
      provider: {
        ...complete.provider,
        conformance: {
          ...(complete.provider.kind === "published-package" ? complete.provider.conformance : {}),
          qualificationDigest: `sha256:${"f".repeat(64)}`,
        },
      },
    })).toThrow();
  });

  it("keeps callback-only requests out of serializable capability evidence", () => {
    const evidence = `${JSON.stringify(publishedCapabilities())}${JSON.stringify(testCapabilities())}`;
    expect(evidence).not.toContain("EXACT_PROMPT_SECRET_CANARY");
    expect(evidence).not.toContain("PROPOSED_RESULT_SECRET_CANARY");
    expectTypeOf<SubagentLifecyclePort>().toMatchTypeOf<{
      capabilities: Function;
      register: Function;
    }>();
  });
});
