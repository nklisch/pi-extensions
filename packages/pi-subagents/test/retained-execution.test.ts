import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { SubagentSession } from "#src/lifecycle/subagent-session";
import { LifecycleInterceptorRegistry } from "#src/lifecycle/lifecycle-interceptor";
import { NotificationManager } from "#src/observation/notification";
import { AgentTool } from "#src/tools/agent-tool";
import { createSessionFactory } from "#test/helpers/manager-stubs";
import { createMockSession, createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";
import { createChildLifecycleMock } from "#test/helpers/subagent-session-io";
import { createToolDeps } from "#test/helpers/make-deps";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeManager(
  factory: (params: any) => Promise<any>,
  limiter = new ConcurrencyLimiter(() => 1),
  extra: Record<string, unknown> = {},
) {
  return new SubagentManager({ baseCwd: "/parent", limiter, createSubagentSession: factory, ...extra } as any);
}

function launchOptions(mode: "joined" | "detached" = "detached", extra: Record<string, unknown> = {}) {
  return { description: "execution test", mode, origin: "service" as const, ...extra };
}

async function recordFor(manager: SubagentManager, factory: any, mode: "joined" | "detached" = "detached", extra: Record<string, unknown> = {}) {
  const result = await manager.launch(STUB_SNAPSHOT, "Explore", "inspect", launchOptions(mode, extra));
  const id = result.kind === "joined" ? result.record.id : result.agentId;
  return { result, record: manager.getRecord(id)! };
}

describe("retained workspace execution boundaries", () => {
  it("prepares a workspace and passes its cwd to session creation", async () => {
    const session = createSessionFactory();
    const workspace = { cwd: "/workspace/child", dispose: vi.fn(() => undefined) };
    const provider = { prepare: vi.fn(async () => workspace) };
    const manager = makeManager(session.factory, new ConcurrencyLimiter(() => 1), { observer: undefined });
    manager.registerWorkspaceProvider(provider);
    const { record } = await recordFor(manager, session.factory);
    await record.settlement;
    expect(provider.prepare).toHaveBeenCalledWith(expect.objectContaining({ agentId: record.id, baseCwd: "/parent" }));
    expect(session.factory).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace/child" }));
    expect(workspace.dispose).toHaveBeenCalledWith({ status: "completed", description: "execution test" });
    await manager.dispose();
  });

  it("returns an addendum from workspace disposal in the child result", async () => {
    const session = createSessionFactory();
    const workspace = { cwd: "/workspace/child", dispose: vi.fn(() => ({ resultAddendum: "\nSaved changes." })) };
    const manager = makeManager(session.factory);
    manager.registerWorkspaceProvider({ prepare: vi.fn(async () => workspace) });
    const { record } = await recordFor(manager, session.factory);
    await record.settlement;
    expect(record.result).toBe("done\nSaved changes.");
    await manager.dispose();
  });

  it("classifies a workspace prepare rejection as execution failure", async () => {
    const session = createSessionFactory();
    const manager = makeManager(session.factory);
    manager.registerWorkspaceProvider({ prepare: vi.fn(async () => { throw new Error("workspace unavailable"); }) });
    const { record } = await recordFor(manager, session.factory);
    await record.settlement;
    expect(record.status).toBe("error");
    expect(record.stateTerminalReason).toBe("execution_failure");
    expect(record.error).toBe("workspace unavailable");
    expect(session.factory).not.toHaveBeenCalled();
    await manager.dispose();
  });

  it("does not dispose when workspace preparation returns no workspace", async () => {
    const session = createSessionFactory();
    const provider = { prepare: vi.fn(async () => undefined) };
    const manager = makeManager(session.factory);
    manager.registerWorkspaceProvider(provider);
    const { record } = await recordFor(manager, session.factory);
    await record.settlement;
    expect(record.status).toBe("completed");
    expect(session.stub.dispose).toHaveBeenCalledTimes(0);
    await manager.dispose();
  });

  it("settles an explicit stop while prepare is pending and disposes once", async () => {
    const session = createSessionFactory();
    const pending = deferred<any>();
    const workspace = { cwd: "/workspace/child", dispose: vi.fn(() => undefined) };
    const provider = { prepare: vi.fn(() => pending.promise) };
    const manager = makeManager(session.factory);
    manager.registerWorkspaceProvider(provider);
    const launch = manager.launch(STUB_SNAPSHOT, "Explore", "inspect", launchOptions());
    await vi.waitFor(() => expect(provider.prepare).toHaveBeenCalled());
    const record = manager.listAgents()[0];
    const stopping = manager.stop(record.id, 1);
    expect(record.isActive()).toBe(true);
    pending.resolve(workspace);
    const outcome = await stopping;
    await launch;
    expect(outcome.kind).toBe("stopped");
    expect(record.status).toBe("stopped");
    expect(record.stateTerminalReason).toBe("explicit_stop");
    expect(workspace.dispose).toHaveBeenCalledOnce();
    expect(session.factory).not.toHaveBeenCalled();
    await manager.dispose();
  });

  it("settles a parent cancellation while prepare is pending and disposes once", async () => {
    const session = createSessionFactory();
    const pending = deferred<any>();
    const workspace = { cwd: "/workspace/child", dispose: vi.fn(() => undefined) };
    const provider = { prepare: vi.fn(() => pending.promise) };
    const controller = new AbortController();
    const manager = makeManager(session.factory);
    manager.registerWorkspaceProvider(provider);
    const launch = manager.launch(STUB_SNAPSHOT, "Explore", "inspect", launchOptions("joined", { signal: controller.signal }));
    await vi.waitFor(() => expect(provider.prepare).toHaveBeenCalled());
    const record = manager.listAgents()[0];
    controller.abort(new Error("parent ended"));
    expect(record.stopRequested).toBe(true);
    pending.resolve(workspace);
    const outcome = await launch;
    expect(outcome.kind).toBe("joined");
    expect(record.status).toBe("stopped");
    expect(record.stateTerminalReason).toBe("parent_cancelled");
    expect(workspace.dispose).toHaveBeenCalledOnce();
    await manager.dispose();
  });

  it("settles a runtime timeout while prepare is pending and disposes once", async () => {
    vi.useFakeTimers();
    try {
      const session = createSessionFactory();
      const pending = deferred<any>();
      const workspace = { cwd: "/workspace/child", dispose: vi.fn(() => undefined) };
      const manager = makeManager(session.factory);
      manager.registerWorkspaceProvider({ prepare: vi.fn(() => pending.promise) });
      const launch = manager.launch(STUB_SNAPSHOT, "Explore", "inspect", launchOptions("detached", { timeoutSeconds: 5 }));
      const record = manager.listAgents()[0];
      await Promise.resolve();
      vi.advanceTimersByTime(5_000);
      expect(record.stopReason).toBe("runtime_timeout");
      pending.resolve(workspace);
      await launch;
      await record.settlement;
      expect(record.status).toBe("stopped");
      expect(record.stateTerminalReason).toBe("runtime_timeout");
      expect(workspace.dispose).toHaveBeenCalledOnce();
      await manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a duplicate workspace provider registration", async () => {
    const manager = makeManager(createSessionFactory().factory);
    const first = { prepare: vi.fn(async () => undefined) };
    manager.registerWorkspaceProvider(first);
    expect(() => manager.registerWorkspaceProvider({ prepare: vi.fn(async () => undefined) })).toThrow(/already registered/);
    await manager.dispose();
  });

  it("removes only the currently registered workspace provider", async () => {
    const manager = makeManager(createSessionFactory().factory);
    const first = { prepare: vi.fn(async () => undefined) };
    const disposeFirst = manager.registerWorkspaceProvider(first);
    disposeFirst();
    const second = { prepare: vi.fn(async () => undefined) };
    const disposeSecond = manager.registerWorkspaceProvider(second);
    disposeFirst();
    expect(manager.workspaceProvider).toBe(second);
    disposeSecond();
    expect(manager.workspaceProvider).toBeUndefined();
    await manager.dispose();
  });
});

describe("retained manager lifecycle boundaries", () => {
  it("keeps a queued record awaitable before its slot opens", async () => {
    const first = createSessionFactory();
    const firstGate = deferred<any>();
    first.stub.runTurnLoop.mockImplementation(() => firstGate.promise);
    const second = createSessionFactory();
    let calls = 0;
    const factory = vi.fn(async (params: any) => (++calls === 1 ? first.factory(params) : second.factory(params)));
    const manager = makeManager(factory);
    const firstLaunch = manager.launch(STUB_SNAPSHOT, "Explore", "first", launchOptions());
    await vi.waitFor(() => expect(first.stub.runTurnLoop).toHaveBeenCalled());
    const secondLaunch = manager.launch(STUB_SNAPSHOT, "Explore", "second", launchOptions());
    const secondRecord = manager.listAgents()[0];
    expect(secondRecord.status).toBe("queued");
    expect(secondRecord.isActive()).toBe(true);
    expect(second.factory).not.toHaveBeenCalled();
    firstGate.resolve({ responseText: "first" });
    await firstLaunch;
    await secondLaunch;
    await secondRecord.settlement;
    expect(secondRecord.status).toBe("completed");
    expect(second.factory).toHaveBeenCalledOnce();
    await manager.dispose();
  });

  it("cancels queued work without creating its session", async () => {
    const first = createSessionFactory();
    const firstGate = deferred<any>();
    first.stub.runTurnLoop.mockImplementation(() => firstGate.promise);
    const second = createSessionFactory();
    let calls = 0;
    const factory = vi.fn(async (params: any) => (++calls === 1 ? first.factory(params) : second.factory(params)));
    const manager = makeManager(factory);
    const firstLaunch = manager.launch(STUB_SNAPSHOT, "Explore", "first", launchOptions());
    await vi.waitFor(() => expect(first.stub.runTurnLoop).toHaveBeenCalled());
    const secondLaunch = manager.launch(STUB_SNAPSHOT, "Explore", "second", launchOptions());
    const queued = manager.listAgents()[0];
    const outcome = await manager.stop(queued.id, 1);
    await secondLaunch;
    expect(outcome.kind).toBe("stopped");
    expect(queued.status).toBe("stopped");
    expect(second.factory).not.toHaveBeenCalled();
    firstGate.resolve({ responseText: "first" });
    await firstLaunch;
    await manager.dispose();
  });

  it("clears completed records and disposes their sessions", async () => {
    const session = createSessionFactory();
    const manager = makeManager(session.factory);
    const { record } = await recordFor(manager, session.factory);
    await record.settlement;
    await manager.clearCompleted();
    expect(manager.getRecord(record.id)).toBeUndefined();
    expect(session.stub.dispose).toHaveBeenCalledOnce();
    await manager.dispose();
  });

  it("does not clear an active record", async () => {
    const session = createSessionFactory();
    const gate = deferred<any>();
    session.stub.runTurnLoop.mockImplementation(() => gate.promise);
    const manager = makeManager(session.factory);
    const launch = manager.launch(STUB_SNAPSHOT, "Explore", "work", launchOptions());
    await vi.waitFor(() => expect(session.stub.runTurnLoop).toHaveBeenCalled());
    const record = manager.listAgents()[0];
    await manager.clearCompleted();
    expect(manager.getRecord(record.id)).toBe(record);
    gate.resolve({ responseText: "done" });
    await launch;
    await manager.dispose();
  });

  it("reports clear notifications for terminal records", async () => {
    const session = createSessionFactory();
    const cleared = vi.fn();
    const manager = makeManager(session.factory, new ConcurrencyLimiter(() => 1), { observer: { onSubagentCleared: cleared } });
    const { record } = await recordFor(manager, session.factory);
    await record.settlement;
    await manager.clearCompleted();
    expect(cleared).toHaveBeenCalledWith(record);
    await manager.dispose();
  });

  it("waits for all active records before returning", async () => {
    const session = createSessionFactory();
    const gate = deferred<any>();
    session.stub.runTurnLoop.mockImplementation(() => gate.promise);
    const manager = makeManager(session.factory);
    const launch = manager.launch(STUB_SNAPSHOT, "Explore", "work", launchOptions());
    await vi.waitFor(() => expect(session.stub.runTurnLoop).toHaveBeenCalled());
    const waiting = manager.waitForAll();
    gate.resolve({ responseText: "done" });
    await waiting;
    await launch;
    expect(manager.hasRunning()).toBe(false);
    await manager.dispose();
  });

  it("releases a consumed session after the short retention window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const session = createSessionFactory();
      const manager = makeManager(session.factory, new ConcurrencyLimiter(() => 1), { getRunConfig: () => ({ consumedSessionRetentionMinutes: 1, unconsumedSessionRetentionMinutes: 10 }) });
      const { record } = await recordFor(manager, session.factory);
      await record.settlement;
      record.markConsumed(0);
      vi.setSystemTime(60_001);
      await (manager as any).cleanup();
      expect(record.sessionReleased).toBe(true);
      expect(record.isSessionReady()).toBe(false);
      expect(session.stub.dispose).toHaveBeenCalledOnce();
      await manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an unconsumed session through the consumed window and releases at its safety cap", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const session = createSessionFactory();
      const manager = makeManager(session.factory, new ConcurrencyLimiter(() => 1), { getRunConfig: () => ({ consumedSessionRetentionMinutes: 1, unconsumedSessionRetentionMinutes: 10 }) });
      const { record } = await recordFor(manager, session.factory);
      await record.settlement;
      vi.setSystemTime(2 * 60_000);
      await (manager as any).cleanup();
      expect(record.sessionReleased).toBe(false);
      vi.setSystemTime(10 * 60_000 + 1);
      await (manager as any).cleanup();
      expect(record.sessionReleased).toBe(true);
      expect(session.stub.dispose).toHaveBeenCalledOnce();
      await manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns records newest-first from listAgents", async () => {
    vi.useFakeTimers();
    try {
      const first = createSessionFactory();
      const second = createSessionFactory();
      let calls = 0;
      const factory = vi.fn(async (params: any) => (++calls === 1 ? first.factory(params) : second.factory(params)));
      const manager = makeManager(factory);
      vi.setSystemTime(1_000);
      const a = await recordFor(manager, factory);
      vi.setSystemTime(2_000);
      const b = await recordFor(manager, factory);
      await a.record.settlement; await b.record.settlement;
      const listed = manager.listAgents();
      expect(listed.map((record) => record.id)).toEqual([b.record.id, a.record.id]);
      await manager.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("retained stop forwarding and resume boundaries", () => {
  it("forwards stop into a child session while a tool execution is active", async () => {
    const session = createMockSession() as any;
    const lifecycle = createChildLifecycleMock();
    const promptDone = deferred<void>();
    session.abort = vi.fn(() => { promptDone.resolve(); });
    session.prompt = vi.fn(async () => {
      session.emit({ type: "tool_execution_start", toolName: "bash" });
      await promptDone.promise;
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "partial" }] });
    });
    const child = new SubagentSession(session as unknown as AgentSession, { outputFile: undefined, sessionId: "child", sessionDir: "/tmp", agentName: "Explore", agentMaxTurns: undefined, parentContext: undefined, lifecycle });
    const manager = makeManager(async () => child);
    const launch = manager.launch(STUB_SNAPSHOT, "Explore", "work", launchOptions());
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    const record = manager.listAgents()[0];
    const outcome = await manager.stop(record.id, 1);
    await launch;
    expect(session.abort).toHaveBeenCalledOnce();
    expect(outcome.kind).toBe("stopped");
    expect(record.stateTerminalReason).toBe("explicit_stop");
    await manager.dispose();
  });

  it("settles a stop requested during a lifecycle completion callback", async () => {
    const session = createMockSession();
    session.prompt = vi.fn(async () => { session.messages.push({ role: "assistant", content: [{ type: "text", text: "candidate" }] }); });
    const lifecycle = createChildLifecycleMock();
    const child = new SubagentSession(session as unknown as AgentSession, { outputFile: undefined, sessionId: "child", sessionDir: "/tmp", agentName: "Explore", agentMaxTurns: undefined, parentContext: undefined, lifecycle });
    const registry = new LifecycleInterceptorRegistry();
    const callback = deferred<any>();
    registry.register({ beforeComplete: async () => callback.promise });
    const manager = makeManager(async () => child, new ConcurrencyLimiter(() => 1), { observer: undefined });
    manager.registerLifecycleInterceptor({ beforeComplete: async () => callback.promise });
    const launch = manager.launch(STUB_SNAPSHOT, "Explore", "work", launchOptions());
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    const record = manager.listAgents()[0];
    const stopping = manager.stop(record.id, 1);
    const outcome = await stopping;
    await launch;
    expect(outcome.kind).toBe("stopped");
    expect(record.status).toBe("stopped");
    expect(record.stateTerminalReason).toBe("explicit_stop");
    callback.resolve(undefined);
    await manager.dispose();
    await registry.dispose();
  });

  it("waits for a resumed session idle boundary before starting the next prompt", async () => {
    const session = createMockSession();
    const child = createSubagentSessionStub(session);
    child.resumeTurnLoop.mockResolvedValue({ text: "resumed" });
    const manager = makeManager(async () => toSubagentSession(child));
    const initial = await manager.launch(STUB_SNAPSHOT, "Explore", "first", launchOptions());
    const record = manager.getRecord(initial.kind === "detached" ? initial.agentId : initial.record.id)!;
    await record.settlement;
    session.isIdle = false;
    const idle = deferred<void>();
    child.waitUntilIdle.mockImplementation(() => idle.promise);
    const resumed = manager.resume(record.id, "continue", "joined", undefined);
    await vi.waitFor(() => expect(child.waitUntilIdle).toHaveBeenCalled());
    expect(child.resumeTurnLoop).not.toHaveBeenCalled();
    const stopping = manager.stop(record.id, 1);
    const stopOutcome = await stopping;
    expect(stopOutcome.kind).toBe("stopped");
    idle.resolve();
    await resumed;
    expect(child.resumeTurnLoop).not.toHaveBeenCalled();
    expect(record.stateTerminalReason).toBe("explicit_stop");
    await manager.dispose();
  });

  it("buffers steering before session creation and flushes it in FIFO order", async () => {
    const session = createSessionFactory();
    const pending = deferred<any>();
    const manager = makeManager(() => pending.promise);
    const launch = manager.launch(STUB_SNAPSHOT, "Explore", "work", launchOptions());
    const record = manager.listAgents()[0];
    await vi.waitFor(() => expect(record.isRunning()).toBe(true));
    expect((await manager.steer(record.id, "first")).kind).toBe("buffered");
    expect((await manager.steer(record.id, "second")).kind).toBe("buffered");
    expect(record.pendingSteerCount).toBe(2);
    pending.resolve(toSubagentSession(session.stub));
    await vi.waitFor(() => expect(session.stub.steer).toHaveBeenCalledTimes(2));
    expect(session.stub.steer.mock.calls.map((call) => call[0])).toEqual(["first", "second"]);
    await launch;
    await record.settlement;
    await manager.dispose();
  });

  it("rejects steering a terminal record with its observed status", async () => {
    const session = createSessionFactory();
    const manager = makeManager(session.factory);
    const { record } = await recordFor(manager, session.factory);
    await record.settlement;
    const outcome = await manager.steer(record.id, "late message");
    expect(outcome).toEqual({ kind: "rejected", runId: 1, status: "completed" });
    expect(session.stub.steer).not.toHaveBeenCalled();
    await manager.dispose();
  });

  it("rejects steering after a stop request owns the run", async () => {
    const session = createSessionFactory();
    const gate = deferred<any>();
    session.stub.runTurnLoop.mockImplementation(() => gate.promise);
    const manager = makeManager(session.factory);
    const launch = manager.launch(STUB_SNAPSHOT, "Explore", "work", launchOptions());
    await vi.waitFor(() => expect(session.stub.runTurnLoop).toHaveBeenCalled());
    const record = manager.listAgents()[0];
    record.requestStop("explicit_stop");
    expect((await manager.steer(record.id, "late message")).kind).toBe("rejected");
    gate.resolve({ responseText: "done" });
    await launch;
    await manager.dispose();
  });

  it("rejects a concurrent resume against an active record", async () => {
    const session = createSessionFactory();
    const gate = deferred<any>();
    session.stub.runTurnLoop.mockImplementation(() => gate.promise);
    const manager = makeManager(session.factory);
    const launch = manager.launch(STUB_SNAPSHOT, "Explore", "work", launchOptions());
    await vi.waitFor(() => expect(session.stub.runTurnLoop).toHaveBeenCalled());
    const record = manager.listAgents()[0];

    const outcome = await manager.resume(record.id, "continue", "detached", undefined);

    expect(outcome).toEqual({ kind: "wrong_state", agentId: record.id, status: "running" });
    expect(session.stub.resumeTurnLoop).not.toHaveBeenCalled();
    gate.resolve({ responseText: "done" });
    await launch;
    await manager.dispose();
  });

  it("delivers a detached resume completion notification and consumes it", async () => {
    const session = createSessionFactory();
    session.stub.resumeTurnLoop.mockResolvedValue({ text: "resumed" });
    const send = vi.fn();
    const notifications = new NotificationManager(send);
    const manager = makeManager(session.factory, new ConcurrencyLimiter(() => 1), {
      observer: {
        onSubagentCreated: vi.fn(),
        onSubagentStarted: vi.fn(),
        onSubagentCompleted: vi.fn(),
        onSubagentCompacted: vi.fn(),
        onSubagentResumedStarted: vi.fn(),
        onSubagentResumed: (record: any) => notifications.sendCompletion(record),
      },
    });
    const initial = await manager.launch(STUB_SNAPSHOT, "Explore", "work", launchOptions());
    const id = initial.kind === "detached" ? initial.agentId : initial.record.id;
    const record = manager.getRecord(id)!;
    await record.settlement;
    const resumed = await manager.resume(id, "continue", "detached", undefined);
    expect(resumed).toEqual({ kind: "detached", agentId: id, runId: 2 });
    await record.settlement;
    expect(session.stub.resumeTurnLoop).toHaveBeenCalledWith("continue", expect.any(AbortSignal));
    expect(send).toHaveBeenCalledOnce();
    expect(record.consumed).toBe(true);
    await manager.dispose();
  });

  it("runs sibling joined AgentTool calls through shared FIFO capacity and parent cancellation", async () => {
    const first = createSessionFactory();
    const firstGate = deferred<any>();
    first.stub.runTurnLoop.mockImplementation(() => firstGate.promise);
    const second = createSessionFactory();
    const third = createSessionFactory();
    let calls = 0;
    const factory = vi.fn(async (params: any) => {
      calls++;
      return calls === 1 ? first.factory(params) : calls === 2 ? second.factory(params) : third.factory(params);
    });
    const manager = makeManager(factory);
    const deps = createToolDeps({ manager: manager as any });
    const tool = new AgentTool(deps.manager, deps.runtime, deps.settings, deps.registry, deps.agentDir);
    const params = { prompt: "work", description: "joined", subagent_type: "general-purpose", mode: "joined" };
    const firstCall = tool.execute("tc-1", params, new AbortController().signal, undefined, undefined);
    await vi.waitFor(() => expect(first.stub.runTurnLoop).toHaveBeenCalled());
    const secondCall = tool.execute("tc-2", params, new AbortController().signal, undefined, undefined);
    const thirdController = new AbortController();
    const thirdCall = tool.execute("tc-3", params, thirdController.signal, undefined, undefined);
    await vi.waitFor(() => expect(manager.listAgents()).toHaveLength(3));
    expect(factory).toHaveBeenCalledOnce();
    thirdController.abort(new Error("parent cancelled"));
    firstGate.resolve({ responseText: "first" });
    const firstResult = await firstCall;
    const secondResult = await secondCall;
    const thirdResult = await thirdCall;
    expect(factory).toHaveBeenCalledTimes(2);
    expect(firstResult.content[0].text).toContain("Agent completed");
    expect(secondResult.content[0].text).toContain("Agent completed");
    expect(thirdResult.content[0].text).toContain("parent cancelled");
    const records = manager.listAgents();
    expect(records.find((record) => record.toolCallId === "tc-1")?.stateTerminalReason).toBe("completed");
    expect(records.find((record) => record.toolCallId === "tc-2")?.stateTerminalReason).toBe("completed");
    expect(records.find((record) => record.toolCallId === "tc-3")?.stateTerminalReason).toBe("parent_cancelled");
    await manager.dispose();
  });

  it("forwards a parent signal to the child turn loop", async () => {
    const session = createSessionFactory();
    const controller = new AbortController();
    session.stub.runTurnLoop.mockImplementation(async (_prompt: string, opts: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => opts.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { responseText: "partial" };
    });
    const manager = makeManager(session.factory);
    const launch = manager.launch(STUB_SNAPSHOT, "Explore", "work", launchOptions("joined", { signal: controller.signal }));
    await vi.waitFor(() => expect(session.stub.runTurnLoop).toHaveBeenCalled());
    const record = manager.listAgents()[0];
    controller.abort(new Error("parent cancelled"));
    const outcome = await launch;
    expect(outcome.kind).toBe("joined");
    expect(record.status).toBe("stopped");
    expect(record.stateTerminalReason).toBe("parent_cancelled");
    await manager.dispose();
  });
});
