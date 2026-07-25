import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedProjectScope } from "../../src/config/loader.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import {
  attachBashPathFacts,
  type BashPathFactContext,
  defaultSystemPathPrefixes,
  deriveBashPathFacts,
  PATH_ARGUMENT_EXTRACTORS,
} from "../../src/parse/native-path-facts.ts";
import type {
  BashCommandShape,
  BashPathFact,
  BashPathFacts,
} from "../../src/parse/shape.ts";

const ORIGINAL_PLATFORM = process.platform;

beforeEach(() => {
  setPlatform("linux");
});
afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
});

const SYSTEM_PREFIXES = defaultSystemPathPrefixes();

/**
 * Mirrors the classification test's scope: cwd `/home/user/proj` is a root +
 * writable, so paths under it are `writable-project`. `/home/user/readonly-area`
 * is a non-writable root (exercises the `project` scope), `/var/tmp` + `/tmp/os-tmp`
 * are configured temp, and `/home/user/proj/secrets` + `/opt/secret` are denied.
 */
function makeScope(
  overrides: Partial<ResolvedProjectScope> = {},
): ResolvedProjectScope {
  return {
    roots: ["/home/user/proj", "/home/user/readonly-area"],
    writableDirectories: ["/home/user/proj", "/home/user/proj/build"],
    tempDirectories: ["/var/tmp", "/tmp/os-tmp"],
    deniedDirectories: ["/home/user/proj/secrets", "/opt/secret"],
    safeHomeDirectories: ["/home/user/dev", "/home/user/repos"],
    unknownPathBehavior: "review",
    sensitivePathBehavior: "review",
    homePathBehavior: "allow",
    ...overrides,
  };
}

function makeContext(
  overrides: Partial<BashPathFactContext> = {},
): BashPathFactContext {
  return {
    cwd: "/home/user/proj",
    projectScope: makeScope(),
    homeDirectory: "/home/user",
    systemPathPrefixes: SYSTEM_PREFIXES,
    ...overrides,
  };
}

async function factsFor(
  command: string,
  context: BashPathFactContext = makeContext(),
): Promise<{ shape: BashCommandShape; facts: BashPathFacts }> {
  const shape = await analyzeBashCommand(command);
  if (shape.kind !== "bash") {
    throw new Error("expected bash shape");
  }
  return { shape, facts: deriveBashPathFacts(shape, context) };
}

function byRaw(facts: BashPathFacts, raw: string): BashPathFact | undefined {
  return facts.facts.find((fact) => fact.raw === raw);
}

function byUsage(
  facts: BashPathFacts,
  usage: BashPathFact["usage"],
): BashPathFact[] {
  return facts.facts.filter((fact) => fact.usage === usage);
}

describe("PATH_ARGUMENT_EXTRACTORS registry", () => {
  it("registers filesystem and formatter path extractors", () => {
    expect(Object.keys(PATH_ARGUMENT_EXTRACTORS).sort()).toEqual([
      "biome",
      "cargo",
      "eslint",
      "mkdir",
      "mktemp",
      "prettier",
      "ruff",
      "touch",
    ]);
    expect(PATH_ARGUMENT_EXTRACTORS.mkdir?.program).toBe("mkdir");
    expect(PATH_ARGUMENT_EXTRACTORS.touch?.program).toBe("touch");
    expect(PATH_ARGUMENT_EXTRACTORS.mktemp?.program).toBe("mktemp");
  });
});

