import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { GetResultTool } from "#src/tools/get-result-tool";
import { createTestSubagent } from "#test/helpers/make-subagent";

const registry = new AgentTypeRegistry(() => new Map());
function tool(record: ReturnType<typeof createTestSubagent> | undefined) {
  return new GetResultTool({ getRecord: () => record }, registry);
}

describe("GetResultTool", () => {
  it("declares a nonblocking, bounded query", () => {
    const def = tool(undefined).toToolDefinition();
    expect(def.promptSnippet).toContain("without waiting");
    expect(def.description).toContain("never waits");
    expect(def.parameters.properties.agent_id).toBeDefined();
    expect(def.parameters.properties.verbose).toBeUndefined();
  });

  it("reports not-found without throwing", async () => {
    const result = await tool(undefined).execute("tc", { agent_id: "missing" }, undefined, undefined, undefined);
    expect(result.content[0].text).toContain("Agent not found");
  });

  it("returns live status and activity without consuming it", async () => {
    const record = createTestSubagent({ status: "running", completedAt: undefined, activeTools: ["read"], responseText: "reading" });
    const result = await tool(record).execute("tc", { agent_id: "agent-1" }, undefined, undefined, undefined);
    expect(result.content[0].text).toContain("Agent agent-1 is running");
    expect(result.content[0].text).toContain("Activity");
    expect(record.consumed).toBe(false);
  });

  it("returns a terminal result and marks it consumed", async () => {
    const record = createTestSubagent({ result: "All done." });
    const result = await tool(record).execute("tc", { agent_id: "agent-1" }, undefined, undefined, undefined);
    expect(result.content[0].text).toContain("Agent agent-1 completed");
    expect(result.content[0].text).toContain("Reason: completed");
    expect(result.content[0].text).toContain("All done.");
    expect(record.consumed).toBe(true);
    expect(result.details).toMatchObject({ agentId: "agent-1", status: "completed" });
  });

  it("includes terminal errors and partial output", async () => {
    const record = createTestSubagent({ status: "error", error: "provider unavailable", result: "partial" });
    const result = await tool(record).execute("tc", { agent_id: "agent-1" }, undefined, undefined, undefined);
    expect(result.content[0].text).toContain("Error: provider unavailable");
    expect(result.content[0].text).toContain("partial");
  });
});
