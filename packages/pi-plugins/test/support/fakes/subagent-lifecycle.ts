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
  type SubagentCompletionDecision,
  type SubagentExecutionIdentity,
  type SubagentExecutionPath,
  type SubagentLifecycleCapabilities,
  type SubagentLifecycleInterceptor,
  type SubagentLifecyclePort,
  type SubagentLifecycleRegistration,
  type SubagentLifecycleRegistrationRequest,
  type SubagentStartDecision,
} from "../../../src/application/ports/subagent-lifecycle.js";
import { HOOK_SUBAGENT_CONTINUATION_BUDGET } from "../../../src/domain/hook-runtime-limits.js";

export type SubagentExecutionCheckpoint =
  | "start-interceptor"
  | "prompt"
  | "proposed-result"
  | "completion-interceptor"
  | "continuation-prompt"
  | "workspace-addendum"
  | "status-update"
  | "finalize"
  | "completion-event"
  | "history"
  | "notification";

export type SubagentAppliedDecision =
  | "start-prompt-replacement"
  | "completion-result-replacement"
  | "same-session-continuation";

export type SubagentExecutionTrace = Readonly<{
  identity: SubagentExecutionIdentity;
  execution: SubagentExecutionPath;
  checkpoints: readonly SubagentExecutionCheckpoint[];
  decisionKinds: readonly string[];
  appliedDecisions: readonly SubagentAppliedDecision[];
  terminal: "completed" | "aborted" | "cancelled";
  continuationRounds: number;
}>;

export interface SubagentLifecycleContractHarness {
  readonly lifecycle: SubagentLifecyclePort;
  execute(request: Readonly<{
    identity: SubagentExecutionIdentity;
    execution: SubagentExecutionPath;
    prompt: string;
    proposedResults: readonly string[];
    outcome?: "completed" | "steered" | "aborted";
    signal: AbortSignal;
  }>): Promise<SubagentExecutionTrace>;
  disposeSession(sessionId: string): Promise<void>;
  sessionDisposeCount(sessionId: string): number;
  registrationDisposeCounts(): readonly number[];
  shutdown(): Promise<void>;
}

export type FakeSubagentLifecycleOptions = Readonly<{
  maxContinuationRounds?: number;
  qualificationDigest?: `sha256:${string}`;
}>;

type RegistrationRecord = {
  readonly id: number;
  readonly interceptor: SubagentLifecycleInterceptor;
  disposed: boolean;
  disposeCount: number;
};

function testCapabilities(qualificationDigest: string): SubagentLifecycleCapabilities {
  const semantics = {
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
  const coverage = {
    tool: true,
    service: true,
    foreground: true,
    background: true,
    queued: true,
    initial: true,
    resume: true,
    parentIdentityWhenPresent: true,
  } as const;
  return SubagentLifecycleCapabilitiesSchemaV1.parse({
    schemaVersion: 1,
    capabilityId: SUBAGENT_LIFECYCLE_CAPABILITY_ID,
    contractVersion: SUBAGENT_LIFECYCLE_CONTRACT_VERSION,
    qualificationDigest,
    semantics,
    coverage,
    provider: {
      kind: "test",
      name: "deterministic-subagent-lifecycle",
      suiteVersion: SUBAGENT_LIFECYCLE_CONFORMANCE_SUITE_VERSION,
      suiteDigest: `sha256:${"e".repeat(64)}`,
    },
  });
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child, seen);
  Object.freeze(value);
  return value;
}

function cancellationReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function awaitWithSignal<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancellationReason(signal));
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(cancellationReason(signal));
    signal.addEventListener("abort", aborted, { once: true });
    void value.then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        if (signal.aborted) reject(cancellationReason(signal));
        else resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(signal.aborted ? cancellationReason(signal) : error);
      },
    );
  });
}

function isAbort(_error: unknown, signal: AbortSignal): boolean {
  // Only the composed execution/runtime signal owns cancellation. An adapter
  // callback that merely throws an AbortError is still an interceptor failure.
  return signal.aborted;
}

/**
 * A test-only turn-order machine. It intentionally owns no model, provider,
 * tool, queue, workspace, persistence, steering, or real child-session logic.
 */
