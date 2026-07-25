import { describe, expect, it } from "vitest";

import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import { attachBashPathFacts } from "../../src/parse/native-path-facts.ts";
import {
  argCount,
  envAssignmentCount,
  evalMatcher,
  flagAllowlist,
  flagValueIn,
  inspectable,
  matcherSpecificity,
  pathScopesAllIn,
  redirect,
  specificity,
} from "../../src/policy/core.ts";
import { defaultResolvedProjectScope } from "../fixtures/resolved-config.ts";

async function shape(command: string, withFacts = false) {
  const parsed = await analyzeBashCommand(command);
  if (!withFacts || parsed.kind !== "bash") {
    return parsed;
  }
  return attachBashPathFacts(parsed, {
    cwd: "/repo",
    projectScope: {
      ...defaultResolvedProjectScope(),
      roots: ["/repo"],
      writableDirectories: ["/repo"],
      tempDirectories: ["/tmp"],
    },
  });
}

describe("inspection matcher extensions", () => {
  it("evaluates counts and flag allowlists fail-closed on non-bash shapes", async () => {
    expect(
      evalMatcher(
        inspectable(argCount({ min: 1 })),
        await shape("node app.js"),
      ),
    ).toBe(true);
    expect(
      evalMatcher(inspectable(argCount({ max: 0 })), await shape("node")),
    ).toBe(true);
    expect(
      evalMatcher(
        inspectable(envAssignmentCount({ min: 1 })),
        await shape("FOO=1 node app.js"),
      ),
    ).toBe(true);
    expect(
      evalMatcher(
        inspectable(flagAllowlist({ shortChars: ["e", "u", "o"] })),
        await shape("set -euo pipefail"),
      ),
    ).toBe(true);
    expect(
      evalMatcher(
        inspectable(flagAllowlist({ shortChars: ["e", "u"] })),
        await shape("set -x"),
      ),
    ).toBe(false);
    expect(
      evalMatcher(
        inspectable(flagValueIn({ names: ["method"], values: ["GET"] })),
        await shape("gh api --method=GET /repos"),
      ),
    ).toBe(true);
    expect(
      evalMatcher(
        inspectable(flagValueIn({ names: ["method"], values: ["GET"] })),
        await shape("gh api --method POST /repos"),
      ),
    ).toBe(false);
    expect(
      evalMatcher(inspectable(argCount({ max: 0 })), {
        kind: "unknown",
        toolName: "x",
        rawInput: null,
        diagnostics: [],
      }),
    ).toBe(false);
  });

  it("matches redirect target kinds", async () => {
    expect(
      evalMatcher(
        inspectable(redirect({ stream: "stdout", targetKind: "file" })),
        await shape("echo x > out"),
      ),
    ).toBe(true);
    expect(
      evalMatcher(
        inspectable(redirect({ stream: "stdout", targetKind: "file" })),
        await shape("echo x 1>&2"),
      ),
    ).toBe(false);
  });

  it("selects redirect facts and handles exact paths and segment vetoes", async () => {
    const temp = await shape("echo x > /tmp/out", true);
    const nullPath = await shape("echo x > /dev/null", true);
    const gitPath = await shape("echo x > /repo/.git/config", true);
    const matcher = pathScopesAllIn({
      scopes: ["temp", "project", "writable-project"],
      usages: ["redirect-target"],
      allowExactPaths: ["/dev/null"],
      forbidPathSegments: [".git"],
    });
    expect(evalMatcher(inspectable(matcher), temp)).toBe(true);
    expect(evalMatcher(inspectable(matcher), nullPath)).toBe(true);
    expect(evalMatcher(inspectable(matcher), gitPath)).toBe(false);
  });

  it("keeps matcher specificity aligned", () => {
    for (const matcher of [
      argCount({ max: 1 }),
      envAssignmentCount({ min: 1 }),
      flagAllowlist({ shortChars: ["m"] }),
      flagValueIn({ names: ["method"], values: ["GET"] }),
      redirect({ targetKind: "file" }),
    ]) {
      expect(specificity(matcher)).toBe(matcherSpecificity(matcher));
    }
  });
});
