import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { GetResultTool } from "#src/tools/get-result-tool";
import { createTestSubagent } from "#test/helpers/make-subagent";

describe("bounded subagent result reporting", () => {
  it("returns a terminal record without a verbose conversation mode", async () => {
    const record = createTestSubagent({ result: "answer" });
    const tool = new GetResultTool({ getRecord: () => record }, new AgentTypeRegistry(() => new Map()));
    const result = await tool.execute("tc", { agent_id: record.id }, undefined, undefined, undefined);
    expect(result.content[0].text).toContain("answer");
    expect(result.content[0].text).not.toContain("Agent Conversation");
  });

  it("points callers to the transcript for bounded output", async () => {
    const record = createTestSubagent({ result: "x".repeat(12_001) });
    const tool = new GetResultTool({ getRecord: () => record }, new AgentTypeRegistry(() => new Map()));
    const result = await tool.execute("tc", { agent_id: record.id }, undefined, undefined, undefined);
    expect(result.content[0].text).toContain("Output truncated");
  });
});
