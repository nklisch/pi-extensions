import { requireNativeEngine } from "../native/loader.ts";
import type { ShapeDiagnostic, ToolShape, UnknownToolShape } from "./shape.ts";

export interface ToolAnalyzer {
  readonly toolName: string;
  readonly analyze: (input: unknown) => Promise<ToolShape>;
}

export interface ToolAnalyzerRegistry {
  /** Analyze a tool input. Unknown tools and analyzer failures are always shapes. */
  readonly analyze: (toolName: string, input: unknown) => Promise<ToolShape>;
}

export function createAnalyzerRegistry(
  analyzers: readonly ToolAnalyzer[],
): ToolAnalyzerRegistry {
  const byToolName = new Map(
    analyzers.map((analyzer) => [analyzer.toolName, analyzer]),
  );

  return {
    analyze: async (toolName, input) => {
      const analyzer = byToolName.get(toolName);
      if (analyzer === undefined) {
        return unknownToolShape(
          toolName,
          input,
          unsupportedDiagnostic(toolName),
        );
      }
      try {
        return await analyzer.analyze(input);
      } catch (error: unknown) {
        return unknownToolShape(
          toolName,
          input,
          analyzerErrorDiagnostic(error),
        );
      }
    },
  };
}

/**
 * The runtime registry is deliberately a single native seam. There is no
 * TypeScript parser or analyzer fallback: a missing/broken native artifact is
 * a startup error, not an opportunity to silently arm a second implementation.
 */
export function createDefaultAnalyzerRegistry(): ToolAnalyzerRegistry {
  const native = requireNativeEngine();
  return {
    analyze: async (toolName, input) => {
      try {
        return native.analyzeTool(toolName, input);
      } catch (error: unknown) {
        if (toolName === "edit" || toolName === "write") {
          return {
            kind: "pi-tool",
            toolName,
            operation: "mutation",
            rawInput: null,
            pathInputs: [],
            diagnostics: [analyzerErrorDiagnostic(error)],
          };
        }
        return unknownToolShape(
          toolName,
          input,
          analyzerErrorDiagnostic(error),
        );
      }
    },
  };
}

function unknownToolShape(
  toolName: string,
  rawInput: unknown,
  diagnostic: ShapeDiagnostic,
): UnknownToolShape {
  return {
    kind: "unknown",
    toolName,
    rawInput,
    diagnostics: [diagnostic],
  };
}

function unsupportedDiagnostic(toolName: string): ShapeDiagnostic {
  return {
    code: "tool:unsupported",
    severity: "warning",
    message: `Tool "${toolName}" is not yet analyzed by pi-auto-approve`,
  };
}

function analyzerErrorDiagnostic(error: unknown): ShapeDiagnostic {
  return {
    code: "tool:analyzer-error",
    severity: "error",
    message: `Tool analyzer failed closed: ${errorMessage(error)}`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown analyzer error";
}
