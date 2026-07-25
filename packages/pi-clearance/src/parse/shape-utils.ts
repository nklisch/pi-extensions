import type {
  BashBlock,
  BashCommandShape,
  BashPipeline,
  BashStage,
  ShapeDiagnostic,
  ToolShape,
} from "./shape.ts";

export interface ShapeSummary {
  readonly stages: readonly string[];
}

export function flattenStages(
  blocks: readonly BashBlock[],
): readonly BashStage[] {
  return blocks.flatMap((block) => block.pipeline.stages);
}

export function hasSubstitution(stage: BashStage): boolean {
  return stage.kind === "command" && stage.substitutions.length > 0;
}

export function hasStdoutRedirect(stage: BashStage): boolean {
  return (
    stage.kind === "command" &&
    stage.redirects.some(
      (redirect) => redirect.stream === "stdout" || redirect.stream === "both",
    )
  );
}

export function pipelineHasTarget(
  pipeline: BashPipeline,
  name: string,
): boolean {
  return name.length > 0 && pipeline.pipeTargets.includes(name);
}

export interface CwdPrefixLiftResult {
  readonly cwdPrefix?: string;
  readonly blocks: readonly BashBlock[];
  readonly diagnostics: readonly ShapeDiagnostic[];
}

export function liftCwdPrefix(
  blocks: readonly BashBlock[],
): CwdPrefixLiftResult {
  const firstBlock = blocks[0];
  if (firstBlock === undefined) return { blocks: [], diagnostics: [] };
  const firstStage = firstBlock.pipeline.stages[0];
  if (firstStage?.kind !== "command" || firstStage.program.program !== "cd") {
    return { blocks: [...blocks], diagnostics: [] };
  }
  const lone =
    blocks.length === 1 &&
    firstBlock.pipeline.stages.length === 1 &&
    firstBlock.operator === undefined &&
    firstBlock.background !== true;
  if (lone) return { blocks: [...blocks], diagnostics: [] };
  const path = firstStage.program.arguments[0];
  const canLift =
    firstBlock.pipeline.stages.length === 1 &&
    firstStage.program.resolvable &&
    firstStage.program.arguments.length === 1 &&
    firstStage.program.flags.length === 0 &&
    firstStage.program.environment.length === 0 &&
    !hasSubstitution(firstStage) &&
    firstStage.redirects.length === 0 &&
    firstBlock.operator === "and" &&
    firstBlock.background !== true;
  if (canLift && path !== undefined) {
    return { cwdPrefix: path, blocks: blocks.slice(1), diagnostics: [] };
  }
  return {
    blocks: [...blocks],
    diagnostics: [cwdPrefixUnsupportedDiagnostic(firstStage)],
  };
}

export function summarizeShape(shape: ToolShape): ShapeSummary {
  return shape.kind === "bash"
    ? { stages: stageProgramNames(shape) }
    : { stages: [] };
}

export function primaryExecutableFromShape(
  shape: ToolShape | undefined,
): string | undefined {
  if (shape?.kind !== "bash") return undefined;
  const fromBlocks = flattenStages(shape.blocks).find(
    (stage) =>
      stage.kind === "command" &&
      stage.program.resolvable &&
      stage.program.program.length > 0,
  );
  if (fromBlocks?.kind === "command") return fromBlocks.program.program;
  return summarizeShape(shape).stages.find((stage) => stage.length > 0);
}

export type EmbeddedShellPiToolShape = Extract<
  ToolShape,
  { kind: "pi-tool" }
> & {
  readonly embeddedShell?: {
    readonly command?: BashCommandShape;
  };
};

export function asEmbeddedShellShape(
  shape: ToolShape,
): EmbeddedShellPiToolShape | undefined {
  return shape.kind === "pi-tool" && shape.operation === "embedded-shell"
    ? (shape as EmbeddedShellPiToolShape)
    : undefined;
}

function stageProgramNames(shape: BashCommandShape): readonly string[] {
  return shape.stages.map((stage) =>
    stage.kind === "command" && stage.program.resolvable
      ? stage.program.program
      : "",
  );
}

export function cwdPrefixUnsupportedDiagnostic(
  stage: BashStage,
): ShapeDiagnostic {
  return {
    code: "bash:cwd-prefix-unsupported",
    message:
      "Leading cd command is not a supported cwd-prefix form and requires review",
    severity: "warning",
    ...(stage.kind === "command" ? { source: stage.span } : {}),
  };
}
