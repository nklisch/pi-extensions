import { describe, expect, it } from "vitest";

import type { ResolvedProjectScope } from "../../src/config/loader.ts";
import { bashProjectConstructivePack } from "../../src/packs/bash.project.constructive.ts";
import { sealedFloor } from "../../src/packs/floor.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import { enrichToolShapeWithPathFacts } from "../../src/parse/native-path-facts.ts";
import type { Decision } from "../../src/policy/core.ts";
import { decide } from "../../src/policy/core.ts";
import { expectCleanLoad } from "./helpers.ts";

const TEST_CWD = "/repo";
const TEST_TEMP_DIR = "/tmp/os-tmp";

function projectScope(
  overrides: Partial<ResolvedProjectScope> = {},
): ResolvedProjectScope {
  return {
    roots: [TEST_CWD],
    writableDirectories: [TEST_CWD],
    tempDirectories: [TEST_TEMP_DIR],
    deniedDirectories: [],
    safeHomeDirectories: [],
    unknownPathBehavior: "review",
  sensitivePathBehavior: "review",
  homePathBehavior: "allow",
    ...overrides,
  };
}

interface ConstructiveDecisionOptions {
  readonly cwd?: string;
  readonly projectScope?: ResolvedProjectScope;
}

interface ConstructiveDecisionCase {
  readonly command: string;
  readonly why: string;
  readonly cwd?: string;
  readonly scope?: ResolvedProjectScope;
}

interface ConstructiveAllowCase extends ConstructiveDecisionCase {
  readonly ruleId: string;
}

async function decideConstructive(
  command: string,
  options: ConstructiveDecisionOptions = {},
): Promise<Decision> {
  const rawShape = await analyzeBashCommand(command);
  const enriched = enrichToolShapeWithPathFacts(rawShape, {
    cwd: options.cwd ?? TEST_CWD,
    projectScope: options.projectScope ?? projectScope(),
  });
  return decide(enriched, {
    floor: sealedFloor.rules,
    active: bashProjectConstructivePack.rules,
  });
}

function decisionOptionsFor({
  cwd,
  scope,
}: ConstructiveDecisionCase): ConstructiveDecisionOptions {
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(scope !== undefined ? { projectScope: scope } : {}),
  };
}

type DefaultReviewReason = "no matching rule" | "parse diagnostics present";

function expectConstructiveAllow(decision: Decision, ruleId: string): void {
  expect(decision).toMatchObject({
    effect: "allow",
    provenance: {
      source: "shipped",
      packId: "bash.project.constructive",
      ruleId,
    },
  });
}

function expectDefaultReview(
  decision: Decision,
  reason: DefaultReviewReason,
): void {
  expect(decision).toMatchObject({
    effect: "review",
    reason,
    provenance: { source: "default" },
  });
}

function expectConstructivePackReview(
  decision: Decision,
  ruleId: string,
): void {
  expect(decision).toMatchObject({
    effect: "review",
    provenance: {
      source: "shipped",
      packId: "bash.project.constructive",
      ruleId,
    },
  });
}

function expectSealedFloorDeny(decision: Decision, ruleId: string): void {
  expect(decision).toMatchObject({
    effect: "deny",
    provenance: {
      source: "shipped",
      packId: "floor.deny",
      ruleId,
    },
  });
}

