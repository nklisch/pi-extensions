import { classifyStageEffect } from "../parse/native-effects.ts";
import type {
  BashPathFact,
  BashStage,
  PiBuiltinToolShape,
  ShapeDiagnostic,
  ToolShape,
} from "../parse/shape.ts";

export interface ReviewerShapeSummaryFact {
  readonly label: string;
  readonly value: unknown;
  readonly stageIndex?: number;
  readonly bodyStageIndex?: number;
}

export interface ReviewerShapeSummary {
  readonly kind: ToolShape["kind"];
  readonly diagnostics: readonly string[];
  readonly facts: readonly ReviewerShapeSummaryFact[];
}

/**
 * Build stable reviewer-facing labels over analyzer-owned facts.
 *
 * The summary is evidence, not policy: it never decides allow/deny, never reads
 * the filesystem, and keeps the raw shape JSON available to the reviewer. Its
 * only job is to give prompt text names that are easier to reference than a
 * deeply nested `ToolShape` object.
 */
export function buildReviewerShapeSummary(
  shape: ToolShape,
): ReviewerShapeSummary {
  try {
    return {
      kind: shape.kind,
      diagnostics: diagnosticCodes(shape.diagnostics),
      facts: summaryFacts(shape),
    };
  } catch (error) {
    return {
      kind: shape.kind,
      diagnostics: diagnosticCodes(shape.diagnostics),
      facts: [
        {
          label: "summary.error",
          value: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

function summaryFacts(shape: ToolShape): readonly ReviewerShapeSummaryFact[] {
  switch (shape.kind) {
    case "bash":
      return bashSummaryFacts(shape.stages, shape.pathFacts?.facts ?? []);
    case "pi-tool":
      return piToolSummaryFacts(shape);
    case "unknown":
      return [
        { label: "tool.name", value: shape.toolName },
        { label: "tool.support", value: "unknown" },
      ];
  }
}

function bashSummaryFacts(
  stages: readonly BashStage[],
  pathFacts: readonly BashPathFact[],
): readonly ReviewerShapeSummaryFact[] {
  const facts: ReviewerShapeSummaryFact[] = [];

  stages.forEach((stage, stageIndex) => {
    facts.push(...stageFacts(stage, stageIndex));
  });

  for (const fact of pathFacts) {
    if (fact.provenance?.kind !== "loop-variable") continue;
    const provenance = fact.provenance;
    facts.push(
      {
        label: "iterator.variable",
        value: provenance.variableName,
        stageIndex: provenance.loopStageIndex,
      },
      {
        label: "iterator.sourceKind",
        value: provenance.iteratorSourceKind,
        stageIndex: provenance.loopStageIndex,
      },
      {
        label: "iterator.scope",
        value: fact.scope,
        stageIndex: provenance.loopStageIndex,
      },
      {
        label: "iterator.globApproximation",
        value: fact.globApproximation === true,
        stageIndex: provenance.loopStageIndex,
      },
      {
        label: "iterator.entries",
        value: provenance.iteratorEntries.map((entry) => ({
          raw: entry.raw,
          literal: entry.literal,
          scope: entry.scope,
          matchedScopes: entry.matchedScopes,
          quote: entry.quote,
          unknownReason: entry.unknownReason,
        })),
        stageIndex: provenance.loopStageIndex,
      },
    );
    if (provenance.unknownReason !== undefined) {
      facts.push({
        label: "iterator.unknownReason",
        value: provenance.unknownReason,
        stageIndex: provenance.loopStageIndex,
      });
    }
  }

  return facts;
}

function stageFacts(
  stage: BashStage,
  stageIndex: number,
): readonly ReviewerShapeSummaryFact[] {
  switch (stage.kind) {
    case "for-loop":
      return [
        { label: "compound.form", value: "for", stageIndex },
        { label: "compound.support", value: "modeled", stageIndex },
        { label: "iterator.variable", value: stage.variable, stageIndex },
        {
          label: "iterator.entryKinds",
          value: stage.iterator.map((entry) => entry.kind),
          stageIndex,
        },
        ...bodyFacts(stage.body.pipeline.stages, stageIndex),
      ];
    case "brace-group":
      return [
        { label: "compound.form", value: "brace-group", stageIndex },
        { label: "compound.support", value: "modeled", stageIndex },
        {
          label: "compound.outputFileRedirect",
          value: hasOutputFileRedirect(stage.redirects),
          stageIndex,
        },
        ...bodyFacts(stage.body.pipeline.stages, stageIndex),
      ];
    case "conditional":
      return [
        { label: "compound.form", value: "if", stageIndex },
        { label: "compound.support", value: "modeled", stageIndex },
        ...stage.arms.flatMap((arm) => [
          ...bodyFacts(arm.test.stages, stageIndex),
          ...bodyFacts(arm.body.pipeline.stages, stageIndex),
        ]),
        ...(stage.elseBody === undefined
          ? []
          : bodyFacts(stage.elseBody.pipeline.stages, stageIndex)),
      ];
    case "control-flow":
      return [
        { label: "compound.form", value: stage.construct, stageIndex },
        {
          label: "compound.support",
          value: "unsupported-diagnostic",
          stageIndex,
        },
      ];
    case "unsupported":
      return [
        { label: "stage.kind", value: "unsupported", stageIndex },
        { label: "stage.unsupportedReason", value: stage.reason, stageIndex },
      ];
    case "subshell":
      return [{ label: "stage.kind", value: "subshell", stageIndex }];
    case "command":
      return commandStageFacts(stage, stageIndex, undefined);
  }
}

function bodyFacts(
  stages: readonly BashStage[],
  ownerStageIndex: number,
): readonly ReviewerShapeSummaryFact[] {
  return stages.flatMap((stage, bodyStageIndex) =>
    commandStageFacts(stage, ownerStageIndex, bodyStageIndex),
  );
}

function commandStageFacts(
  stage: BashStage,
  stageIndex: number,
  bodyStageIndex: number | undefined,
): readonly ReviewerShapeSummaryFact[] {
  if (stage.kind !== "command") {
    return [
      {
        label: bodyStageIndex === undefined ? "stage.kind" : "body.kind",
        value: stage.kind,
        stageIndex,
        ...(bodyStageIndex === undefined ? {} : { bodyStageIndex }),
      },
    ];
  }

  const effect = classifyStageEffect(stage);
  return [
    {
      label: bodyStageIndex === undefined ? "stage.program" : "body.program",
      value: stage.program.program,
      stageIndex,
      ...(bodyStageIndex === undefined ? {} : { bodyStageIndex }),
    },
    {
      label: bodyStageIndex === undefined ? "stage.effect" : "body.effect",
      value: effect,
      stageIndex,
      ...(bodyStageIndex === undefined ? {} : { bodyStageIndex }),
    },
    {
      label:
        bodyStageIndex === undefined
          ? "stage.hasSubstitution"
          : "body.hasSubstitution",
      value: stage.substitutions.length > 0,
      stageIndex,
      ...(bodyStageIndex === undefined ? {} : { bodyStageIndex }),
    },
    {
      label:
        bodyStageIndex === undefined
          ? "stage.outputFileRedirect"
          : "body.outputFileRedirect",
      value: hasOutputFileRedirect(stage.redirects),
      stageIndex,
      ...(bodyStageIndex === undefined ? {} : { bodyStageIndex }),
    },
  ];
}

function piToolSummaryFacts(
  shape: PiBuiltinToolShape,
): readonly ReviewerShapeSummaryFact[] {
  const facts: ReviewerShapeSummaryFact[] = [
    { label: "tool.name", value: shape.toolName },
    { label: "tool.operation", value: shape.operation },
  ];

  if (shape.mutationFacts !== undefined) {
    facts.push({ label: "mutationFacts", value: shape.mutationFacts });
  }

  const firstPathFact = shape.pathFacts?.facts[0];
  if (firstPathFact !== undefined) {
    facts.push({
      label: "path.firstFact",
      value: {
        raw: firstPathFact.raw,
        access: firstPathFact.access,
        scope: firstPathFact.scope,
        dynamic: firstPathFact.dynamic,
        unknownReason: firstPathFact.unknownReason,
      },
    });
  }

  if (shape.trustBoundary !== undefined) {
    facts.push({ label: "trustBoundary", value: shape.trustBoundary });
  }

  return facts;
}

function hasOutputFileRedirect(
  redirects: readonly {
    readonly targetKind: string;
    readonly stream: string;
  }[],
): boolean {
  return redirects.some(
    (redirect) =>
      redirect.targetKind === "file" &&
      (redirect.stream === "stdout" ||
        redirect.stream === "stderr" ||
        redirect.stream === "both" ||
        redirect.stream === "fd"),
  );
}

function diagnosticCodes(
  diagnostics: readonly ShapeDiagnostic[],
): readonly string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}