export class FakeSubagentLifecycle implements SubagentLifecycleContractHarness {
  readonly lifecycle: SubagentLifecyclePort;
  private readonly qualification: SubagentLifecycleCapabilities;
  private readonly maxContinuationRounds: number;
  private readonly runtimeAbort = new AbortController();
  private readonly registrations: RegistrationRecord[] = [];
  private readonly seenRunIds = new Set<string>();
  private readonly disposedSessions = new Map<string, number>();
  private nextRegistrationId = 1;
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: FakeSubagentLifecycleOptions = {}) {
    const max = options.maxContinuationRounds ?? HOOK_SUBAGENT_CONTINUATION_BUDGET;
    if (!Number.isInteger(max) || max <= 0) {
      throw new TypeError("fake lifecycle continuation bound must be positive");
    }
    this.maxContinuationRounds = max;
    this.qualification = testCapabilities(
      options.qualificationDigest ?? `sha256:${"d".repeat(64)}`,
    );
    this.lifecycle = Object.freeze({
      capabilities: (signal: AbortSignal) => this.capabilities(signal),
      register: (
        request: SubagentLifecycleRegistrationRequest,
        signal: AbortSignal,
      ) => this.register(request, signal),
    });
  }

  private capabilities(signal: AbortSignal): Promise<SubagentLifecycleCapabilities> {
    signal.throwIfAborted();
    if (this.runtimeAbort.signal.aborted) {
      return Promise.reject(cancellationReason(this.runtimeAbort.signal));
    }
    return Promise.resolve(this.qualification);
  }

  private register(
    request: SubagentLifecycleRegistrationRequest,
    signal: AbortSignal,
  ): Promise<SubagentLifecycleRegistration> {
    signal.throwIfAborted();
    if (this.runtimeAbort.signal.aborted) {
      return Promise.reject(cancellationReason(this.runtimeAbort.signal));
    }
    if (
      request === null ||
      typeof request !== "object" ||
      request.interceptor === null ||
      typeof request.interceptor !== "object" ||
      typeof request.interceptor.beforeStart !== "function" ||
      typeof request.interceptor.beforeComplete !== "function" ||
      request.expectedQualificationDigest !== this.qualification.qualificationDigest ||
      request.maxContinuationRounds !== this.maxContinuationRounds
    ) {
      return Promise.reject(new Error("fake lifecycle registration rejected"));
    }
    const record: RegistrationRecord = {
      id: this.nextRegistrationId++,
      interceptor: request.interceptor,
      disposed: false,
      disposeCount: 0,
    };
    this.registrations.push(record);
    let disposal: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      disposal ??= Promise.resolve().then(() => {
        if (!record.disposed) {
          record.disposed = true;
          record.disposeCount += 1;
        }
      });
      return disposal;
    };
    return Promise.resolve(Object.freeze({
      evidence: SubagentLifecycleRegistrationEvidenceSchemaV1.parse({
        schemaVersion: 1,
        contractVersion: SUBAGENT_LIFECYCLE_CONTRACT_VERSION,
        capabilityId: SUBAGENT_LIFECYCLE_CAPABILITY_ID,
        qualificationDigest: this.qualification.qualificationDigest,
        orderedAsync: true,
        maxContinuationRounds: this.maxContinuationRounds,
        state: "registered",
      }),
      dispose,
    }));
  }

  async execute(request: Readonly<{
    identity: SubagentExecutionIdentity;
    execution: SubagentExecutionPath;
    prompt: string;
    proposedResults: readonly string[];
    outcome?: "completed" | "steered" | "aborted";
    signal: AbortSignal;
  }>): Promise<SubagentExecutionTrace> {
    const identity = SubagentExecutionIdentitySchemaV1.parse(request.identity);
    const execution = SubagentExecutionPathSchemaV1.parse(request.execution);
    if (typeof request.prompt !== "string" || request.proposedResults.length === 0) {
      throw new TypeError("fake lifecycle execution requires prompt and proposed result");
    }
    if (this.seenRunIds.has(identity.runId)) {
      throw new Error("subagent execution run id was reused");
    }
    if ((this.disposedSessions.get(identity.sessionId) ?? 0) > 0) {
      throw new Error("subagent session was already disposed");
    }
    this.seenRunIds.add(identity.runId);
    this.disposedSessions.set(identity.sessionId, 0);

    const signal = AbortSignal.any([request.signal, this.runtimeAbort.signal]);
    const checkpoints: SubagentExecutionCheckpoint[] = [];
    const decisionKinds: string[] = [];
    const appliedDecisions: SubagentAppliedDecision[] = [];
    let continuationRound = 0;

    const trace = (terminal: SubagentExecutionTrace["terminal"]): SubagentExecutionTrace =>
      freeze({
        identity,
        execution,
        checkpoints: [...checkpoints],
        decisionKinds: [...decisionKinds],
        appliedDecisions: [...appliedDecisions],
        terminal,
        continuationRounds: continuationRound,
      });

    try {
      signal.throwIfAborted();
      let prompt = request.prompt;
      const startSnapshot = this.registrations
        .filter((record) => !record.disposed)
        .map((record) => record.interceptor);
      for (const interceptor of startSnapshot) {
        checkpoints.push("start-interceptor");
        const decision: SubagentStartDecision = SubagentStartDecisionSchemaV1.parse(
          await awaitWithSignal(
            interceptor.beforeStart(Object.freeze({
              identity,
              execution,
              prompt,
              signal,
            })),
            signal,
          ),
        );
        decisionKinds.push(`start:${decision.action}`);
        if (decision.action === "abort") return trace("aborted");
        prompt = decision.prompt;
      }
      signal.throwIfAborted();
      if (prompt !== request.prompt) appliedDecisions.push("start-prompt-replacement");
      checkpoints.push("prompt");

      while (true) {
        signal.throwIfAborted();
        const proposedResult = request.proposedResults[continuationRound] ??
          request.proposedResults.at(-1)!;
        checkpoints.push("proposed-result");
        let result = proposedResult;
        let terminalDecision: SubagentCompletionDecision | undefined;
        const completionSnapshot = this.registrations
          .filter((record) => !record.disposed)
          .map((record) => record.interceptor);
        for (const interceptor of completionSnapshot) {
          checkpoints.push("completion-interceptor");
          const decision = SubagentCompletionDecisionSchemaV1.parse(
            await awaitWithSignal(
              interceptor.beforeComplete(Object.freeze({
                identity,
                execution,
                proposedResult: result,
                outcome: request.outcome ?? "completed",
                continuationRound,
                maxContinuationRounds: this.maxContinuationRounds,
                signal,
              })),
              signal,
            ),
          );
          decisionKinds.push(`completion:${decision.action}`);
          if (decision.action === "complete") result = decision.result;
          else {
            terminalDecision = decision;
            break;
          }
        }
        if (terminalDecision?.action === "abort") return trace("aborted");
        if (terminalDecision?.action === "continue") {
          if (continuationRound >= this.maxContinuationRounds) {
            decisionKinds.push("completion:abort:continuation-limit");
            return trace("aborted");
          }
          // The exact continuation prompt is callback-lifetime only. The trace
          // records that the same-session decision was applied, never its text.
          prompt = terminalDecision.prompt;
          void prompt;
          appliedDecisions.push("same-session-continuation");
          checkpoints.push("continuation-prompt");
          continuationRound += 1;
          continue;
        }
        signal.throwIfAborted();
        if (result !== proposedResult) {
          appliedDecisions.push("completion-result-replacement");
        }
        // `result` deliberately dies here. Trace evidence never retains it.
        void result;
        checkpoints.push("workspace-addendum");
        checkpoints.push("status-update");
        checkpoints.push("finalize");
        checkpoints.push("completion-event");
        checkpoints.push("history");
        checkpoints.push("notification");
        return trace("completed");
      }
    } catch (error) {
      if (isAbort(error, signal)) throw cancellationReason(signal);
      throw new Error("fake subagent lifecycle execution failed", { cause: error });
    }
  }

  disposeSession(sessionId: string): Promise<void> {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return Promise.reject(new TypeError("session id is required"));
    }
    if (!this.disposedSessions.has(sessionId)) {
      this.disposedSessions.set(sessionId, 1);
    } else if (this.disposedSessions.get(sessionId) === 0) {
      this.disposedSessions.set(sessionId, 1);
    }
    return Promise.resolve();
  }

  sessionDisposeCount(sessionId: string): number {
    return this.disposedSessions.get(sessionId) ?? 0;
  }

  registrationDisposeCounts(): readonly number[] {
    return this.registrations.map((record) => record.disposeCount);
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      if (!this.runtimeAbort.signal.aborted) {
        this.runtimeAbort.abort(new DOMException("Lifecycle runtime disposed", "AbortError"));
      }
      for (const registration of this.registrations) {
        if (!registration.disposed) {
          registration.disposed = true;
          registration.disposeCount += 1;
        }
      }
      for (const [sessionId, count] of this.disposedSessions) {
        if (count === 0) this.disposedSessions.set(sessionId, 1);
      }
    })();
    return this.shutdownPromise;
  }
}

export function createFakeSubagentLifecycle(
  options: FakeSubagentLifecycleOptions = {},
): FakeSubagentLifecycle {
  return new FakeSubagentLifecycle(options);
}
