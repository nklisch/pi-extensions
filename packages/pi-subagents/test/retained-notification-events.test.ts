import { describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { SubagentEventsObserver, type SubagentEventsObserverDeps } from "#src/observation/subagent-events-observer";
import { buildEventData, buildNotificationDetails, escapeXml, formatTaskNotification, getStatusLabel, NotificationManager } from "#src/observation/notification";
import { createTestSubagent } from "#test/helpers/make-subagent";
import { createSubagentSessionStub, toSubagentSession } from "#test/helpers/mock-session";

describe("retained notification formatting", () => {
  it("escapes quotes and apostrophes for XML text", () => {
    expect(escapeXml(`a & <b> \"c\" 'd'`)).toBe("a &amp; &lt;b&gt; &quot;c&quot; &apos;d&apos;");
  });

  it("leaves plain XML-safe text unchanged", () => {
    expect(escapeXml("plain text")).toBe("plain text");
  });

  it("labels provider errors with their public error text", () => { expect(getStatusLabel("error", "provider_failure", "unavailable")).toBe("Error: unavailable"); });
  it("labels missing provider errors as unknown", () => { expect(getStatusLabel("error", "provider_failure")).toBe("Error: unknown"); });
  it("labels graceful turn-limit completion", () => { expect(getStatusLabel("completed", "turn_limit_graceful")).toBe("Completed (turn limit)"); });
  it("labels hard turn-limit stops", () => { expect(getStatusLabel("stopped", "turn_limit_hard")).toBe("Stopped (turn limit)"); });
  it("labels explicit stops", () => { expect(getStatusLabel("stopped", "explicit_stop")).toBe("Stopped (explicit stop)"); });
  it("labels ordinary completion as done", () => { expect(getStatusLabel("completed", "completed")).toBe("Done"); });

  it("produces the full task notification structure", () => {
    const record = createTestSubagent({ description: "inspect", result: "found", terminalReason: "completed" });
    const xml = formatTaskNotification(record, 500);
    expect(xml).toContain("<task-notification>");
    expect(xml).toContain("<task-id>agent-1</task-id>");
    expect(xml).toContain("<run-id>1</run-id>");
    expect(xml).toContain("<mode>detached</mode>");
    expect(xml).toContain("<terminal-reason>completed</terminal-reason>");
    expect(xml).toContain("<result>found</result>");
    expect(xml).toContain("</task-notification>");
  });

  it("escapes task descriptions and results in notifications", () => {
    const xml = formatTaskNotification(createTestSubagent({ description: "<task>", result: "a & b" }), 500);
    expect(xml).toContain('Subagent "&lt;task&gt;"');
    expect(xml).toContain("<result>a &amp; b</result>");
  });

  it("truncates notification result previews at the requested bound", () => {
    const xml = formatTaskNotification(createTestSubagent({ result: "x".repeat(20) }), 5);
    expect(xml).toContain("xxxxx\n...(truncated");
  });

  it("uses an explicit no-output notification marker", () => { expect(formatTaskNotification(createTestSubagent({ result: undefined }), 500)).toContain("<result>No output.</result>"); });

  it("includes output-file when the child has a transcript", () => {
    const record = createTestSubagent();
    record.subagentSession = toSubagentSession(createSubagentSessionStub(undefined, "/tmp/child.jsonl"));
    expect(formatTaskNotification(record, 500)).toContain("<output-file>/tmp/child.jsonl</output-file>");
  });

  it("projects usage and live fields into notification details", () => {
    const record = createTestSubagent({ type: "Explore", toolUses: 4, turnCount: 3, maxTurns: 5, lifetimeUsage: { input: 100, output: 200, cacheWrite: 50 } });
    expect(buildNotificationDetails(record, 500)).toMatchObject({ id: "agent-1", mode: "detached", toolUses: 4, turnCount: 3, maxTurns: 5, totalTokens: 350 });
  });

  it("projects terminal errors and bounded result text into event data", () => {
    const record = createTestSubagent({ status: "error", error: "provider", result: "partial", terminalReason: "provider_failure" });
    expect(buildEventData(record)).toMatchObject({ status: "error", error: "provider", result: "partial", terminalReason: "provider_failure" });
  });

  it("omits zero-token usage from event data", () => { expect(buildEventData(createTestSubagent({ lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } })).tokens).toBeUndefined(); });
  it("includes input output and total token usage in event data", () => { expect(buildEventData(createTestSubagent({ lifetimeUsage: { input: 10, output: 20, cacheWrite: 5 } })).tokens).toEqual({ input: 10, output: 20, total: 35 }); });
});

