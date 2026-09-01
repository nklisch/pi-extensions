import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { LifecycleInterceptorError, LifecycleInterceptorRegistry, type SubagentLifecycleExecutionPath, type SubagentLifecycleIdentity } from "#src/lifecycle/lifecycle-interceptor";
import { SubagentSession } from "#src/lifecycle/subagent-session";
import { createChildLifecycleMock } from "#test/helpers/subagent-session-io";
import { createMockSession } from "#test/helpers/mock-session";

function control(registry: LifecycleInterceptorRegistry, signal = new AbortController().signal) {
  const identity: SubagentLifecycleIdentity = { agentId: "agent-1", sessionId: "child-1", runId: 1, agentType: "Explore", parentSessionId: "parent" };
  const execution: SubagentLifecycleExecutionPath = { phase: "initial", origin: "tool", mode: "detached", admission: "immediate" };
  return registry.createTurnLifecycle({ identity, execution, signal });
}
function makeSub(session: any, lifecycle = createChildLifecycleMock()) {
  return new SubagentSession(session as AgentSession, { outputFile: undefined, sessionId: "child-1", sessionDir: "/dir", agentName: "Explore", agentMaxTurns: undefined, parentContext: undefined, lifecycle });
}

describe("LifecycleInterceptorRegistry", () => {
  it("rejects invalid registrations", () => {
    expect(() => new LifecycleInterceptorRegistry().register(null as never)).toThrow(/interceptor object/);
  });

  it("runs ordered prompt and result transformations with immutable context", async () => {
    const registry = new LifecycleInterceptorRegistry();
    const seen: unknown[] = [];
    registry.register({ beforeStart: c => { seen.push(c.identity, c.execution); return { action: "continue", prompt: `${c.prompt}:one` }; }, beforeComplete: c => ({ action: "complete", result: `${c.proposedResult}:one` }) });
    registry.register({ beforeStart: c => ({ action: "continue", prompt: `${c.prompt}:two` }), beforeComplete: c => ({ action: "complete", result: `${c.proposedResult}:two` }) });
    const turn = control(registry);
    expect(await turn.beforeStart("prompt")).toEqual({ action: "continue", prompt: "prompt:one:two" });
    expect(await turn.beforeComplete("result", "completed", 0)).toEqual({ action: "complete", result: "result:one:two" });
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen(seen[1])).toBe(true);
    await registry.dispose();
  });

  it("cancels an in-flight interceptor callback", async () => {
    const registry = new LifecycleInterceptorRegistry();
    registry.register({ beforeStart: async () => new Promise(() => {}) });
    const controller = new AbortController();
    const pending = control(registry, controller.signal).beforeStart("prompt");
    const reason = new Error("cancelled"); controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await registry.dispose();
  });

  it("waits for in-flight callbacks before provider disposal", async () => {
    const registry = new LifecycleInterceptorRegistry();
    let finish!: () => void;
    const callback = new Promise<void>(resolve => { finish = resolve; });
    const disposed = { value: false };
    registry.register({ beforeStart: async () => { await callback; }, dispose: () => { disposed.value = true; } });
    const pending = control(registry).beforeStart("prompt");
    const registration = registry.register({ dispose: () => {} });
    finish(); await pending; await registration.dispose(); await registry.dispose();
    expect(disposed.value).toBe(true);
  });

  it("contains disposer failures", async () => {
    const registry = new LifecycleInterceptorRegistry();
    const registration = registry.register({ dispose: () => { throw new Error("dispose"); } });
    await expect(registration.dispose()).resolves.toBeUndefined();
  });
});

describe("SubagentSession lifecycle interception", () => {
  it("runs start and completion hooks around the child prompt", async () => {
    const registry = new LifecycleInterceptorRegistry();
    registry.register({ beforeStart: c => ({ action: "continue", prompt: `${c.prompt}:changed` }), beforeComplete: c => ({ action: "complete", result: `${c.proposedResult}:accepted` }) });
    const session = createMockSession();
    session.prompt = vi.fn(async (prompt: string) => { session.messages.push({ role: "assistant", content: [{ type: "text", text: prompt }] }); });
    const lifecycle = createChildLifecycleMock();
    const sub = makeSub(session, lifecycle);
    const result = await sub.runTurnLoop("work", { lifecycle: control(registry) });
    expect(session.prompt).toHaveBeenCalledWith("work:changed");
    expect(result).toMatchObject({ responseText: "work:changed:accepted" });
    expect(lifecycle.completed).toHaveBeenCalledWith({ sessionDir: "/dir", agentName: "Explore", terminalReason: "completed" });
    await registry.dispose();
  });

  it("does not prompt or publish completion when start is aborted", async () => {
    const registry = new LifecycleInterceptorRegistry();
    registry.register({ beforeStart: () => ({ action: "abort", reason: "blocked" }) });
    const session = createMockSession(); session.prompt = vi.fn(); const lifecycle = createChildLifecycleMock();
    const result = await makeSub(session, lifecycle).runTurnLoop("work", { lifecycle: control(registry) });
    expect(result).toEqual({ responseText: "blocked", terminalReason: "lifecycle_abort" });
    expect(session.prompt).not.toHaveBeenCalled();
    expect(lifecycle.completed).not.toHaveBeenCalled();
    await registry.dispose();
  });

  it("bounds lifecycle continuation rounds", async () => {
    const registry = new LifecycleInterceptorRegistry();
    registry.register({ beforeComplete: () => ({ action: "continue", prompt: "again" }) });
    const session = createMockSession(); session.prompt = vi.fn(async () => { session.messages.push({ role: "assistant", content: [{ type: "text", text: "candidate" }] }); });
    const result = await makeSub(session).runTurnLoop("work", { lifecycle: control(registry) });
    expect(result.terminalReason).toBe("lifecycle_abort");
    expect(session.prompt).toHaveBeenCalledTimes(4);
    await registry.dispose();
  });

  it("wraps interceptor failures without exposing callback details", async () => {
    const registry = new LifecycleInterceptorRegistry();
    registry.register({ beforeComplete: () => { throw new Error("secret"); } });
    const session = createMockSession(); session.prompt = vi.fn(async () => { session.messages.push({ role: "assistant", content: [{ role: "assistant", text: "candidate" }] }); });
    await expect(makeSub(session).runTurnLoop("work", { lifecycle: control(registry) })).rejects.toBeInstanceOf(LifecycleInterceptorError);
    await registry.dispose();
  });
});
