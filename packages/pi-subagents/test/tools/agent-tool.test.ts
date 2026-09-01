import { describe, expect, it, vi } from "vitest";
import { AgentTool } from "#src/tools/agent-tool";
import { createToolDeps, createToolDepsWithDisabledBuiltInAgents } from "#test/helpers/make-deps";
import { createTestSubagent } from "#test/helpers/make-subagent";

function makeTool(deps: ReturnType<typeof createToolDeps>) {
  return new AgentTool(deps.manager, deps.runtime, deps.settings, deps.registry, deps.agentDir);
}
async function execute(deps: ReturnType<typeof createToolDeps>, params: Record<string, unknown>, signal = new AbortController().signal) {
  return makeTool(deps).execute("tc-1", params, signal, vi.fn(), {});
}
const params = { prompt: "do task", description: "task", subagent_type: "general-purpose" };

describe("AgentTool", () => {
  it("declares the subagent tool and current delivery schema", () => {
    const def = makeTool(createToolDeps()).toToolDefinition();
    expect(def.name).toBe("subagent");
    expect(def.label).toBe("Subagent");
    expect(def.promptSnippet).toContain("Launch");
    expect(def.description).toContain("mode: joined");
    expect(def.description).toContain("automatically wakes you");
    expect(def.parameters.properties.mode).toBeDefined();
    expect(def.parameters.properties.run_in_background).toBeUndefined();
    expect(def.parameters.properties.resume).toBeUndefined();
  });

  it("builds enabled type and guideline text", () => {
    const def = makeTool(createToolDeps()).toToolDefinition();
    expect(def.description).toContain("- general-purpose:");
    expect(def.description).toContain("- Explore:");
    expect(def.description).toContain("Use Explore for codebase searches");
    const disabled = makeTool(createToolDepsWithDisabledBuiltInAgents("Explore")).toToolDefinition();
    expect(disabled.description).not.toContain("- Explore:");
  });

  it("reloads config and launches detached work by default", async () => {
    const deps = createToolDeps();
    const reload = vi.spyOn(deps.registry, "reload");
    const result = await execute(deps, params);
    expect(reload).toHaveBeenCalledOnce();
    expect(result.content[0].text).toContain("Agent detached");
    expect(result.content[0].text).toContain("Agent ID: agent-1");
    expect((deps.manager.launch as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/test" }), "general-purpose", "do task", expect.objectContaining({ mode: "detached", parentSession: expect.objectContaining({ toolCallId: "tc-1" }) }),
    );
  });

  it("returns joined completion output and consumes the terminal record", async () => {
    const deps = createToolDeps();
    const record = createTestSubagent({ result: "Task complete.", mode: "joined" });
    deps.manager.launch = vi.fn().mockResolvedValue({ kind: "joined", record });
    deps.manager.getRecord = vi.fn().mockReturnValue(record);
    const result = await execute(deps, { ...params, mode: "joined" });
    expect(result.content[0].text).toContain("Agent completed");
    expect(result.content[0].text).toContain("Task complete.");
    expect(record.consumed).toBe(true);
  });

  it("projects terminal errors and bounded partial output", async () => {
    const deps = createToolDeps();
    const record = createTestSubagent({ status: "error", error: "provider failed", result: "partial", mode: "joined" });
    deps.manager.launch = vi.fn().mockResolvedValue({ kind: "joined", record });
    deps.manager.getRecord = vi.fn().mockReturnValue(record);
    const result = await execute(deps, { ...params, mode: "joined" });
    expect(result.content[0].text).toContain("Agent failed: provider failed");
    expect(result.content[0].text).toContain("Partial output");
  });

  it("returns launch failures as tool text", async () => {
    const deps = createToolDeps();
    deps.manager.launch = vi.fn().mockRejectedValue(new Error("launch failed"));
    const result = await execute(deps, params);
    expect(result.content[0].text).toBe("launch failed");
  });

  it("rejects an unknown model before launch", async () => {
    const deps = createToolDeps();
    const result = await execute(deps, { ...params, model: "unknown-model" });
    expect(result.content[0].text).toContain("unknown-model");
    expect(deps.manager.launch).not.toHaveBeenCalled();
  });

  it("passes timeout, thinking, context, and joined signal to the manager", async () => {
    const deps = createToolDeps();
    await execute(deps, { ...params, mode: "joined", timeout_seconds: 12, thinking: "high", inherit_context: true });
    expect(deps.runtime.buildSnapshot).toHaveBeenCalledWith(true);
    expect(deps.manager.launch).toHaveBeenCalledWith(
      expect.anything(), expect.any(String), expect.any(String),
      expect.objectContaining({ mode: "joined", timeoutSeconds: 12, thinkingLevel: "off", signal: expect.any(AbortSignal) }),
    );
  });
});
