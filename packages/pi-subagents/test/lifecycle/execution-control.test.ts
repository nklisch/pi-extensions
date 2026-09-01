import { describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { NotificationManager } from "#src/observation/notification";
import { SubagentEventsObserver } from "#src/observation/subagent-events-observer";
import { PARENT_ONLY_TOOL_NAMES, PARENT_ONLY_TOOL_SET } from "#src/tools/parent-tool-registry";
import { createSessionFactory } from "#test/helpers/manager-stubs";
import { makeModel } from "#test/helpers/make-model";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";

const snapshot: ParentSnapshot = {
  cwd: "/tmp/project",
  systemPrompt: "",
  model: makeModel({ id: "parent-model" }),
  modelRegistry: { find: vi.fn(), getAvailable: () => [] },
};

function makeManager(factory: (params: any) => Promise<any>, limiter = new ConcurrencyLimiter(() => 1)) {
  return new SubagentManager({ baseCwd: snapshot.cwd, limiter, createSubagentSession: factory });
}

const options = (mode: "joined" | "detached" = "detached") => ({ description: "test run", mode, origin: "tool" as const });

describe("joined and detached execution control", () => {
  it("returns detached identity without waiting and joined records after settlement", async () => {
    const detachedSession = createSessionFactory();
    const manager = makeManager(detachedSession.factory);
    const detached = await manager.launch(snapshot, "Explore", "detached task", options());
    expect(detached.kind).toBe("detached");
    expect(detached).toHaveProperty("agentId");
    const detachedRecord = manager.getRecord((detached as { agentId: string }).agentId)!;
    await detachedRecord.settlement;
    expect(detachedRecord.status).toBe("completed");

    const joinedSession = createSessionFactory();
    const joinedManager = makeManager(joinedSession.factory);
    const joined = await joinedManager.launch(snapshot, "Explore", "joined task", options("joined"));
    expect(joined.kind).toBe("joined");
    if (joined.kind !== "joined") throw new Error("expected joined delivery");
    expect(joined.record.status).toBe("completed");
    expect(joined.record.result).toBe("done");

    await manager.dispose();
    await joinedManager.dispose();
  });

  it("cancels a queued record immediately without creating a child session", async () => {
    let release!: () => void;
    const first = createSessionFactory();
    first.stub.runTurnLoop.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ responseText: "first" }); }));
    const second = createSessionFactory();
    const calls = vi.fn(async (params: any) => {
      if (calls.mock.calls.length === 1) return first.factory(params);
      return second.factory(params);
    });
    const manager = makeManager(calls);
    const firstLaunch = await manager.launch(snapshot, "Explore", "first", options());
    await vi.waitFor(() => expect(first.stub.runTurnLoop).toHaveBeenCalled());
    const secondLaunch = await manager.launch(snapshot, "Explore", "second", options());
    const secondId = (secondLaunch as { agentId: string }).agentId;
    expect(manager.getRecord(secondId)!.status).toBe("queued");

    const stopped = await manager.stop(secondId, 1);
    expect(stopped.kind).toBe("stopped");
    if (stopped.kind !== "stopped") throw new Error("expected stopped delivery");
    expect(stopped.record.status).toBe("stopped");
    expect(stopped.reason).toBe("explicit_stop");
    expect(second.factory).not.toHaveBeenCalled();

    release();
    await manager.getRecord((firstLaunch as { agentId: string }).agentId)!.settlement;
    await manager.dispose();
  });

  it("keeps an uncooperative running child active after bounded stop wait", async () => {
    let release!: () => void;
    const session = createSessionFactory();
    session.stub.runTurnLoop.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ responseText: "partial" }); }));
    const manager = makeManager(session.factory);
    const launch = await manager.launch(snapshot, "Explore", "long task", options());
    const id = (launch as { agentId: string }).agentId;
    await vi.waitFor(() => expect(session.stub.runTurnLoop).toHaveBeenCalled());

    const outcome = await manager.stop(id, 0.001);
    expect(outcome.kind).toBe("stop_pending");
    expect(manager.getRecord(id)!.isActive()).toBe(true);
    expect(manager.getRecord(id)!.stopRequested).toBe(true);

    release();
    await manager.getRecord(id)!.settlement;
    expect(manager.getRecord(id)!.status).toBe("stopped");
    expect(manager.getRecord(id)!.stateTerminalReason).toBe("explicit_stop");
    await manager.dispose();
  });

  it("attributes parent cancellation before admission and does not create a child session", async () => {
    const factory = createSessionFactory();
    const limiter = new ConcurrencyLimiter(() => 0);
    const manager = makeManager(factory.factory, limiter);
    const controller = new AbortController();
    const launchPromise = manager.launch(snapshot, "Explore", "queued joined", { ...options("joined"), signal: controller.signal });
    await vi.waitFor(() => expect(manager.listAgents()).toHaveLength(1));
    controller.abort(new Error("parent stopped"));
    const outcome = await launchPromise;
    expect(outcome.kind).toBe("joined");
    if (outcome.kind !== "joined") throw new Error("expected joined delivery");
    expect(outcome.record.status).toBe("stopped");
    expect(outcome.record.stateTerminalReason).toBe("parent_cancelled");
    expect(factory.factory).not.toHaveBeenCalled();
    await manager.dispose();
  });

  it("emits one detached completion nudge with the current run metadata", async () => {
    const messages: unknown[] = [];
    const notifications = new NotificationManager((message) => messages.push(message));
    const emitted: string[] = [];
    const observer = new SubagentEventsObserver({
      emit: (channel) => emitted.push(channel),
      appendEntry: () => undefined,
      notifications,
    });
    const session = createSessionFactory();
    const manager = new SubagentManager({
      baseCwd: snapshot.cwd,
      limiter: new ConcurrencyLimiter(() => 1),
      createSubagentSession: session.factory,
      observer,
    });
    const launch = await manager.launch(snapshot, "Explore", "notify me", options());
    const id = (launch as { agentId: string }).agentId;
    await manager.getRecord(id)!.settlement;
    expect(emitted).toContain("subagents:completed");
    expect(messages).toHaveLength(1);
    expect((messages[0] as { details: { mode: string; runId: number; status: string } }).details).toMatchObject({ mode: "detached", runId: 1, status: "completed" });
    await manager.dispose();
    notifications.dispose();
  });

  it("increments run id and resets terminal state for detached resume", async () => {
    const session = createSessionFactory();
    const manager = makeManager(session.factory);
    const launch = await manager.launch(snapshot, "Explore", "initial", options());
    const id = (launch as { agentId: string }).agentId;
    await manager.getRecord(id)!.settlement;
    const resumed = await manager.resume(id, "continue", "detached", undefined);
    expect(resumed).toMatchObject({ kind: "detached", agentId: id, runId: 2 });
    await manager.getRecord(id)!.settlement;
    expect(manager.getRecord(id)!.runId).toBe(2);
    expect(manager.getRecord(id)!.status).toBe("completed");
    expect(session.stub.resumeTurnLoop).toHaveBeenCalledWith("continue", expect.any(AbortSignal));
    await manager.dispose();
  });

  it("keeps a stop during session creation pending until creation and teardown settle", async () => {
    let createSession!: (params: any) => void;
    const session = createSessionFactory();
    const factory = vi.fn(() => new Promise((resolve) => { createSession = resolve; }));
    const manager = makeManager(factory as any);
    const launch = await manager.launch(snapshot, "Explore", "create slowly", options());
    const id = (launch as { agentId: string }).agentId;
    await vi.waitFor(() => expect(factory).toHaveBeenCalled());
    const pending = await manager.stop(id, 0.001);
    expect(pending.kind).toBe("stop_pending");
    expect(manager.getRecord(id)!.isActive()).toBe(true);
    createSession(session.stub as any);
    await manager.getRecord(id)!.settlement;
    expect(manager.getRecord(id)!.status).toBe("stopped");
    expect(manager.getRecord(id)!.stateTerminalReason).toBe("explicit_stop");
    await manager.dispose();
  });

  it("starts runtime deadlines only after admission", async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = createSessionFactory();
    first.stub.runTurnLoop.mockImplementation(() => new Promise((resolve) => { releaseFirst = () => resolve({ responseText: "first" }); }));
    const second = createSessionFactory();
    second.stub.runTurnLoop.mockImplementation(() => new Promise((resolve) => { releaseSecond = () => resolve({ responseText: "second" }); }));
    let call = 0;
    const factory = vi.fn(async (params: any) => (++call === 1 ? first.factory(params) : second.factory(params)));
    const manager = makeManager(factory);
    const firstLaunch = await manager.launch(snapshot, "Explore", "first", options());
    await vi.waitFor(() => expect(first.stub.runTurnLoop).toHaveBeenCalled());
    const secondLaunch = await manager.launch(snapshot, "Explore", "second", { ...options(), timeoutSeconds: 0.01 });
    const secondId = (secondLaunch as { agentId: string }).agentId;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manager.getRecord(secondId)!.status).toBe("queued");
    expect(manager.getRecord(secondId)!.stopRequested).toBe(false);
    releaseFirst();
    await vi.waitFor(() => expect(second.stub.runTurnLoop).toHaveBeenCalled());
    await vi.waitFor(() => expect(manager.getRecord(secondId)!.stopRequested).toBe(true));
    releaseSecond();
    await manager.getRecord(secondId)!.settlement;
    expect(manager.getRecord(secondId)!.stateTerminalReason).toBe("runtime_timeout");
    await manager.getRecord((firstLaunch as { agentId: string }).agentId)!.settlement;
    await manager.dispose();
  });

  it("uses the same terminal reason path for provider failures", async () => {
    const session = createSessionFactory();
    session.stub.runTurnLoop.mockResolvedValue({ responseText: "partial", failure: "provider unavailable" });
    const manager = makeManager(session.factory);
    const outcome = await manager.launch(snapshot, "Explore", "fails", options("joined"));
    expect(outcome.kind).toBe("joined");
    if (outcome.kind !== "joined") throw new Error("expected joined delivery");
    expect(outcome.record.status).toBe("error");
    expect(outcome.record.stateTerminalReason).toBe("provider_failure");
    expect(outcome.record.error).toBe("provider unavailable");
    await manager.dispose();
  });

  it("reports workspace teardown failures instead of claiming cancellation success", async () => {
    const session = createSessionFactory();
    const manager = makeManager(session.factory);
    manager.registerWorkspaceProvider({
      prepare: async () => ({ cwd: "/tmp/workspace", dispose: () => { throw new Error("teardown failed"); } }),
    });
    const outcome = await manager.launch(snapshot, "Explore", "workspace", options("joined"));
    expect(outcome.kind).toBe("joined");
    if (outcome.kind !== "joined") throw new Error("expected joined delivery");
    expect(outcome.record.status).toBe("error");
    expect(outcome.record.stateTerminalReason).toBe("workspace_teardown_failure");
    await manager.dispose();
  });

  it("does not treat an execution failure as a settled cancellation", async () => {
    let rejectRun!: (error: Error) => void;
    const session = createSessionFactory();
    session.stub.runTurnLoop.mockImplementation(() => new Promise((_resolve, reject) => { rejectRun = reject; }));
    const manager = makeManager(session.factory);
    const launch = manager.launch(snapshot, "Explore", "fails", options("joined"));
    const record = manager.listAgents()[0];
    await vi.waitFor(() => expect(session.stub.runTurnLoop).toHaveBeenCalled());
    record.requestStop("explicit_stop");
    rejectRun(new Error("child execution failed"));
    const outcome = await launch;
    expect(outcome.kind).toBe("joined");
    if (outcome.kind !== "joined") throw new Error("expected joined delivery");
    expect(outcome.record.status).toBe("error");
    expect(outcome.record.stateTerminalReason).toBe("execution_failure");
    await manager.dispose();
  });

  it("uses one parent-only tool registry for recursion filtering", () => {
    expect(PARENT_ONLY_TOOL_NAMES).toEqual([
      "subagent", "resume_subagent", "stop_subagent", "steer_subagent", "list_subagents", "get_subagent_result", "query_subagent_session",
    ]);
    for (const name of PARENT_ONLY_TOOL_NAMES) expect(PARENT_ONLY_TOOL_SET.has(name)).toBe(true);
  });

  it("does not allow a detached caller that is already cancelled to create a record", async () => {
    const factory = createSessionFactory();
    const manager = makeManager(factory.factory);
    const controller = new AbortController();
    controller.abort(new Error("cancelled before launch"));
    await expect(manager.launch(snapshot, "Explore", "cancelled", { ...options(), signal: controller.signal })).rejects.toThrow("cancelled before launch");
    expect(manager.listAgents()).toHaveLength(0);
    await manager.dispose();
  });
});
