import { describe, expect, it, vi } from "vitest";
import { buildEventData, type NotificationSystem } from "#src/observation/notification";
import { SubagentEventsObserver } from "#src/observation/subagent-events-observer";
import { createTestSubagent } from "#test/helpers/make-subagent";

function make() {
  const emit = vi.fn();
  const appendEntry = vi.fn();
  const notifications: NotificationSystem = { sendCompletion: vi.fn(), dispose: vi.fn() };
  return { observer: new SubagentEventsObserver({ emit, appendEntry, notifications }), emit, appendEntry, notifications };
}

describe("SubagentEventsObserver", () => {
  it("emits creation and started facts with mode and run id", () => {
    const { observer, emit } = make();
    const record = createTestSubagent({ id: "a", type: "Explore", description: "search", mode: "detached" });
    observer.onSubagentCreated(record); observer.onSubagentStarted(record);
    expect(emit).toHaveBeenNthCalledWith(1, "subagents:created", expect.objectContaining({ id: "a", mode: "detached", runId: 1 }));
    expect(emit).toHaveBeenNthCalledWith(2, "subagents:started", expect.objectContaining({ id: "a", mode: "detached", runId: 1 }));
  });

  it("emits completion, persistence, and notification projections", () => {
    const { observer, emit, appendEntry, notifications } = make();
    const record = createTestSubagent({ result: "done" });
    observer.onSubagentCompleted(record);
    expect(emit).toHaveBeenCalledWith("subagents:completed", buildEventData(record));
    expect(appendEntry).toHaveBeenCalledWith("subagents:record", buildEventData(record));
    expect(notifications.sendCompletion).toHaveBeenCalledWith(record);
  });

  it("routes stopped and error records to the failed channel", () => {
    const { observer, emit } = make();
    observer.onSubagentCompleted(createTestSubagent({ status: "stopped", terminalReason: "explicit_stop" }));
    observer.onSubagentCompleted(createTestSubagent({ status: "error", error: "boom", terminalReason: "provider_failure" }));
    expect(emit).toHaveBeenNthCalledWith(1, "subagents:failed", expect.anything());
    expect(emit).toHaveBeenNthCalledWith(2, "subagents:failed", expect.anything());
  });

  it("emits resumed and compacted projections", () => {
    const { observer, emit, appendEntry } = make();
    const record = createTestSubagent({ result: "continued" });
    observer.onSubagentResumed(record);
    observer.onSubagentCompacted(record, { reason: "threshold", tokensBefore: 99 });
    expect(emit).toHaveBeenCalledWith("subagents:resumed", buildEventData(record));
    expect(emit).toHaveBeenCalledWith("subagents:compacted", expect.objectContaining({ id: record.id, runId: 1, tokensBefore: 99 }));
    expect(appendEntry).toHaveBeenCalledOnce();
  });

  it("contains independent sink failures", () => {
    const { observer, emit, appendEntry, notifications } = make();
    emit.mockImplementation(() => { throw new Error("emit"); });
    appendEntry.mockImplementation(() => { throw new Error("append"); });
    vi.mocked(notifications.sendCompletion).mockImplementation(() => { throw new Error("notify"); });
    expect(() => observer.onSubagentCompleted(createTestSubagent())).not.toThrow();
    expect(emit).toHaveBeenCalledOnce();
    expect(appendEntry).toHaveBeenCalledOnce();
    expect(notifications.sendCompletion).toHaveBeenCalledOnce();
  });
});
