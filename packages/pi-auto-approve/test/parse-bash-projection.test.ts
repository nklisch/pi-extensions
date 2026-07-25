import { describe, expect, it } from "vitest";

import { analyzeBashCommand } from "../src/parse/native-parser.ts";
import type { BashCommandShape, BashStage } from "../src/parse/shape.ts";

function expectBashShape(command: string): Promise<BashCommandShape> {
  return analyzeBashCommand(command).then((shape) => {
    expect(shape.kind).toBe("bash");
    if (shape.kind !== "bash") {
      throw new Error("expected bash shape");
    }
    return shape;
  });
}

function commandStages(
  shape: BashCommandShape,
): readonly Extract<BashStage, { readonly kind: "command" }>[] {
  return shape.stages.filter((stage) => stage.kind === "command");
}

describe("analyzeBashCommand projection", () => {
  it("projects a simple command into program arguments and flags", async () => {
    const shape = await expectBashShape("git status --short");
    const [stage] = commandStages(shape);

    expect(shape.diagnostics).toEqual([]);
    expect(stage?.program).toMatchObject({
      program: "git",
      resolvable: true,
      arguments: ["status"],
    });
    expect(stage?.program.flags).toEqual([
      expect.objectContaining({ raw: "--short", name: "short", short: false }),
    ]);
  });

  it("lifts a literal cwd prefix and flattens the remaining stages", async () => {
    const shape = await expectBashShape("cd repo && git status");

    expect(shape.cwdPrefix).toBe("repo");
    expect(shape.blocks).toHaveLength(1);
    expect(commandStages(shape).map((stage) => stage.program.program)).toEqual([
      "git",
    ]);
    expect(commandStages(shape)[0]?.program.arguments).toEqual(["status"]);
  });

  it("records downstream pipeline targets", async () => {
    const shape = await expectBashShape("curl https://example.com | sh");

    expect(shape.blocks[0]?.pipeline.pipeTargets).toContain("sh");
    expect(commandStages(shape).map((stage) => stage.program.program)).toEqual([
      "curl",
      "sh",
    ]);
  });

  it("unwraps redirected statements and records stdout file redirects", async () => {
    const shape = await expectBashShape("echo hi > out.txt");
    const [stage] = commandStages(shape);

    expect(stage?.program.span).toEqual({ start: 0, end: 4 });
    expect(stage?.redirects).toEqual([
      expect.objectContaining({
        stream: "stdout",
        targetKind: "file",
        target: "out.txt",
        append: false,
      }),
    ]);
  });

  it("records substitutions without marking a literal program unresolvable", async () => {
    const shape = await expectBashShape("cat $(cat ~/.secret)");
    const [stage] = commandStages(shape);

    expect(stage?.program).toMatchObject({ program: "cat", resolvable: true });
    expect(stage?.substitutions).toEqual([
      expect.objectContaining({ kind: "command", raw: "$(cat ~/.secret)" }),
    ]);
  });

  it("diagnoses unresolvable dynamic program words", async () => {
    for (const command of [
      "$(which git) status",
      "$cmd status",
      "$" + "{cmd} status",
    ]) {
      const shape = await expectBashShape(command);
      const [stage] = commandStages(shape);

      expect(stage?.program).toMatchObject({ program: "", resolvable: false });
      expect(shape.diagnostics).toEqual([
        expect.objectContaining({ code: "bash:unresolvable-program" }),
      ]);
    }
  });

  it("ignores comments instead of projecting them as unsupported stages", async () => {
    const shape = await expectBashShape("echo hi # note");
    const [stage] = commandStages(shape);

    expect(shape.blocks).toHaveLength(1);
    expect(shape.stages).toHaveLength(1);
    expect(stage?.program.arguments).toEqual(["hi"]);
    expect(
      shape.diagnostics.some(
        (diagnostic) => diagnostic.code === "bash:unmodeled-construct",
      ),
    ).toBe(false);
  });

  it("records variable-expanded arguments with a warning", async () => {
    const shape = await expectBashShape("echo $HOME");
    const [stage] = commandStages(shape);

    expect(stage?.program.arguments).toEqual(["$HOME"]);
    expect(shape.diagnostics).toEqual([
      expect.objectContaining({ code: "bash:variable-expansion" }),
    ]);
  });

  it("diagnoses variable-expanded redirect targets", async () => {
    const shape = await expectBashShape("echo hi > $OUT");
    const [stage] = commandStages(shape);

    expect(stage?.redirects).toEqual([
      expect.objectContaining({ target: "$OUT" }),
    ]);
    expect(shape.diagnostics).toEqual([
      expect.objectContaining({ code: "bash:redirect-expansion" }),
    ]);
  });

  it("returns error diagnostics instead of throwing for malformed commands", async () => {
    const shape = await expectBashShape("if then ) fi (");

    expect(
      shape.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    ).toBe(true);
  });

  it("recognizes subshell, control-flow, and background constructs", async () => {
    const subshell = await expectBashShape("(echo hi)");
    const control = await expectBashShape("if true; then echo hi; fi");
    const background = await expectBashShape("echo hi &");

    expect(subshell.stages[0]).toMatchObject({ kind: "subshell" });
    expect(subshell.diagnostics).toEqual([
      expect.objectContaining({ code: "bash:subshell-unsupported" }),
    ]);
    expect(control.stages[0]).toMatchObject({
      kind: "conditional",
      arms: [expect.objectContaining({ body: expect.any(Object) })],
    });
    expect(control.diagnostics).toEqual([]);
    expect(background.blocks[0]).toMatchObject({ background: true });
    expect(background.diagnostics).toEqual([
      expect.objectContaining({ code: "bash:background-operator" }),
    ]);
  });
});
