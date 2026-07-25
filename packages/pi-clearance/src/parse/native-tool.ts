import { requireNativeEngine } from "../native/loader.ts";
import type { ToolAnalyzer } from "./registry.ts";
import type { PiBuiltinToolShape, PiBuiltinToolSpec } from "./shape.ts";
import {
  SUPPORTED_PI_BUILTIN_TOOL_SPECS,
  SUPPORTED_PI_EXTENSION_TOOL_SPECS,
  SUPPORTED_PI_MUTATION_TOOL_SPECS,
  SUPPORTED_PI_TOOL_SPECS,
} from "./tool-specs.ts";

export {
  SUPPORTED_PI_BUILTIN_TOOL_SPECS,
  SUPPORTED_PI_EXTENSION_TOOL_SPECS,
  SUPPORTED_PI_MUTATION_TOOL_SPECS,
  SUPPORTED_PI_TOOL_SPECS,
};

export function createPiBuiltinToolAnalyzers(): readonly ToolAnalyzer[] {
  return SUPPORTED_PI_TOOL_SPECS.map((spec) => ({
    toolName: spec.toolName,
    analyze: async (input) => analyzePiBuiltinToolAsync(spec, input),
  }));
}

export function analyzePiBuiltinTool(
  spec: PiBuiltinToolSpec,
  input: unknown,
): PiBuiltinToolShape {
  try {
    return requireNativeEngine().analyzeTool(
      spec.toolName,
      input,
    ) as PiBuiltinToolShape;
  } catch (error: unknown) {
    return {
      kind: "pi-tool",
      toolName: spec.toolName,
      operation: spec.operation,
      rawInput: null,
      pathInputs: [],
      diagnostics: [
        {
          code: "pi-tool:malformed-input",
          severity: "error",
          message: `Tool "${spec.toolName}" input could not be analyzed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

export async function analyzePiBuiltinToolAsync(
  spec: PiBuiltinToolSpec,
  input: unknown,
): Promise<PiBuiltinToolShape> {
  return analyzePiBuiltinTool(spec, input);
}
