import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { renderFinishedLine, renderRunningLines, renderWidgetLines, type WidgetAgent } from "#src/ui/widget-renderer";
import type { Theme } from "#src/ui/display";

const registry = new AgentTypeRegistry(() => new Map());
const theme: Theme = { fg: (style, text) => `[${style}:${text}]`, bold: text => `**${text}**` };
function agent(overrides: Partial<WidgetAgent> = {}): WidgetAgent {
  return { id: "a", type: "general-purpose", status: "completed", description: "task", modelLabel: "p/m", thinkingLevel: "medium", toolUses: 2, startedAt: 1_000, activeRuntimeMs: 5_000, lifetimeUsage: { input: 10, output: 20, cacheWrite: 0 }, compactionCount: 0, turnCount: 3, activeTools: new Map(), responseText: "", contextPercent: null, ...overrides };
}

describe("widget-renderer", () => {
  it("renders terminal stats and success", () => {
    const line = renderFinishedLine(agent(), registry, theme);
    expect(line).toContain("[success:✓]");
    expect(line).toContain("5.0s");
    expect(line).toContain("2 tool uses");
    expect(line).toContain("↻3");
  });

  it("renders stopped and failed terminal reasons", () => {
    expect(renderFinishedLine(agent({ status: "stopped", terminalReason: "runtime_timeout" }), registry, theme)).toContain("stopped (runtime timeout)");
    expect(renderFinishedLine(agent({ status: "error", error: "boom" }), registry, theme)).toContain("error: boom");
  });

  it("renders live activity with a spinner", () => {
    const [header, activity] = renderRunningLines(agent({ status: "running", activeTools: new Map([["1", "read"]]), responseText: "reading" }), registry, 0, theme);
    expect(header).toContain("**Agent**");
    expect(header).toContain("p/m");
    expect(activity).toContain("read");
  });

  it("renders queued and finished sections", () => {
    const lines = renderWidgetLines({ agents: [agent(), agent({ id: "q", status: "queued" })], registry, spinnerFrame: 0, terminalWidth: 120, theme, shouldShowFinished: () => true });
    expect(lines.join("\n")).toContain("Agents");
    expect(lines.join("\n")).toContain("queued");
    expect(lines.join("\n")).toContain("task");
  });

  it("returns no lines when no record is visible", () => {
    expect(renderWidgetLines({ agents: [], registry, spinnerFrame: 0, terminalWidth: 120, theme, shouldShowFinished: () => true })).toEqual([]);
  });

  it("prioritizes active records and reports overflow", () => {
    const agents = Array.from({ length: 10 }, (_, i) => agent({ id: String(i), status: i < 6 ? "running" : "completed" }));
    const lines = renderWidgetLines({ agents, registry, spinnerFrame: 0, terminalWidth: 120, theme, shouldShowFinished: () => true });
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.join("\n")).toContain("more");
  });
});
