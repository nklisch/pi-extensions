import { describe, expect, it } from "vitest";

import type {
  BashBlock,
  BashFlag,
  BashPipeline,
  BashStage,
  BashStageProgram,
  Redirect,
  SourceSpan,
  Substitution,
  ToolShape,
} from "../src/parse/shape.ts";
import {
  flattenStages,
  hasStdoutRedirect,
  hasSubstitution,
  liftCwdPrefix,
  pipelineHasTarget,
  summarizeShape,
} from "../src/parse/shape-utils.ts";

const span = (start: number, end: number): SourceSpan => ({ start, end });

function commandStage(options: {
  readonly program: string;
  readonly arguments?: readonly string[];
  readonly flags?: readonly BashFlag[];
  readonly substitutions?: readonly Substitution[];
  readonly redirects?: readonly Redirect[];
  readonly resolvable?: boolean;
  readonly span?: SourceSpan;
}): Extract<BashStage, { readonly kind: "command" }> {
  const stageSpan = options.span ?? span(0, options.program.length);
  const program: BashStageProgram = {
    program: options.program,
    resolvable: options.resolvable ?? true,
    arguments: options.arguments ?? [],
    flags: options.flags ?? [],
    environment: [],
    span: stageSpan,
  };

  return {
    kind: "command",
    program,
    substitutions: options.substitutions ?? [],
    redirects: options.redirects ?? [],
    span: stageSpan,
  };
}

function flag(raw: string, start = 0): BashFlag {
  return {
    raw,
    name: raw.replace(/^-+/, ""),
    short: !raw.startsWith("--"),
    span: span(start, start + raw.length),
  };
}

function substitution(raw: string, start = 0): Substitution {
  return {
    kind: "command",
    raw,
    span: span(start, start + raw.length),
  };
}

function redirect(stream: Redirect["stream"], start = 0): Redirect {
  return {
    stream,
    targetKind: "file",
    target: "out.txt",
    append: false,
    span: span(start, start + 9),
  };
}

function pipeline(stages: readonly BashStage[]): BashPipeline {
  return {
    stages,
    pipeTargets: stages
      .slice(1)
      .map((stage) =>
        stage.kind === "command" && stage.program.resolvable
          ? stage.program.program
          : "",
      ),
    span: span(0, 20),
  };
}

function block(options: {
  readonly stages: readonly BashStage[];
  readonly operator?: BashBlock["operator"];
  readonly background?: boolean;
}): BashBlock {
  return {
    pipeline: pipeline(options.stages),
    span: span(0, 20),
    ...(options.operator === undefined ? {} : { operator: options.operator }),
    ...(options.background === undefined
      ? {}
      : { background: options.background }),
  };
}

function bashShape(stages: readonly BashStage[]): ToolShape {
  return {
    kind: "bash",
    rawCommand: "git status",
    blocks: [block({ stages })],
    stages,
    diagnostics: [],
  };
}

