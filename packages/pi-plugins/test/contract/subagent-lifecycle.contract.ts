import { describe, expect, it } from "vitest";
import type {
  SubagentExecutionIdentity,
  SubagentExecutionPath,
  SubagentLifecycleInterceptor,
  SubagentLifecycleRegistration,
} from "../../src/application/ports/subagent-lifecycle.js";
import type {
  SubagentExecutionTrace,
  SubagentLifecycleContractHarness,
} from "../support/fakes/subagent-lifecycle.js";

let nextRun = 1;

export function lifecycleIdentity(
  overrides: Partial<SubagentExecutionIdentity> = {},
): SubagentExecutionIdentity {
  return {
    schemaVersion: 1,
    agentId: "agent-contract",
    sessionId: "child-session-contract",
    runId: `run-contract-${nextRun++}`,
    agentType: "implementor",
    parentSessionId: "parent-session-contract",
    ...overrides,
  };
}

export function lifecyclePath(
  overrides: Partial<SubagentExecutionPath> = {},
): SubagentExecutionPath {
  return {
    phase: "initial",
    origin: "tool",
    mode: "foreground",
    admission: "immediate",
    ...overrides,
  };
}

async function register(
  harness: SubagentLifecycleContractHarness,
  interceptor: SubagentLifecycleInterceptor,
): Promise<SubagentLifecycleRegistration> {
  const signal = new AbortController().signal;
  const qualification = await harness.lifecycle.capabilities(signal);
  return harness.lifecycle.register({
    interceptor,
    expectedQualificationDigest: qualification.qualificationDigest,
    maxContinuationRounds: 3,
  }, signal);
}

function firstIndex(trace: SubagentExecutionTrace, checkpoint: string): number {
  return trace.checkpoints.indexOf(checkpoint as never);
}