describe("bash.project.constructive pack", () => {
  it("compiles and loads cleanly against the sealed floor", () => {
    expect(bashProjectConstructivePack).toMatchObject({
      version: 1,
      id: "bash.project.constructive",
    });
    expectCleanLoad(bashProjectConstructivePack);
  });

  it.each([
    {
      command: "touch README.md",
      why: "relative target under writable project root",
      ruleId: "bash.project.constructive:allow-touch",
    },
    {
      command: "touch /repo/README.md",
      why: "absolute target under writable project root",
      ruleId: "bash.project.constructive:allow-touch",
    },
    {
      command: "touch /repo/sub/file",
      why: "absolute target under writable project subdirectory",
      ruleId: "bash.project.constructive:allow-touch",
    },
    {
      command: "mkdir -p dist",
      why: "relative create under writable project root",
      ruleId: "bash.project.constructive:allow-mkdir",
    },
    {
      command: "mkdir /repo/readonly/path",
      why: "target under non-writable project root still satisfies project scope",
      cwd: `${TEST_CWD}/writable`,
      scope: projectScope({
        writableDirectories: [`${TEST_CWD}/writable`],
      }),
      ruleId: "bash.project.constructive:allow-mkdir",
    },
    {
      command: "mktemp",
      why: "bare implicit temp file",
      ruleId: "bash.project.constructive:allow-mktemp",
    },
    {
      command: "mktemp -d",
      why: "implicit temp directory",
      ruleId: "bash.project.constructive:allow-mktemp",
    },
    {
      command: `mktemp -p ${TEST_TEMP_DIR}`,
      why: "explicit configured temp directory",
      ruleId: "bash.project.constructive:allow-mktemp",
    },
    {
      command: `mktemp --tmpdir=${TEST_TEMP_DIR}`,
      why: "inline explicit configured temp directory",
      ruleId: "bash.project.constructive:allow-mktemp",
    },
    {
      command: "mktemp /repo/template.XXXX",
      why: "project-scoped template operand",
      ruleId: "bash.project.constructive:allow-mktemp",
    },
    {
      command: "cd subdir && touch file",
      why: "cwd prefix shifts relative target into the project",
      ruleId: "bash.project.constructive:allow-touch",
    },
    {
      command: "touch 'src/file'",
      why: "single-quoted literal target in project scope",
      ruleId: "bash.project.constructive:allow-touch",
    },
    {
      command: 'touch "src/file"',
      why: "double-quoted literal target in project scope",
      ruleId: "bash.project.constructive:allow-touch",
    },
    {
      command: "touch 'src'/\"file\"",
      why: "mixed quoted literal target in project scope",
      ruleId: "bash.project.constructive:allow-touch",
    },
    {
      command: "touch src/../file",
      why: "parent traversal resolves inside the project",
      ruleId: "bash.project.constructive:allow-touch",
    },
  ] satisfies readonly ConstructiveAllowCase[])("allows $why: $command", async (testCase) => {
    expectConstructiveAllow(
      await decideConstructive(testCase.command, decisionOptionsFor(testCase)),
      testCase.ruleId,
    );
  });

  it.each([
    {
      command: "touch /home/user/file",
      why: "home-like path while runtime home is not plumbed",
    },
    {
      command: "touch /outside/random",
      why: "outside-project absolute path",
    },
    {
      command: "touch /etc/passwd",
      why: "system path",
    },
    {
      command: "touch /repo/denied/file",
      why: "denied-directory precedence over project scope",
      scope: projectScope({ deniedDirectories: ["/repo/denied"] }),
    },
    {
      command: "touch ../outside",
      why: "parent traversal escapes project roots",
    },
    {
      command: "cd .. && touch file",
      why: "cwd prefix shifts relative target outside project roots",
    },
    {
      command: "mktemp -p /outside/tmp",
      why: "explicit temp directory outside configured temp scope",
    },
    {
      command: "touch /srv/file",
      why: "outside-project absolute path under srv",
    },
    {
      command: "touch out*",
      why: "glob target has unknown path scope",
    },
    {
      command: "touch {a,b}",
      why: "brace expansion has unknown path scope",
    },
    {
      command: "cd /etc && touch /repo/file",
      why: "cwd prefix contributes an unsafe system path fact",
    },
    {
      command: "touch file 2> /etc/log",
      why: "redirect target contributes an unsafe system path fact",
    },
    {
      command: "touch",
      why: "missing path operand fails the per-stage fact requirement",
    },
    {
      command: "touch ~/file",
      why: "home expansion is unknown without runtime home plumbing",
    },
  ] satisfies readonly ConstructiveDecisionCase[])("reviews $why: $command", async (testCase) => {
    expect(
      await decideConstructive(testCase.command, decisionOptionsFor(testCase)),
    ).toMatchObject({
      effect: "review",
    });
  });

  describe("unknown path facts and precedence", () => {
    it.each([
      {
        command: 'touch "$FILE"',
        why: "variable expansion operand uses parse-diagnostic review",
        reason: "parse diagnostics present",
      },
      {
        command: "mkdir $(pwd)",
        why: "command substitution operand makes the path scope unknown",
        reason: "no matching rule",
      },
      {
        command: "touch re*",
        why: "glob operand makes the path scope unknown",
        reason: "no matching rule",
      },
      {
        command: "touch {a,b}",
        why: "brace operand makes the path scope unknown",
        reason: "no matching rule",
      },
      {
        command: "touch ~root/x",
        why: "portable scope for ~user cannot be resolved",
        reason: "no matching rule",
      },
      {
        command: "touch",
        why: "missing operands provide no per-stage path fact",
        reason: "no matching rule",
      },
    ] satisfies readonly (ConstructiveDecisionCase & {
      readonly reason: DefaultReviewReason;
    })[])("reviews $why: $command", async (testCase) => {
      expectDefaultReview(
        await decideConstructive(testCase.command),
        testCase.reason,
      );
    });

    it("keeps mktemp --tmpdir without a value as implicit temp", async () => {
      expectConstructiveAllow(
        await decideConstructive("mktemp --tmpdir"),
        "bash.project.constructive:allow-mktemp",
      );
    });

    it.each([
      {
        command: "touch file 2> /etc/log",
        why: "project-local operand has an out-of-scope redirect target",
      },
      {
        command: "echo hi > /repo/out 2> /etc/log",
        why: "non-constructive command has a project redirect and system redirect",
      },
      {
        command: "touch /repo/file /etc/passwd",
        why: "mixed project-safe and system operands must all be in scope",
      },
      {
        command: "touch /repo/file ../outside",
        why: "mixed absolute project-safe and escaping relative operands",
      },
      {
        command: "rm -rf build",
        why: "destructive command has no constructive allow and no floor match",
      },
    ] satisfies readonly ConstructiveDecisionCase[])("reviews $why: $command", async (testCase) => {
      expectDefaultReview(
        await decideConstructive(testCase.command),
        "no matching rule",
      );
    });

    it("keeps the sealed floor above constructive allows", async () => {
      expectSealedFloorDeny(
        await decideConstructive("sudo mkdir dir"),
        "floor:deny-privilege-escalation",
      );
    });

    it.each([
      {
        command: "mkdir -m 777 dir",
        ruleId: "bash.project.constructive:review-mkdir-mode",
      },
      {
        command: "mkdir --mode 755 dir",
        ruleId: "bash.project.constructive:review-mkdir-mode",
      },
      {
        command: "cp src dest",
        ruleId: "bash.project.constructive:review-copy-move",
      },
      {
        command: "mv -f a b",
        ruleId: "bash.project.constructive:review-copy-move",
      },
    ])("uses pack review-rule precedence for $command", async (testCase) => {
      expectConstructivePackReview(
        await decideConstructive(testCase.command),
        testCase.ruleId,
      );
    });

    it("reviews un-enriched constructive shapes rather than allowing", async () => {
      const shape = await analyzeBashCommand("touch README.md");

      expectDefaultReview(
        decide(shape, {
          floor: sealedFloor.rules,
          active: bashProjectConstructivePack.rules,
        }),
        "no matching rule",
      );
    });
  });

  it("reviews denied-directory targets", async () => {
    expect(
      await decideConstructive("touch /repo/denied/file", {
        projectScope: projectScope({ deniedDirectories: ["/repo/denied"] }),
      }),
    ).toMatchObject({
      effect: "review",
    });
  });

  it("surfaces system path facts while reviewing system targets", async () => {
    const rawShape = await analyzeBashCommand("touch /etc/passwd");
    const enriched = enrichToolShapeWithPathFacts(rawShape, {
      cwd: TEST_CWD,
      projectScope: projectScope(),
    });
    if (enriched.kind !== "bash") {
      throw new Error("expected bash shape");
    }

    expect(enriched.pathFacts?.hasSystemPath).toBe(true);
    const target = enriched.pathFacts?.facts.find(
      (fact) => fact.raw === "/etc/passwd",
    );
    expect(target).toMatchObject({
      usage: "argument",
      access: "write",
      program: "touch",
      scope: "system",
      absolutePath: "/etc/passwd",
    });
    expect(await decideConstructive("touch /etc/passwd")).toMatchObject({
      effect: "review",
    });
  });
});
