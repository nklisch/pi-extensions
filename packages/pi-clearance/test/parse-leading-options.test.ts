import { describe, expect, it } from "vitest";
import { bashReviewRiskyPack } from "../src/packs/bash.review.risky.ts";
import { bashVcsReadPack } from "../src/packs/bash.vcs.read.ts";
import { analyzeBashCommand } from "../src/parse/native-parser.ts";
import { decideWithPacks } from "./packs/helpers.ts";

async function commandStage(command: string) {
  const shape = await analyzeBashCommand(command);
  expect(shape.kind).toBe("bash");
  if (shape.kind !== "bash") {
    throw new Error("expected bash shape");
  }
  const stage = shape.stages[0];
  expect(stage?.kind).toBe("command");
  if (stage?.kind !== "command") {
    throw new Error("expected command stage");
  }
  return { shape, stage };
}

describe("generic leading-option projection", () => {
  it.each([
    ["pnpm --filter foo test", ["test"]],
    ["pnpm --filter=foo test", ["test"]],
    ["pnpm -w list", ["list"]],
    ["pnpm --workspace-root list", ["list"]],
    ["pnpm -C /tmp test", ["test"]],
    ["pnpm -- test", ["test"]],
    ["git -C repo status", ["status"]],
    ["git --git-dir=/x --work-tree=/y status", ["status"]],
    ["git --git-dir /x log", ["log"]],
    ["git --no-pager diff", ["diff"]],
    ["git --literal-pathspecs status", ["status"]],
    ["git --no-pager -C repo log", ["log"]],
    ["timeout 60 git -C repo status", ["status"]],
  ] as const)("strips modeled options: %s", async (command, arguments_) => {
    const { shape, stage } = await commandStage(command);
    expect(stage.program.arguments).toEqual(arguments_);
    expect(stage.program.flags).toEqual([]);
    expect(shape.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "bash:leading-options-stripped",
          severity: "info",
        }),
      ]),
    );
  });

  it("projects options in pipeline and compound-body stages", async () => {
    const pipeline = await analyzeBashCommand("git -C repo log | head -5");
    expect(pipeline.kind).toBe("bash");
    if (pipeline.kind === "bash") {
      expect(pipeline.stages[0]).toMatchObject({
        kind: "command",
        program: { program: "git", arguments: ["log"], flags: [] },
      });
    }

    const compound = await analyzeBashCommand(
      "for f in '*.md'; do git --no-pager -C repo log; done",
    );
    expect(compound.kind).toBe("bash");
    if (compound.kind === "bash") {
      expect(compound.stages[0]).toMatchObject({ kind: "for-loop" });
      const loop = compound.stages[0];
      if (loop?.kind === "for-loop") {
        expect(loop.body.pipeline.stages[0]).toMatchObject({
          kind: "command",
          program: { program: "git", arguments: ["log"], flags: [] },
        });
      }
    }
  });

  it.each([
    "pnpm --unknown-opt test",
    "git -c a=b status",
    "git --config-env=x=y status",
    "git -P status",
    "git --exec-path=/x status",
    "git -C/repo status",
    "git --unknown-opt status",
    "git --no-pager -c a=b status",
  ])("refuses unmodeled options atomically: %s", async (command) => {
    const { shape, stage } = await commandStage(command);
    expect(shape.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "bash:leading-option-unmodeled",
          severity: "warning",
        }),
      ]),
    );
    expect(stage.program.program).toBe(
      command.startsWith("pnpm") ? "pnpm" : "git",
    );
    expect(stage.program.arguments).toContain(
      command.startsWith("pnpm") ? "test" : "status",
    );
    expect(shape.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "bash:leading-options-stripped" }),
      ]),
    );
  });

  it.each([
    "git --version",
    "git --help",
    "git --no-pager",
  ])("passes through no-subcommand flags without a diagnostic: %s", async (command) => {
    const { shape } = await commandStage(command);
    expect(shape.diagnostics).toEqual([]);
  });

  it("does not strip an unresolved option value", async () => {
    const { shape, stage } = await commandStage("git -C $DIR status");
    expect(stage.program.arguments).toEqual(["$DIR", "status"]);
    expect(stage.program.flags).toEqual([
      expect.objectContaining({ raw: "-C", name: "C" }),
    ]);
    expect(shape.diagnostics).toEqual([
      expect.objectContaining({ code: "bash:variable-expansion" }),
    ]);
  });

  it.each([
    "git -c core.sshCommand=x status",
    "git -c core.pager=evil log",
    "git --no-pager -c a=b status",
  ])("routes refused git options through the named review rule: %s", async (command) => {
    expect(
      await decideWithPacks(command, [bashVcsReadPack, bashReviewRiskyPack]),
    ).toMatchObject({
      effect: "review",
      provenance: {
        packId: "bash.review.risky",
        ruleId: "bash.review.risky:review-unmodeled-leading-option",
      },
    });
  });
});
