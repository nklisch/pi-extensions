import { describe, expect, it } from "vitest";
import { renderHookContextMessage, type HookContextMessageDetails } from "../../../src/pi/hooks/pi-hook-context-renderer.js";

const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text } as any;

function message(details: Partial<HookContextMessageDetails>, content: string) {
  return { role: "custom", customType: "pi-plugin-host.hook-context-v1", content, display: true, details, timestamp: 0 } as any;
}

function rendered(component: { render(width: number): string[] } | undefined): string {
  return component === undefined ? "" : component.render(100).join("\n").trimEnd();
}

describe("hook context transcript renderer", () => {
  it("collapses to one attribution line without leaking the injected text", () => {
    const output = rendered(renderHookContextMessage(
      message({ plugin: "agile-workflow@lab", event: "SessionStart", presentation: "line" }, "SECRET INJECTED TEXT"),
      { expanded: false },
      theme,
    ));
    expect(output).toContain("agile-workflow@lab");
    expect(output).toContain("SessionStart");
    expect(output).toContain("20 chars");
    expect(output).not.toContain("SECRET INJECTED TEXT");
  });

  it("shows the exact injected text when expanded", () => {
    const output = rendered(renderHookContextMessage(
      message({ plugin: "agile-workflow@lab", event: "SessionStart", presentation: "line" }, "the full context"),
      { expanded: true },
      theme,
    ));
    expect(output).toContain("the full context");
  });

  it("preserves multiline structure and counts the raw injected length", () => {
    const multiline = "first line\nsecond line\nthird line";
    const collapsed = rendered(renderHookContextMessage(
      message({ plugin: "demo@market", event: "SessionStart", presentation: "line" }, multiline),
      { expanded: false },
      theme,
    ));
    expect(collapsed).toContain(`${multiline.length} chars`);
    const expanded = rendered(renderHookContextMessage(
      message({ plugin: "demo@market", event: "SessionStart", presentation: "line" }, multiline),
      { expanded: true },
      theme,
    ));
    expect(expanded.split("\n").map((line) => line.trimEnd())).toEqual([
      "⚙ demo@market · SessionStart · hook added this to model context",
      "first line",
      "second line",
      "third line",
    ]);
    expect(expanded).not.toContain("\ufffd");
  });

  it("always shows the injected text for full presentation, even unexpanded", () => {
    const output = rendered(renderHookContextMessage(
      message({ plugin: "demo@market", event: "UserPromptSubmit", presentation: "full" }, "everything"),
      { expanded: false },
      theme,
    ));
    expect(output).toContain("everything");
  });

  it("sanitizes terminal control sequences out of attribution and content", () => {
    const output = rendered(renderHookContextMessage(
      message({ plugin: "demo\u001b[2J@market", event: "Stop", presentation: "full" }, "payload\u001b[1Ghere"),
      { expanded: true },
      theme,
    ));
    expect(output).not.toContain("\u001b");
    expect(output).toContain("payload");
    expect(output).toContain("demo");
  });
});
