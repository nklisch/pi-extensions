import { describe, expect, it } from "vitest";

import { analyzeBashCommand } from "../src/parse/native-parser.ts";
import type { BashCommandShape, BashStage } from "../src/parse/shape.ts";
import type { EffectivePolicy } from "../src/policy/core.ts";
import { decide } from "../src/policy/core.ts";

async function expectBashShape(command: string): Promise<BashCommandShape> {
  const shape = await analyzeBashCommand(command);
  expect(shape.kind).toBe("bash");
  if (shape.kind !== "bash") {
    throw new Error("expected bash shape");
  }
  return shape;
}

function expectFirstStage<K extends BashStage["kind"]>(
  shape: BashCommandShape,
  kind: K,
): Extract<BashStage, { readonly kind: K }> {
  const stage = shape.stages[0];
  expect(stage?.kind).toBe(kind);
  if (stage?.kind !== kind) {
    throw new Error(`expected first stage kind ${kind}`);
  }
  return stage as Extract<BashStage, { readonly kind: K }>;
}

function diagnosticCodes(shape: BashCommandShape): readonly string[] {
  return shape.diagnostics.map((diagnostic) => diagnostic.code);
}

function expectCompoundDiagnostic(
  shape: BashCommandShape,
  code: string,
  reason: string,
): void {
  expect(shape.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code,
        message: expect.stringContaining(reason),
      }),
    ]),
  );
}