/** Shared package-independent behavior suite for every lifecycle adapter. */
export function defineSubagentLifecycleContract(
  name: string,
  create: () =>
    | SubagentLifecycleContractHarness
    | Promise<SubagentLifecycleContractHarness>,
): void {
  describe(`subagent lifecycle contract: ${name}`, () => {
    it("covers every execution path without changing no-interceptor order", async () => {
      const harness = await create();
      const variants = {
        phase: ["initial", "resume"],
        origin: ["tool", "service"],
        mode: ["foreground", "background"],
        admission: ["immediate", "queued"],
      } as const;
      for (const phase of variants.phase) {
        for (const origin of variants.origin) {
          for (const mode of variants.mode) {
            for (const admission of variants.admission) {
              const trace = await harness.execute({
                identity: lifecycleIdentity({
                  ...(origin === "service" ? { parentSessionId: undefined } : {}),
                }),
                execution: lifecyclePath({ phase, origin, mode, admission }),
                prompt: "EXACT_PROMPT_SECRET_CANARY",
                proposedResults: ["PROPOSED_RESULT_SECRET_CANARY"],
                signal: new AbortController().signal,
              });
              expect(trace.checkpoints).toEqual([
                "prompt",
                "proposed-result",
                "workspace-addendum",
                "status-update",
                "finalize",
                "completion-event",
                "history",
                "notification",
              ]);
              expect(trace.appliedDecisions).toEqual([]);
              expect(trace.terminal).toBe("completed");
              expect(JSON.stringify(trace)).not.toContain("SECRET_CANARY");
            }
          }
        }
      }
      await harness.shutdown();
    });

    it("runs both lifecycle interceptors on every declared execution path", async () => {
      const harness = await create();
      let starts = 0;
      let completions = 0;
      await register(harness, {
        beforeStart: async (request) => {
          starts += 1;
          return { action: "continue", prompt: request.prompt };
        },
        beforeComplete: async (request) => {
          completions += 1;
          return { action: "complete", result: request.proposedResult };
        },
      });
      const phases = ["initial", "resume"] as const;
      const origins = ["tool", "service"] as const;
      const modes = ["foreground", "background"] as const;
      const admissions = ["immediate", "queued"] as const;
      let executions = 0;
      for (const phase of phases) {
        for (const origin of origins) {
          for (const mode of modes) {
            for (const admission of admissions) {
              executions += 1;
              const trace = await harness.execute({
                identity: lifecycleIdentity({
                  ...(origin === "service" ? { parentSessionId: undefined } : {}),
                }),
                execution: lifecyclePath({ phase, origin, mode, admission }),
                prompt: "PATH_PROMPT_SECRET_CANARY",
                proposedResults: ["PATH_RESULT_SECRET_CANARY"],
                signal: new AbortController().signal,
              });
              expect(trace.checkpoints.filter((value) => value === "start-interceptor")).toHaveLength(1);
              expect(trace.checkpoints.filter((value) => value === "completion-interceptor")).toHaveLength(1);
              expect(traceContractViolations(trace, { requireInterceptors: true })).toEqual([]);
              expect(JSON.stringify(trace)).not.toContain("SECRET_CANARY");
            }
          }
        }
      }
      expect(starts).toBe(executions);
      expect(completions).toBe(executions);
      await harness.shutdown();
    });

    it("awaits interceptors in registration order and pipes replacements", async () => {
      const harness = await create();
      const seen: string[] = [];
      const callbackIdentities: unknown[] = [];
      await register(harness, {
        beforeStart: async (request) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          callbackIdentities.push(request.identity, request.execution);
          seen.push(`start-1:${request.prompt}`);
          return { action: "continue", prompt: `${request.prompt}:first` };
        },
        beforeComplete: async (request) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          callbackIdentities.push(request.identity, request.execution);
          seen.push(`complete-1:${request.proposedResult}`);
          return { action: "complete", result: `${request.proposedResult}:first` };
        },
      });
      await register(harness, {
        beforeStart: async (request) => {
          seen.push(`start-2:${request.prompt}`);
          return { action: "continue", prompt: `${request.prompt}:second` };
        },
        beforeComplete: async (request) => {
          seen.push(`complete-2:${request.proposedResult}`);
          return { action: "complete", result: `${request.proposedResult}:second` };
        },
      });

      const identity = lifecycleIdentity();
      const execution = lifecyclePath();
      const trace = await harness.execute({
        identity,
        execution,
        prompt: "prompt",
        proposedResults: ["result"],
        signal: new AbortController().signal,
      });
      expect(seen).toEqual([
        "start-1:prompt",
        "start-2:prompt:first",
        "complete-1:result",
        "complete-2:result:first",
      ]);
      expect(trace.checkpoints).toEqual([
        "start-interceptor",
        "start-interceptor",
        "prompt",
        "proposed-result",
        "completion-interceptor",
        "completion-interceptor",
        "workspace-addendum",
        "status-update",
        "finalize",
        "completion-event",
        "history",
        "notification",
      ]);
      expect(trace.appliedDecisions).toEqual([
        "start-prompt-replacement",
        "completion-result-replacement",
      ]);
      expect(callbackIdentities).toEqual([
        identity,
        execution,
        identity,
        execution,
      ]);
      expect(traceContractViolations(trace, {
        requireInterceptors: true,
        requireStartReplacement: true,
        requireCompletionReplacement: true,
        expectedIdentity: identity,
      })).toEqual([]);
      await harness.shutdown();
    });

    it("aborts start before prompt and propagates cancellation while awaiting start", async () => {
      const blocked = await create();
      await register(blocked, {
        beforeStart: async () => ({
          action: "abort",
          code: "hook-blocked",
          reason: "safe reason",
        }),
        beforeComplete: async (request) => ({ action: "complete", result: request.proposedResult }),
      });
      const blockedTrace = await blocked.execute({
        identity: lifecycleIdentity(),
        execution: lifecyclePath(),
        prompt: "secret prompt",
        proposedResults: ["secret result"],
        signal: new AbortController().signal,
      });
      expect(blockedTrace.terminal).toBe("aborted");
      expect(blockedTrace.checkpoints).toEqual(["start-interceptor"]);
      await blocked.shutdown();

      const cancelled = await create();
      let entered!: () => void;
      const didEnter = new Promise<void>((resolve) => { entered = resolve; });
      await register(cancelled, {
        beforeStart: async () => {
          entered();
          return new Promise(() => undefined);
        },
        beforeComplete: async (request) => ({ action: "complete", result: request.proposedResult }),
      });
      const controller = new AbortController();
      const reason = new Error("caller-owned cancellation");
      const execution = cancelled.execute({
        identity: lifecycleIdentity(),
        execution: lifecyclePath(),
        prompt: "secret prompt",
        proposedResults: ["secret result"],
        signal: controller.signal,
      });
      await didEnter;
      controller.abort(reason);
      await expect(execution).rejects.toBe(reason);
      await cancelled.shutdown();
    });

    it("intercepts completion before finalization and continues the same immutable run to the exact bound", async () => {
      const harness = await create();
      const identities: string[] = [];
      await register(harness, {
        beforeStart: async (request) => ({ action: "continue", prompt: request.prompt }),
        beforeComplete: async (request) => {
          identities.push(JSON.stringify({
            identity: request.identity,
            execution: request.execution,
            round: request.continuationRound,
          }));
          return { action: "continue", prompt: `round-${request.continuationRound}` };
        },
      });
      const trace = await harness.execute({
        identity: lifecycleIdentity(),
        execution: lifecyclePath({ phase: "resume", origin: "service", mode: "background", admission: "queued" }),
        prompt: "secret prompt",
        proposedResults: ["result-0", "result-1", "result-2", "result-3"],
        outcome: "steered",
        signal: new AbortController().signal,
      });

      expect(trace.terminal).toBe("aborted");
      expect(trace.continuationRounds).toBe(3);
      expect(trace.decisionKinds.at(-1)).toBe("completion:abort:continuation-limit");
      expect(trace.checkpoints.filter((value) => value === "continuation-prompt")).toHaveLength(3);
      expect(trace.appliedDecisions).toEqual([
        "same-session-continuation",
        "same-session-continuation",
        "same-session-continuation",
      ]);
      expect(trace.checkpoints).not.toContain("finalize");
      expect(trace.checkpoints).not.toContain("completion-event");
      expect(new Set(identities.map((value) => JSON.parse(value).identity.runId)).size).toBe(1);
      expect(identities.map((value) => JSON.parse(value).round)).toEqual([0, 1, 2, 3]);
      await harness.shutdown();
    });

    it("keeps disposal idempotent and unregister affects future snapshots only", async () => {
      const harness = await create();
      let secondCalls = 0;
      let second!: SubagentLifecycleRegistration;
      await register(harness, {
        beforeStart: async (request) => {
          await second.dispose();
          return { action: "continue", prompt: request.prompt };
        },
        beforeComplete: async (request) => ({ action: "complete", result: request.proposedResult }),
      });
      second = await register(harness, {
        beforeStart: async (request) => {
          secondCalls += 1;
          return { action: "continue", prompt: request.prompt };
        },
        beforeComplete: async (request) => {
          secondCalls += 1;
          return { action: "complete", result: request.proposedResult };
        },
      });

      const first = await harness.execute({
        identity: lifecycleIdentity(),
        execution: lifecyclePath(),
        prompt: "prompt",
        proposedResults: ["result"],
        signal: new AbortController().signal,
      });
      expect(first.checkpoints.filter((value) => value === "start-interceptor")).toHaveLength(2);
      expect(secondCalls).toBe(1);
      await second.dispose();
      expect(disposalContractViolations(0, harness.registrationDisposeCounts())).toEqual([]);
      expect(harness.registrationDisposeCounts()[1]).toBe(1);
      await harness.execute({
        identity: lifecycleIdentity(),
        execution: lifecyclePath(),
        prompt: "prompt",
        proposedResults: ["result"],
        signal: new AbortController().signal,
      });
      expect(secondCalls).toBe(1);
      await harness.shutdown();
    });

    it("rejects reused execution identity and disposes sessions exactly once", async () => {
      const harness = await create();
      const identity = lifecycleIdentity();
      const request = {
        identity,
        execution: lifecyclePath(),
        prompt: "secret prompt",
        proposedResults: ["secret result"],
        signal: new AbortController().signal,
      } as const;
      await harness.execute(request);
      await expect(harness.execute(request)).rejects.toThrow("run id was reused");
      await harness.disposeSession(identity.sessionId);
      await harness.disposeSession(identity.sessionId);
      expect(harness.sessionDisposeCount(identity.sessionId)).toBe(1);
      expect(disposalContractViolations(
        harness.sessionDisposeCount(identity.sessionId),
        harness.registrationDisposeCounts(),
      )).toEqual([]);
      await expect(harness.execute({
        ...request,
        identity: lifecycleIdentity({ sessionId: identity.sessionId }),
      })).rejects.toThrow("session was already disposed");
      await harness.shutdown();
    });

    it("never lets completion cancellation cross the finalization window", async () => {
      const harness = await create();
      let entered!: () => void;
      const didEnter = new Promise<void>((resolve) => { entered = resolve; });
      await register(harness, {
        beforeStart: async (request) => ({ action: "continue", prompt: request.prompt }),
        beforeComplete: async () => {
          entered();
          return new Promise(() => undefined);
        },
      });
      const controller = new AbortController();
      const reason = new Error("cancel completion");
      const execution = harness.execute({
        identity: lifecycleIdentity(),
        execution: lifecyclePath(),
        prompt: "secret prompt",
        proposedResults: ["secret result"],
        signal: controller.signal,
      });
      await didEnter;
      controller.abort(reason);
      await expect(execution).rejects.toBe(reason);
      await harness.shutdown();
    });
  });
}

