import { describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { SubagentState } from "#src/lifecycle/subagent-state";

function makeTask() {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const task = vi.fn(() => promise);
  return { promise, task, resolve, reject };
}

describe("retained SubagentState behavior", () => {
  it("defaults startedAt to a timestamp when not provided", () => {
    const before = Date.now();
    const state = new SubagentState();
    const after = Date.now();
    expect(state.startedAt).toBeGreaterThanOrEqual(before);
    expect(state.startedAt).toBeLessThanOrEqual(after);
  });

  it("passes through optional transition fields", () => {
    const state = new SubagentState({ status: "completed", result: "done", error: "oops", startedAt: 1000, completedAt: 2000, terminalReason: "completed" });
    expect(state.status).toBe("completed");
    expect(state.result).toBe("done");
    expect(state.error).toBe("oops");
    expect(state.startedAt).toBe(1000);
    expect(state.completedAt).toBe(2000);
    expect(state.terminalReason).toBe("completed");
  });

  it("leaves optional fields undefined when not provided", () => {
    const state = new SubagentState();
    expect(state.result).toBeUndefined();
    expect(state.error).toBeUndefined();
    expect(state.completedAt).toBeUndefined();
    expect(state.terminalReason).toBeUndefined();
  });

  it("sets status to running and updates startedAt", () => {
    const state = new SubagentState({ status: "queued", startedAt: 1000 });
    state.markRunning(2000);
    expect(state.status).toBe("running");
    expect(state.startedAt).toBe(2000);
  });

  it("sets completed result and terminal reason", () => {
    const state = new SubagentState({ status: "running" });
    state.markCompleted("all done", "completed", 5000);
    expect(state.status).toBe("completed");
    expect(state.result).toBe("all done");
    expect(state.completedAt).toBe(5000);
    expect(state.terminalReason).toBe("completed");
  });

  it("records a graceful turn-limit completion distinctly", () => {
    const state = new SubagentState({ status: "running" });
    state.markCompleted("wrap up", "turn_limit_graceful", 5000);
    expect(state.status).toBe("completed");
    expect(state.terminalReason).toBe("turn_limit_graceful");
  });

  it("defaults completedAt when marking completed", () => {
    const state = new SubagentState({ status: "running" });
    const before = Date.now();
    state.markCompleted("done", "completed");
    const after = Date.now();
    expect(state.completedAt).toBeGreaterThanOrEqual(before);
    expect(state.completedAt).toBeLessThanOrEqual(after);
  });

  it("sets stopped result and explicit reason", () => {
    const state = new SubagentState({ status: "running" });
    state.markStopped("partial", "explicit_stop", 3000);
    expect(state.status).toBe("stopped");
    expect(state.result).toBe("partial");
    expect(state.completedAt).toBe(3000);
    expect(state.terminalReason).toBe("explicit_stop");
  });

  it("records parent cancellation as a stopped terminal reason", () => {
    const state = new SubagentState({ status: "running" });
    state.markStopped(undefined, "parent_cancelled", 3000);
    expect(state.status).toBe("stopped");
    expect(state.terminalReason).toBe("parent_cancelled");
  });

  it("records runtime timeout as a stopped terminal reason", () => {
    const state = new SubagentState({ status: "running" });
    state.markStopped("partial", "runtime_timeout", 3000);
    expect(state.terminalReason).toBe("runtime_timeout");
  });

  it("records a hard turn-limit stop", () => {
    const state = new SubagentState({ status: "running" });
    state.markStopped("partial", "turn_limit_hard", 3000);
    expect(state.status).toBe("stopped");
    expect(state.terminalReason).toBe("turn_limit_hard");
  });

  it("defaults completedAt when marking stopped", () => {
    const state = new SubagentState({ status: "running" });
    const before = Date.now();
    state.markStopped(undefined, "explicit_stop");
    const after = Date.now();
    expect(state.completedAt).toBeGreaterThanOrEqual(before);
    expect(state.completedAt).toBeLessThanOrEqual(after);
  });

  it("records provider errors and preserves partial output", () => {
    const state = new SubagentState({ status: "running" });
    state.markError(new Error("something broke"), "provider_failure", "partial", 6000);
    expect(state.status).toBe("error");
    expect(state.error).toBe("something broke");
    expect(state.result).toBe("partial");
    expect(state.completedAt).toBe(6000);
    expect(state.terminalReason).toBe("provider_failure");
  });

  it("formats non-Error failures with String", () => {
    const state = new SubagentState({ status: "running" });
    state.markError(42, "execution_failure", undefined, 6000);
    expect(state.error).toBe("42");
    expect(state.terminalReason).toBe("execution_failure");
  });

  it("omits whitespace-only error result output", () => {
    const state = new SubagentState({ status: "running" });
    state.markError(new Error("boom"), "provider_failure", "  ", 6000);
    expect(state.result).toBeUndefined();
  });

  it("marks consumed once and preserves the first consumption time", () => {
    const state = new SubagentState({ status: "completed" });
    state.markConsumed(1000);
    state.markConsumed(2000);
    expect(state.consumed).toBe(true);
    expect(state.consumedAt).toBe(1000);
  });

  it("increments tool uses independently", () => {
    const state = new SubagentState();
    state.incrementToolUses();
    state.incrementToolUses();
    expect(state.toolUses).toBe(2);
  });

  it("accumulates usage deltas", () => {
    const state = new SubagentState();
    state.addUsage({ input: 100, output: 50, cacheWrite: 10 });
    state.addUsage({ input: 200, output: 80, cacheWrite: 20 });
    expect(state.lifetimeUsage).toEqual({ input: 300, output: 130, cacheWrite: 30 });
  });

  it("increments compactions independently", () => {
    const state = new SubagentState();
    state.incrementCompactions();
    state.incrementCompactions();
    expect(state.compactionCount).toBe(2);
  });

  it("resets terminal fields for a queued resume lease", () => {
    const state = new SubagentState({ status: "error", result: "old", error: "bad", completedAt: 5000, terminalReason: "provider_failure", consumedAt: 6000 });
    state.resetForResume();
    expect(state.status).toBe("queued");
    expect(state.completedAt).toBeUndefined();
    expect(state.result).toBeUndefined();
    expect(state.error).toBeUndefined();
    expect(state.terminalReason).toBeUndefined();
    expect(state.consumed).toBe(false);
  });

  it("clears live activity when resetting for resume", () => {
    const state = new SubagentState({ status: "completed", turnCount: 4, activeTools: new Map([["read_1", "read"]]), responseText: "old" });
    state.resetForResume();
    expect(state.turnCount).toBe(1);
    expect(state.activeTools.size).toBe(0);
    expect(state.responseText).toBe("");
  });

  it("increments turnCount", () => {
    const state = new SubagentState();
    state.incrementTurnCount();
    state.incrementTurnCount();
    expect(state.turnCount).toBe(3);
  });

  it("adds same-name active tools under unique keys", () => {
    const state = new SubagentState();
    state.addActiveTool("Read");
    state.addActiveTool("Read");
    expect(state.activeTools.size).toBe(2);
    expect(new Set(state.activeTools.keys()).size).toBe(2);
    expect([...state.activeTools.values()]).toEqual(["Read", "Read"]);
  });

  it("removes only the first matching active tool", () => {
    const state = new SubagentState();
    state.addActiveTool("Read");
    state.addActiveTool("Read");
    state.removeActiveTool("Read");
    expect(state.activeTools.size).toBe(1);
    expect([...state.activeTools.values()]).toEqual(["Read"]);
  });

  it("does nothing when removing an inactive tool", () => {
    const state = new SubagentState();
    state.addActiveTool("Read");
    state.removeActiveTool("Write");
    expect([...state.activeTools.values()]).toEqual(["Read"]);
  });

  it("concatenates and resets response text", () => {
    const state = new SubagentState();
    state.appendResponseText("Hello ");
    state.appendResponseText("world");
    expect(state.responseText).toBe("Hello world");
    state.resetResponseText();
    expect(state.responseText).toBe("");
  });
});

describe("retained ConcurrencyLimiter behavior", () => {
  it("runs a task immediately when a slot is free", () => {
    const limiter = new ConcurrencyLimiter(() => 2);
    const task = makeTask();
    limiter.schedule(task.task);
    expect(task.task).toHaveBeenCalledOnce();
  });

  it("runs tasks up to the limit and queues the rest", () => {
    const limiter = new ConcurrencyLimiter(() => 2);
    const a = makeTask(); const b = makeTask(); const c = makeTask();
    limiter.schedule(a.task); limiter.schedule(b.task); limiter.schedule(c.task);
    expect(a.task).toHaveBeenCalledOnce();
    expect(b.task).toHaveBeenCalledOnce();
    expect(c.task).not.toHaveBeenCalled();
    expect(limiter.activeCount).toBe(2);
    expect(limiter.queuedCount).toBe(1);
  });

  it("starts the next pending task when an active task settles", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const first = makeTask(); const next = makeTask();
    limiter.schedule(first.task); limiter.schedule(next.task);
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(next.task).toHaveBeenCalledOnce();
  });

  it("starts pending tasks in scheduling order", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const order: string[] = [];
    const first = makeTask(); const second = makeTask(); const third = makeTask();
    first.task.mockImplementation(() => { order.push("first"); return first.promise; });
    second.task.mockImplementation(() => { order.push("second"); return second.promise; });
    third.task.mockImplementation(() => { order.push("third"); return third.promise; });
    limiter.schedule(first.task); limiter.schedule(second.task); limiter.schedule(third.task);
    expect(order).toEqual(["first"]);
    first.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(["first", "second"]);
    second.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(["first", "second", "third"]);
    third.resolve();
  });

  it("resolves the handle promise when the task resolves", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const task = makeTask();
    const handle = limiter.schedule(task.task);
    task.resolve();
    await expect(handle.promise).resolves.toBeUndefined();
  });

  it("rejects the handle promise when the task rejects", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const task = makeTask();
    const handle = limiter.schedule(task.task);
    task.reject(new Error("boom"));
    await expect(handle.promise).rejects.toThrow("boom");
  });

  it("frees the slot for the next task when a task rejects", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const failed = makeTask(); const next = makeTask();
    const handle = limiter.schedule(failed.task);
    limiter.schedule(next.task);
    failed.reject(new Error("boom"));
    await expect(handle.promise).rejects.toThrow("boom");
    await Promise.resolve(); await Promise.resolve();
    expect(next.task).toHaveBeenCalledOnce();
    next.resolve();
  });

  it("starts newly admissible pending tasks when the limit grows", () => {
    let limit = 1;
    const limiter = new ConcurrencyLimiter(() => limit);
    const first = makeTask(); const next = makeTask();
    limiter.schedule(first.task); limiter.schedule(next.task);
    limit = 2;
    limiter.recheck();
    expect(next.task).toHaveBeenCalledOnce();
  });

  it("does nothing when no slot is free", () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const first = makeTask(); const next = makeTask();
    limiter.schedule(first.task); limiter.schedule(next.task);
    limiter.recheck();
    expect(next.task).not.toHaveBeenCalled();
  });

  it("re-evaluates a lowered dynamic limit without evicting active work", () => {
    let limit = 2;
    const limiter = new ConcurrencyLimiter(() => limit);
    const a = makeTask(); const b = makeTask(); const c = makeTask();
    limiter.schedule(a.task); limiter.schedule(b.task); limiter.schedule(c.task);
    limit = 1;
    limiter.recheck();
    expect(c.task).not.toHaveBeenCalled();
    a.resolve(); b.resolve(); c.resolve();
  });

  it("drops a pending task through its owner cancellation handle", () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const active = makeTask(); const pending = makeTask();
    limiter.schedule(active.task);
    const handle = limiter.schedule(pending.task);
    handle.cancel();
    active.resolve();
    expect(pending.task).not.toHaveBeenCalled();
    expect(limiter.queuedCount).toBe(0);
  });

  it("resolves a cancelled pending handle", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const active = makeTask();
    limiter.schedule(active.task);
    const dropped = limiter.schedule(makeTask().task);
    dropped.cancel();
    await expect(dropped.promise).resolves.toBeUndefined();
    active.resolve();
  });

  it("does not disturb already-running tasks when cancelling a queued sibling", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const active = makeTask();
    const handle = limiter.schedule(active.task);
    const queued = limiter.schedule(makeTask().task);
    queued.cancel();
    expect(handle.admitted).toBe(true);
    active.resolve();
    await expect(handle.promise).resolves.toBeUndefined();
  });

  it("contains a synchronous task throw and drains the next task", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const next = makeTask();
    const failed = limiter.schedule(() => { throw new Error("sync boom"); });
    limiter.schedule(next.task);
    await expect(failed.promise).rejects.toThrow("sync boom");
    await Promise.resolve(); await Promise.resolve();
    expect(next.task).toHaveBeenCalledOnce();
    next.resolve();
  });
});
