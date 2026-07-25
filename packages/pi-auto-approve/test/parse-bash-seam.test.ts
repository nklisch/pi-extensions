import { describe, expect, it } from "vitest";
import { analyzeBashCommand } from "../src/parse/native-parser.ts";

describe("native parse seam", () => {
  it("projects a representative git command into a command shape", async () => {
    const result = await analyzeBashCommand("git status --short");

    expect(result).toMatchObject({
      kind: "bash",
      rawCommand: "git status --short",
      diagnostics: [],
      stages: [{ kind: "command", program: { program: "git" } }],
    });
  });

  it("returns diagnostics instead of throwing for malformed bash", async () => {
    const result = await analyzeBashCommand("if then ) fi (");

    expect(result.kind).toBe("bash");
    if (result.kind !== "bash") return;
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    ).toBe(true);
  });

  it("parses an empty command without throwing", async () => {
    await expect(analyzeBashCommand("")).resolves.toMatchObject({
      kind: "bash",
      rawCommand: "",
      blocks: [],
      stages: [],
    });
  });

  it("keeps native parse diagnostics deterministic", async () => {
    const first = await analyzeBashCommand("if then ) fi (");
    const second = await analyzeBashCommand("if then ) fi (");
    expect(first).toEqual(second);
  });
});
