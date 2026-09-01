import { describe, expect, it } from "vitest";
import { createTestSubagent } from "./make-subagent";

describe("createTestSubagent", () => {
  it("provides a valid terminal fixture", () => {
    const record = createTestSubagent();
    expect(record).toMatchObject({ id: "agent-1", type: "general-purpose", description: "Test task", status: "completed", result: "All done.", runId: 1, mode: "detached" });
    expect(record.isActive()).toBe(false);
  });

  it("seeds live activity and lifetime metrics", () => {
    const record = createTestSubagent({ turnCount: 4, activeTools: ["read", "grep"], responseText: "working", toolUses: 2, lifetimeUsage: { input: 10, output: 20, cacheWrite: 3 }, maxTurns: 8 });
    expect(record.turnCount).toBe(4);
    expect([...record.activeTools.values()]).toEqual(["read", "grep"]);
    expect(record.responseText).toBe("working");
    expect(record.toolUses).toBe(2);
    expect(record.lifetimeUsage).toEqual({ input: 10, output: 20, cacheWrite: 3 });
    expect(record.maxTurns).toBe(8);
  });

  it("represents a passive running projection", () => {
    const record = createTestSubagent({ status: "running", completedAt: undefined });
    expect(record.isActive()).toBe(true);
    expect(record.isRunning()).toBe(true);
    expect(record.completedAt).toBeUndefined();
  });

  it("supports explicit mode and identity overrides", () => {
    const record = createTestSubagent({ id: "custom", mode: "joined", type: "Explore", description: "inspect" });
    expect(record).toMatchObject({ id: "custom", mode: "joined", type: "Explore", description: "inspect" });
  });
});
