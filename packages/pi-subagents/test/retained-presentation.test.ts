import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { buildAgentPrompt } from "#src/session/prompts";
import { buildAgentGuidelines, buildDetails, buildTypeListText, formatLifetimeTokens, getModelLabelFromConfig, getStatusNote } from "#src/tools/helpers";
import { renderAgentResult, renderCompleted, renderFailed, renderRunning, renderStats, renderStopped } from "#src/tools/result-renderer";
import type { AgentDetails, Theme } from "#src/ui/display";
import { formatDuration, formatModelThinking, formatMs, formatSessionTokens, formatTokens, formatTurns } from "#src/ui/display";
import { createTestSubagent } from "#test/helpers/make-subagent";

const theme: Theme = {
  fg: (color, text) => `[${color}:${text}]`,
  bold: (text) => `**${text}**`,
};
const env = { isGitRepo: true, branch: "main", platform: "linux" } as const;
const noGit = { isGitRepo: false, branch: "", platform: "linux" } as const;
const registry = new AgentTypeRegistry(() => new Map());
const config = (overrides: Record<string, unknown> = {}) => ({ name: "custom", description: "Custom", systemPrompt: "Custom instructions", promptMode: "replace" as const, ...overrides });

function details(overrides: Partial<AgentDetails> = {}): AgentDetails {
  return {
    displayName: "TestAgent", description: "task", subagentType: "general-purpose", modelName: "anthropic/claude-sonnet", thinkingLevel: "high", toolUses: 0, tokens: "", durationMs: 2_000, status: "completed", ...overrides,
  };
}

