import { homedir } from "node:os";

import { describe, expect, it } from "vitest";

import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import { enrichToolShapeWithPathFacts } from "../../src/parse/native-path-facts.ts";
import type { ToolShape } from "../../src/parse/shape.ts";
import { buildHumanReviewCard } from "../../src/runtime/human-review-card.ts";
import type { ResolvedProjectScope } from "../../src/config/loader.ts";

function projectScope(): ResolvedProjectScope {
  return {
    roots: ["/repo"],
    writableDirectories: ["/repo"],
    tempDirectories: ["/tmp"],
    deniedDirectories: [],
    safeHomeDirectories: [],
    unknownPathBehavior: "review",
    sensitivePathBehavior: "review",
    homePathBehavior: "allow",
  };
}

async function bashShape(command: string): Promise<ToolShape> {
  const parsed = await analyzeBashCommand(command);
  return enrichToolShapeWithPathFacts(parsed, {
    cwd: "/repo",
    projectScope: projectScope(),
  });
}

describe("buildHumanReviewCard", () => {
  it("describes a common read-only search with its verb and effect class", async () => {
    const card = buildHumanReviewCard(
      await bashShape("grep -rn pattern src/index.ts"),
    );

    expect(card.whatItDoes[0]).toContain("Searches file contents");
    expect(card.whatItDoes[0]).toContain("read-only");
  });

  it("labels paths with human scope vocabulary", async () => {
    const card = buildHumanReviewCard(
      await bashShape(`cat ${homedir()}/.config/app/settings.json`),
    );

    expect(card.whereItActs.length).toBeGreaterThan(0);
    expect(card.whereItActs[0]).toContain("settings.json");
    expect(card.whereItActs[0]).toMatch(
      /home|outside|sensitive|system|denied|could not be determined/,
    );
    // The label must be human vocabulary, never a raw config key.
    expect(card.whereItActs[0]).not.toMatch(/writable-project|safe-home/);
  });

  it("falls back to effect-class copy for unrecognized programs", async () => {
    const card = buildHumanReviewCard(await bashShape("frobnicate --all"));

    expect(card.whatItDoes[0]).toBe(
      "Runs `frobnicate` (no effect classification)",
    );
  });

  it("names destructive programs plainly", async () => {
    const card = buildHumanReviewCard(await bashShape("rm -rf /repo/build"));

    expect(card.whatItDoes[0]).toContain("Deletes files");
    expect(card.whatItDoes[0]).toContain("destructive");
  });

  it("describes a for loop with its body programs", async () => {
    const card = buildHumanReviewCard(
      await bashShape("for f in a.txt b.txt; do cat $f; done"),
    );

    expect(card.whatItDoes[0]).toContain("for loop");
    expect(card.whatItDoes[0]).toContain("cat");
  });

  it("caps behavior bullets and counts the remainder", async () => {
    const card = buildHumanReviewCard(
      await bashShape("cat a; cat b; cat c; cat d; cat e"),
    );

    expect(card.whatItDoes.length).toBe(4);
    expect(card.whatItDoes[3]).toContain("2 more");
  });

  it("describes embedded-shell and agent-dispatch conservatively", () => {
    const embeddedShell = {
      kind: "pi-tool",
      toolName: "monitor",
      operation: "embedded-shell",
      rawInput: {},
      pathInputs: [],
      diagnostics: [],
    } satisfies ToolShape;
    const agentDispatch = {
      kind: "pi-tool",
      toolName: "subagent",
      operation: "agent-dispatch",
      rawInput: {},
      pathInputs: [],
      diagnostics: [],
    } satisfies ToolShape;

    expect(buildHumanReviewCard(embeddedShell).whatItDoes[0]).toContain(
      "runs shell commands",
    );
    expect(buildHumanReviewCard(embeddedShell).whatItDoes[0]).not.toContain(
      "read-only",
    );
    expect(buildHumanReviewCard(agentDispatch).whatItDoes[0]).toContain(
      "dispatches an agent",
    );
    expect(buildHumanReviewCard(agentDispatch).whatItDoes[0]).not.toContain(
      "read-only",
    );
  });

  it("skips git leading-option values when naming the subcommand", async () => {
    const card = buildHumanReviewCard(
      await bashShape("git -C /repo status"),
    );

    expect(card.whatItDoes[0]).toContain("git status");
    expect(card.whatItDoes[0]).not.toContain("git /repo");
  });

  it("names conditional body programs", async () => {
    const card = buildHumanReviewCard(
      await bashShape("if [ -f x ]; then rm x; fi"),
    );

    expect(card.whatItDoes[0]).toContain("conditional");
    expect(card.whatItDoes[0]).toContain("rm");
  });

  it("renders paths containing backticks without breaking the card", async () => {
    const card = buildHumanReviewCard(
      await bashShape("cat /repo/weird\\`name.txt"),
    );

    // Adaptive fence: a path with a backtick gets a wider fence, not a
    // broken single-backtick span.
    expect(card.whereItActs[0]).toMatch(/^`` /);
  });

  it("describes pi-tool mutations without parser jargon", () => {
    const shape = {
      kind: "pi-tool",
      toolName: "write",
      operation: "mutation",
      rawInput: { path: "notes.md", content: "hi" },
      pathInputs: [{ key: "path", raw: "notes.md", required: true }],
      diagnostics: [],
    } satisfies ToolShape;

    const card = buildHumanReviewCard(shape);

    expect(card.whatItDoes[0]).toBe(
      "Uses the Pi write tool (modifies files)",
    );
  });

  it("says when a tool could not be analyzed", () => {
    const shape = {
      kind: "unknown",
      toolName: "custom_tool",
      rawInput: {},
      diagnostics: [],
    } satisfies ToolShape;

    const card = buildHumanReviewCard(shape);

    expect(card.whatItDoes[0]).toContain("custom_tool");
    expect(card.whatItDoes[0]).toContain("could not analyze");
  });
});