type TraceContractExpectation = Readonly<{
  requireInterceptors?: boolean;
  requireStartReplacement?: boolean;
  requireCompletionReplacement?: boolean;
  expectedIdentity?: SubagentExecutionIdentity;
}>;

/** Receiver-side validators shared by the real suite and broken-harness evidence. */
export function traceContractViolations(
  trace: SubagentExecutionTrace,
  expectation: TraceContractExpectation = {},
): readonly string[] {
  const violations: string[] = [];
  const prompt = firstIndex(trace, "prompt");
  const start = firstIndex(trace, "start-interceptor");
  const completion = firstIndex(trace, "completion-interceptor");
  const firstFinalizationSideEffect = Math.min(
    ...[
      "workspace-addendum",
      "status-update",
      "finalize",
      "completion-event",
      "history",
      "notification",
    ].map((checkpoint) => firstIndex(trace, checkpoint)).filter((index) => index >= 0),
  );
  const finalize = firstIndex(trace, "finalize");
  const completionEvent = firstIndex(trace, "completion-event");
  if (start >= 0 && (prompt < 0 || start > prompt)) violations.push("start-after-prompt");
  if (completion >= 0 && Number.isFinite(firstFinalizationSideEffect) && completion > firstFinalizationSideEffect) {
    violations.push("completion-after-finalization-side-effect");
  }
  if (completionEvent >= 0 && finalize < 0) violations.push("event-without-finalize");
  if (trace.continuationRounds > 3) violations.push("unbounded-continuation");
  if (expectation.requireInterceptors === true && start < 0) violations.push("missing-start-interception");
  if (expectation.requireInterceptors === true && completion < 0) violations.push("missing-completion-interception");
  if (
    expectation.requireStartReplacement === true &&
    !trace.appliedDecisions.includes("start-prompt-replacement")
  ) violations.push("start-replacement-lost");
  if (
    expectation.requireCompletionReplacement === true &&
    !trace.appliedDecisions.includes("completion-result-replacement")
  ) violations.push("completion-replacement-lost");
  if (
    expectation.expectedIdentity !== undefined &&
    JSON.stringify(trace.identity) !== JSON.stringify(expectation.expectedIdentity)
  ) violations.push("identity-drift");
  return Object.freeze(violations);
}

export function disposalContractViolations(
  sessionDisposeCount: number,
  registrationDisposeCounts: readonly number[],
): readonly string[] {
  const violations: string[] = [];
  if (sessionDisposeCount > 1) violations.push("double-session-disposal");
  if (registrationDisposeCounts.some((count) => count > 1)) {
    violations.push("double-registration-disposal");
  }
  return Object.freeze(violations);
}