describe("retained helper contracts", () => {
  it("formats a positive lifetime token total", () => {
    expect(formatLifetimeTokens({ lifetimeUsage: { input: 500, output: 500, cacheWrite: 0 } })).toBe("1.0k token");
  });

  it("returns an empty lifetime token label for zero usage", () => {
    expect(formatLifetimeTokens({ lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } })).toBe("");
  });

  it("formats large lifetime token totals", () => {
    expect(formatLifetimeTokens({ lifetimeUsage: { input: 15_000, output: 18_800, cacheWrite: 0 } })).toBe("33.8k token");
  });

  it("strips a provider prefix from configured model labels", () => {
    expect(getModelLabelFromConfig("anthropic/claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("strips a trailing date suffix from configured model labels", () => {
    expect(getModelLabelFromConfig("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("strips provider and date suffixes together", () => {
    expect(getModelLabelFromConfig("anthropic/claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
  });

  it("keeps an unqualified model label unchanged", () => {
    expect(getModelLabelFromConfig("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("uses the final path segment for models with multiple slashes", () => {
    expect(getModelLabelFromConfig("provider/sub/model-name")).toBe("model-name");
  });

  it("returns a stopped status note and no note for successful status", () => {
    expect(getStatusNote("stopped")).toBe(" (stopped)");
    expect(getStatusNote("completed")).toBe("");
    expect(getStatusNote("error")).toBe("");
  });

  it("lists enabled default agents with descriptions", () => {
    const list = new AgentTypeRegistry(() => new Map());
    expect(buildTypeListText(list, "/home/user/.pi")).toContain("general-purpose");
    expect(buildTypeListText(list, "/home/user/.pi")).toContain("Custom agents can be defined");
  });

  it("adds configured model labels to type descriptions", () => {
    const list = {
      getDefaultAgentNames: () => ["Explore"], getUserAgentNames: () => [], getAvailableTypes: () => ["Explore"], getToolNamesForType: () => [],
      resolveAgentConfig: () => ({ name: "Explore", description: "fast", systemPrompt: "", promptMode: "append" as const, model: "anthropic/claude-haiku-4-5" }),
    };
    expect(buildTypeListText(list, "/home/.pi")).toContain("- Explore: fast (claude-haiku-4-5)");
  });

  it("omits disabled default agents from type descriptions", () => {
    const list = {
      getDefaultAgentNames: () => ["disabled"], getUserAgentNames: () => [], getAvailableTypes: () => [], getToolNamesForType: () => [],
      resolveAgentConfig: () => ({ name: "disabled", description: "hidden", systemPrompt: "", promptMode: "append" as const, enabled: false }),
    };
    expect(buildTypeListText(list, "/home/.pi")).not.toContain("disabled");
  });

  it("renders custom agents in a separate section", () => {
    const list = {
      getDefaultAgentNames: () => [], getUserAgentNames: () => ["mine"], getAvailableTypes: () => ["mine"], getToolNamesForType: () => [],
      resolveAgentConfig: () => ({ name: "mine", description: "custom task", systemPrompt: "", promptMode: "replace" as const }),
    };
    const text = buildTypeListText(list, "/home/.pi");
    expect(text).toContain("Custom agents:");
    expect(text).toContain("- mine: custom task");
  });

  it("omits the custom section when no custom agents exist", () => {
    expect(buildTypeListText(registry, "/home/.pi")).not.toContain("Custom agents:");
  });

  it("includes the configured agent directory in the type-list hint", () => {
    expect(buildTypeListText(registry, "/home/nathan/.pi")).toContain("/home/nathan/.pi");
  });

  it("preserves enabled guideline order", () => {
    const list = {
      getDefaultAgentNames: () => ["one", "two"], getUserAgentNames: () => [], getAvailableTypes: () => ["one", "two"], getToolNamesForType: () => [],
      resolveAgentConfig: (name: string) => ({ name, description: name, systemPrompt: "", promptMode: "append" as const, toolGuideline: `Use ${name}` }),
    };
    expect(buildAgentGuidelines(list)).toEqual(["Use one", "Use two"]);
  });

  it("omits disabled agent guidelines", () => {
    const list = {
      getDefaultAgentNames: () => ["one", "two"], getUserAgentNames: () => [], getAvailableTypes: () => [], getToolNamesForType: () => [],
      resolveAgentConfig: (name: string) => ({ name, description: name, systemPrompt: "", promptMode: "append" as const, enabled: name === "two" ? false : true, toolGuideline: name }),
    };
    expect(buildAgentGuidelines(list)).toEqual(["one"]);
  });

  it("omits agents without guidelines", () => {
    const list = {
      getDefaultAgentNames: () => ["one", "two"], getUserAgentNames: () => [], getAvailableTypes: () => [], getToolNamesForType: () => [],
      resolveAgentConfig: (name: string) => ({ name, description: name, systemPrompt: "", promptMode: "append" as const, ...(name === "one" ? { toolGuideline: "Use one" } : {}) }),
    };
    expect(buildAgentGuidelines(list)).toEqual(["Use one"]);
  });

  it("maps record metrics and active runtime into details", () => {
    const record = createTestSubagent({ startedAt: 1_000, completedAt: 5_000, turnCount: 7, maxTurns: 10 });
    const result = buildDetails({ displayName: "Agent", description: "task", subagentType: "Explore", modelName: undefined, thinkingLevel: "high", tags: undefined }, record, { durationMs: 4_000 });
    expect(result).toMatchObject({ toolUses: 3, durationMs: 4_000, turnCount: 7, maxTurns: 10, status: "completed", agentId: "agent-1" });
  });

  it("uses the active runtime instead of timestamp subtraction", () => {
    const record = { toolUses: 0, startedAt: 1_000, completedAt: 9_000, activeRuntimeMs: 125, status: "running", lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } };
    expect(buildDetails({ displayName: "A", description: "d", subagentType: "x", modelName: undefined, thinkingLevel: "off", tags: undefined }, record).durationMs).toBe(125);
  });

  it("applies detail overrides after computed fields", () => {
    const record = createTestSubagent();
    expect(buildDetails({ displayName: "A", description: "d", subagentType: "x", modelName: undefined, thinkingLevel: "off", tags: undefined }, record, { tokens: "99.9k token" }).tokens).toBe("99.9k token");
  });

  it("returns zero runtime when no active runtime is supplied", () => {
    const record = { toolUses: 0, startedAt: 1_000, status: "queued", lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 } };
    expect(buildDetails({ displayName: "A", description: "d", subagentType: "x", modelName: undefined, thinkingLevel: "off", tags: undefined }, record).durationMs).toBe(0);
  });
});

describe("retained display formatters", () => {
  it("formats token counts below one thousand", () => { expect(formatTokens(999)).toBe("999 token"); });
  it("formats token counts with k suffix", () => { expect(formatTokens(1_500)).toBe("1.5k token"); });
  it("formats token counts with M suffix", () => { expect(formatTokens(1_500_000)).toBe("1.5M token"); });
  it("formats exact model and thinking labels", () => { expect(formatModelThinking("p/model", "medium")).toBe("p/model · thinking: medium"); });
  it("formats milliseconds as seconds", () => { expect(formatMs(3_500)).toBe("3.5s"); });
  it("formats a completed duration", () => { expect(formatDuration(1_000, 4_500)).toBe("3.5s"); });
  it("formats a running duration with a marker", () => { expect(formatDuration(Date.now(), undefined)).toMatch(/0\.\ds \(running\)/); });
  it("formats turns with and without a maximum", () => { expect(formatTurns(5, 30)).toBe("↻5≤30"); expect(formatTurns(5)).toBe("↻5"); });
  it("formats session token annotations below warning thresholds", () => { expect(formatSessionTokens(1_000, 45, theme)).toContain("[dim:45%]"); });
  it("formats session token annotations at warning thresholds", () => { expect(formatSessionTokens(1_000, 70, theme)).toContain("[warning:70%]"); });
  it("formats session token annotations at error thresholds", () => { expect(formatSessionTokens(1_000, 85, theme)).toContain("[error:85%]"); });
  it("includes compaction annotations in session token display", () => { expect(formatSessionTokens(1_000, null, theme, 2)).toContain("⇊2"); });
});

describe("retained joined-result rendering", () => {
  it("always includes the effective model when other stats are absent", () => { expect(renderStats(details(), theme)).toContain("anthropic/claude-sonnet · thinking: high"); });
  it("includes tags while avoiding a duplicate thinking tag", () => { expect(renderStats(details({ tags: ["thinking: high", "inherit context"] }), theme)).toContain("inherit context"); });
  it("includes turn count with a max", () => { expect(renderStats(details({ turnCount: 5, maxTurns: 30 }), theme)).toContain("↻5≤30"); });
  it("includes turn count without a max", () => { expect(renderStats(details({ turnCount: 5 }), theme)).toContain("↻5"); });
  it("omits zero turn count and zero tool uses", () => { const text = renderStats(details({ turnCount: 0, toolUses: 0 }), theme); expect(text).not.toContain("↻"); expect(text).not.toContain("tool use"); });
  it("uses singular tool-use grammar", () => { expect(renderStats(details({ toolUses: 1 }), theme)).toContain("1 tool use]"); });
  it("uses plural tool-use grammar", () => { expect(renderStats(details({ toolUses: 3 }), theme)).toContain("3 tool uses]"); });
  it("includes lifetime tokens", () => { expect(renderStats(details({ tokens: "33.8k token" }), theme)).toContain("33.8k token"); });
  it("uses the requested spinner frame", () => { expect(renderRunning(details({ status: "running", spinnerFrame: 1 }), theme)).toContain("[accent:⠙]"); });
  it("defaults the spinner frame to the first frame", () => { expect(renderRunning(details({ status: "running" }), theme)).toContain("[accent:⠋]"); });
  it("uses activity text when present", () => { expect(renderRunning(details({ status: "running", activity: "reading files" }), theme)).toContain("reading files"); });
  it("falls back to thinking activity", () => { expect(renderRunning(details({ status: "running" }), theme)).toContain("thinking…"); });
  it("renders activity on a dim second line", () => { expect(renderRunning(details({ status: "running", activity: "searching" }), theme)).toContain("[dim:  ⎿  searching]"); });
  it("renders completed output in expanded view", () => { expect(renderCompleted(details(), "one\ntwo", true, theme)).toContain("[dim:  one]\n[dim:  two]"); });
  it("limits expanded output to fifty lines", () => { const output = renderCompleted(details(), Array.from({ length: 55 }, (_, i) => `line ${i + 1}`).join("\n"), true, theme); expect(output).toContain("line 50"); expect(output).not.toContain("line 51"); expect(output).toContain("output truncated"); });
  it("does not add content lines for empty collapsed output", () => { expect(renderCompleted(details(), "", false, theme)).toContain("Done"); });
  it("labels graceful turn-limit completion in the collapsed result", () => { expect(renderCompleted(details({ terminalReason: "turn_limit_graceful" }), "", false, theme)).toContain("Completed (turn limit)"); });
  it("renders stopped reason text", () => { expect(renderStopped(details({ status: "stopped", terminalReason: "runtime_timeout" }), theme)).toContain("Stopped (runtime timeout)"); });
  it("renders stopped statistics", () => { expect(renderStopped(details({ status: "stopped", modelName: "haiku" }), theme)).toContain("haiku · thinking: high"); });
  it("renders error text", () => { expect(renderFailed(details({ status: "error", error: "Out of context" }), theme)).toContain("Error: Out of context"); });
  it("uses an unknown error label when error is absent", () => { expect(renderFailed(details({ status: "error" }), theme)).toContain("Error: unknown"); });
  it("dispatches queued results to the running renderer", () => { expect(renderAgentResult(details({ status: "queued" }), "", false, false, theme)).toContain("thinking…"); });
  it("dispatches partial completed results to the running renderer", () => { expect(renderAgentResult(details(), "", false, true, theme)).toContain("thinking…"); });
  it("dispatches completed results to the completed renderer", () => { expect(renderAgentResult(details(), "", false, false, theme)).toContain("Done"); });
  it("dispatches stopped results to the stopped renderer", () => { expect(renderAgentResult(details({ status: "stopped" }), "", false, false, theme)).toContain("Stopped"); });
  it("dispatches errors to the failed renderer", () => { expect(renderAgentResult(details({ status: "error", error: "boom" }), "", false, false, theme)).toContain("Error: boom"); });
});

describe("retained prompt contracts", () => {
  it("includes cwd and git information", () => { const text = buildAgentPrompt(registry.resolveAgentConfig("general-purpose"), "/workspace", env); expect(text).toContain("Working directory: /workspace"); expect(text).toContain("Branch: main"); expect(text).toContain("linux"); });
  it("describes a non-git repository", () => { expect(buildAgentPrompt(registry.resolveAgentConfig("Explore"), "/workspace", noGit)).toContain("Not a git repository"); });
  it("uses the generic base when no parent prompt is available", () => { expect(buildAgentPrompt(config(), "/workspace", env)).toContain("general-purpose coding agent"); });
  it("places replace instructions after environment metadata", () => { const text = buildAgentPrompt(config({ name: "ordered" }), "/workspace", env, "IDENTITY"); expect(text.indexOf("# Environment")).toBeLessThan(text.indexOf("Custom instructions")); });
  it("keeps replace mode free of the append bridge", () => { expect(buildAgentPrompt(config(), "/workspace", env, "Parent")).not.toContain("<sub_agent_context>"); });
  it("wraps non-empty append instructions", () => { const text = buildAgentPrompt(config({ promptMode: "append" }), "/workspace", env, "Parent"); expect(text).toContain("<sub_agent_context>"); expect(text).toContain("<agent_instructions>"); });
  it("keeps empty append instructions as a parent clone with bridge metadata", () => { const text = buildAgentPrompt(config({ promptMode: "append", systemPrompt: "" }), "/workspace", env, "Parent"); expect(text).toContain("<sub_agent_context>"); expect(text).not.toContain("<agent_instructions>"); });
  it("places the active agent tag in replace mode", () => { expect(buildAgentPrompt(config({ name: "replace-agent" }), "/workspace", env)).toContain('<active_agent name="replace-agent"/>'); });
  it("places the active agent tag in append mode", () => { expect(buildAgentPrompt(config({ name: "append-agent", promptMode: "append" }), "/workspace", env, "Parent")).toContain('<active_agent name="append-agent"/>'); });
  it("preserves active agent ordering before environment metadata", () => { const text = buildAgentPrompt(config({ name: "ordered" }), "/workspace", env); expect(text.indexOf('<active_agent name="ordered"/>')).toBeLessThan(text.indexOf("# Environment")); });
  it("removes a contradictory parent cwd footer for a different child cwd", () => { const text = buildAgentPrompt(config({ promptMode: "append", systemPrompt: "" }), "/workspace/worktree", env, "Current working directory: /workspace/main", "/workspace/main"); expect(text).not.toContain("Current working directory: /workspace/main"); expect(text).toContain("Working directory: /workspace/worktree"); });
  it("retains the parent cwd footer when cwd is shared", () => { const text = buildAgentPrompt(config(), "/workspace", env, "Current working directory: /workspace", "/workspace"); expect(text).toContain("Current working directory: /workspace"); });
  it("normalizes backslashes when comparing prompt paths", () => { const text = buildAgentPrompt(config({ promptMode: "append", systemPrompt: "" }), "C:\\work\\child", env, "Current working directory: C:\\work\\parent", "C:\\work\\parent"); expect(text).not.toContain("Current working directory: C:/work/parent"); });
});
