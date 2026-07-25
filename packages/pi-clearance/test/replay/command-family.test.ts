import { describe, expect, it } from "vitest";

import { firstSemanticArgument } from "../../src/replay/command-family-primitives.ts";

describe("command-family authoring primitives", () => {
  it("skips value-taking global options", () => {
    expect(firstSemanticArgument("git", ["-C", "/repo", "status"])).toBe(
      "status",
    );
  });

  it("recognizes long options with inline values", () => {
    expect(firstSemanticArgument("pnpm", ["--dir=/repo", "test"])).toBe("test");
  });

  it("falls back to the first positional for unknown programs", () => {
    expect(firstSemanticArgument("custom-tool", ["--verbose", "input"])).toBe(
      "input",
    );
  });
});
