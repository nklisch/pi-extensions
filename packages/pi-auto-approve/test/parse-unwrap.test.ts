import { describe, expect, it } from "vitest";

import { bashDevVerifyPack } from "../src/packs/bash.dev.verify.ts";
import { bashInspectCorePack } from "../src/packs/bash.inspect.core.ts";
import { bashReviewRiskyPack } from "../src/packs/bash.review.risky.ts";
import { bashSearchReadPack } from "../src/packs/bash.search.read.ts";
import { sealedFloor } from "../src/packs/floor.ts";
import { analyzeBashCommand } from "../src/parse/native-parser.ts";
import { decide } from "../src/policy/core.ts";
import { decideWithPacks } from "./packs/helpers.ts";

describe("bash wrapper projection", () => {
  it.each([
    "pnpm exec biome check .",
    "pnpm exec -- biome check .",
    "pnpm exec env CI=true biome check .",
    "timeout 5 pnpm exec tsc",
    "pnpm exec ./node_modules/.bin/vitest",
    "./node_modules/.bin/biome check .",
    "pnpm --filter foo test",
    "timeout 60 cargo test",
    "timeout -k 5 60 pnpm test",
    "timeout --signal=KILL 10 cargo build",
    "env FOO=1 pnpm test",
    "env -i FOO=1 cargo test",
    "env -u HOME pnpm test",
    "rustup run stable cargo test",
  ])("unwraps safe wrapper: %s", async (command) => {
    const packs = [bashDevVerifyPack, bashReviewRiskyPack];
    const shape = await analyzeBashCommand(command);
    expect(shape).toMatchObject({
      kind: "bash",
      stages: [{ kind: "command" }],
    });
    expect(await decideWithPacks(command, packs)).toMatchObject({
      effect: "allow",
      provenance: { source: "shipped", packId: "bash.dev.verify" },
    });
  });

  it.each([
    "/usr/bin/grep pattern file",
    "/bin/ls",
    "/usr/local/bin/grep pattern file",
  ])("unwraps trusted system-bin path: %s", async (command) => {
    expect(
      await decideWithPacks(command, [
        bashInspectCorePack,
        bashSearchReadPack,
        bashReviewRiskyPack,
      ]),
    ).toMatchObject({ effect: "allow" });
  });

  it("supports nested wrappers while preserving the effective environment", async () => {
    const shape = await analyzeBashCommand("timeout 30 env CI=true cargo test");
    expect(shape.kind).toBe("bash");
    if (shape.kind !== "bash") {
      return;
    }

    const stage = shape.stages[0];
    expect(stage).toMatchObject({
      kind: "command",
      program: {
        program: "cargo",
        arguments: ["test"],
        environment: [{ name: "CI", value: "true" }],
      },
    });
    const unwrapDiagnostics = shape.diagnostics.filter(
      (diagnostic) => diagnostic.code === "bash:stage-unwrapped",
    );
    expect(unwrapDiagnostics).toHaveLength(2);
    expect(unwrapDiagnostics[0]?.source).toEqual({ start: 0, end: 10 });
    expect(unwrapDiagnostics[1]?.source).toEqual({ start: 11, end: 22 });
  });

  it("unwraps command stages inside modeled compound bodies", async () => {
    const shape = await analyzeBashCommand(
      "for f in '*.md'; do timeout 60 cat \"$f\"; done",
    );
    expect(shape.kind).toBe("bash");
    if (shape.kind !== "bash") {
      return;
    }

    const loop = shape.stages[0];
    expect(loop?.kind).toBe("for-loop");
    if (loop?.kind !== "for-loop") {
      return;
    }
    expect(loop.body.pipeline.stages[0]).toMatchObject({
      kind: "command",
      program: { program: "cat", arguments: ['"$f"'] },
    });
  });

  it.each([
    "pnpm exec --shell-mode x",
    "pnpm exec --package foo biome",
    "pnpm exec",
    "env -C /tmp pnpm test",
    "env -S 'FOO=1 pnpm test'",
    "env",
    "printenv",
    "timeout 60 sh -c 'echo hi'",
    "timeout $DUR cargo test",
  ])("keeps unsafe or unresolved wrapper reviewed: %s", async (command) => {
    const decision = await decideWithPacks(command, [
      bashDevVerifyPack,
      bashInspectCorePack,
      bashReviewRiskyPack,
    ]);
    expect(decision.effect).toBe("review");
  });

  it.each([
    "timeout 60 sudo rm -rf /",
    "/usr/bin/sudo ls",
  ])("keeps floor denial after wrapper projection: %s", async (command) => {
    expect(
      await decideWithPacks(command, [
        bashDevVerifyPack,
        bashInspectCorePack,
        bashSearchReadPack,
        bashReviewRiskyPack,
      ]),
    ).toMatchObject({ effect: "deny", provenance: { packId: "floor.deny" } });
  });

  it("screens dangerous assignments after env unwrapping", async () => {
    const shape = await analyzeBashCommand(
      "env LD_PRELOAD=/tmp/evil.so pnpm test",
    );
    expect(shape.kind).toBe("bash");
    if (shape.kind !== "bash") {
      return;
    }
    expect(shape.stages[0]).toMatchObject({
      program: {
        program: "pnpm",
        environment: [{ name: "LD_PRELOAD" }],
      },
    });

    const decision = decide(shape, {
      floor: sealedFloor.rules,
      active: [bashDevVerifyPack, bashReviewRiskyPack].flatMap((pack) => [
        ...pack.rules,
      ]),
    });
    expect(decision).toMatchObject({
      effect: "review",
      provenance: {
        packId: "bash.review.risky",
        ruleId: "bash.review.risky:review-dangerous-env-assignment",
      },
    });
  });

  it("retains substitutions from wrapper arguments on the effective stage", async () => {
    const shape = await analyzeBashCommand("timeout 60 cargo $(date)");
    expect(shape.kind).toBe("bash");
    if (shape.kind !== "bash") {
      return;
    }
    expect(shape.stages[0]).toMatchObject({
      program: { program: "cargo", arguments: ["$(date)"] },
      substitutions: [{ kind: "command", raw: "$(date)" }],
    });
    expect(
      await decideWithPacks("timeout 60 cargo $(date)", [
        bashDevVerifyPack,
        bashReviewRiskyPack,
      ]),
    ).toMatchObject({ effect: "review" });
  });

  it("does not unwrap a dynamic inner program", async () => {
    const shape = await analyzeBashCommand("timeout 60 $COMMAND cargo test");
    expect(shape.kind).toBe("bash");
    if (shape.kind !== "bash") {
      return;
    }
    expect(shape.stages[0]).toMatchObject({
      program: { program: "timeout" },
    });
    expect(
      shape.diagnostics.some(
        (diagnostic) => diagnostic.code === "bash:stage-unwrapped",
      ),
    ).toBe(false);
  });
});
