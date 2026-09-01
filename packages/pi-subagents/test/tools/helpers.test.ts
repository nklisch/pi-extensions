import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { buildAgentGuidelines, buildDetails, buildTypeListText, formatLifetimeTokens, getModelLabelFromConfig, getStatusNote } from "#src/tools/helpers";
import { createTestSubagent } from "#test/helpers/make-subagent";

describe("getStatusNote", () => {
  it("only annotates explicit stops", () => {
    expect(getStatusNote("stopped")).toBe(" (stopped)");
    expect(getStatusNote("completed")).toBe("");
    expect(getStatusNote("error")).toBe("");
  });
});

describe("buildDetails", () => {
  it("projects current-run and lifetime record fields", () => {
    const record = createTestSubagent({ toolUses: 3, lifetimeUsage: { input: 2_000, output: 2_000, cacheWrite: 0 }, status: "completed" });
    const details = buildDetails({
      displayName: "Agent", description: "task", subagentType: "general-purpose", modelName: "p/m", thinkingLevel: "medium", tags: [],
    }, record);
    expect(details).toMatchObject({ displayName: "Agent", toolUses: 3, tokens: "4.0k token", durationMs: 0, status: "completed", agentId: "agent-1" });
  });

  it("uses an explicit active-runtime projection rather than timestamp subtraction", () => {
    const record = createTestSubagent({ startedAt: 100, completedAt: 500 });
    expect(buildDetails({ displayName: "A", description: "d", subagentType: "t", modelName: "p/m", thinkingLevel: "off" }, record).durationMs).toBe(0);
    expect(buildDetails({ displayName: "A", description: "d", subagentType: "t", modelName: "p/m", thinkingLevel: "off" }, record, { durationMs: 400 })).toMatchObject({ durationMs: 400 });
  });
});

describe("helper projections", () => {
  it("formats lifetime tokens and model config labels", () => {
    expect(formatLifetimeTokens(createTestSubagent({ lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } }))).toBe("");
    expect(getModelLabelFromConfig("anthropic/claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("builds enabled type and guideline text", () => {
    const registry = new AgentTypeRegistry(() => new Map());
    const text = buildTypeListText(registry, "/home/user/.pi");
    expect(text).toContain("general-purpose");
    expect(text).toContain(".pi/agents/<name>.md");
    expect(buildAgentGuidelines(registry)).toContain("- Use Explore for codebase searches and code understanding.");
  });
});
