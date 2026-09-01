/**
 * The authoritative subagent record and its run leases.
 *
 * A record remains active until the current lease's settlement promise resolves.
 * In particular, requesting a stop never fabricates terminal state while child
 * code, teardown, or an admission callback can still mutate the workspace.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { debugLog, runDetached, runSafely } from "#src/debug";
import type { AdmissionHandle } from "#src/lifecycle/concurrency-limiter";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import type {
  LifecycleInterceptorRegistry,
  SubagentLifecycleExecutionPath,
  SubagentTurnLifecycle,
} from "#src/lifecycle/lifecycle-interceptor";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { RunListeners } from "#src/lifecycle/run-listeners";
import type { SubagentSession, TurnLoopResult } from "#src/lifecycle/subagent-session";
import { SubagentState, type SubagentStatus, type SubagentStopReason, type SubagentTerminalReason } from "#src/lifecycle/subagent-state";
import type { LifetimeUsage } from "#src/lifecycle/usage";
import type { WorkspaceProvider } from "#src/lifecycle/workspace";
import { WorkspaceBracket } from "#src/lifecycle/workspace-bracket";
import { subscribeSubagentObserver } from "#src/observation/record-observer";
import type { RunConfig } from "#src/runtime";
import { formatModelLabel } from "#src/session/model-label";
import { resolveEffectiveThinkingLevel } from "#src/session/thinking-level";
import type { AgentInvocation, CompactionInfo, ParentSessionInfo, SessionMessage, SubagentMode, SubagentType, ThinkingLevel } from "#src/types";

export interface SubagentLifecycleObserver {
  onStarted?(agent: Subagent): void;
  onSessionCreated?(agent: Subagent): void;
  onRunFinished?(agent: Subagent): void;
  onResumedStarted?(agent: Subagent): void;
  onResumedFinished?(agent: Subagent): void;
  onCompacted?(agent: Subagent, info: CompactionInfo): void;
}

export type SteerOutcome =
  | { kind: "delivered"; runId: number }
  | { kind: "buffered"; runId: number }
  | { kind: "rejected"; runId: number; status: SubagentStatus };

export interface SubagentExecution {
  createSubagentSession: (params: CreateSubagentSessionParams) => Promise<SubagentSession>;
  snapshot: ParentSnapshot;
  prompt: string;
  baseCwd: string;
  mode: SubagentMode;
  timeoutSeconds?: number;
  observer?: SubagentLifecycleObserver;
  getRunConfig?: () => RunConfig;
  getWorkspaceProvider?: () => WorkspaceProvider | undefined;
  model?: Model<any>;
  maxTurns?: number;
  thinkingLevel?: ThinkingLevel;
  parentSession?: ParentSessionInfo;
  lifecycleParentSession?: ParentSessionInfo;
  signal?: AbortSignal;
  lifecycleInterceptors?: LifecycleInterceptorRegistry;
  executionPath?: Omit<SubagentLifecycleExecutionPath, "phase" | "mode"> & { admission?: "immediate" | "queued" };
}

export interface SubagentInit {
  id: string;
  type: SubagentType;
  description: string;
  invocation?: AgentInvocation;
  execution: SubagentExecution;
  state?: SubagentState;
}

interface RunLease {
  readonly runId: number;
  readonly phase: "initial" | "resume";
  readonly mode: SubagentMode;
  readonly prompt: string;
  readonly timeoutSeconds?: number;
  readonly executionController: AbortController;
  readonly settlement: Promise<void>;
  readonly resolveSettlement: () => void;
  admission?: AdmissionHandle;
  admitted: boolean;
  settled: boolean;
  admissionPath: "immediate" | "queued";
  startedAt?: number;
  runtimeTimer?: ReturnType<typeof setTimeout>;
  parentSignalCleanup?: () => void;
  stopRequest?: SubagentStopReason;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

export class Subagent {
  readonly id: string;
  readonly type: SubagentType;
  readonly description: string;
  readonly invocation?: AgentInvocation;

  private readonly state: SubagentState;
  private readonly execution: SubagentExecution;
  private readonly listeners = new RunListeners();
  private readonly workspaceBracket: WorkspaceBracket;
  private currentLease: RunLease;
  private nextRunId = 1;
  private _modelLabel: string;
  private _effectiveThinkingLevel: ThinkingLevel;
  private _sessionReleased = false;
  private releasedOutputFile?: string;
  private pendingResumeAbort?: AbortController;
  private pendingSteers: string[] = [];
  private readonly recordUpdateListeners = new Set<() => void>();
  private runtimeMs = 0;

  subagentSession?: SubagentSession;

  get status(): SubagentStatus { return this.state.status; }
  get result(): string | undefined { return this.state.result; }
  get error(): string | undefined { return this.state.error; }
  get startedAt(): number { return this.state.startedAt; }
  get completedAt(): number | undefined { return this.state.completedAt; }
  get consumedAt(): number | undefined { return this.state.consumedAt; }
  get consumed(): boolean { return this.state.consumed; }
  get toolUses(): number { return this.state.toolUses; }
  get lifetimeUsage(): Readonly<LifetimeUsage> { return this.state.lifetimeUsage; }
  get compactionCount(): number { return this.state.compactionCount; }
  get turnCount(): number { return this.state.turnCount; }
  get activeTools(): ReadonlyMap<string, string> { return this.state.activeTools; }
  get responseText(): string { return this.state.responseText; }
  get maxTurns(): number | undefined { return this.execution.maxTurns; }
  get modelLabel(): string { return this._modelLabel; }
  get effectiveThinkingLevel(): ThinkingLevel { return this._effectiveThinkingLevel; }
  get runId(): number { return this.currentLease.runId; }
  get mode(): SubagentMode { return this.currentLease.mode; }
  get stopRequested(): boolean { return this.currentLease.stopRequest !== undefined; }
  get stopReason(): SubagentStopReason | undefined { return this.currentLease.stopRequest; }
  get stateTerminalReason(): SubagentTerminalReason | undefined { return this.state.terminalReason; }
  get activeRuntimeMs(): number {
    if (this.currentLease.admitted && !this.currentLease.settled && this.currentLease.startedAt != null) {
      return Date.now() - this.currentLease.startedAt;
    }
    return this.currentLease.settled ? this.runtimeMs : 0;
  }
  get sessionReleased(): boolean { return this._sessionReleased; }
  get pendingSteerCount(): number { return this.pendingSteers.length; }
  get outputFile(): string | undefined { return this.subagentSession?.outputFile ?? this.releasedOutputFile; }
  get toolCallId(): string | undefined { return this.execution.parentSession?.toolCallId; }
  get settlement(): Promise<void> { return this.currentLease.settlement; }
  get isSettled(): boolean { return this.currentLease.settled; }

  constructor(init: SubagentInit) {
    this.id = init.id;
    this.type = init.type;
    this.description = init.description;
    this.invocation = init.invocation;
    this.state = init.state ?? new SubagentState();
    this.execution = init.execution;
    this._modelLabel = formatModelLabel(this.execution.model ?? this.execution.snapshot.model);
    this._effectiveThinkingLevel = resolveEffectiveThinkingLevel(
      this.execution.model ?? this.execution.snapshot.model,
      this.execution.thinkingLevel,
      this.execution.snapshot.thinkingLevel,
    );
    this.workspaceBracket = new WorkspaceBracket(this.execution.getWorkspaceProvider ?? (() => undefined));
    this.currentLease = this.createLease(1, "initial", this.execution.mode, this.execution.prompt, this.execution.timeoutSeconds);
    // A terminal state can be supplied when a record is reconstructed for a
    // read-only projection (for example, a service or renderer test). Keep
    // the lease invariant aligned with that state instead of claiming that a
    // terminal record still has work in flight. Manager-created records start
    // queued and take the normal admission path below.
    if (this.state.status === "completed" || this.state.status === "stopped" || this.state.status === "error") {
      this.currentLease.settled = true;
      this.currentLease.resolveSettlement();
    } else if (this.state.status === "running") {
      this.currentLease.admitted = true;
      this.currentLease.startedAt = this.state.startedAt;
    }
  }

  isSessionReady(): boolean { return this.subagentSession != null; }
  isActive(): boolean { return !this.currentLease.settled; }
  isRunning(): boolean { return this.currentLease.admitted && !this.currentLease.settled; }

  /** Schedule this lease through the one shared FIFO limiter. */
  scheduleVia(schedule: (task: () => Promise<void>) => AdmissionHandle): AdmissionHandle {
    const lease = this.currentLease;
    const handle = schedule(() => this.admitAndRun(lease));
    lease.admission = handle;
    if (lease.stopRequest && !handle.admitted) handle.cancel();
    return handle;
  }

  /** Arm cancellation before admission; detached callers intentionally pass no signal. */
  armParentSignal(signal: AbortSignal | undefined): void {
    if (!signal) return;
    const lease = this.currentLease;
    const onAbort = (): void => { this.requestStop("parent_cancelled"); };
    signal.addEventListener("abort", onAbort, { once: true });
    lease.parentSignalCleanup = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  }

  async steer(message: string): Promise<SteerOutcome> {
    const lease = this.currentLease;
    if (!this.isRunning() || lease.stopRequest) return { kind: "rejected", runId: lease.runId, status: this.status };
    if (!this.subagentSession) {
      this.pendingSteers.push(message);
      return { kind: "buffered", runId: lease.runId };
    }
    await this.subagentSession.steer(message);
    return { kind: "delivered", runId: lease.runId };
  }

  getConversation(): string | undefined { return this.subagentSession?.getConversation(); }
  getContextPercent(): number | null { return this.subagentSession?.getContextPercent() ?? null; }
  subscribeToUpdates(fn: (event: AgentSessionEvent) => void): (() => void) | undefined { return this.subagentSession?.subscribe(fn); }
  /** Read-only lifecycle notification for adapters that bridge retention release. */
  subscribeToRecordUpdates(fn: () => void): () => void {
    this.recordUpdateListeners.add(fn);
    return () => { this.recordUpdateListeners.delete(fn); };
  }
  get messages(): readonly unknown[] { return this.subagentSession?.messages ?? []; }
  get agentMessages(): readonly SessionMessage[] { return this.subagentSession?.agentMessages ?? []; }
  getToolDefinition(name: string): ToolDefinition | undefined { return this.subagentSession?.getToolDefinition(name); }

  /** Request cooperative cancellation. The first reason owns this lease. */
  requestStop(reason: SubagentStopReason): boolean {
    const lease = this.currentLease;
    if (lease.settled) return false;
    lease.stopRequest ??= reason;
    lease.executionController.abort(lease.stopRequest);
    this.pendingResumeAbort?.abort(lease.stopRequest);
    lease.admission?.cancel();
    if (!lease.admitted) void this.finalizePendingStop(lease);
    return true;
  }

  /** Reserve a retained session for resume before any asynchronous wait. */
  reserveResume(
    prompt: string,
    mode: SubagentMode,
    timeoutSeconds: number | undefined,
    schedule: (task: () => Promise<void>) => AdmissionHandle,
    signal?: AbortSignal,
    admissionPath: "immediate" | "queued" = "immediate",
  ): { accepted: true; runId: number } | { accepted: false; kind: "not_found" | "wrong_state"; status?: SubagentStatus } {
    if (!this.subagentSession || this._sessionReleased) return { accepted: false, kind: "wrong_state", status: this.status };
    if (this.isActive()) return { accepted: false, kind: "wrong_state", status: this.status };

    const previous = this.currentLease;
    const runId = ++this.nextRunId;
    const lease = this.createLease(runId, "resume", mode, prompt, timeoutSeconds, admissionPath);
    this.currentLease = lease;
    this.state.resetForResume();
    const resumeAbort = new AbortController();
    this.pendingResumeAbort = resumeAbort;
    // A detached resume is independent of the caller even while waiting for
    // the prior turn to become idle. The private controller remains available
    // for an explicit stop request.
    const waitSignal = mode === "joined" && signal
      ? AbortSignal.any([resumeAbort.signal, signal])
      : resumeAbort.signal;
    if (mode === "joined") this.armParentSignal(signal);

    void this.waitAndScheduleResume(lease, previous, waitSignal, schedule);
    return { accepted: true, runId };
  }

  private async waitAndScheduleResume(
    lease: RunLease,
    previous: RunLease,
    signal: AbortSignal,
    schedule: (task: () => Promise<void>) => AdmissionHandle,
  ): Promise<void> {
    try {
      await previous.settlement;
      await this.subagentSession?.waitUntilIdle(signal);
      signal.throwIfAborted();
      if (this.currentLease !== lease || lease.settled) return;
      // Resume only enters the limiter after Pi's idle boundary. Queue time is
      // therefore excluded from both the deadline and the active runtime.
      lease.admission = schedule(() => this.admitAndRun(lease));
      if (lease.stopRequest && !lease.admission.admitted) lease.admission.cancel();
    } catch (error) {
      if (this.currentLease !== lease || lease.settled) return;
      if (lease.stopRequest || signal.aborted) {
        lease.stopRequest ??= "parent_cancelled";
        await this.finalizePendingStop(lease);
      } else {
        await this.finalizeError(lease, error, "execution_failure");
      }
    } finally {
      if (this.currentLease === lease) this.pendingResumeAbort = undefined;
    }
  }

  private async admitAndRun(lease: RunLease): Promise<void> {
    if (this.currentLease !== lease || lease.settled) return;
    if (lease.stopRequest) {
      await this.finalizePendingStop(lease);
      return;
    }
    lease.admitted = true;
    lease.startedAt = Date.now();
    this.runtimeMs = 0;
    this.state.markRunning(lease.startedAt);
    if (lease.timeoutSeconds != null) {
      lease.runtimeTimer = setTimeout(() => this.requestStop("runtime_timeout"), lease.timeoutSeconds * 1000);
    }
    if (lease.phase === "resume") {
      runSafely("subagent onResumedStarted observer", () => this.execution.observer?.onResumedStarted?.(this));
    } else {
      runSafely("subagent onStarted observer", () => this.execution.observer?.onStarted?.(this));
    }
    await this.executeLease(lease);
  }

  private async executeLease(lease: RunLease): Promise<void> {
    try {
      if (lease.phase === "resume") {
        await this.executeResume(lease);
      } else {
        await this.executeInitial(lease);
      }
    } catch (error) {
      // A stop request aborts both provider work and lifecycle callbacks. Those
      // callbacks reject through the same cooperative signal, so this is a
      // normal stopped run rather than an execution failure. Keep genuine
      // failures classified below when no stop owns the lease.
      if (lease.stopRequest && isCooperativeAbort(error, lease.executionController.signal)) {
        await this.finalizeResult(lease, { responseText: "" }, lease.phase === "initial");
      } else {
        await this.finalizeError(lease, error, "execution_failure");
      }
    }
  }

  private async executeInitial(lease: RunLease): Promise<void> {
    let cwd: string | undefined;
    if (this.workspaceBracket.hasProvider()) {
      cwd = await this.workspaceBracket.prepare({
        agentId: this.id,
        agentType: this.type,
        baseCwd: this.execution.baseCwd,
        invocation: this.invocation,
      });
    }
    if (lease.stopRequest) {
      // Admission has already happened, so finalize through the full run
      // boundary. In particular, a stop arriving while workspace preparation
      // is pending must dispose the prepared workspace exactly once rather
      // than taking the queued-only fast path.
      await this.finalizeResult(lease, { responseText: "" }, true);
      return;
    }

    const session = await this.execution.createSubagentSession({
      snapshot: this.execution.snapshot,
      type: this.type,
      cwd,
      parentSession: this.execution.parentSession,
      model: this.execution.model,
      thinkingLevel: this.execution.thinkingLevel,
    });
    this.subagentSession = session;
    this._modelLabel = formatModelLabel(session.model ?? this.execution.model ?? this.execution.snapshot.model);
    this._effectiveThinkingLevel = session.thinkingLevel ?? this._effectiveThinkingLevel;

    if (lease.stopRequest) {
      this.releasedOutputFile = session.outputFile;
      this.subagentSession = undefined;
      await session.dispose();
      return this.finalizeResult(lease, { responseText: "" }, true);
    }

    this.flushPendingSteers();
    this.listeners.attachObserver(subscribeSubagentObserver(session, this.state, {
      onCompact: (info) => runSafely("subagent onCompacted observer", () => this.execution.observer?.onCompacted?.(this, info)),
    }));
    runSafely("subagent onSessionCreated observer", () => this.execution.observer?.onSessionCreated?.(this));

    const runConfig = this.execution.getRunConfig?.();
    const lifecycle = this.createTurnLifecycle(lease);
    const result = await session.runTurnLoop(lease.prompt, {
      maxTurns: this.execution.maxTurns,
      defaultMaxTurns: runConfig?.defaultMaxTurns,
      graceTurns: runConfig?.graceTurns,
      signal: lease.executionController.signal,
      ...(lifecycle ? { lifecycle } : {}),
    });
    await this.finalizeResult(lease, result, true);
  }

  private async executeResume(lease: RunLease): Promise<void> {
    const session = this.subagentSession;
    if (!session) return this.finalizeError(lease, new Error("Subagent session was released while resuming"), "execution_failure");
    this.listeners.attachObserver(subscribeSubagentObserver(session, this.state, {
      onCompact: (info) => runSafely("subagent onCompacted observer", () => this.execution.observer?.onCompacted?.(this, info)),
    }));
    const lifecycle = this.createTurnLifecycle(lease);
    if (lifecycle) {
      const result = await session.resumeLifecycleTurnLoop(lease.prompt, lease.executionController.signal, lifecycle);
      await this.finalizeResult(lease, result, false);
    } else {
      const result = await session.resumeTurnLoop(lease.prompt, lease.executionController.signal);
      await this.finalizeResult(lease, {
        responseText: result.text,
        ...(result.failure ? { failure: result.failure } : {}),
        ...(result.terminalReason ? { terminalReason: result.terminalReason } : {}),
      }, false);
    }
  }

  private createTurnLifecycle(lease: RunLease): SubagentTurnLifecycle | undefined {
    const registry = this.execution.lifecycleInterceptors;
    const session = this.subagentSession;
    if (!registry?.hasInterceptors() || !session) return undefined;
    const basePath = this.execution.executionPath ?? { origin: "service" as const, admission: "immediate" as const };
    const execution: SubagentLifecycleExecutionPath = {
      phase: lease.phase,
      origin: basePath.origin,
      mode: lease.mode,
      admission: lease.admissionPath,
    };
    const lifecycleParent = this.execution.lifecycleParentSession ?? this.execution.parentSession;
    return registry.createTurnLifecycle({
      identity: {
        agentId: this.id,
        sessionId: session.sessionId,
        runId: lease.runId,
        agentType: this.type,
        ...(lifecycleParent?.parentSessionId ? { parentSessionId: lifecycleParent.parentSessionId } : {}),
      },
      execution,
      signal: lease.executionController.signal,
    });
  }

  private async finalizeResult(lease: RunLease, result: TurnLoopResult, disposeWorkspace: boolean): Promise<void> {
    if (this.currentLease !== lease || lease.settled) return;
    this.listeners.release();
    let finalResult = result.responseText;
    if (disposeWorkspace) {
      const terminalStatus: "completed" | "stopped" | "error" = result.failure
        ? "error"
        : lease.stopRequest || result.terminalReason === "turn_limit_hard" || result.terminalReason === "lifecycle_abort"
          ? "stopped"
          : "completed";
      try {
        finalResult += this.workspaceBracket.dispose({ status: terminalStatus, description: this.description });
      } catch (error) {
        return this.finalizeError(lease, error, "workspace_teardown_failure", finalResult);
      }
    }

    if (result.failure) {
      await this.finalizeTerminal(lease, "error", "provider_failure", finalResult, result.failure);
    } else if (lease.stopRequest) {
      await this.finalizeTerminal(lease, "stopped", lease.stopRequest, finalResult);
    } else if (result.terminalReason === "lifecycle_abort") {
      await this.finalizeTerminal(lease, "stopped", "lifecycle_abort", finalResult);
    } else if (result.terminalReason === "turn_limit_hard") {
      await this.finalizeTerminal(lease, "stopped", "turn_limit_hard", finalResult);
    } else {
      await this.finalizeTerminal(lease, "completed", result.terminalReason ?? "completed", finalResult);
    }
  }

  private async finalizeError(
    lease: RunLease,
    error: unknown,
    reason: "provider_failure" | "execution_failure" | "workspace_teardown_failure",
    partialResult?: string,
  ): Promise<void> {
    if (this.currentLease !== lease || lease.settled) return;
    this.listeners.release();
    let finalResult = partialResult;
    if (reason !== "workspace_teardown_failure") {
      try {
        finalResult = (finalResult ?? "") + this.workspaceBracket.dispose({ status: lease.stopRequest ? "stopped" : "error", description: this.description });
      } catch (cleanupError) {
        debugLog("workspace dispose on agent error", cleanupError);
        reason = "workspace_teardown_failure";
        error = cleanupError;
      }
    }
    // An actual execution failure outranks a cancellation request. A normal
    // cooperative abort resolves through finalizeResult and therefore still
    // reports the lease's first stop reason; this branch is reserved for a
    // genuine thrown failure while running or tearing down the child.
    await this.finalizeTerminal(lease, "error", reason, finalResult, error);
  }

  private async finalizePendingStop(lease: RunLease): Promise<void> {
    if (this.currentLease !== lease || lease.settled || lease.admitted) return;
    await this.finalizeTerminal(lease, "stopped", lease.stopRequest ?? "explicit_stop");
  }

  private async finalizeTerminal(
    lease: RunLease,
    status: SubagentStatus,
    reason: SubagentTerminalReason,
    result?: string,
    error?: unknown,
  ): Promise<void> {
    if (this.currentLease !== lease || lease.settled) return;
    lease.settled = true;
    lease.parentSignalCleanup?.();
    lease.parentSignalCleanup = undefined;
    if (lease.runtimeTimer) clearTimeout(lease.runtimeTimer);
    this.runtimeMs = lease.admitted && lease.startedAt != null ? Math.max(0, Date.now() - lease.startedAt) : 0;

    if (status === "completed") this.state.markCompleted(result ?? "", reason as "completed" | "turn_limit_graceful");
    else if (status === "stopped") this.state.markStopped(result, reason as SubagentStopReason | "turn_limit_hard" | "lifecycle_abort");
    else this.state.markError(error ?? result ?? "subagent execution failed", reason as "provider_failure" | "execution_failure" | "workspace_teardown_failure", result);

    if (lease.phase === "resume") {
      runSafely("subagent onResumedFinished observer", () => this.execution.observer?.onResumedFinished?.(this));
    } else {
      runSafely("subagent onRunFinished observer", () => this.execution.observer?.onRunFinished?.(this));
    }
    lease.resolveSettlement();
  }

  private createLease(
    runId: number,
    phase: "initial" | "resume",
    mode: SubagentMode,
    prompt: string,
    timeoutSeconds?: number,
    admissionPath: "immediate" | "queued" = "immediate",
  ): RunLease {
    const d = deferred();
    return {
      runId,
      phase,
      mode,
      prompt,
      timeoutSeconds,
      executionController: new AbortController(),
      settlement: d.promise,
      resolveSettlement: d.resolve,
      admitted: false,
      settled: false,
      admissionPath,
    };
  }

  private flushPendingSteers(): void {
    for (const message of this.pendingSteers) runDetached("subagent buffered steer", () => this.subagentSession?.steer(message));
    this.pendingSteers = [];
  }

  incrementToolUses(): void { this.state.incrementToolUses(); }
  addUsage(delta: { input: number; output: number; cacheWrite: number }): void { this.state.addUsage(delta); }
  incrementCompactions(): void { this.state.incrementCompactions(); }
  markConsumed(at?: number): void { this.state.markConsumed(at); }

  async waitForSettlement(signal?: AbortSignal): Promise<void> {
    if (!signal) return this.currentLease.settlement;
    await settleOrAbort(this.currentLease.settlement, signal);
  }

  async disposeSession(): Promise<void> {
    const session = this.subagentSession;
    if (!session) return;
    this.subagentSession = undefined;
    await session.dispose();
  }

  async releaseSession(): Promise<void> {
    const session = this.subagentSession;
    if (!session) return;
    this.releasedOutputFile = session.outputFile;
    this.subagentSession = undefined;
    this._sessionReleased = true;
    for (const listener of this.recordUpdateListeners) runSafely("subagent release update", listener);
    await session.dispose();
  }
}

function isCooperativeAbort(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (error === signal.reason) return true;
  return error instanceof Error && /abort|cancel/i.test(error.message);
}

async function settleOrAbort(run: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", finish);
      resolve();
    };
    signal.addEventListener("abort", finish, { once: true });
    void run.then(finish, finish);
  });
}