describe("retained notification-manager races", () => {
  it("sends an idle detached completion immediately and consumes it", () => {
    const send = vi.fn();
    const manager = new NotificationManager(send);
    const record = createTestSubagent({ mode: "detached" });
    manager.sendCompletion(record);
    expect(send).toHaveBeenCalledOnce();
    expect(record.consumed).toBe(true);
  });

  it("withholds a detached completion while the parent is running", () => {
    const send = vi.fn();
    const manager = new NotificationManager(send);
    const record = createTestSubagent({ mode: "detached" });
    manager.onParentAgentStart();
    manager.sendCompletion(record);
    expect(send).not.toHaveBeenCalled();
    expect(record.consumed).toBe(false);
    manager.onParentAgentSettled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("suppresses a withheld completion consumed by the parent before flush", () => {
    const send = vi.fn();
    const manager = new NotificationManager(send);
    const record = createTestSubagent({ mode: "detached" });
    manager.onParentAgentStart(); manager.sendCompletion(record); record.markConsumed(); manager.onParentAgentSettled();
    expect(send).not.toHaveBeenCalled();
  });

  it("suppresses a stale withheld completion after a new run starts", async () => {
    const send = vi.fn();
    const manager = new NotificationManager(send);
    const record = createTestSubagent({ mode: "detached" });
    manager.onParentAgentStart(); manager.sendCompletion(record);
    const stub = createSubagentSessionStub();
    stub.resumeTurnLoop.mockResolvedValue({ text: "resumed" });
    record.subagentSession = toSubagentSession(stub);
    const limiter = new ConcurrencyLimiter(() => 1);
    const resumed = record.reserveResume("continue", "detached", undefined, (task) => limiter.schedule(task));
    expect(resumed.accepted).toBe(true);
    manager.onParentAgentSettled();
    expect(send).not.toHaveBeenCalled();
    await record.settlement;
  });

  it("does not send joined completions", () => {
    const send = vi.fn();
    const manager = new NotificationManager(send);
    manager.sendCompletion(createTestSubagent({ mode: "joined" }));
    expect(send).not.toHaveBeenCalled();
  });

  it("does not send an already consumed completion", () => {
    const send = vi.fn();
    const manager = new NotificationManager(send);
    const record = createTestSubagent({ mode: "detached" }); record.markConsumed(); manager.sendCompletion(record);
    expect(send).not.toHaveBeenCalled();
  });

  it("clears pending notifications on disposal", () => {
    const send = vi.fn();
    const manager = new NotificationManager(send);
    manager.onParentAgentStart(); manager.sendCompletion(createTestSubagent({ mode: "detached" })); manager.dispose(); manager.onParentAgentSettled();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not send after disposal even when parent is idle", () => {
    const send = vi.fn();
    const manager = new NotificationManager(send); manager.dispose(); manager.sendCompletion(createTestSubagent({ mode: "detached" }));
    expect(send).not.toHaveBeenCalled();
  });
});

describe("retained subagent event projections", () => {
  function makeObserver(overrides: Partial<SubagentEventsObserverDeps> = {}) {
    const deps = { emit: vi.fn(), appendEntry: vi.fn(), notifications: { sendCompletion: vi.fn(), dispose: vi.fn() } };
    Object.assign(deps, overrides);
    return { observer: new SubagentEventsObserver(deps), deps };
  }

  it("emits started with identity and delivery mode", () => {
    const { observer, deps } = makeObserver();
    observer.onSubagentStarted(createTestSubagent({ id: "a", mode: "joined" }));
    expect(deps.emit).toHaveBeenCalledWith("subagents:started", expect.objectContaining({ id: "a", mode: "joined", type: "general-purpose" }));
  });

  it("emits created without persisting or notifying", () => {
    const { observer, deps } = makeObserver(); observer.onSubagentCreated(createTestSubagent());
    expect(deps.emit).toHaveBeenCalledWith("subagents:created", expect.anything());
    expect(deps.appendEntry).not.toHaveBeenCalled(); expect(deps.notifications.sendCompletion).not.toHaveBeenCalled();
  });

  it("emits compacted without persisting or notifying", () => {
    const { observer, deps } = makeObserver(); observer.onSubagentCompacted(createTestSubagent(), { reason: "overflow", tokensBefore: 123 });
    expect(deps.emit).toHaveBeenCalledWith("subagents:compacted", expect.objectContaining({ tokensBefore: 123 }));
    expect(deps.appendEntry).not.toHaveBeenCalled(); expect(deps.notifications.sendCompletion).not.toHaveBeenCalled();
  });

  it("routes stopped records to the failed event channel", () => {
    const { observer, deps } = makeObserver(); observer.onSubagentCompleted(createTestSubagent({ status: "stopped", terminalReason: "explicit_stop" }));
    expect(deps.emit).toHaveBeenCalledWith("subagents:failed", expect.objectContaining({ status: "stopped", terminalReason: "explicit_stop" }));
  });

  it("routes provider errors to the failed event channel", () => {
    const { observer, deps } = makeObserver(); observer.onSubagentCompleted(createTestSubagent({ status: "error", error: "bad", terminalReason: "provider_failure" }));
    expect(deps.emit).toHaveBeenCalledWith("subagents:failed", expect.objectContaining({ error: "bad" }));
  });

  it("persists and notifies successful terminal records", () => {
    const { observer, deps } = makeObserver(); const record = createTestSubagent(); observer.onSubagentCompleted(record);
    expect(deps.emit).toHaveBeenCalledWith("subagents:completed", expect.anything());
    expect(deps.appendEntry).toHaveBeenCalledWith("subagents:record", expect.anything());
    expect(deps.notifications.sendCompletion).toHaveBeenCalledWith(record);
  });

  it("emits resumed-started with a resumed marker", () => {
    const { observer, deps } = makeObserver(); observer.onSubagentResumedStarted(createTestSubagent());
    expect(deps.emit).toHaveBeenCalledWith("subagents:started", expect.objectContaining({ resumed: true }));
  });

  it("emits resumed and persists its record", () => {
    const { observer, deps } = makeObserver(); const record = createTestSubagent({ mode: "detached" }); observer.onSubagentResumed(record);
    expect(deps.emit).toHaveBeenCalledWith("subagents:resumed", expect.anything());
    expect(deps.appendEntry).toHaveBeenCalledWith("subagents:record", expect.anything());
    expect(deps.notifications.sendCompletion).toHaveBeenCalledWith(record);
  });

  it("continues terminal projection when event emission fails", () => {
    const { observer, deps } = makeObserver();
    deps.emit.mockImplementation(() => { throw new Error("emit failed"); });
    const record = createTestSubagent();
    observer.onSubagentCompleted(record);
    expect(deps.appendEntry).toHaveBeenCalledWith("subagents:record", expect.anything());
    expect(deps.notifications.sendCompletion).toHaveBeenCalledWith(record);
  });

  it("continues terminal projection when persistence fails", () => {
    const { observer, deps } = makeObserver();
    deps.appendEntry.mockImplementation(() => { throw new Error("append failed"); });
    const record = createTestSubagent();
    observer.onSubagentCompleted(record);
    expect(deps.emit).toHaveBeenCalledWith("subagents:completed", expect.anything());
    expect(deps.notifications.sendCompletion).toHaveBeenCalledWith(record);
  });

  it("contains notification sink failures", () => {
    const { observer, deps } = makeObserver();
    deps.notifications.sendCompletion.mockImplementation(() => { throw new Error("notify failed"); });
    expect(() => observer.onSubagentCompleted(createTestSubagent())).not.toThrow();
  });

  it("does not import the Pi event API at the projection boundary", () => {
    const { observer } = makeObserver();
    expect(observer).toBeInstanceOf(SubagentEventsObserver);
  });
});
