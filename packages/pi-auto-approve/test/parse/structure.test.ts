import { describe, expect, it } from "vitest";

import type {
  BashBlock,
  BashStage,
  BashStageProgram,
  SourceSpan,
  ToolShape,
} from "../../src/parse/shape.ts";
import { primaryExecutableFromShape } from "../../src/parse/shape-utils.ts";

const span = (start: number, end: number): SourceSpan => ({ start, end });

function commandStage(
  programName: string,
  options: { readonly resolvable?: boolean } = {},
): Extract<BashStage, { readonly kind: "command" }> {
  const program: BashStageProgram = {
    program: programName,
    resolvable: options.resolvable ?? true,
    arguments: [],
    flags: [],
    environment: [],
    span: span(0, programName.length),
  };

  return {
    kind: "command",
    program,
    substitutions: [],
    redirects: [],
    span: span(0, programName.length),
  };
}

function block(stages: readonly BashStage[]): BashBlock {
  return {
    pipeline: {
      stages,
      pipeTargets: [],
      span: span(0, 20),
    },
    span: span(0, 20),
  };
}

function bashShape(options: {
  readonly blocks: readonly BashBlock[];
  readonly stages?: readonly BashStage[];
}): ToolShape {
  return {
    kind: "bash",
    rawCommand: "git status",
    blocks: options.blocks,
    stages:
      options.stages ?? options.blocks.flatMap((item) => item.pipeline.stages),
    diagnostics: [],
  };
}

describe("primaryExecutableFromShape", () => {
  it("returns the first resolvable command-stage program", () => {
    expect(
      primaryExecutableFromShape(
        bashShape({ blocks: [block([commandStage("git")])] }),
      ),
    ).toBe("git");
  });

  it("skips non-resolvable stages and returns a later resolvable program", () => {
    expect(
      primaryExecutableFromShape(
        bashShape({
          blocks: [
            block([commandStage("shell-function", { resolvable: false })]),
            block([commandStage("git")]),
          ],
        }),
      ),
    ).toBe("git");
  });

  it("falls back to the first non-empty summarized stage name", () => {
    expect(
      primaryExecutableFromShape(
        bashShape({
          blocks: [
            block([commandStage("shell-function", { resolvable: false })]),
          ],
          stages: [commandStage("workflow-tool")],
        }),
      ),
    ).toBe("workflow-tool");
  });

  it("returns undefined for unknown-tool shapes", () => {
    expect(
      primaryExecutableFromShape({
        kind: "unknown",
        toolName: "read",
        rawInput: { path: "README.md" },
        diagnostics: [],
      }),
    ).toBeUndefined();
  });

  it("returns undefined for missing shape input", () => {
    expect(primaryExecutableFromShape(undefined)).toBeUndefined();
  });
});
