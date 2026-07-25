import { describe, expect, it } from "vitest";

import { analyzeBashCommand } from "../src/parse/native-parser.ts";
import { classifyBashPathFact } from "../src/parse/native-path-facts.ts";
import type { BashCommandShape } from "../src/parse/shape.ts";

async function bash(command: string): Promise<BashCommandShape> {
  const shape = await analyzeBashCommand(command);
  expect(shape.kind).toBe("bash");
  if (shape.kind !== "bash") {
    throw new Error("expected bash shape");
  }
  return shape;
}

describe("baseline inspection parse projections", () => {
  it("projects export assignments into the environment and screens expansions", async () => {
    const literal = await bash("export FOO=1 BAR=2");
    expect(literal.stages[0]).toMatchObject({
      kind: "command",
      program: {
        program: "export",
        environment: [{ name: "FOO" }, { name: "BAR" }],
      },
    });
    expect(literal.diagnostics).toEqual([]);

    const dynamic = await bash("export FOO=$HOME");
    expect(dynamic.diagnostics).toEqual([
      expect.objectContaining({ code: "bash:variable-expansion" }),
    ]);
    const substitution = await bash("export FOO=$(cmd)");
    expect(substitution.stages[0]).toMatchObject({
      kind: "command",
      substitutions: [expect.objectContaining({ kind: "command" })],
    });
  });

  it("projects bracket tests without operand fidelity but preserves dynamic diagnostics", async () => {
    const bracket = await bash("[ -f x ]");
    const doubleBracket = await bash("[[ -n $VALUE ]]");
    expect(bracket.stages[0]).toMatchObject({
      kind: "command",
      program: { program: "[", arguments: [], flags: [] },
    });
    expect(doubleBracket.stages[0]).toMatchObject({
      kind: "command",
      program: { program: "[[", arguments: [], flags: [] },
    });
    expect(doubleBracket.diagnostics).toEqual([
      expect.objectContaining({ code: "bash:variable-expansion" }),
    ]);
  });

  it("keeps lone cd modeled while retaining diagnostics for cd prefixes", async () => {
    expect((await bash("cd ..")).diagnostics).toEqual([]);
    expect((await bash("cd x; ls")).diagnostics).toEqual([
      expect.objectContaining({ code: "bash:cwd-prefix-unsupported" }),
    ]);
  });

  it("allows only the exact TMPDIR slash prefix in redirect diagnostics", async () => {
    for (const command of ["echo x > $TMPDIR/out", 'echo x > "$TMPDIR/out"']) {
      expect((await bash(command)).diagnostics).toEqual([]);
    }
    for (const command of [
      "echo x > $TMPDIR",
      "echo x > $TMPDIR$x",
      "echo x > $OTHER/out",
      "echo x > a$TMPDIR/out",
    ]) {
      expect((await bash(command)).diagnostics.length).toBeGreaterThan(0);
      expect((await bash(command)).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "bash:redirect-expansion" }),
        ]),
      );
    }
  });
});

describe("TMPDIR path-fact decoding", () => {
  it("resolves the configured first temp directory and rejects unsafe suffixes", () => {
    const context = {
      cwd: "/repo",
      projectScope: {
        roots: ["/repo"],
        writableDirectories: ["/repo"],
        tempDirectories: ["/tmp/configured"],
        deniedDirectories: [],
        safeHomeDirectories: [],
        unknownPathBehavior: "review" as const,
      },
    };
    const fact = classifyBashPathFact(
      {
        raw: "$TMPDIR/out",
        usage: "redirect-target",
        access: "write",
        source: { start: 0, end: 12 },
      },
      context,
    );
    expect(fact).toMatchObject({
      scope: "temp",
      absolutePath: "/tmp/configured/out",
    });

    for (const raw of [
      "$TMPDIR/../../etc/out",
      "$TMPDIR/*.log",
      "$TMPDIR/$OTHER",
    ]) {
      expect(
        classifyBashPathFact(
          {
            raw,
            usage: "redirect-target",
            access: "write",
            source: { start: 0, end: raw.length },
          },
          context,
        ).scope,
      ).toBe("unknown");
    }

    expect(
      classifyBashPathFact(
        {
          raw: "$TMPDIR/out",
          usage: "redirect-target",
          access: "write",
          source: { start: 0, end: 12 },
        },
        {
          ...context,
          projectScope: { ...context.projectScope, tempDirectories: [] },
        },
      ).scope,
    ).toBe("unknown");
  });
});
