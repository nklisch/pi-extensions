import { describe, expect, it, vi } from "vitest";
import { createToolDeps } from "./make-deps";

describe("createToolDeps", () => {
  it("creates a complete AgentTool fixture", () => {
    const deps = createToolDeps();
    expect(deps.agentDir).toBeTypeOf("string");
    expect(deps.settings.defaultMaxTurns).toBeUndefined();
    expect(deps.registry.resolveAgentConfig("general-purpose")).toBeDefined();
    expect(deps.manager.launch).toBeTypeOf("function");
    expect(deps.manager.getRecord).toBeTypeOf("function");
  });

  it("allows top-level and manager overrides", async () => {
    const launch = vi.fn().mockResolvedValue({ kind: "detached", agentId: "custom", runId: 1 });
    const deps = createToolDeps({ agentDir: "/custom", manager: { ...createToolDeps().manager, launch } });
    expect(deps.agentDir).toBe("/custom");
    await deps.manager.launch({} as never, "type", "prompt", { description: "d", mode: "detached" });
    expect(launch).toHaveBeenCalledOnce();
  });
});
