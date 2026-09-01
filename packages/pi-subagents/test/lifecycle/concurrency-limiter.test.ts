import { describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve, task: vi.fn(() => promise) };
}

describe("ConcurrencyLimiter", () => {
  it("admits up to the dynamic limit", () => {
    const limiter = new ConcurrencyLimiter(() => 2);
    const a = gate(); const b = gate(); const c = gate();
    limiter.schedule(a.task); limiter.schedule(b.task); limiter.schedule(c.task);
    expect(a.task).toHaveBeenCalledOnce();
    expect(b.task).toHaveBeenCalledOnce();
    expect(c.task).not.toHaveBeenCalled();
    expect(limiter.activeCount).toBe(2);
    expect(limiter.queuedCount).toBe(1);
  });

  it("drains queued work FIFO when a slot settles", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const a = gate(); const b = gate(); const c = gate();
    limiter.schedule(a.task); limiter.schedule(b.task); limiter.schedule(c.task);
    a.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(b.task).toHaveBeenCalledOnce();
    b.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(c.task).toHaveBeenCalledOnce();
  });

  it("exposes a settlement promise and cancellation removes queued work", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const active = gate(); const queued = gate();
    limiter.schedule(active.task);
    const handle = limiter.schedule(queued.task);
    handle.cancel();
    await expect(handle.promise).resolves.toBeUndefined();
    expect(queued.task).not.toHaveBeenCalled();
    active.resolve();
    expect(limiter.queuedCount).toBe(0);
  });

  it("marks admitted handles and resolves normal completion", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const work = gate();
    const handle = limiter.schedule(work.task);
    expect(handle.admitted).toBe(true);
    work.resolve();
    await expect(handle.promise).resolves.toBeUndefined();
    expect(limiter.activeCount).toBe(0);
  });

  it("forwards task failures through the handle and frees the slot", async () => {
    const next = gate();
    const limiter = new ConcurrencyLimiter(() => 1);
    const handle = limiter.schedule(async () => { throw new Error("boom"); });
    limiter.schedule(next.task);
    await expect(handle.promise).rejects.toThrow("boom");
    await Promise.resolve(); await Promise.resolve();
    expect(next.task).toHaveBeenCalledOnce();
  });

  it("starts newly admissible work after a limit increase", () => {
    let limit = 1;
    const limiter = new ConcurrencyLimiter(() => limit);
    const a = gate(); const b = gate();
    limiter.schedule(a.task); limiter.schedule(b.task);
    limit = 2;
    limiter.recheck();
    expect(b.task).toHaveBeenCalledOnce();
  });

  it("does not start work when the limit is saturated", () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const a = gate(); const b = gate();
    limiter.schedule(a.task); limiter.schedule(b.task);
    limiter.recheck();
    expect(b.task).not.toHaveBeenCalled();
  });

  it("handles a synchronous task throw without losing the queue", async () => {
    const limiter = new ConcurrencyLimiter(() => 1);
    const next = gate();
    const failed = limiter.schedule(() => { throw new Error("sync boom"); });
    limiter.schedule(next.task);
    await expect(failed.promise).rejects.toThrow("sync boom");
    await Promise.resolve(); await Promise.resolve();
    expect(next.task).toHaveBeenCalledOnce();
  });
});
