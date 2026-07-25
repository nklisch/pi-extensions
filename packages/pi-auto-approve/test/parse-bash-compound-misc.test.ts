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

describe("compound brace-group bash projection", () => {
  it("projects a narrow brace group body", async () => {
    const shape = await expectBashShape("{ echo hi; echo bye; }");
    const stage = expectFirstStage(shape, "brace-group");

    expect(shape.diagnostics).toEqual([]);
    expect(stage.redirects).toEqual([]);
    expect(stage.body.pipeline.stages).toHaveLength(2);
    expect(
      stage.body.pipeline.stages.map((bodyStage) =>
        bodyStage.kind === "command"
          ? bodyStage.program.program
          : bodyStage.kind,
      ),
    ).toEqual(["echo", "echo"]);
  });

  it("propagates loop-variable scope through a brace group inside a for loop", async () => {
    const shape = await expectBashShape(
      'for f in *.md; do { echo "$f"; cat "$f"; }; done',
    );
    const loop = expectFirstStage(shape, "for-loop");
    const group = loop.body.pipeline.stages[0];

    expect(shape.diagnostics).toEqual([]);
    expect(group?.kind).toBe("brace-group");
    if (group?.kind !== "brace-group") {
      throw new Error("expected brace group in for-loop body");
    }
    for (const bodyStage of group.body.pipeline.stages) {
      expect(bodyStage.kind).toBe("command");
      if (bodyStage.kind !== "command") {
        throw new Error("expected command in brace-group body");
      }
      expect(bodyStage.program.variableReferences).toEqual([
        expect.objectContaining({ name: "f", raw: '"$f"', quote: "double" }),
      ]);
    }
  });

  it("projects group-level redirects", async () => {
    const shape = await expectBashShape("{ echo hi; } > out");
    const stage = expectFirstStage(shape, "brace-group");

    expect(shape.diagnostics).toEqual([]);
    expect(stage.redirects).toEqual([
      expect.objectContaining({ targetKind: "file", target: "out" }),
    ]);
  });

  it("keeps redirect target expansion diagnostics without blocking brace projection", async () => {
    const shape = await expectBashShape("{ echo hi; } > $OUT");
    const stage = expectFirstStage(shape, "brace-group");

    expect(stage.redirects).toEqual([
      expect.objectContaining({ targetKind: "file", target: "$OUT" }),
    ]);
    expect(shape.diagnostics).toEqual([
      expect.objectContaining({ code: "bash:redirect-expansion" }),
    ]);
  });

  it("fails closed when a brace body contains an unsupported compound form", async () => {
    const shape = await expectBashShape("{ while true; do x; done; }");
    const stage = expectFirstStage(shape, "control-flow");

    expect(stage.construct).toBe("brace-group");
    expectCompoundDiagnostic(
      shape,
      "bash:compound-body-unsupported",
      "nested-form",
    );
  });

  it("preserves heredoc diagnostics and falls back for heredocs inside brace bodies", async () => {
    const shape = await expectBashShape("{ cat <<EOF\nhi\nEOF\n}");
    const stage = expectFirstStage(shape, "control-flow");

    expect(stage.construct).toBe("brace-group");
    expect(shape.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "bash:heredoc-presence" }),
        expect.objectContaining({
          code: "bash:compound-body-unsupported",
          message: expect.stringContaining("unsupported-stage"),
        }),
      ]),
    );
  });
});

describe("compound conditional bash projection", () => {
  it("projects a simple if statement", async () => {
    const shape = await expectBashShape(
      "if git diff --quiet; then echo ok; fi",
    );
    const stage = expectFirstStage(shape, "conditional");

    expect(shape.diagnostics).toEqual([]);
    expect(stage.arms).toHaveLength(1);
    expect(stage.arms[0]?.test.stages).toHaveLength(1);
    expect(stage.arms[0]?.body.pipeline.stages).toHaveLength(1);
    expect(stage.elseBody).toBeUndefined();
  });

  it("projects if/elif/else chains", async () => {
    const shape = await expectBashShape(
      "if a; then x; elif b; then y; else z; fi",
    );
    const stage = expectFirstStage(shape, "conditional");

    expect(shape.diagnostics).toEqual([]);
    expect(stage.arms).toHaveLength(2);
    expect(stage.elseBody?.pipeline.stages).toHaveLength(1);
    expect(stage.elseSpan).toBeDefined();
  });

  it("accepts multi-stage command-only test pipelines", async () => {
    const shape = await expectBashShape(
      "if git diff --quiet | grep -q x; then echo ok; fi",
    );
    const stage = expectFirstStage(shape, "conditional");

    expect(shape.diagnostics).toEqual([]);
    expect(stage.arms[0]?.test.stages).toHaveLength(2);
    expect(stage.arms[0]?.test.pipeTargets).toEqual(["grep"]);
  });

  it("fails closed when an if body contains an unsupported brace group", async () => {
    const shape = await expectBashShape(
      "if a; then { while true; do x; done; }; fi",
    );
    const stage = expectFirstStage(shape, "control-flow");

    expect(stage.construct).toBe("if");
    expectCompoundDiagnostic(
      shape,
      "bash:compound-body-unsupported",
      "nested-form",
    );
  });

  it("fails closed when an if test contains a subshell", async () => {
    const shape = await expectBashShape("if (subshell); then x; fi");
    const stage = expectFirstStage(shape, "control-flow");

    expect(stage.construct).toBe("if");
    expectCompoundDiagnostic(
      shape,
      "bash:compound-body-unsupported",
      "unsupported-stage",
    );
  });
});

describe("unsupported compound feature diagnostics", () => {
  it.each([
    ["case", "case x in a) echo;; esac", "case"],
    ["while", 'while read x; do echo "$x"; done', "while"],
    ["until", "until x; do echo; done", "until"],
    ["select", 'select x in a b; do echo "$x"; done', "select"],
  ])("emits a feature diagnostic for %s", async (_label, command, reason) => {
    const shape = await expectBashShape(command);
    const stage = expectFirstStage(shape, "control-flow");

    expect(stage.construct).toBe(reason);
    expectCompoundDiagnostic(
      shape,
      "bash:compound-feature-unsupported",
      reason,
    );
  });

  it("policy reviews shapes with unsupported compound features", async () => {
    const shape = await expectBashShape("case x in a) echo;; esac");
    const emptyPolicy: EffectivePolicy = { floor: [], active: [] };

    expect(decide(shape, emptyPolicy).effect).toBe("review");
  });
});