describe("deriveBashPathFacts cwd-prefix resolution", () => {
  it("records a cwd-prefix fact and resolves a later relative operand against it", async () => {
    const { shape, facts } = await factsFor("cd repo && touch file");

    expect(shape.cwdPrefix).toBe("repo");
    expect(facts.effectiveCwd).toBe("/home/user/proj/repo");
    expect(facts.cwdPrefix?.usage).toBe("cwd-prefix");
    expect(facts.cwdPrefix?.raw).toBe("repo");
    expect(facts.cwdPrefix?.scope).toBe("writable-project");
    expect(facts.cwdPrefix?.access).toBe("cwd");
    expect(facts.cwdPrefix?.program).toBe("cd");

    const file = byRaw(facts, "file");
    expect(file).toMatchObject({
      usage: "argument",
      access: "write",
      program: "touch",
      scope: "writable-project",
      isRelative: true,
    });
    expect(file?.absolutePath).toBe("/home/user/proj/repo/file");
    expect(file?.stageIndex).toBe(0);
    expect(facts.hasUnknown).toBe(false);
  });

  it("records parent traversal for `cd ..` and classifies the escaped effective cwd", async () => {
    const { shape, facts } = await factsFor("cd .. && touch file");

    expect(shape.cwdPrefix).toBe("..");
    expect(facts.effectiveCwd).toBe("/home/user");
    expect(facts.cwdPrefix?.scope).toBe("home");
    expect(facts.cwdPrefix?.hasParentTraversal).toBe(true);

    const file = byRaw(facts, "file");
    expect(file?.scope).toBe("home");
    expect(file?.absolutePath).toBe("/home/user/file");
    expect(file?.hasParentTraversal).toBe(false);
  });

  it("resolves operands after a nested cwd-prefix without dropping later blocks", async () => {
    const { facts } = await factsFor("cd repo && mkdir -p dist nested/dir");
    expect(facts.effectiveCwd).toBe("/home/user/proj/repo");
    expect(byRaw(facts, "dist")?.absolutePath).toBe(
      "/home/user/proj/repo/dist",
    );
    expect(byRaw(facts, "nested/dir")?.absolutePath).toBe(
      "/home/user/proj/repo/nested/dir",
    );
  });
});

describe("deriveBashPathFacts unsupported cwd-prefix forms", () => {
  it("fails closed for a variable cwd-prefix: unknown cwd-prefix fact + unresolved later operands", async () => {
    const { shape, facts } = await factsFor('cd "$DIR" && touch file');

    // `cd "$DIR"` lifts (the argument carries a simple_expansion the projection
    // does not count as a stage substitution), so cwdPrefix is defined but
    // decodes as a dynamic-expansion unknown.
    expect(shape.cwdPrefix).toBe('"$DIR"');
    expect(facts.cwdPrefix?.scope).toBe("unknown");
    expect(facts.cwdPrefix?.unknownReason).toBe("dynamic-expansion");
    expect(facts.effectiveCwd).toBe("/home/user/proj");

    const file = byRaw(facts, "file");
    expect(file?.scope).toBe("unknown");
    expect(file?.unknownReason).toBe("unresolved-cwd-prefix");
    expect(file?.isRelative).toBe(true);
    expect(facts.hasUnknown).toBe(true);
    // The shape carries the variable-expansion diagnostic for review.
    expect(
      shape.diagnostics.some((d) => d.code === "bash:variable-expansion"),
    ).toBe(true);
  });

  it("fails closed for an unsupported multi-arg cd (not lifted, diagnostic present)", async () => {
    const { shape, facts } = await factsFor("cd a b && touch file");

    expect(shape.cwdPrefix).toBeUndefined();
    expect(
      shape.diagnostics.some((d) => d.code === "bash:cwd-prefix-unsupported"),
    ).toBe(true);
    expect(facts.effectiveCwd).toBe("/home/user/proj");

    // The leading `cd` stage is retained but cd is not a path extractor, so it
    // contributes no facts; the later relative operand fails closed.
    const file = byRaw(facts, "file");
    expect(file?.scope).toBe("unknown");
    expect(file?.unknownReason).toBe("unresolved-cwd-prefix");
    expect(facts.hasUnknown).toBe(true);
  });

  it("still classifies absolute operands when the cwd-prefix is unknown", async () => {
    const { facts } = await factsFor("cd re* && touch /etc/passwd");
    expect(facts.cwdPrefix?.unknownReason).toBe("glob-expansion");

    const passwd = byRaw(facts, "/etc/passwd");
    expect(passwd?.scope).toBe("system");
    expect(passwd?.unknownReason).toBeUndefined();
  });

  it("fails closed for a glob cwd-prefix's later relative operands", async () => {
    const { facts } = await factsFor("cd re* && touch file");
    expect(facts.cwdPrefix?.unknownReason).toBe("glob-expansion");
    const file = byRaw(facts, "file");
    expect(file?.scope).toBe("unknown");
    expect(file?.unknownReason).toBe("unresolved-cwd-prefix");
    expect(file?.isRelative).toBe(true);
  });

  it("fails closed for relative operands after a second retained cd stage", async () => {
    const { facts } = await factsFor("cd a && cd b && touch file");

    expect(facts.effectiveCwd).toBe("/home/user/proj/a");
    const file = byRaw(facts, "file");
    expect(file?.scope).toBe("unknown");
    expect(file?.unknownReason).toBe("unresolved-cwd-prefix");
    expect(file?.isRelative).toBe(true);
  });

  it("still classifies absolute operands after a second retained cd stage", async () => {
    const { facts } = await factsFor("cd a && cd b && touch /etc/passwd");
    const passwd = byRaw(facts, "/etc/passwd");
    expect(passwd?.scope).toBe("system");
    expect(passwd?.unknownReason).toBeUndefined();
  });
});

