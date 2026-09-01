import { describe, expect, it } from "vitest";
import { renderAgentResult, renderCompleted, renderFailed, renderRunning, renderStats, renderStopped } from "#src/tools/result-renderer";
import type { AgentDetails, Theme } from "#src/ui/display";

const theme: Theme = { fg: (style, text) => `[${style}:${text}]`, bold: text => `**${text}**` };
function details(overrides: Partial<AgentDetails> = {}): AgentDetails {
  return { displayName: "Agent", description: "task", subagentType: "general-purpose", modelName: "p/m", thinkingLevel: "high", toolUses: 0, tokens: "", durationMs: 2_000, status: "completed", ...overrides };
}

describe("result-renderer", () => {
  it("renders model, thinking, tags, turns, tools, and tokens", () => {
    const text = renderStats(details({ tags: ["mode: joined"], turnCount: 2, maxTurns: 5, toolUses: 3, tokens: "1.0k token" }), theme);
    expect(text).toContain("p/m · thinking: high");
    expect(text).toContain("mode: joined");
    expect(text).toContain("↻2≤5");
    expect(text).toContain("3 tool uses");
  });

  it("renders running status and activity", () => {
    expect(renderRunning(details({ status: "running", activity: "reading", spinnerFrame: 1 }), theme)).toContain("reading");
  });

  it("renders completed output collapsed or expanded", () => {
    expect(renderCompleted(details(), "one\ntwo", false, theme)).toContain("Done");
    expect(renderCompleted(details(), "one\ntwo", true, theme)).toContain("  one");
    expect(renderCompleted(details(), "one\ntwo", true, theme)).toContain("  two");
  });

  it("bounds expanded result rendering", () => {
    const result = renderCompleted(details(), Array.from({ length: 55 }, (_, i) => `line ${i + 1}`).join("\n"), true, theme);
    expect(result).toContain("line 50");
    expect(result).not.toContain("line 51");
    expect(result).toContain("output truncated");
  });

  it("renders stop and error reasons", () => {
    expect(renderStopped(details({ status: "stopped", terminalReason: "runtime_timeout" }), theme)).toContain("Stopped (runtime timeout)");
    expect(renderFailed(details({ status: "error", error: "boom" }), theme)).toContain("Error: boom");
  });

  it("dispatches by coarse status and partial state", () => {
    expect(renderAgentResult(details({ status: "running" }), "", false, false, theme)).toContain("thinking");
    expect(renderAgentResult(details({ status: "completed" }), "answer", false, false, theme)).toContain("Done");
    expect(renderAgentResult(details({ status: "stopped", terminalReason: "explicit_stop" }), "", false, false, theme)).toContain("Stopped");
    expect(renderAgentResult(details({ status: "error", error: "bad" }), "", false, false, theme)).toContain("Error: bad");
    expect(renderAgentResult(details({ status: "completed" }), "", false, true, theme)).toContain("thinking");
  });
});
