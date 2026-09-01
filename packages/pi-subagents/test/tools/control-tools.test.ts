import { describe, expect, it, vi } from "vitest";
import { GetResultTool } from "#src/tools/get-result-tool";
import { ListTool } from "#src/tools/list-tool";
import { ResumeTool } from "#src/tools/resume-tool";
import { SteerTool } from "#src/tools/steer-tool";
import { StopTool } from "#src/tools/stop-tool";

describe("parent control tool contracts", () => {
  it("registers the dedicated lifecycle tools with stable names", () => {
    const names = [
      new ResumeTool({ resume: vi.fn(), getRecord: vi.fn() }).toToolDefinition().name,
      new StopTool({ stop: vi.fn() }).toToolDefinition().name,
      new ListTool({ listAgents: () => [] }).toToolDefinition().name,
      new GetResultTool({ getRecord: vi.fn() }, { resolveAgentConfig: () => ({ name: "x", description: "x", systemPrompt: "", promptMode: "append" }), getToolNamesForType: () => [] }).toToolDefinition().name,
      new SteerTool({ steer: vi.fn() }, { emit: vi.fn() }).toToolDefinition().name,
    ];
    expect(names).toEqual(["resume_subagent", "stop_subagent", "list_subagents", "get_subagent_result", "steer_subagent"]);
  });

  it("keeps list and stop bounds in their schemas", () => {
    const list = new ListTool({ listAgents: () => [] }).toToolDefinition();
    const stop = new StopTool({ stop: vi.fn() }).toToolDefinition();
    expect(list.parameters.properties.limit.minimum).toBe(1);
    expect(list.parameters.properties.limit.maximum).toBe(100);
    expect(stop.parameters.properties.settlement_timeout_seconds.minimum).toBe(1);
    expect(stop.parameters.properties.settlement_timeout_seconds.maximum).toBe(30);
  });
});