describe("deriveBashPathFacts mkdir extraction", () => {
  it("treats positional operands as create facts and skips -p", async () => {
    const { facts } = await factsFor("mkdir -p dist nested/dir");
    const creates = byUsage(facts, "argument");
    expect(creates).toHaveLength(2);
    expect(creates.every((fact) => fact.access === "create")).toBe(true);
    expect(byRaw(facts, "dist")?.absolutePath).toBe("/home/user/proj/dist");
    expect(byRaw(facts, "nested/dir")?.absolutePath).toBe(
      "/home/user/proj/nested/dir",
    );
    // -p is a no-value flag, not a path fact.
    expect(facts.facts.some((fact) => fact.raw === "-p")).toBe(false);
  });

  it("skips the separate-token value of -m and keeps the operand", async () => {
    const { facts } = await factsFor("mkdir -m 0644 dist");
    expect(byRaw(facts, "0644")).toBeUndefined();
    const dist = byRaw(facts, "dist");
    expect(dist?.access).toBe("create");
    expect(dist?.absolutePath).toBe("/home/user/proj/dist");
  });

  it("skips the inline value of --mode= and keeps the operand", async () => {
    const { facts } = await factsFor("mkdir --mode=0644 dist");
    expect(byRaw(facts, "0644")).toBeUndefined();
    expect(byRaw(facts, "dist")?.access).toBe("create");
  });

  it("respects -- and treats dashed tokens after it as operands", async () => {
    const { facts } = await factsFor("mkdir -- -p dist");
    expect(byRaw(facts, "--")).toBeUndefined();
    expect(byRaw(facts, "-p")).toMatchObject({
      usage: "argument",
      access: "create",
      scope: "writable-project",
    });
    expect(byRaw(facts, "dist")?.access).toBe("create");
  });

  it("does not let operand-before-value-flag order hide a dangerous operand", async () => {
    const { facts } = await factsFor("mkdir /etc/foo -m 0644");
    expect(byRaw(facts, "0644")).toBeUndefined();
    const systemOperand = byRaw(facts, "/etc/foo");
    expect(systemOperand).toMatchObject({
      usage: "argument",
      access: "create",
      scope: "system",
    });
    expect(facts.hasSystemPath).toBe(true);
  });

  it("produces unknown facts for dynamic, glob, and brace-expanded operands", async () => {
    const variable = await factsFor("mkdir $DIR");
    expect(byRaw(variable.facts, "$DIR")?.unknownReason).toBe(
      "dynamic-expansion",
    );

    const glob = await factsFor("mkdir fi*");
    expect(byRaw(glob.facts, "fi*")?.unknownReason).toBe("glob-expansion");

    const brace = await factsFor("mkdir {a,b}");
    expect(byRaw(brace.facts, "{a,b}")?.unknownReason).toBe("brace-expansion");
  });

  it("recovers distinct operand source spans within the stage region", async () => {
    const { facts } = await factsFor("mkdir -p dist nested/dir");
    const dist = byRaw(facts, "dist");
    const nested = byRaw(facts, "nested/dir");
    // "mkdir -p dist nested/dir": dist at 9..13, nested/dir at 14..24.
    expect(dist?.source).toEqual({ start: 9, end: 13 });
    expect(nested?.source).toEqual({ start: 14, end: 24 });
  });
});