describe("liftCwdPrefix", () => {
  it("lifts the literal cd single-argument and-prefix block", () => {
    const cd = commandStage({
      program: "cd",
      arguments: ["repo"],
      span: span(0, 7),
    });
    const git = commandStage({ program: "git", arguments: ["status"] });
    const blocks = [
      block({ stages: [cd], operator: "and" }),
      block({ stages: [git] }),
    ];

    const result = liftCwdPrefix(blocks);

    expect(result.cwdPrefix).toBe("repo");
    expect(result.blocks).toEqual([blocks[1]]);
    expect(result.blocks).not.toBe(blocks);
    expect(result.diagnostics).toEqual([]);
  });

  it("does not diagnose when there is no leading cd candidate", () => {
    const blocks = [block({ stages: [commandStage({ program: "git" })] })];

    expect(liftCwdPrefix(blocks)).toEqual({ blocks, diagnostics: [] });
  });

  it.each([
    [
      "flags",
      block({
        stages: [
          commandStage({
            program: "cd",
            arguments: ["repo"],
            flags: [flag("-P")],
          }),
        ],
        operator: "and",
      }),
    ],
    [
      "substitution in path",
      block({
        stages: [
          commandStage({
            program: "cd",
            arguments: ["$(pwd)"],
            substitutions: [substitution("$(pwd)")],
          }),
        ],
        operator: "and",
      }),
    ],
    [
      "extra arguments",
      block({
        stages: [commandStage({ program: "cd", arguments: ["a", "b"] })],
        operator: "and",
      }),
    ],
    [
      "missing and operator",
      block({ stages: [commandStage({ program: "cd", arguments: ["repo"] })] }),
    ],
    [
      "sequence operator",
      block({
        stages: [commandStage({ program: "cd", arguments: ["repo"] })],
        operator: "seq",
      }),
    ],
    [
      "redirect",
      block({
        stages: [
          commandStage({
            program: "cd",
            arguments: ["repo"],
            redirects: [redirect("stdout")],
          }),
        ],
        operator: "and",
      }),
    ],
    [
      "background",
      block({
        stages: [commandStage({ program: "cd", arguments: ["repo"] })],
        operator: "and",
        background: true,
      }),
    ],
    [
      "pipeline",
      block({
        stages: [
          commandStage({ program: "cd", arguments: ["repo"] }),
          commandStage({ program: "cat" }),
        ],
        operator: "and",
      }),
    ],
  ])("leaves %s cd prefixes unlifted with a diagnostic", (_label, first) => {
    const blocks = [
      first,
      block({ stages: [commandStage({ program: "git" })] }),
    ];

    const result = liftCwdPrefix(blocks);

    expect(result.cwdPrefix).toBeUndefined();
    expect(result.blocks).toEqual(blocks);
    expect(result.blocks).not.toBe(blocks);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "bash:cwd-prefix-unsupported",
      severity: "warning",
    });
  });
});

describe("structure predicates", () => {
  it("flattens stages in block order", () => {
    const git = commandStage({ program: "git" });
    const tail = commandStage({ program: "tail" });
    const pnpm = commandStage({ program: "pnpm" });

    expect(
      flattenStages([
        block({ stages: [git, tail] }),
        block({ stages: [pnpm] }),
      ]),
    ).toEqual([git, tail, pnpm]);
  });

  it("detects substitutions only on command stages", () => {
    expect(
      hasSubstitution(
        commandStage({ program: "cat", substitutions: [substitution("$(x)")] }),
      ),
    ).toBe(true);
    expect(hasSubstitution(commandStage({ program: "cat" }))).toBe(false);
    expect(hasSubstitution({ kind: "subshell", span: span(0, 4) })).toBe(false);
  });

  it("detects stdout redirects including combined redirects", () => {
    expect(
      hasStdoutRedirect(
        commandStage({ program: "echo", redirects: [redirect("stdout")] }),
      ),
    ).toBe(true);
    expect(
      hasStdoutRedirect(
        commandStage({ program: "echo", redirects: [redirect("both")] }),
      ),
    ).toBe(true);
    expect(
      hasStdoutRedirect(
        commandStage({ program: "echo", redirects: [redirect("stderr")] }),
      ),
    ).toBe(false);
  });

  it("matches downstream pipeline targets", () => {
    const pipe = pipeline([
      commandStage({ program: "curl" }),
      commandStage({ program: "sh" }),
    ]);

    expect(pipelineHasTarget(pipe, "sh")).toBe(true);
    expect(pipelineHasTarget(pipe, "curl")).toBe(false);
    expect(pipelineHasTarget(pipe, "")).toBe(false);
  });
});

describe("summarizeShape", () => {
  it("summarizes real bash shape stage programs", () => {
    expect(
      summarizeShape(
        bashShape([
          commandStage({ program: "git" }),
          commandStage({ program: "tail" }),
          commandStage({ program: "", resolvable: false }),
        ]),
      ),
    ).toEqual({ stages: ["git", "tail", ""] });
  });

  it("keeps unknown tool shapes as an empty stage summary", () => {
    expect(
      summarizeShape({
        kind: "unknown",
        toolName: "bash",
        rawInput: "git status",
        diagnostics: [],
      }),
    ).toEqual({ stages: [] });
  });
});
