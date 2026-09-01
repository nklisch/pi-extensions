import { describe, expect, it } from "vitest";
import { SubagentState } from "#src/lifecycle/subagent-state";

describe("subagent state contract", () => {
  it("keeps cancellation reason separate from coarse status", () => {
    const state = new SubagentState({ status: "running", startedAt: 10 });
    state.markStopped("partial", "runtime_timeout", 42);
    expect(state.status).toBe("stopped");
    expect(state.terminalReason).toBe("runtime_timeout");
    expect(state.completedAt).toBe(42);
    expect(state.result).toBe("partial");
  });

  it("represents graceful turn limits as completed", () => {
    const state = new SubagentState({ status: "running" });
    state.markCompleted("answer", "turn_limit_graceful");
    expect(state.status).toBe("completed");
    expect(state.terminalReason).toBe("turn_limit_graceful");
  });

  it("clears terminal fields for a new resume lease", () => {
    const state = new SubagentState({ status: "running" });
    state.markError(new Error("provider"), "provider_failure", "partial");
    state.markConsumed();
    state.resetForResume();
    expect(state.status).toBe("queued");
    expect(state.terminalReason).toBeUndefined();
    expect(state.result).toBeUndefined();
    expect(state.consumed).toBe(false);
  });
});