describe("deriveBashPathFacts touch extraction", () => {
  it("treats positional operands as write facts", async () => {
    const { facts } = await factsFor("touch README.md");
    const file = byRaw(facts, "README.md");
    expect(file).toMatchObject({ usage: "argument", access: "write" });
    expect(file?.absolutePath).toBe("/home/user/proj/README.md");
  });

  it("classifies -r/--reference values as read facts and the rest as write", async () => {
    const { facts } = await factsFor("touch -r ref file");
    expect(byRaw(facts, "ref")).toMatchObject({
      usage: "flag-value",
      access: "read",
    });
    expect(byRaw(facts, "file")).toMatchObject({
      usage: "argument",
      access: "write",
    });
  });

  it("classifies the inline --reference= value as a read fact", async () => {
    const { facts } = await factsFor("touch --reference=ref file");
    expect(byRaw(facts, "ref")).toMatchObject({
      usage: "flag-value",
      access: "read",
    });
    expect(byRaw(facts, "file")?.access).toBe("write");
  });

  it("skips time/date option values as non-path", async () => {
    const { facts } = await factsFor("touch -t 202001010000 file");
    expect(byRaw(facts, "202001010000")).toBeUndefined();
    expect(byRaw(facts, "file")?.access).toBe("write");
  });

  it("respects -- and treats dashed touch operands as paths", async () => {
    const { facts } = await factsFor("touch -- -file");
    expect(byRaw(facts, "--")).toBeUndefined();
    expect(byRaw(facts, "-file")).toMatchObject({
      usage: "argument",
      access: "write",
      scope: "writable-project",
    });
  });
});

describe("deriveBashPathFacts mktemp extraction", () => {
  it("emits an implicit-temp fact for bare mktemp", async () => {
    const { facts } = await factsFor("mktemp");
    expect(facts.facts).toHaveLength(1);
    const fact = facts.facts[0];
    expect(fact).toMatchObject({
      usage: "implicit-temp",
      access: "temp",
      scope: "temp",
      program: "mktemp",
    });
    expect(fact?.matchedScopes).toEqual(["temp"]);
    expect(fact?.absolutePath).toBeUndefined();
  });

  it("classifies the -p directory value as a temp flag-value fact", async () => {
    const { facts } = await factsFor("mktemp -p /var/tmp");
    const dir = byRaw(facts, "/var/tmp");
    expect(dir).toMatchObject({
      usage: "flag-value",
      access: "temp",
      scope: "temp",
    });
    // An explicit temp dir suppresses the implicit-temp fallback.
    expect(byUsage(facts, "implicit-temp")).toEqual([]);
  });

  it("classifies the inline --tmpdir= directory value as a temp fact", async () => {
    const { facts } = await factsFor("mktemp --tmpdir=/var/tmp");
    expect(byRaw(facts, "/var/tmp")?.scope).toBe("temp");
    expect(byUsage(facts, "implicit-temp")).toEqual([]);
  });

  it("treats bare --tmpdir as implicit-temp (uses $TMPDIR)", async () => {
    const { facts } = await factsFor("mktemp --tmpdir");
    expect(byUsage(facts, "implicit-temp")).toHaveLength(1);
    // --tmpdir alone must NOT claim a following template as its value.
    expect(facts.facts.some((fact) => fact.usage === "flag-value")).toBe(false);
  });

  it("classifies an explicit template operand as a create fact", async () => {
    const { facts } = await factsFor("mktemp fooXXXX");
    const tpl = byRaw(facts, "fooXXXX");
    expect(tpl).toMatchObject({ usage: "argument", access: "create" });
    expect(tpl?.absolutePath).toBe("/home/user/proj/fooXXXX");
    expect(byUsage(facts, "implicit-temp")).toEqual([]);
  });
});