describe("compound for-loop bash projection", () => {
  it("projects the motivating backlog-inspection loop", async () => {
    const shape = await expectBashShape(
      "for f in .work/backlog/*.md; do echo '---' \"$f\"; sed -n '1,120p' \"$f\"; done",
    );
    const stage = expectFirstStage(shape, "for-loop");

    expect(shape.diagnostics).toEqual([]);
    expect(stage.variable).toBe("f");
    expect(stage.iterator).toEqual([
      expect.objectContaining({
        kind: "literal-glob",
        raw: ".work/backlog/*.md",
        literal: ".work/backlog/*.md",
      }),
    ]);
    expect(stage.body.pipeline.stages).toHaveLength(2);
    expect(
      stage.body.pipeline.stages.map((bodyStage) =>
        bodyStage.kind === "command"
          ? bodyStage.program.program
          : bodyStage.kind,
      ),
    ).toEqual(["echo", "sed"]);
    for (const bodyStage of stage.body.pipeline.stages) {
      expect(bodyStage.kind).toBe("command");
      if (bodyStage.kind !== "command") {
        throw new Error("expected command body stage");
      }
      expect(bodyStage.program.variableReferences).toEqual([
        expect.objectContaining({ name: "f", raw: '"$f"', quote: "double" }),
      ]);
    }
    expect(diagnosticCodes(shape)).not.toContain("bash:variable-expansion");
  });

  it("classifies literal words as iterator entries", async () => {
    const shape = await expectBashShape('for f in a b c; do echo "$f"; done');
    const stage = expectFirstStage(shape, "for-loop");

    expect(shape.diagnostics).toEqual([]);
    expect(stage.iterator).toEqual([
      expect.objectContaining({ kind: "literal-word", raw: "a", literal: "a" }),
      expect.objectContaining({ kind: "literal-word", raw: "b", literal: "b" }),
      expect.objectContaining({ kind: "literal-word", raw: "c", literal: "c" }),
    ]);
    expect(stage.body.pipeline.stages[0]).toMatchObject({
      kind: "command",
      program: { variableReferences: [expect.objectContaining({ name: "f" })] },
    });
  });

  it("classifies unquoted globs as literal-glob iterator entries", async () => {
    const shape = await expectBashShape(
      'for f in *.md *.txt; do echo "$f"; done',
    );
    const stage = expectFirstStage(shape, "for-loop");

    expect(shape.diagnostics).toEqual([]);
    expect(stage.iterator).toEqual([
      expect.objectContaining({ kind: "literal-glob", raw: "*.md" }),
      expect.objectContaining({ kind: "literal-glob", raw: "*.txt" }),
    ]);
  });

  it("classifies quoted glob metacharacters as literal words", async () => {
    const shape = await expectBashShape(
      "for f in '*.md'; do echo \"$f\"; done",
    );
    const stage = expectFirstStage(shape, "for-loop");

    expect(shape.diagnostics).toEqual([]);
    expect(stage.iterator).toEqual([
      expect.objectContaining({
        kind: "literal-word",
        raw: "'*.md'",
        literal: "*.md",
        quote: "single",
      }),
    ]);
  });

  it("fails closed for arithmetic for loops", async () => {
    const shape = await expectBashShape(
      "for ((i=0; i<3; i++)); do echo $i; done",
    );
    const stage = expectFirstStage(shape, "control-flow");

    expect(stage.construct).toBe("for");
    expectCompoundDiagnostic(
      shape,
      "bash:compound-feature-unsupported",
      "for-arithmetic",
    );
  });

  it.each([
    [
      "command substitution",
      'for f in $(ls); do echo "$f"; done',
      "substitution",
    ],
    ["parameter expansion", 'for f in $LIST; do echo "$f"; done', "parameter"],
    [
      "indirect expansion",
      "for f in $" + '{!var}; do echo "$f"; done',
      "indirect",
    ],
    [
      "double-quoted indirect expansion",
      'for f in "$' + '{!var}"; do echo "$f"; done',
      "indirect",
    ],
    ["brace expansion", 'for f in {a,b}; do echo "$f"; done', "brace"],
    ["brace range", 'for f in {1..10}; do echo "$f"; done', "brace"],
    [
      "arithmetic expansion",
      'for f in $((1)); do echo "$f"; done',
      "arithmetic",
    ],
    ["extglob", 'for f in @(a); do echo "$f"; done', "extglob"],
  ])("fails closed for iterator %s", async (_label, command, reason) => {
    const shape = await expectBashShape(command);
    const stage = expectFirstStage(shape, "control-flow");

    expect(stage.construct).toBe("for");
    expectCompoundDiagnostic(
      shape,
      "bash:compound-iterator-unsupported",
      reason,
    );
  });

  it.each([
    [
      "single-quoted indirect-looking text",
      "for f in '$" + "{!x}" + '\'; do echo "$f"; done',
    ],
    [
      "escaped indirect-looking text",
      "for f in \\$" + '{!x}; do echo "$f"; done',
    ],
  ])("treats %s as literal iterator text", async (_label, command) => {
    const shape = await expectBashShape(command);
    const stage = expectFirstStage(shape, "for-loop");
    const indirectText = "$" + "{!x}";

    expect(shape.diagnostics).toEqual([]);
    expect(stage.iterator).toEqual([
      expect.objectContaining({ kind: "literal-word", literal: indirectText }),
    ]);
  });

  it.each([
    [
      "unmodeled while body",
      'for f in *.md; do while read x; do echo "$x"; done; done',
      "nested-form",
    ],
    [
      "nested modeled for body",
      'for f in *.md; do for g in *.txt; do echo "$g"; done; done',
      "nested-form",
    ],
    [
      "function definition body",
      "for f in *.md; do g() { :; }; done",
      "function",
    ],
  ])("fails closed when the body contains %s", async (_label, command, reason) => {
    const shape = await expectBashShape(command);
    const stage = expectFirstStage(shape, "control-flow");

    expect(stage.construct).toBe("for");
    expectCompoundDiagnostic(shape, "bash:compound-body-unsupported", reason);
  });

  it("keeps redirect target expansion diagnostic while projecting the loop", async () => {
    const shape = await expectBashShape(
      'for f in *.md; do echo "$f" > $f; done',
    );
    const stage = expectFirstStage(shape, "for-loop");
    const bodyStage = stage.body.pipeline.stages[0];

    expect(bodyStage).toMatchObject({
      kind: "command",
      redirects: [expect.objectContaining({ target: "$f" })],
      program: { variableReferences: [expect.objectContaining({ name: "f" })] },
    });
    expect(shape.diagnostics).toEqual([
      expect.objectContaining({ code: "bash:redirect-expansion" }),
    ]);
  });

  it("diagnoses mixed-position loop variable arguments", async () => {
    const shape = await expectBashShape(
      'for f in *.md; do echo "' + "$" + '{f}.bak"; done',
    );
    const stage = expectFirstStage(shape, "for-loop");
    const bodyStage = stage.body.pipeline.stages[0];

    expect(bodyStage).toMatchObject({
      kind: "command",
      program: { variableReferences: [] },
    });
    expect(shape.diagnostics).toEqual([
      expect.objectContaining({ code: "bash:variable-expansion" }),
    ]);
  });

  it("policy reviews shapes with compound unsupported diagnostics", async () => {
    const shape = await expectBashShape(
      "for ((i=0; i<3; i++)); do echo $i; done",
    );
    const emptyPolicy: EffectivePolicy = { floor: [], active: [] };

    expect(decide(shape, emptyPolicy).effect).toBe("review");
  });
});
