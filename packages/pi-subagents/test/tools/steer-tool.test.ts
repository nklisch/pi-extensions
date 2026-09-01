import { describe, expect, it, vi } from "vitest";
import { SteerTool } from "#src/tools/steer-tool";
import type { ManagerSteerOutcome } from "#src/lifecycle/subagent-manager";

function execute(manager: { steer: (id: string, message: string) => Promise<ManagerSteerOutcome> }, params: { agent_id: string; message: string }) {
  return new SteerTool(manager, { emit: vi.fn() }).execute("tc", params, new AbortController().signal, undefined, undefined);
}

describe("SteerTool", () => {
  it("declares its focused control schema", () => {
    const tool = new SteerTool({ steer: vi.fn() }, { emit: vi.fn() });
    expect(tool.toToolDefinition().name).toBe("steer_subagent");
    expect(tool.toToolDefinition().promptSnippet).toContain("running subagent");
  });

  it("renders not-found and rejected outcomes", async () => {
    const notFound = await execute({ steer: vi.fn().mockResolvedValue({ kind: "not_found", agentId: "missing" }) }, { agent_id: "missing", message: "hi" });
    expect(notFound.content[0].text).toContain("Agent not found");
    const rejected = await execute({ steer: vi.fn().mockResolvedValue({ kind: "rejected", runId: 2, status: "completed" }) }, { agent_id: "a", message: "hi" });
    expect(rejected.content[0].text).toContain("cannot be steered");
    expect(rejected.details).toMatchObject({ kind: "rejected", runId: 2 });
  });

  it("renders delivered and buffered outcomes with run identity", async () => {
    const delivered = await execute({ steer: vi.fn().mockResolvedValue({ kind: "delivered", runId: 3 }) }, { agent_id: "a", message: "change" });
    expect(delivered.content[0].text).toContain("delivered");
    expect(delivered.content[0].text).toContain("Run ID: 3");
    const buffered = await execute({ steer: vi.fn().mockResolvedValue({ kind: "buffered", runId: 4 }) }, { agent_id: "a", message: "change" });
    expect(buffered.content[0].text).toContain("buffered");
    expect(buffered.details).toMatchObject({ agentId: "a", runId: 4 });
  });
});
