import { describe, expect, it } from "vitest";
import { SubagentState } from "#src/lifecycle/subagent-state";

describe("SubagentState", () => {
  it("starts queued with initialized metrics", () => {
    const state = new SubagentState();
    expect(state.status).toBe("queued");
    expect(state.turnCount).toBe(1);
    expect(state.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(state.consumed).toBe(false);
  });

  it("records terminal reasons separately from coarse status", () => {
    const state = new SubagentState({ status: "running", startedAt: 10 });
    state.markStopped("partial", "runtime_timeout", 42);
    expect(state.status).toBe("stopped");
    expect(state.terminalReason).toBe("runtime_timeout");
    expect(state.completedAt).toBe(42);
    expect(state.result).toBe("partial");
  });

  it("keeps provider failures and partial output", () => {
    const state = new SubagentState({ status: "running" });
    state.markError(new Error("provider"), "provider_failure", "partial", 42);
    expect(state.status).toBe("error");
    expect(state.error).toBe("provider");
    expect(state.result).toBe("partial");
    expect(state.terminalReason).toBe("provider_failure");
  });

  it("represents graceful turn limits as completed", () => {
    const state = new SubagentState({ status: "running" });
    state.markCompleted("answer", "turn_limit_graceful", 42);
    expect(state.status).toBe("completed");
    expect(state.terminalReason).toBe("turn_limit_graceful");
  });

  it("resets terminal fields for a new queued resume lease", () => {
    const state = new SubagentState({ status: "running" });
    state.markError(new Error("provider"), "provider_failure", "partial", 42);
    state.markConsumed(50);
    state.resetForResume();
    expect(state.status).toBe("queued");
    expect(state.terminalReason).toBeUndefined();
    expect(state.result).toBeUndefined();
    expect(state.consumed).toBe(false);
  });
});