describe("deriveBashPathFacts redirect extraction", () => {
  it("classifies a stdout file redirect as a write fact", async () => {
    const { facts } = await factsFor("echo hi > out.txt");
    const target = byRaw(facts, "out.txt");
    expect(target).toMatchObject({
      usage: "redirect-target",
      access: "write",
      scope: "writable-project",
    });
    expect(target?.absolutePath).toBe("/home/user/proj/out.txt");
    // echo is not a path extractor, so "hi" is not a path fact.
    expect(byRaw(facts, "hi")).toBeUndefined();
    // Source span is the redirect node span (`> out.txt`).
    expect(target?.source).toEqual({ start: 8, end: 17 });
  });

  it("classifies a stdin file redirect as a read fact", async () => {
    const { facts } = await factsFor("cat < input.txt");
    expect(byRaw(facts, "input.txt")).toMatchObject({
      usage: "redirect-target",
      access: "read",
    });
  });

  it("classifies a stderr file redirect as a write fact", async () => {
    const { facts } = await factsFor("cmd 2> err.log");
    expect(byRaw(facts, "err.log")).toMatchObject({
      usage: "redirect-target",
      access: "write",
    });
  });

  it("classifies a combined &> redirect as a write fact", async () => {
    const { facts } = await factsFor("cmd &> combined.log");
    expect(byRaw(facts, "combined.log")).toMatchObject({
      usage: "redirect-target",
      access: "write",
    });
  });

  it("produces unknown facts for variable-expanded redirect targets", async () => {
    const { facts } = await factsFor("echo hi > $OUT");
    const target = byRaw(facts, "$OUT");
    expect(target?.scope).toBe("unknown");
    expect(target?.unknownReason).toBe("dynamic-expansion");
    expect(target?.dynamic).toBe(true);
  });

  it("produces unknown facts for glob redirect targets", async () => {
    const { facts } = await factsFor("echo hi > re*");
    expect(byRaw(facts, "re*")?.unknownReason).toBe("glob-expansion");
  });

  it("produces unknown facts for brace-expansion redirect targets", async () => {
    const { facts } = await factsFor("echo hi > {a,b}");
    expect(byRaw(facts, "{a,b}")?.unknownReason).toBe("brace-expansion");
  });

  it("emits no path fact for fd-only redirects", async () => {
    const { facts } = await factsFor("cmd 2>&1");
    expect(facts.facts).toEqual([]);
  });

  it("emits no path fact for heredoc and herestring targets", async () => {
    const heredoc = await factsFor("cat <<EOF\nhi\nEOF");
    expect(heredoc.facts.facts).toEqual([]);

    const herestring = await factsFor('cat <<< "text"');
    expect(herestring.facts.facts).toEqual([]);
  });
});

describe("deriveBashPathFacts does not classify arbitrary arguments", () => {
  it("produces no path facts for non-extractor programs without redirects", async () => {
    const { facts } = await factsFor("git status --short");
    expect(facts.facts).toEqual([]);
    expect(facts.hasUnknown).toBe(false);
  });

  it("produces no path facts for echo with no redirect", async () => {
    const { facts } = await factsFor("echo hi");
    expect(facts.facts).toEqual([]);
  });
});

describe("deriveBashPathFacts summary flags", () => {
  it("sets hasSystemPath when a redirect targets a system path", async () => {
    const { facts } = await factsFor("echo hi > /etc/passwd");
    expect(facts.hasSystemPath).toBe(true);
    expect(byRaw(facts, "/etc/passwd")?.scope).toBe("system");
  });

  it("sets hasDenied when an operand targets a denied directory", async () => {
    const { facts } = await factsFor("touch secrets/key");
    expect(facts.hasDenied).toBe(true);
    expect(byRaw(facts, "secrets/key")?.scope).toBe("denied");
  });

  it("sets hasOutsideProject for an absolute outside-project redirect", async () => {
    const { facts } = await factsFor("echo hi > /outside/random");
    expect(facts.hasOutsideProject).toBe(true);
    expect(byRaw(facts, "/outside/random")?.scope).toBe("outside");
  });
});

describe("attachBashPathFacts with extraction", () => {
  it("attaches derived path facts (including extracted operands) to a bash shape", async () => {
    const shape = await analyzeBashCommand("cd repo && touch file");
    if (shape.kind !== "bash") {
      throw new Error("expected bash shape");
    }
    const enriched = attachBashPathFacts(shape, makeContext());
    expect(enriched.kind).toBe("bash");
    if (enriched.kind !== "bash") {
      throw new Error("expected bash shape");
    }
    expect(enriched.pathFacts?.effectiveCwd).toBe("/home/user/proj/repo");
    expect(enriched.pathFacts?.facts).toHaveLength(2);
    // Original shape is not mutated.
    expect(shape.pathFacts).toBeUndefined();
  });
});

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}
