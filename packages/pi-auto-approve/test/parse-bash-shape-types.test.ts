import { describe, expect, it } from "vitest";
import type {
  BashBlock,
  BashLoopVariableReference,
  BashPathFact,
  BashPipeline,
  BashStage,
  BashStageProgram,
  SourceSpan,
} from "../src/parse/shape.ts";
import {
  BASH_ITERATOR_ENTRY_KINDS,
  COMPOUND_BODY_REASONS,
  COMPOUND_FEATURE_REASONS,
  COMPOUND_ITERATOR_REASONS,
  ITERATOR_SOURCE_KINDS,
} from "../src/parse/shape.ts";

describe("compound bash shape type surface", () => {
  it("keeps compound reason registries in documented order", () => {
    expect(BASH_ITERATOR_ENTRY_KINDS).toEqual(["literal-word", "literal-glob"]);
    expect(ITERATOR_SOURCE_KINDS).toEqual([
      "literal-word",
      "literal-glob",
      "mixed",
      "opaque",
    ]);
    expect(COMPOUND_ITERATOR_REASONS).toEqual([
      "substitution",
      "arithmetic",
      "indirect",
      "parameter",
      "brace",
      "extglob",
      "mixed",
    ]);
    expect(COMPOUND_BODY_REASONS).toEqual([
      "nested-form",
      "unsupported-stage",
      "function",
    ]);
    expect(COMPOUND_FEATURE_REASONS).toEqual([
      "select",
      "for-arithmetic",
      "case",
      "while",
      "until",
      "heredoc-in-compound",
    ]);
  });

  it("accepts old and provenance-annotated bash path fact contracts", () => {
    const span = { start: 0, end: 1 } satisfies SourceSpan;

    const oldShapeFact: BashPathFact = {
      id: "path:argument:0:1",
      stageIndex: 0,
      program: "cat",
      usage: "argument",
      access: "read",
      raw: "README.md",
      literal: "README.md",
      absolutePath: "/repo/README.md",
      scope: "project",
      matchedScopes: ["project"],
      normalization: "lexical",
      isAbsolute: false,
      isRelative: true,
      hasParentTraversal: false,
      quote: "none",
      dynamic: false,
      source: span,
    };

    const provenanceFact = {
      id: "path:compound:loop-var:0:0:1",
      stageIndex: 0,
      program: "cat",
      usage: "argument",
      access: "read",
      raw: '"$f"',
      scope: "project",
      matchedScopes: ["project"],
      normalization: "lexical",
      isAbsolute: false,
      isRelative: true,
      hasParentTraversal: false,
      quote: "double",
      dynamic: false,
      source: span,
      provenance: {
        kind: "loop-variable",
        variableName: "f",
        iteratorSourceKind: "literal-glob",
        iteratorEntries: [
          {
            raw: ".work/backlog/*.md",
            literal: ".work/backlog/*.md",
            staticPrefixAbsolutePath: "/repo/.work/backlog",
            scope: "project",
            matchedScopes: ["project"],
            quote: "none",
          },
        ],
        loopStageIndex: 0,
      },
      globApproximation: true,
    } satisfies BashPathFact;

    expect(oldShapeFact.provenance).toBeUndefined();
    expect(oldShapeFact.globApproximation).toBeUndefined();
    expect(provenanceFact.provenance.variableName).toBe("f");
    expect(provenanceFact.globApproximation).toBe(true);
  });

  it("accepts the modeled for-loop, brace-group, and conditional stage contracts", () => {
    const span = { start: 0, end: 1 } satisfies SourceSpan;
    const loopReference = {
      name: "f",
      raw: '"$f"',
      quote: "double",
      span,
    } satisfies BashLoopVariableReference;
    const program = {
      program: "echo",
      resolvable: true,
      arguments: ['"$f"'],
      flags: [],
      environment: [],
      variableReferences: [loopReference],
      span,
    } satisfies BashStageProgram;
    const commandStage = {
      kind: "command",
      program,
      substitutions: [],
      redirects: [],
      span,
    } satisfies BashStage;
    const pipeline = {
      stages: [commandStage],
      pipeTargets: [],
      span,
    } satisfies BashPipeline;
    const block = { pipeline, span } satisfies BashBlock;

    const forLoop = {
      kind: "for-loop",
      variable: "f",
      variableSpan: span,
      iterator: [
        {
          kind: "literal-glob",
          raw: "docs/*.md",
          literal: "docs/*.md",
          quote: "none",
          span,
        },
      ],
      body: block,
      keywordSpans: { for: span, in: span, do: span, done: span },
      span,
    } satisfies BashStage;

    const braceGroup = {
      kind: "brace-group",
      body: block,
      redirects: [],
      span,
    } satisfies BashStage;

    const conditional = {
      kind: "conditional",
      arms: [
        { test: pipeline, body: block, ifOrElseSpan: span, thenSpan: span },
      ],
      elseBody: block,
      elseSpan: span,
      span,
    } satisfies BashStage;

    expect(forLoop.kind).toBe("for-loop");
    expect(braceGroup.kind).toBe("brace-group");
    expect(conditional.kind).toBe("conditional");
    expect(program.variableReferences).toEqual([loopReference]);
  });
});
