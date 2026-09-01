import { describe, expect, it, vi } from "vitest";
import { AgentTool } from "#src/tools/agent-tool";
import { createToolDeps } from "#test/helpers/make-deps";

describe("detached subagent delivery", () => {
  it("uses mode detached instead of a separate background spawner", async () => {
    const deps = createToolDeps();
    const result = await new AgentTool(deps.manager, deps.runtime, deps.settings, deps.registry, deps.agentDir).execute(
      "tc", { prompt: "work", description: "background work", subagent_type: "general-purpose", mode: "detached" }, new AbortController().signal, vi.fn(), undefined,
    );
    expect(result.content[0].text).toContain("Agent detached");
    expect(deps.manager.launch).toHaveBeenCalledWith(expect.anything(), "general-purpose", "work", expect.objectContaining({ mode: "detached" }));
  });

  it("does not expose legacy background or resume parameters", () => {
    const deps = createToolDeps();
    const def = new AgentTool(deps.manager, deps.runtime, deps.settings, deps.registry, deps.agentDir).toToolDefinition();
    expect(def.parameters.properties.run_in_background).toBeUndefined();
    expect(def.parameters.properties.resume).toBeUndefined();
  });
});
