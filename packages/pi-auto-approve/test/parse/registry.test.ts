import { describe, expect, it } from "vitest";

import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import {
  createAnalyzerRegistry,
  createDefaultAnalyzerRegistry,
  type ToolAnalyzer,
} from "../../src/parse/registry.ts";
import type { ToolShape } from "../../src/parse/shape.ts";

describe("ToolAnalyzerRegistry", () => {
  it("uses the default bash analyzer for bash tool calls", async () => {
    const registry = createDefaultAnalyzerRegistry();
    const expected = await analyzeBashCommand("git status");

    await expect(
      registry.analyze("bash", { command: "git status" }),
    ).resolves.toEqual(expected);
  });

  it("returns a bash diagnostic shape for missing or non-string bash command input", async () => {
    const registry = createDefaultAnalyzerRegistry();

    for (const input of [{}, { command: 42 }, { command: null }]) {
      await expect(registry.analyze("bash", input)).resolves.toEqual({
        kind: "bash",
        rawCommand: "",
        blocks: [],
        stages: [],
        diagnostics: [
          expect.objectContaining({
            code: "tool:malformed-bash-input",
            severity: "error",
          }),
        ],
      });
    }
  });

  it("returns an unknown-tool shape for unregistered tools", async () => {
    const input = { path: "README.md" };

    // `edit` and `write` are first-class analyzed Pi tools now; this fixture
    // stands in for any truly unregistered tool name.
    await expect(
      createDefaultAnalyzerRegistry().analyze("legacy_edit", input),
    ).resolves.toEqual({
      kind: "unknown",
      toolName: "legacy_edit",
      rawInput: input,
      diagnostics: [
        expect.objectContaining({
          code: "tool:unsupported",
          severity: "warning",
          message: 'Tool "legacy_edit" is not yet analyzed by pi-auto-approve',
        }),
      ],
    });
  });

  it("selects custom analyzers by toolName", async () => {
    const shape: ToolShape = {
      kind: "unknown",
      toolName: "custom",
      rawInput: { value: 1 },
      diagnostics: [],
    };
    const analyzer: ToolAnalyzer = {
      toolName: "custom",
      analyze: async () => shape,
    };

    await expect(
      createAnalyzerRegistry([analyzer]).analyze("custom", { value: 1 }),
    ).resolves.toBe(shape);
  });

  it("catches analyzer exceptions and fails closed to a diagnostic shape", async () => {
    const analyzer: ToolAnalyzer = {
      toolName: "explode",
      analyze: async () => {
        throw new Error("boom");
      },
    };

    await expect(
      createAnalyzerRegistry([analyzer]).analyze("explode", { command: "x" }),
    ).resolves.toEqual({
      kind: "unknown",
      toolName: "explode",
      rawInput: { command: "x" },
      diagnostics: [
        expect.objectContaining({
          code: "tool:analyzer-error",
          severity: "error",
          message: "Tool analyzer failed closed: boom",
        }),
      ],
    });
  });
});
