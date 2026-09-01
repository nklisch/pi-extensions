import { describe, expect, it, vi } from "vitest";
import { LifecycleInterceptorError, LifecycleInterceptorRegistry, MAX_LIFECYCLE_CONTINUATION_ROUNDS } from "#src/lifecycle/lifecycle-interceptor";
import { RunListeners } from "#src/lifecycle/run-listeners";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function turn(registry: LifecycleInterceptorRegistry, signal = new AbortController().signal) {
  return registry.createTurnLifecycle({
    identity: { agentId: "agent-1", sessionId: "session-1", runId: 2, agentType: "Explore", parentSessionId: "parent" },
    execution: { phase: "resume", origin: "service", mode: "joined", admission: "queued" },
    signal,
  });
}

describe("retained lifecycle interceptor contracts", () => {
  it("rejects null and primitive registrations", () => {
    const registry = new LifecycleInterceptorRegistry();
    expect(() => registry.register(null as never)).toThrow(TypeError);
    expect(() => registry.register("bad" as never)).toThrow(TypeError);
  });

  it("returns undefined when no start callback transforms the prompt", async () => {
    const registry = new LifecycleInterceptorRegistry();
    expect(await turn(registry).beforeStart("prompt")).toBeUndefined();
    await registry.dispose();
  });

  it("runs start callbacks in registration order", async () => {
    const registry = new LifecycleInterceptorRegistry();
    const seen: string[] = [];
    registry.register({ beforeStart: (context) => { seen.push(`one:${context.prompt}`); return { action: "continue", prompt: `${context.prompt}:one` }; } });
    registry.register({ beforeStart: (context) => { seen.push(`two:${context.prompt}`); return { action: "continue", prompt: `${context.prompt}:two` }; } });
    expect(await turn(registry).beforeStart("work")).toEqual({ action: "continue", prompt: "work:one:two" });
    expect(seen).toEqual(["one:work", "two:work:one"]);
    await registry.dispose();
  });

  it("runs completion callbacks in registration order with transformed results", async () => {
    const registry = new LifecycleInterceptorRegistry();
    registry.register({ beforeComplete: (context) => ({ action: "complete", result: `${context.proposedResult}:one` }) });
    registry.register({ beforeComplete: (context) => ({ action: "complete", result: `${context.proposedResult}:two` }) });
    expect(await turn(registry).beforeComplete("answer", "completed", 0)).toEqual({ action: "complete", result: "answer:one:two" });
    await registry.dispose();
  });

  it("freezes callback identity and execution path snapshots", async () => {
    const registry = new LifecycleInterceptorRegistry();
    let seen: any;
    registry.register({ beforeStart: (context) => { seen = context; return undefined; } });
    await turn(registry).beforeStart("work");
    expect(Object.isFrozen(seen)).toBe(true);
    expect(Object.isFrozen(seen.identity)).toBe(true);
    expect(Object.isFrozen(seen.execution)).toBe(true);
    expect(seen.identity.runId).toBe(2);
    expect(seen.execution.admission).toBe("queued");
    await registry.dispose();
  });

  it("passes completion outcome and continuation round to providers", async () => {
    const registry = new LifecycleInterceptorRegistry();
    const callback = vi.fn(() => undefined);
    registry.register({ beforeComplete: callback });
    await turn(registry).beforeComplete("answer", "turn_limit_graceful", 2);
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ proposedResult: "answer", outcome: "turn_limit_graceful", continuationRound: 2, maxContinuationRounds: MAX_LIFECYCLE_CONTINUATION_ROUNDS }));
    await registry.dispose();
  });

  it("returns a completion abort decision unchanged", async () => {
    const registry = new LifecycleInterceptorRegistry();
    registry.register({ beforeComplete: () => ({ action: "abort", reason: "policy denied" }) });
    expect(await turn(registry).beforeComplete("answer", "completed", 0)).toEqual({ action: "abort", reason: "policy denied" });
    await registry.dispose();
  });

  it("rejects malformed start decisions", async () => {
    const registry = new LifecycleInterceptorRegistry();
    registry.register({ beforeStart: () => ({ action: "continue", prompt: 42 } as never) });
    await expect(turn(registry).beforeStart("work")).rejects.toThrow(/prompt must be a string/);
    await registry.dispose();
  });

  it("rejects malformed completion decisions", async () => {
    const registry = new LifecycleInterceptorRegistry();
    registry.register({ beforeComplete: () => ({ action: "continue", prompt: "" }) });
    await expect(turn(registry).beforeComplete("work", "completed", 0)).rejects.toThrow(/invalid decision/);
    await registry.dispose();
  });

  it("wraps callback failures without exposing callback details", async () => {
    const registry = new LifecycleInterceptorRegistry();
    registry.register({ beforeStart: () => { throw new Error("private detail"); } });
    await expect(turn(registry).beforeStart("work")).rejects.toBeInstanceOf(LifecycleInterceptorError);
    await expect(turn(registry).beforeStart("work")).rejects.not.toThrow("private detail");
    await registry.dispose();
  });

  it("keeps a captured ordered snapshot alive after unregistration", async () => {
    const registry = new LifecycleInterceptorRegistry();
    const gate = deferred<void>();
    const secondCallback = vi.fn();
    registry.register({ beforeStart: async () => { await gate.promise; } });
    const second = registry.register({ beforeStart: secondCallback });
    const pending = turn(registry).beforeStart("work");
    await Promise.resolve();
    await second.dispose();
    gate.resolve();
    await pending;
    expect(secondCallback).toHaveBeenCalledOnce();
    await registry.dispose();
  });

  it("unregisters a provider from future snapshots", async () => {
    const registry = new LifecycleInterceptorRegistry();
    const callback = vi.fn();
    const registration = registry.register({ beforeStart: callback });
    await registration.dispose();
    await turn(registry).beforeStart("work");
    expect(callback).not.toHaveBeenCalled();
    await registry.dispose();
  });

  it("disposes each registration at most once", async () => {
    const registry = new LifecycleInterceptorRegistry();
    const dispose = vi.fn();
    const registration = registry.register({ dispose });
    await registration.dispose(); await registration.dispose(); await registry.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("contains a provider disposer rejection", async () => {
    const registry = new LifecycleInterceptorRegistry();
    registry.register({ dispose: () => Promise.reject(new Error("dispose failed")) });
    await expect(registry.dispose()).resolves.toBeUndefined();
  });

  it("cancels an in-flight callback with the execution signal", async () => {
    const registry = new LifecycleInterceptorRegistry();
    const controller = new AbortController();
    registry.register({ beforeStart: async () => new Promise(() => {}) });
    const pending = turn(registry, controller.signal).beforeStart("work");
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await registry.dispose();
  });

  it("rejects new registrations after registry disposal", async () => {
    const registry = new LifecycleInterceptorRegistry();
    await registry.dispose();
    expect(() => registry.register({})).toThrow(/disposed/);
  });

  it("aborts callback signals when the registry shuts down", async () => {
    const registry = new LifecycleInterceptorRegistry();
    let observed: AbortSignal | undefined;
    registry.register({ beforeStart: (context) => { observed = context.signal; return undefined; } });
    await turn(registry).beforeStart("work");
    await registry.dispose();
    expect(observed?.aborted).toBe(true);
  });
});

describe("retained RunListeners cleanup", () => {
  it("releases an attached observer", () => {
    const listeners = new RunListeners(); const unsubscribe = vi.fn();
    listeners.attachObserver(unsubscribe); listeners.release();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("makes release idempotent", () => {
    const listeners = new RunListeners(); const unsubscribe = vi.fn();
    listeners.attachObserver(unsubscribe); listeners.release(); listeners.release();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does nothing when no observer is attached", () => { expect(() => new RunListeners().release()).not.toThrow(); });

  it("allows a new observer after releasing the prior one", () => {
    const listeners = new RunListeners(); const first = vi.fn(); const second = vi.fn();
    listeners.attachObserver(first); listeners.release(); listeners.attachObserver(second); listeners.release();
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
  });
});
