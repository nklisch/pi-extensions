import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEventData, buildNotificationDetails, escapeXml, formatTaskNotification, getStatusLabel, NotificationManager } from "#src/observation/notification";
import { createTestSubagent } from "#test/helpers/make-subagent";

describe("notification projections", () => {
  it("escapes XML text", () => {
    expect(escapeXml(`a & <b> \"c\"`)).toBe("a &amp; &lt;b&gt; &quot;c&quot;");
  });

  it("labels coarse status using terminal reason", () => {
    expect(getStatusLabel("error", undefined, "timeout")).toBe("Error: timeout");
    expect(getStatusLabel("completed", "turn_limit_graceful")).toBe("Completed (turn limit)");
    expect(getStatusLabel("stopped", "runtime_timeout")).toBe("Stopped (runtime timeout)");
    expect(getStatusLabel("completed")).toBe("Done");
  });

  it("formats detached completion metadata and bounded output", () => {
    const record = createTestSubagent({ description: "<task>", result: "x".repeat(600) });
    const xml = formatTaskNotification(record, 100);
    expect(xml).toContain("<task-id>agent-1</task-id>");
    expect(xml).toContain("<run-id>1</run-id>");
    expect(xml).toContain("<mode>detached</mode>");
    expect(xml).toContain("&lt;task&gt;");
    expect(xml).toContain("truncated");
  });

  it("includes an explicit no-output marker", () => {
    expect(formatTaskNotification(createTestSubagent({ result: undefined }), 500)).toContain("No output.");
  });

  it("projects notification details and event data from the current record", () => {
    const record = createTestSubagent({ type: "Explore", description: "Search", result: "Found", toolUses: 5, lifetimeUsage: { input: 1_000, output: 500, cacheWrite: 0 }, turnCount: 3, maxTurns: 5 });
    const details = buildNotificationDetails(record, 500);
    expect(details).toMatchObject({ id: "agent-1", mode: "detached", status: "completed", toolUses: 5, turnCount: 3, maxTurns: 5, totalTokens: 1_500, durationMs: 0, resultPreview: "Found" });
    expect(buildEventData(record)).toMatchObject({ id: "agent-1", runId: 1, mode: "detached", type: "Explore", status: "completed", activeRuntimeMs: 0, tokens: { total: 1_500 } });
  });

  it("omits zero token totals", () => {
    expect(buildEventData(createTestSubagent({ lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } })).tokens).toBeUndefined();
  });
});

describe("NotificationManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("delivers detached results immediately and consumes them", () => {
    const send = vi.fn();
    const manager = new NotificationManager(send);
    const record = createTestSubagent({ mode: "detached" });
    manager.sendCompletion(record);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ customType: "subagent-notification", display: true }), expect.objectContaining({ deliverAs: "followUp", triggerTurn: true }));
    expect(record.consumed).toBe(true);
  });

  it("does not notify joined or already consumed records", () => {
    const send = vi.fn();
    const manager = new NotificationManager(send);
    manager.sendCompletion(createTestSubagent({ mode: "joined" }));
    const consumed = createTestSubagent({ mode: "detached" }); consumed.markConsumed(); manager.sendCompletion(consumed);
    expect(send).not.toHaveBeenCalled();
  });

  it("withholds during a parent run and flushes only still-current unconsumed work", () => {
    const send = vi.fn();
    const manager = new NotificationManager(send);
    const record = createTestSubagent({ mode: "detached" });
    manager.onParentAgentStart(); manager.sendCompletion(record);
    expect(send).not.toHaveBeenCalled();
    manager.onParentAgentSettled();
    expect(send).toHaveBeenCalledOnce();
  });

  it("drops queued notifications after disposal", () => {
    const send = vi.fn();
    const manager = new NotificationManager(send);
    manager.onParentAgentStart(); manager.sendCompletion(createTestSubagent({ mode: "detached" })); manager.dispose(); manager.onParentAgentSettled();
    expect(send).not.toHaveBeenCalled();
  });
});
