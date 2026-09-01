import { describe, expect, it, vi } from "vitest";
import { AgentTool } from "#src/tools/agent-tool";
import { createToolDeps } from "#test/helpers/make-deps";

describe("joined subagent delivery", () => {
  it("uses mode joined and returns settled output", async () => {
    const deps = createToolDeps();
    const record = deps.manager.getRecord("agent-1");
    if (!record) throw new Error("test fixture did not provide a record");
    deps.manager.launch = vi.fn().mockResolvedValue({ kind: "joined", record });
    const result = await new AgentTool(deps.manager, deps.runtime, deps.settings, deps.registry, deps.agentDir).execute(
      "tc", { prompt: "plan", description: "joined plan", subagent_type: "general-purpose", mode: "joined" }, new AbortController().signal, vi.fn(), undefined,
    );
    expect(result.content[0].text).toContain("Agent completed");
    expect(deps.manager.launch).toHaveBeenCalledWith(expect.anything(), "general-purpose", "plan", expect.objectContaining({ mode: "joined" }));
  });

  it("renders manager failures as tool errors", async () => {
    const deps = createToolDeps();
    deps.manager.launch = vi.fn().mockRejectedValue(new Error("provider failed"));
    const result = await new AgentTool(deps.manager, deps.runtime, deps.settings, deps.registry, deps.agentDir).execute(
      "tc", { prompt: "plan", description: "joined plan", subagent_type: "general-purpose", mode: "joined" }, new AbortController().signal, undefined, undefined,
    );
    expect(result.content[0].text).toContain("provider failed");
  });
});
