import { describe, expect, it, vi } from "vitest";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { createSessionFactory } from "#test/helpers/manager-stubs";
import { makeModel } from "#test/helpers/make-model";

const snapshot: ParentSnapshot = {
  cwd: "/tmp/project", systemPrompt: "", model: makeModel({ id: "parent" }),
  modelRegistry: { find: vi.fn(), getAvailable: () => [] },
};
const opts = (mode: "joined" | "detached" = "detached") => ({ description: "task", mode, origin: "tool" as const });
function manager(factory: any, limiter = new ConcurrencyLimiter(() => 1)) {
  return new SubagentManager({ baseCwd: snapshot.cwd, limiter, createSubagentSession: factory });
}

async function detachedId(mgr: SubagentManager, factory: any, mode: "joined" | "detached" = "detached") {
  const outcome = await mgr.launch(snapshot, "Explore", "task", opts(mode));
  if (outcome.kind === "detached") return outcome.agentId;
  return outcome.record.id;
}

describe("SubagentManager", () => {
  it("creates a detached record and settles it through the injected session", async () => {
    const session = createSessionFactory();
    const mgr = manager(session.factory);
    const id = await detachedId(mgr, session.factory);
    const record = mgr.getRecord(id)!;
    await record.settlement;
    expect(record.status).toBe("completed");
    expect(record.result).toBe("done");
    expect(record.runId).toBe(1);
    await mgr.dispose();
  });

  it("awaits joined launch and preserves current run metadata", async () => {
    const session = createSessionFactory();
    const mgr = manager(session.factory);
    const outcome = await mgr.launch(snapshot, "Explore", "task", opts("joined"));
    expect(outcome.kind).toBe("joined");
    if (outcome.kind !== "joined") throw new Error("expected joined");
    expect(outcome.record.status).toBe("completed");
    expect(outcome.record.mode).toBe("joined");
    await mgr.dispose();
  });

  it("queues excess work and admits it in FIFO order", async () => {
    const first = createSessionFactory();
    let release!: () => void;
    first.stub.runTurnLoop.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ responseText: "first" }); }));
    const second = createSessionFactory();
    const calls = vi.fn(async (params: any) => calls.mock.calls.length === 1 ? first.factory(params) : second.factory(params));
    const mgr = manager(calls);
    const firstResult = await mgr.launch(snapshot, "Explore", "first", opts());
    await vi.waitFor(() => expect(first.stub.runTurnLoop).toHaveBeenCalled());
    const secondResult = await mgr.launch(snapshot, "Explore", "second", opts());
    const secondId = (secondResult as { agentId: string }).agentId;
    expect(mgr.getRecord(secondId)!.status).toBe("queued");
    expect(second.factory).not.toHaveBeenCalled();
    release();
    await mgr.getRecord((firstResult as { agentId: string }).agentId)!.settlement;
    await mgr.getRecord(secondId)!.settlement;
    expect(second.factory).toHaveBeenCalledOnce();
    await mgr.dispose();
  });

  it("stops queued work without creating a session", async () => {
    const first = createSessionFactory();
    let release!: () => void;
    first.stub.runTurnLoop.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ responseText: "first" }); }));
    const second = createSessionFactory();
    let call = 0;
    const factory = vi.fn(async (params: any) => ++call === 1 ? first.factory(params) : second.factory(params));
    const mgr = manager(factory);
    const firstResult = await mgr.launch(snapshot, "Explore", "first", opts());
    await vi.waitFor(() => expect(first.stub.runTurnLoop).toHaveBeenCalled());
    const secondResult = await mgr.launch(snapshot, "Explore", "second", opts());
    const id = (secondResult as { agentId: string }).agentId;
    const stopped = await mgr.stop(id, 1);
    expect(stopped.kind).toBe("stopped");
    expect(mgr.getRecord(id)!.status).toBe("stopped");
    expect(second.factory).not.toHaveBeenCalled();
    release();
    await mgr.getRecord((firstResult as { agentId: string }).agentId)!.settlement;
    await mgr.dispose();
  });

  it("reports stop-pending without lying about an uncooperative child", async () => {
    const session = createSessionFactory();
    let release!: () => void;
    session.stub.runTurnLoop.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ responseText: "partial" }); }));
    const mgr = manager(session.factory);
    const id = await detachedId(mgr, session.factory);
    await vi.waitFor(() => expect(session.stub.runTurnLoop).toHaveBeenCalled());
    const stopped = await mgr.stop(id, 0.001);
    expect(stopped.kind).toBe("stop_pending");
    expect(mgr.getRecord(id)!.isActive()).toBe(true);
    expect(mgr.getRecord(id)!.stopRequested).toBe(true);
    release();
    await mgr.getRecord(id)!.settlement;
    await mgr.dispose();
  });

  it("returns discriminated outcomes for stop, steer, list, and result queries", async () => {
    const session = createSessionFactory();
    const mgr = manager(session.factory);
    const id = await detachedId(mgr, session.factory);
    const record = mgr.getRecord(id)!;
    await record.settlement;
    expect((await mgr.stop(id)).kind).toBe("already_terminal");
    expect((await mgr.stop("missing")).kind).toBe("not_found");
    expect((await mgr.steer("missing", "hi")).kind).toBe("not_found");
    expect(mgr.listAgents()).toContain(record);
    expect(mgr.hasRunning()).toBe(false);
    await mgr.dispose();
  });

  it("resumes a retained session as a new lease", async () => {
    const session = createSessionFactory();
    session.stub.resumeTurnLoop.mockResolvedValue({ text: "resumed" });
    const mgr = manager(session.factory);
    const id = await detachedId(mgr, session.factory);
    await mgr.getRecord(id)!.settlement;
    const outcome = await mgr.resume(id, "continue", "joined", undefined);
    expect(outcome.kind).toBe("joined");
    expect(mgr.getRecord(id)!.runId).toBe(2);
    expect(mgr.getRecord(id)!.result).toBe("resumed");
    await mgr.dispose();
  });

  it("forwards lifecycle observers and persists terminal records", async () => {
    const session = createSessionFactory();
    const observer = { onSubagentCreated: vi.fn(), onSubagentStarted: vi.fn(), onSubagentCompleted: vi.fn(), onSubagentCompacted: vi.fn() };
    const mgr = new SubagentManager({ baseCwd: snapshot.cwd, limiter: new ConcurrencyLimiter(() => 1), createSubagentSession: session.factory, observer });
    const id = await detachedId(mgr, session.factory);
    await mgr.getRecord(id)!.settlement;
    expect(observer.onSubagentCreated).toHaveBeenCalledWith(expect.objectContaining({ id }));
    expect(observer.onSubagentStarted).toHaveBeenCalledOnce();
    expect(observer.onSubagentCompleted).toHaveBeenCalledOnce();
    await mgr.dispose();
  });
});
