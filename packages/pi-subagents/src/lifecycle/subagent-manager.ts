/** Central parent-only registry for child run admission and lifecycle ownership. */

import { randomUUID } from "node:crypto";
import type { Model } from "@earendil-works/pi-ai";
import { debugLog, runDetached, runSafely } from "#src/debug";
import type { AdmissionHandle, ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import type { CreateSubagentSessionParams } from "#src/lifecycle/create-subagent-session";
import type {
  LifecycleInterceptorRegistry,
  SubagentExecutionAdmission,
  SubagentExecutionOrigin,
  SubagentLifecycleInterceptor,
  SubagentLifecycleRegistration,
} from "#src/lifecycle/lifecycle-interceptor";
import { LifecycleInterceptorRegistry as InterceptorRegistry } from "#src/lifecycle/lifecycle-interceptor";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { Subagent, type SubagentLifecycleObserver } from "#src/lifecycle/subagent";
import type { SubagentSession } from "#src/lifecycle/subagent-session";
import { SubagentState, type SubagentStatus, type SubagentStopReason } from "#src/lifecycle/subagent-state";
import type { WorkspaceProvider } from "#src/lifecycle/workspace";
import type { RunConfig } from "#src/runtime";
import type { AgentInvocation, CompactionInfo, ParentSessionInfo, SubagentMode, SubagentType, ThinkingLevel } from "#src/types";

export interface SubagentManagerObserver {
  onSubagentStarted(record: Subagent): void;
  onSubagentCompleted(record: Subagent): void;
  onSubagentResumedStarted?(record: Subagent): void;
  onSubagentResumed?(record: Subagent): void;
  onSubagentCleared?(record: Subagent): void;
  onSubagentCompacted(record: Subagent, info: CompactionInfo): void;
  onSubagentCreated(record: Subagent): void;
}

export interface SubagentManagerOptions {
  createSubagentSession: (params: CreateSubagentSessionParams) => Promise<SubagentSession>;
  limiter: ConcurrencyLimiter;
  baseCwd: string;
  getRunConfig?: () => RunConfig;
  observer?: SubagentManagerObserver;
}

export interface AgentSpawnConfig {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  mode: SubagentMode;
  timeoutSeconds?: number;
  invocation?: AgentInvocation;
  signal?: AbortSignal;
  observer?: SubagentLifecycleObserver;
  parentSession?: ParentSessionInfo;
  lifecycleParentSession?: ParentSessionInfo;
  origin?: SubagentExecutionOrigin;
  /** Internal hook used by joined tool delivery to stream after record creation. */
  onCreated?: (record: Subagent) => void;
}

export type DeliveryOutcome =
  | { kind: "detached"; agentId: string; runId: number }
  | { kind: "joined"; record: Subagent };

export type ResumeOutcome = DeliveryOutcome | { kind: "not_found"; agentId: string } | { kind: "wrong_state"; agentId: string; status: SubagentStatus };

export type StopOutcome =
  | { kind: "stopped"; agentId: string; runId: number; reason: SubagentStopReason; record: Subagent }
  | { kind: "stop_pending"; agentId: string; runId: number; reason: SubagentStopReason; record: Subagent }
  | { kind: "already_terminal"; agentId: string; runId: number; record: Subagent }
  | { kind: "not_found"; agentId: string };

export type ManagerSteerOutcome =
  | { kind: "not_found"; agentId: string }
  | ({ kind: "rejected"; status: SubagentStatus; runId: number })
  | ({ kind: "delivered" | "buffered"; runId: number });

export class SubagentManager {
  private readonly agents = new Map<string, Subagent>();
  private readonly cleanupInterval: ReturnType<typeof setInterval>;
  private readonly observer?: SubagentManagerObserver;
  private readonly createSubagentSession: (params: CreateSubagentSessionParams) => Promise<SubagentSession>;
  private readonly limiter: ConcurrencyLimiter;
  private readonly baseCwd: string;
  private readonly getRunConfig?: () => RunConfig;
  private workspace?: WorkspaceProvider;
  private readonly lifecycleInterceptors: LifecycleInterceptorRegistry = new InterceptorRegistry();
  private disposalPromise?: Promise<void>;

  constructor(options: SubagentManagerOptions) {
    this.createSubagentSession = options.createSubagentSession;
    this.limiter = options.limiter;
    this.baseCwd = options.baseCwd;
    this.observer = options.observer;
    this.getRunConfig = options.getRunConfig;
    this.cleanupInterval = setInterval(() => runDetached("retention cleanup", () => this.cleanup()), 60_000);
    this.cleanupInterval.unref();
  }

  get workspaceProvider(): WorkspaceProvider | undefined { return this.workspace; }

  registerWorkspaceProvider(provider: WorkspaceProvider): () => void {
    if (this.workspace) throw new Error("A WorkspaceProvider is already registered; only one is supported.");
    this.workspace = provider;
    return () => { if (this.workspace === provider) this.workspace = undefined; };
  }

  registerLifecycleInterceptor(interceptor: SubagentLifecycleInterceptor): SubagentLifecycleRegistration {
    return this.lifecycleInterceptors.register(interceptor);
  }

  private buildObserver(options: AgentSpawnConfig): SubagentLifecycleObserver {
    return {
      onStarted: (record) => runSafely("onSubagentStarted observer", () => this.observer?.onSubagentStarted(record)),
      onSessionCreated: options.observer?.onSessionCreated
        ? (record) => runSafely("onSessionCreated observer", () => options.observer!.onSessionCreated!(record))
        : undefined,
      onRunFinished: (record) => runSafely("onSubagentCompleted observer", () => this.observer?.onSubagentCompleted(record)),
      onResumedStarted: (record) => runSafely("onSubagentResumedStarted observer", () => this.observer?.onSubagentResumedStarted?.(record)),
      onResumedFinished: (record) => runSafely("onSubagentResumed observer", () => this.observer?.onSubagentResumed?.(record)),
      onCompacted: (record, info) => runSafely("onSubagentCompacted observer", () => this.observer?.onSubagentCompacted(record, info)),
    };
  }

  /** Synchronous creation plus shared FIFO admission. */
  spawn(snapshot: ParentSnapshot, type: SubagentType, prompt: string, options: AgentSpawnConfig): Subagent {
    const id = randomUUID().slice(0, 17);
    const admission: SubagentExecutionAdmission = this.limiter.isSaturated() ? "queued" : "immediate";
    const record = new Subagent({
      id,
      type,
      description: options.description,
      invocation: options.invocation,
      state: new SubagentState(),
      execution: {
        createSubagentSession: this.createSubagentSession,
        snapshot,
        prompt,
        baseCwd: this.baseCwd,
        mode: options.mode,
        timeoutSeconds: options.timeoutSeconds,
        observer: this.buildObserver(options),
        getRunConfig: this.getRunConfig,
        getWorkspaceProvider: () => this.workspace,
        model: options.model,
        maxTurns: options.maxTurns,
        thinkingLevel: options.thinkingLevel,
        parentSession: options.parentSession,
        lifecycleParentSession: options.lifecycleParentSession,
        lifecycleInterceptors: this.lifecycleInterceptors,
        executionPath: {
          origin: options.origin ?? "service",
          admission,
        },
      },
    });
    this.agents.set(id, record);
    runSafely("onSubagentCreated hook", () => options.onCreated?.(record));
    runSafely("onSubagentCreated observer", () => this.observer?.onSubagentCreated(record));

    // A joined caller is armed before it can enter the queue. Detached callers
    // deliberately omit the signal so parent tool settlement cannot stop them.
    if (options.mode === "joined") record.armParentSignal(options.signal);
    record.scheduleVia((task) => this.limiter.schedule(task));
    return record;
  }

  async launch(snapshot: ParentSnapshot, type: SubagentType, prompt: string, options: AgentSpawnConfig): Promise<DeliveryOutcome> {
    // An already-cancelled detached call is rejected before creating work;
    // once accepted, detached execution is independent of later cancellation.
    if (options.signal?.aborted && options.mode === "detached") {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Detached launch was already cancelled");
    }
    const record = this.spawn(snapshot, type, prompt, options);
    if (options.mode === "detached") return { kind: "detached", agentId: record.id, runId: record.runId };
    await record.settlement;
    return { kind: "joined", record };
  }

  async resume(
    id: string,
    prompt: string,
    mode: SubagentMode,
    timeoutSeconds: number | undefined,
    signal?: AbortSignal,
    onReserved?: (record: Subagent) => void,
  ): Promise<ResumeOutcome> {
    const record = this.agents.get(id);
    if (!record) return { kind: "not_found", agentId: id };
    if (signal?.aborted && mode === "detached") {
      throw signal.reason instanceof Error ? signal.reason : new Error("Detached resume was already cancelled");
    }
    const admission: SubagentExecutionAdmission = this.limiter.isSaturated() ? "queued" : "immediate";
    const result = record.reserveResume(
      prompt,
      mode,
      timeoutSeconds,
      (task) => this.limiter.schedule(task),
      mode === "joined" ? signal : undefined,
      admission,
    );
    if (!result.accepted) return { kind: "wrong_state", agentId: id, status: result.status ?? record.status };
    runSafely("onSubagentResumed reserved hook", () => onReserved?.(record));
    if (mode === "detached") return { kind: "detached", agentId: id, runId: result.runId };
    await record.settlement;
    return { kind: "joined", record };
  }

  async stop(id: string, settlementTimeoutSeconds = 5, waitSignal?: AbortSignal): Promise<StopOutcome> {
    const record = this.agents.get(id);
    if (!record) return { kind: "not_found", agentId: id };
    const runId = record.runId;
    if (!record.isActive()) return { kind: "already_terminal", agentId: id, runId, record };

    // The child stop request is deliberately independent of the caller's wait:
    // aborting the parent tool must not undo cancellation, but it may return the
    // bounded stop report early when the child is uncooperative.
    record.requestStop("explicit_stop");
    const settled = await waitWithTimeout(record.settlement, settlementTimeoutSeconds * 1000, waitSignal);
    const reason = record.stopReason ?? "explicit_stop";
    return settled
      ? { kind: "stopped", agentId: id, runId, reason, record }
      : { kind: "stop_pending", agentId: id, runId, reason, record };
  }

  async steer(id: string, message: string): Promise<ManagerSteerOutcome> {
    const record = this.agents.get(id);
    if (!record) return { kind: "not_found", agentId: id };
    return record.steer(message);
  }

  getRecord(id: string): Subagent | undefined { return this.agents.get(id); }

  listAgents(): Subagent[] {
    return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  async clearCompleted(): Promise<void> {
    const disposals: Promise<void>[] = [];
    for (const [id, record] of this.agents) {
      if (record.isActive()) continue;
      runSafely("onSubagentCleared observer", () => this.observer?.onSubagentCleared?.(record));
      this.agents.delete(id);
      disposals.push(record.disposeSession());
    }
    await Promise.all(disposals);
  }

  hasRunning(): boolean { return [...this.agents.values()].some((record) => record.isActive()); }

  /** Parent interruption is a cancellation request, not an immediate terminal transition. */
  abortAll(): number {
    let count = 0;
    for (const record of this.agents.values()) {
      if (record.requestStop("parent_cancelled")) count++;
    }
    return count;
  }

  async waitForAll(): Promise<void> {
    for (;;) {
      const pending = [...this.agents.values()].filter((record) => record.isActive()).map((record) => record.settlement);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  dispose(): Promise<void> {
    this.disposalPromise ??= this.disposeOnce();
    return this.disposalPromise;
  }

  private async disposeOnce(): Promise<void> {
    clearInterval(this.cleanupInterval);
    // Abort first so in-flight lifecycle callbacks receive the same cooperative
    // signal as provider and tool work before their registrations are retired.
    this.abortAll();
    const interceptorsDisposed = await waitWithTimeout(this.lifecycleInterceptors.dispose(), 5_000);
    if (!interceptorsDisposed) debugLog("lifecycle interceptor shutdown timeout", new Error("A lifecycle interceptor did not cooperate before shutdown"));
    const settled = await waitWithTimeout(this.waitForAll(), 5_000);
    if (!settled) debugLog("manager shutdown settlement timeout", new Error("One or more subagents did not cooperate before shutdown"));
    const records = [...this.agents.values()];
    this.agents.clear();
    await Promise.all(records.map((record) => record.disposeSession()));
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    const config = this.getRunConfig?.();
    const consumedRetentionMinutes = config?.consumedSessionRetentionMinutes ?? 10;
    const unconsumedRetentionMinutes = config?.unconsumedSessionRetentionMinutes ?? 720;
    const releases: Promise<void>[] = [];
    for (const record of this.agents.values()) {
      if (record.isActive() || !record.isSessionReady() || record.completedAt == null) continue;
      // Consumption changes the retention clock: once a result has actually
      // been delivered, retain it for the shorter consumed window and anchor
      // that window at delivery. Unconsumed sessions retain the existing
      // longer grace period from completion so a parent can still resume them.
      const retentionMinutes = record.consumed ? consumedRetentionMinutes : unconsumedRetentionMinutes;
      const anchor = record.consumed ? (record.consumedAt ?? record.completedAt) : record.completedAt;
      if (anchor + retentionMinutes * 60_000 > now) continue;
      releases.push(record.releaseSession());
    }
    await Promise.all(releases);
  }
}

async function waitWithTimeout(promise: Promise<void>, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  if (timeoutMs <= 0 || signal?.aborted) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const callerAbort = signal
    ? new Promise<false>((resolve) => {
      const onAbort = (): void => resolve(false);
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", onAbort);
    })
    : undefined;
  try {
    return await Promise.race([
      promise.then(() => true as const),
      timeout,
      ...(callerAbort ? [callerAbort] : []),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort?.();
  }
}
