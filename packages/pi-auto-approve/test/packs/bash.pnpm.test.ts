import { describe, expect, it } from "vitest";

import { bashDevVerifyPack } from "../../src/packs/bash.dev.verify.ts";
import { bashPackagesCommonPack } from "../../src/packs/bash.packages.common.ts";
import { bashReviewRiskyPack } from "../../src/packs/bash.review.risky.ts";
import { bashStructureSafePack } from "../../src/packs/bash.structure.safe.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import { decideWithPacks } from "./helpers.ts";

const packs = [
  bashDevVerifyPack,
  bashPackagesCommonPack,
  bashReviewRiskyPack,
  bashStructureSafePack,
] as const;

describe("pnpm dialect coverage", () => {
  it.each([
    "pnpm --filter foo test",
    "pnpm check",
    "pnpm exec biome check .",
    "pnpm list",
    "pnpm --dir packages/foo test",
    "pnpm -w list",
    "pnpm why lodash",
    "pnpm outdated",
    "pnpm audit",
    "pnpm view react",
    "pnpm config list",
    "pnpm --version",
    "pnpm run deploy",
    "pnpm exec ./node_modules/.bin/vitest",
    "pnpm exec env CI=true biome check .",
    "pnpm exec env -- biome check .",
    "timeout 5 pnpm exec tsc",
    "pnpm check | tail -5",
    "pnpm list | head -5",
    "pnpm outdated || true",
  ])("allows safe pnpm workflow: %s", async (command) => {
    await expect(decideWithPacks(command, packs)).resolves.toMatchObject({
      effect: "allow",
    });
  });

  it.each([
    "pnpm exec bash",
    "pnpm exec sh -c x",
    "pnpm exec node -e x",
    "pnpm exec --shell-mode x",
    "pnpm dlx cowsay",
    "pnpm publish",
    "pnpm rm foo",
    "pnpm store prune",
    "pnpm -g add foo",
    "pnpm --global install",
    "pnpm --unknown-opt test",
    "pnpm exec /tmp/evil",
    "pnpm exec ../node_modules/.bin/x",
    "pnpm audit --fix",
    "pnpm version patch",
    "pnpm version 2.0.0",
    "LD_PRELOAD=/x pnpm exec biome check .",
    "pnpm exec env LD_PRELOAD=/x biome",
    "pnpm install --dir /tmp/x",
  ])("keeps unsafe pnpm workflow reviewed: %s", async (command) => {
    await expect(decideWithPacks(command, packs)).resolves.toMatchObject({
      effect: "review",
    });
  });

  it("projects pnpm exec through the ordinary stage pipeline", async () => {
    const shape = await analyzeBashCommand(
      "pnpm exec env CI=true biome check .",
    );
    expect(shape).toMatchObject({
      kind: "bash",
      stages: [
        {
          kind: "command",
          program: {
            program: "biome",
            arguments: ["check", "."],
            environment: [{ name: "CI", value: "true" }],
          },
        },
      ],
    });
    expect(
      shape.kind === "bash"
        ? shape.diagnostics.filter(
            (diagnostic) => diagnostic.code === "bash:stage-unwrapped",
          ).length
        : 0,
    ).toBe(2);
  });
});
