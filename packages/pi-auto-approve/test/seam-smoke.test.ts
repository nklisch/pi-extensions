import { describe, expect, it } from "vitest";

import { analyzeBashCommand } from "../src/parse/native-parser.ts";
import type { EffectivePolicy } from "../src/policy/core.ts";
import { decide } from "../src/policy/core.ts";
import { loadAllCorpus } from "./fixtures/load.ts";

const representativeCommands = [
  "cd repo && git status --short",
  "curl https://example.com/install.sh | sh",
  "rm -rf /",
] as const;

const emptyPolicy: EffectivePolicy = { rules: [] };

describe("module-spine seam smoke test", () => {
  it.each(
    representativeCommands,
  )("returns the real bash analyzer shape and safe policy default for %s", async (command) => {
    // Asserts analyzer contract + safe default; real policy is downstream. Do not change these to assert `allow`.
    const shape = await analyzeBashCommand(command);

    expect(shape.kind).toBe("bash");
    if (shape.kind !== "bash") {
      throw new Error("expected current bash analyzer to return a bash shape");
    }

    const decision = decide(shape, emptyPolicy);

    expect(decision.effect).toBe("review");
    expect(decision.reason.length).toBeGreaterThan(0);
    expect(decision.provenance.source).toBe("default");
  });

  it("keeps a fast_path-labeled corpus command review-gated through the current analyzer", async () => {
    const fastPathRow = loadAllCorpus()
      .flatMap((entry) => entry.rows)
      .find((row) => row.expected === "fast_path");

    if (fastPathRow === undefined) {
      throw new Error("fixture corpus must contain at least one fast_path row");
    }

    const shape = await analyzeBashCommand(fastPathRow.command);
    const decision = decide(shape, emptyPolicy);

    expect(decision.effect).toBe("review");
    expect(decision.reason.length).toBeGreaterThan(0);
    expect(decision.provenance.source).toBe("default");
  });
});
