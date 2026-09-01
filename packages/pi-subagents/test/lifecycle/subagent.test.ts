import { describe, expect, it, vi } from "vitest";
import { Subagent } from "#src/lifecycle/subagent";
import { SubagentState } from "#src/lifecycle/subagent-state";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";
import { makeModel } from "#test/helpers/make-model";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";

function makeRecord(overrides: Record<string, unknown> = {}) {
  const session = createSubagentSessionStub();
  const record = new Subagent({
    id: "agent-1", type: "Explore", description: "task",
    state: new SubagentState(),
    execution: {
      createSubagentSession: vi.fn(async () => toSubagentSession(session)),
      snapshot: { ...STUB_SNAPSHOT, model: makeModel({ id: "parent" }) },
      prompt: "inspect", baseCwd: "/tmp", mode: "detached",
      ...overrides,
    },
  });
  return { record, session };
}

describe("Subagent lease lifecycle", () => {
  it("starts queued and becomes running only after admission", async () => {
    const { record, session } = makeRecord();
    let release!: () => void;
    session.runTurnLoop.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ responseText: "done" }); }));
    const limiter = new ConcurrencyLimiter(() => 1);
    const handle = record.scheduleVia((task) => limiter.schedule(task));
    expect(handle.admitted).toBe(true);
    await vi.waitFor(() => expect(record.status).toBe("running"));
    expect(record.isRunning()).toBe(true);
    release();
    await record.settlement;
    expect(record.status).toBe("completed");
    expect(record.result).toBe("done");
  });

  it("cancels before admission without creating a session", async () => {
    const { record, session } = makeRecord();
    const limiter = new ConcurrencyLimiter(() => 0);
    const handle = record.scheduleVia((task) => limiter.schedule(task));
    expect(handle.admitted).toBe(false);
    expect(record.requestStop("explicit_stop")).toBe(true);
    await record.settlement;
    expect(record.status).toBe("stopped");
    expect(record.stateTerminalReason).toBe("explicit_stop");
    expect(session.runTurnLoop).not.toHaveBeenCalled();
  });

  it("keeps running state until cooperative execution and teardown settle", async () => {
    const { record, session } = makeRecord();
    let release!: () => void;
    session.runTurnLoop.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ responseText: "partial" }); }));
    record.scheduleVia((task) => new ConcurrencyLimiter(() => 1).schedule(task));
    await vi.waitFor(() => expect(session.runTurnLoop).toHaveBeenCalled());
    record.requestStop("runtime_timeout");
    expect(record.isActive()).toBe(true);
    release();
    await record.settlement;
    expect(record.status).toBe("stopped");
    expect(record.stateTerminalReason).toBe("runtime_timeout");
  });

  it("buffers and then delivers steering at the session boundary", async () => {
    const { record, session } = makeRecord();
    record.scheduleVia((task) => new ConcurrencyLimiter(() => 1).schedule(task));
    await vi.waitFor(() => expect(record.isRunning()).toBe(true));
    // Session creation is synchronous in the stub factory, so this is delivered.
    const outcome = await record.steer("change direction");
    expect(outcome.kind).toBe("delivered");
    expect(session.steer).toHaveBeenCalledWith("change direction");
    record.requestStop("explicit_stop");
    await record.settlement;
  });

  it("refreshes the lease and clears terminal state for resume", async () => {
    const { record, session } = makeRecord();
    session.resumeTurnLoop.mockResolvedValue({ text: "continued" });
    record.scheduleVia((task) => new ConcurrencyLimiter(() => 1).schedule(task));
    await record.settlement;
    const result = record.reserveResume("continue", "joined", undefined, (task) => new ConcurrencyLimiter(() => 1).schedule(task));
    expect(result).toEqual({ accepted: true, runId: 2 });
    await record.settlement;
    expect(record.result).toBe("continued");
    expect(record.runId).toBe(2);
  });

  it("reports provider failures as errors with their reason", async () => {
    const { record, session } = makeRecord();
    session.runTurnLoop.mockResolvedValue({ responseText: "partial", failure: "provider down" });
    record.scheduleVia((task) => new ConcurrencyLimiter(() => 1).schedule(task));
    await record.settlement;
    expect(record.status).toBe("error");
    expect(record.error).toBe("provider down");
    expect(record.stateTerminalReason).toBe("provider_failure");
  });
});
