import { describe, expect, test } from "bun:test";
import modelListExtension from "./model-list";

type ToolDef = {
  name: string;
  label?: string;
  description?: string;
  promptSnippet?: string;
};

function load() {
  const tools = new Map<string, ToolDef>();
  const pi = {
    registerTool: (tool: ToolDef) => {
      tools.set(tool.name, tool);
    },
  };
  modelListExtension(pi as never);
  return tools;
}

describe("list_subagent_models tool", () => {
  test("registers the list_subagent_models tool", () => {
    const tools = load();
    expect(tools.has("list_subagent_models")).toBe(true);
  });

  test("describes the available-by-default behavior and subagentModel usage", () => {
    const tools = load();
    const tool = tools.get("list_subagent_models")!;
    expect(tool.description ?? "").toMatch(/available/i);
    expect(tool.promptSnippet ?? "").toMatch(/available=false/i);
  });
});
