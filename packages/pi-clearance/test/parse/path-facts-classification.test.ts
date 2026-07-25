import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedProjectScope } from "../../src/config/loader.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import {
  attachBashPathFacts,
  type BashPathFactContext,
  type BashPathFactInput,
  classifyBashPathFact,
  defaultSystemPathPrefixes,
  deriveBashPathFacts,
  derivePiBuiltinToolPathFacts,
  enrichToolShapeWithPathFacts,
} from "../../src/parse/native-path-facts.ts";
import {
  analyzePiBuiltinTool,
  SUPPORTED_PI_BUILTIN_TOOL_SPECS,
  SUPPORTED_PI_EXTENSION_TOOL_SPECS,
  SUPPORTED_PI_MUTATION_TOOL_SPECS,
} from "../../src/parse/native-tool.ts";
import type {
  BashPathFact,
  PathScope,
  PiBuiltinToolShape,
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
 * Realistic resolved scope mirroring loader output: cwd is a root + writable
 * (the loader seeds both), so every path under the project root is
 * `writable-project`. `/home/user/readonly-area` is an extra non-writable
 * root so the `project` (non-writable) scope is reachable for testing.
 */
function makeScope(
  overrides: Partial<ResolvedProjectScope> = {},
): ResolvedProjectScope {
  return {
    roots: ["/home/user/proj", "/home/user/readonly-area"],
    writableDirectories: ["/home/user/proj", "/home/user/proj/build"],
    tempDirectories: ["/var/tmp", "/tmp/os-tmp"],
    deniedDirectories: ["/home/user/proj/secrets", "/opt/secret"],
    safeHomeDirectories: [
      "/home/user/projects",
      "/home/user/dev",
      "/home/user/src",
      "/home/user/code",
      "/home/user/repos",
      "/home/user/Developer",
    ],
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

/** Context with no `homeDirectory` so `~` cannot expand (fail-closed unknown). */
function makeContextWithoutHome(
  overrides: Partial<BashPathFactContext> = {},
): BashPathFactContext {
  return {
    cwd: "/home/user/proj",
    projectScope: makeScope(),
    systemPathPrefixes: SYSTEM_PREFIXES,
    ...overrides,
  };
}

function classify(
  raw: string,
  overrides: Partial<BashPathFactInput> & {
    context?: BashPathFactContext;
  } = {},
): BashPathFact {
  const { context, ...input } = overrides;
  return classifyBashPathFact(
    {
      raw,
      usage: "argument",
      access: "write",
      source: { start: 0, end: raw.length },
      ...input,
    },
    context ?? makeContext(),
  );
}

function expectConcrete(
  fact: BashPathFact,
  scope: PathScope,
): asserts fact is BashPathFact & { literal: string; absolutePath: string } {
  expect(fact.scope).toBe(scope);
  expect(fact.unknownReason).toBeUndefined();
  expect(fact.dynamic).toBe(false);
  expect(fact.normalization).toBe("lexical");
  expect(typeof fact.literal).toBe("string");
  expect(typeof fact.absolutePath).toBe("string");
}

function expectUnknown(
  fact: BashPathFact,
  reason: BashPathFact["unknownReason"],
  dynamic: boolean,
): void {
  expect(fact.scope).toBe("unknown");
  expect(fact.matchedScopes).toEqual(["unknown"]);
  expect(fact.unknownReason).toBe(reason);
  expect(fact.dynamic).toBe(dynamic);
  expect(fact.literal).toBeUndefined();
  expect(fact.absolutePath).toBeUndefined();
  expect(fact.isAbsolute).toBe(false);
  expect(fact.isRelative).toBe(false);
}

/** Assert the decoder produced a concrete literal with the expected value/quote. */
function expectDecoded(
  fact: BashPathFact,
  literal: string,
  quote: BashPathFact["quote"],
): asserts fact is BashPathFact & { literal: string } {
  expect(fact.unknownReason).toBeUndefined();
  expect(fact.dynamic).toBe(false);
  expect(fact.literal).toBe(literal);
  expect(fact.quote).toBe(quote);
  expect(fact.normalization).toBe("lexical");
}

describe("classifyBashPathFact scope coverage", () => {
  it("classifies the project root (cwd) as writable-project, matching project+home", () => {
    const fact = classify("/home/user/proj");
    expectConcrete(fact, "writable-project");
    expect(fact.matchedScopes).toEqual(["writable-project", "project", "home"]);
    expect(fact.isAbsolute).toBe(true);
    expect(fact.isRelative).toBe(false);
    expect(fact.hasParentTraversal).toBe(false);
  });

  it("classifies a writable project subdirectory as writable-project", () => {
    const fact = classify("/home/user/proj/build");
    expectConcrete(fact, "writable-project");
    expect(fact.matchedScopes).toEqual(["writable-project", "project", "home"]);
  });

  it("classifies a non-writable project directory as project", () => {
    const fact = classify("/home/user/readonly-area/x");
    expectConcrete(fact, "project");
    expect(fact.matchedScopes).toEqual(["project", "home"]);
  });

  it("classifies a configured temp directory as temp (beating system)", () => {
    const fact = classify("/var/tmp/x");
    expectConcrete(fact, "temp");
    expect(fact.matchedScopes).toEqual(["temp", "system"]);
  });

  it("classifies the OS temp directory as temp, not system", () => {
    const fact = classify("/tmp/os-tmp/x");
    expectConcrete(fact, "temp");
    expect(fact.matchedScopes).toEqual(["temp"]);
  });

  it("classifies a home-outside-project path as home", () => {
    const fact = classify("/home/user/other");
    expectConcrete(fact, "home");
    expect(fact.matchedScopes).toEqual(["home"]);
  });

  it("classifies a configured safe-home path as safe-home", () => {
    const fact = classify("/home/user/dev/foo.ts");
    expectConcrete(fact, "safe-home");
    expect(fact.matchedScopes).toEqual(["safe-home"]);
  });

  it.each([
    "/home/user/.pi/agent/skills/clearance/SKILL.md",
    "/home/user/.pi/agent/plugins/example/index.ts",
    "/home/user/.pi/agent/npm/node_modules/pkg/README.md",
    "/home/user/.pi/agent/plugin-host/stores/packs/example.json",
  ])("classifies a configured Pi support root as agent-support: %s", (raw) => {
    const fact = classify(raw, {
      context: makeContext({
        projectScope: makeScope({
          agentSupportDirectories: [
            "/home/user/.pi/agent/skills",
            "/home/user/.pi/agent/plugins",
            "/home/user/.pi/agent/npm/node_modules",
            "/home/user/.pi/agent/plugin-host/stores",
          ],
        }),
      }),
    });
    expectConcrete(fact, "agent-support");
    expect(fact.matchedScopes).toEqual(["agent-support", "home"]);
  });

  it("classifies an explicitly configured support root outside home", () => {
    const fact = classify("/opt/pi-support/docs/README.md", {
      context: makeContext({
        projectScope: makeScope({
          agentSupportDirectories: ["/opt/pi-support"],
        }),
      }),
    });
    expectConcrete(fact, "agent-support");
    expect(fact.matchedScopes).toEqual(["agent-support", "system"]);
  });

  it("keeps Pi auth material in sensitive-home even under a broad support root", () => {
    const fact = classify("/home/user/.pi/agent/auth.json", {
      context: makeContext({
        projectScope: makeScope({
          agentSupportDirectories: ["/home/user/.pi/agent"],
        }),
      }),
    });
    expectConcrete(fact, "sensitive-home");
    expect(fact.matchedScopes).toEqual(["sensitive-home"]);
  });

  it("classifies ordinary home paths separately from agent-support", () => {
    const fact = classify("/home/user/Documents/notes.md", {
      context: makeContext({
        projectScope: makeScope({
          agentSupportDirectories: ["/home/user/.pi/agent/skills"],
        }),
      }),
    });
    expectConcrete(fact, "home");
    expect(fact.matchedScopes).toEqual(["home"]);
  });

  it("classifies sensitive home paths as sensitive-home before safe-home", () => {
    const context = makeContext({
      projectScope: makeScope({
        safeHomeDirectories: ["/home/user"],
      }),
    });

    const ssh = classify("/home/user/.ssh/config", { context });
    const aws = classify("/home/user/.aws/credentials", { context });

    expectConcrete(ssh, "sensitive-home");
    expect(ssh.matchedScopes).toEqual(["sensitive-home"]);
    expectConcrete(aws, "sensitive-home");
    expect(aws.matchedScopes).toEqual(["sensitive-home"]);
  });

  it.each([
    "/home/user/.pi/agent/auth.json",
    "/home/user/.pi/agent/models.json",
    "/home/user/.config/gh/hosts.yml",
    "/home/user/.config/glab-cli/hosts.yml",
    "/home/user/.npmrc",
    "/home/user/.pypirc",
    "/home/user/.cargo/credentials.toml",
    "/home/user/.config/gcloud/credentials.db",
    "/home/user/.azure/accessTokens.json",
    "/home/user/.config/provider/token",
  ])("classifies newly cataloged credential path %s as sensitive-home", (raw) => {
    expectConcrete(classify(raw), "sensitive-home");
  });

  it.each([
    "/home/user/.pi/agent/settings.json",
    "/home/user/.pi/agent/trust.json",
    "/home/user/.pi/agent/sessions/2026-01-01.session.jsonl",
    "/home/user/.pi/agent/audit/decisions.jsonl",
    "/home/user/.pi/agent/cache/context.json",
    "/home/user/.config/gh/config.yml",
    "/home/user/.config/glab-cli/config.yml",
    "/home/user/.cargo/config.toml",
  ])("keeps adjacent Pi and provider context in home scope: %s", (raw) => {
    expectConcrete(classify(raw), "home");
  });

  it("keeps broad home paths out of safe-home defaults", () => {
    expect(classify("/home/user/Documents/x").scope).toBe("home");
    expect(classify("/home/user/random.txt").scope).toBe("home");
  });

  it("classifies a system path as system", () => {
    const fact = classify("/etc/passwd");
    expectConcrete(fact, "system");
    expect(fact.matchedScopes).toEqual(["system"]);
  });

  it("classifies an outside-project path as outside", () => {
    const fact = classify("/outside/random/path");
    expectConcrete(fact, "outside");
    expect(fact.matchedScopes).toEqual(["outside"]);
  });

  it("classifies a denied directory as denied, winning over everything concrete", () => {
    const fact = classify("/home/user/proj/secrets/x");
    expectConcrete(fact, "denied");
    expect(fact.matchedScopes).toEqual([
      "denied",
      "writable-project",
      "project",
      "home",
    ]);
  });

  it("classifies a denied directory outside the project as denied over system", () => {
    const fact = classify("/opt/secret/x");
    expectConcrete(fact, "denied");
    expect(fact.matchedScopes).toEqual(["denied", "system"]);
  });

  it("treats a non-writable project root as project when cwd is not writable", () => {
    const context = makeContext({
      projectScope: makeScope({ writableDirectories: [] }),
    });
    const fact = classify("/home/user/proj", { context });
    expectConcrete(fact, "project");
    expect(fact.matchedScopes).toEqual(["project", "home"]);
  });
});

describe("classifyBashPathFact scope precedence", () => {
  it("unknown beats every concrete scope", () => {
    const fact = classify("$VAR");
    expect(fact.scope).toBe("unknown");
    expect(fact.matchedScopes).toEqual(["unknown"]);
  });

  it("denied beats writable-project, project, and home", () => {
    const fact = classify("/home/user/proj/secrets/x");
    expect(fact.scope).toBe("denied");
  });

  it("writable-project beats project and home (project checked out under $HOME)", () => {
    const fact = classify("/home/user/proj/build");
    expect(fact.scope).toBe("writable-project");
    expect(fact.matchedScopes).toContain("home");
    expect(fact.matchedScopes).toContain("project");
  });

  it("project beats home for a non-writable project directory", () => {
    const fact = classify("/home/user/readonly-area/x");
    expect(fact.scope).toBe("project");
    expect(fact.matchedScopes).toContain("home");
    expect(fact.matchedScopes).not.toContain("writable-project");
  });

  it("project beats safe-home for a project checkout under a safe-home directory", () => {
    const context = makeContext({
      cwd: "/home/user/repos/pi-clearance",
      projectScope: makeScope({
        roots: ["/home/user/repos/pi-clearance"],
        writableDirectories: ["/home/user/repos/pi-clearance"],
      }),
    });

    const fact = classify("/home/user/repos/pi-clearance/src/x.ts", {
      context,
    });

    expect(fact.scope).toBe("writable-project");
    expect(fact.matchedScopes).toEqual([
      "writable-project",
      "project",
      "safe-home",
    ]);
  });

  it("temp beats system so os.tmpdir() under a system prefix stays temp", () => {
    const fact = classify("/var/tmp/x");
    expect(fact.scope).toBe("temp");
    expect(fact.matchedScopes).toContain("system");
  });

  it("denied beats system for a denied path under a system prefix", () => {
    const fact = classify("/opt/secret/x");
    expect(fact.scope).toBe("denied");
    expect(fact.matchedScopes).toContain("system");
  });
});

describe("classifyBashPathFact relative resolution and parent traversal", () => {
  it("resolves a relative path against the supplied effective cwd", () => {
    const fact = classify("src/file");
    expectConcrete(fact, "writable-project");
    expect(fact.absolutePath).toBe(path.resolve("/home/user/proj", "src/file"));
    expect(fact.isRelative).toBe(true);
    expect(fact.isAbsolute).toBe(false);
    expect(fact.hasParentTraversal).toBe(false);
  });

  it("resolves relative paths against an explicit effective cwd override", () => {
    const fact = classify("file", {
      effectiveCwd: "/home/user/proj/build",
    });
    expectConcrete(fact, "writable-project");
    expect(fact.absolutePath).toBe("/home/user/proj/build/file");
  });

  it("records parent traversal even when the final path stays in scope", () => {
    const fact = classify("src/../file");
    expectConcrete(fact, "writable-project");
    expect(fact.absolutePath).toBe("/home/user/proj/file");
    expect(fact.hasParentTraversal).toBe(true);
  });

  it("records parent traversal and classifies the escaped path", () => {
    const fact = classify("../sibling");
    expectConcrete(fact, "home");
    expect(fact.absolutePath).toBe("/home/user/sibling");
    expect(fact.hasParentTraversal).toBe(true);
  });

  it("resolves a bare `..` to the parent and records traversal", () => {
    const fact = classify("..");
    expectConcrete(fact, "home");
    expect(fact.absolutePath).toBe("/home/user");
    expect(fact.hasParentTraversal).toBe(true);
  });

  it("resolves `.` to the effective cwd (project root)", () => {
    const fact = classify(".");
    expectConcrete(fact, "writable-project");
    expect(fact.absolutePath).toBe("/home/user/proj");
  });

  it("classifies a relative path escaping above all scopes as outside", () => {
    const fact = classify("../../..");
    expect(fact.scope).toBe("outside");
    expect(fact.hasParentTraversal).toBe(true);
  });

  it("resolves a relative path against a cwd-prefix effective cwd inside denied", () => {
    const fact = classify("file", {
      effectiveCwd: "/home/user/proj/secrets",
    });
    expectConcrete(fact, "denied");
  });
});

describe("classifyBashPathFact quoted literals", () => {
  it("decodes single-quoted literal paths", () => {
    const fact = classify("'src/file'");
    expectDecoded(fact, "src/file", "single");
    expect(fact.isRelative).toBe(true);
  });

  it("decodes double-quoted literal paths", () => {
    const fact = classify('"src/file"');
    expectDecoded(fact, "src/file", "double");
  });

  it('decodes mixed quoted/unquoted concatenation such as "docs"/file', () => {
    const fact = classify('"src"/file');
    expectDecoded(fact, "src/file", "double");
  });

  it("records mixed single+double quoting", () => {
    const fact = classify("'a'/\"b\"");
    expectDecoded(fact, "a/b", "mixed");
  });

  it("treats a quoted tilde as a literal character, not home expansion", () => {
    const fact = classify('"~/x"');
    expectDecoded(fact, "~/x", "double");
    expect(fact.isRelative).toBe(true);
    expect(fact.isAbsolute).toBe(false);
  });

  it("decodes a quoted absolute path and still classifies by scope", () => {
    const fact = classify('"/etc/passwd"');
    expectDecoded(fact, "/etc/passwd", "double");
    expect(fact.scope).toBe("system");
    expect(fact.isAbsolute).toBe(true);
  });

  it("decodes backslash escapes in double quotes", () => {
    const fact = classify('"a\\"b"');
    expectDecoded(fact, 'a"b', "double");
  });
});

describe("classifyBashPathFact tilde expansion", () => {
  it("expands a bare `~` to the home directory and classifies as home", () => {
    const fact = classify("~");
    expectConcrete(fact, "home");
    expect(fact.absolutePath).toBe("/home/user");
    expect(fact.isAbsolute).toBe(true);
    expect(fact.quote).toBe("none");
  });

  it("expands `~/...` to the home directory", () => {
    const fact = classify("~/x");
    expectConcrete(fact, "home");
    expect(fact.absolutePath).toBe("/home/user/x");
    expect(fact.isAbsolute).toBe(true);
  });

  it("classifies a default safe-home tilde path as safe-home", () => {
    const fact = classify("~/dev/foo.ts");
    expectConcrete(fact, "safe-home");
    expect(fact.absolutePath).toBe("/home/user/dev/foo.ts");
  });

  it("classifies `~user` as unknown (another user's home is not portable)", () => {
    const fact = classify("~user/x");
    expectUnknown(fact, "unsupported-shell-literal", true);
  });

  it("classifies `~+` and `~-` as unknown (cwd-stack expansion)", () => {
    expectUnknown(classify("~+"), "unsupported-shell-literal", true);
    expectUnknown(classify("~-"), "unsupported-shell-literal", true);
  });

  it("classifies `~` as unknown when no home directory is configured", () => {
    const context = makeContextWithoutHome();
    expectUnknown(
      classify("~", { context }),
      "unsupported-shell-literal",
      false,
    );
    expectUnknown(
      classify("~/x", { context }),
      "unsupported-shell-literal",
      false,
    );
  });
});

describe("classifyBashPathFact dynamic and unknown literal forms", () => {
  it("classifies variable and command substitution as dynamic-expansion", () => {
    expectUnknown(classify("$VAR"), "dynamic-expansion", true);
    expectUnknown(classify("$" + "{HOME}/x"), "dynamic-expansion", true);
    expectUnknown(classify("$(cmd)"), "dynamic-expansion", true);
    expectUnknown(classify("`cmd`"), "dynamic-expansion", true);
  });

  it("classifies process substitution as dynamic-expansion", () => {
    expectUnknown(classify("<(cmd)"), "dynamic-expansion", true);
    expectUnknown(classify(">(cmd)"), "dynamic-expansion", true);
  });

  it("classifies expansion inside double quotes as dynamic-expansion", () => {
    expectUnknown(classify('"$VAR"'), "dynamic-expansion", true);
  });

  it("classifies globs as glob-expansion", () => {
    expectUnknown(classify("a*b"), "glob-expansion", true);
    expectUnknown(classify("a?b"), "glob-expansion", true);
    expectUnknown(classify("file[abc]"), "glob-expansion", true);
  });

  it("does not treat a quoted glob character as a glob", () => {
    const fact = classify("'re*'");
    expectConcrete(fact, "writable-project");
    expect(fact.literal).toBe("re*");
  });

  it("classifies brace expansion as brace-expansion", () => {
    expectUnknown(classify("{a,b}"), "brace-expansion", true);
    expectUnknown(classify("{1..5}"), "brace-expansion", true);
    expectUnknown(classify("file{a,b}"), "brace-expansion", true);
  });

  it("does not treat a brace without comma/range as brace expansion", () => {
    const fact = classify("{foo}");
    expectConcrete(fact, "writable-project");
    expect(fact.literal).toBe("{foo}");
  });

  it("classifies unclosed quotes as unsupported-shell-literal", () => {
    expectUnknown(classify('"foo'), "unsupported-shell-literal", false);
    expectUnknown(classify("'foo"), "unsupported-shell-literal", false);
  });

  it("classifies a trailing backslash as unsupported-shell-literal", () => {
    expectUnknown(classify("foo\\"), "unsupported-shell-literal", false);
  });

  it("classifies a NUL byte as unsupported-shell-literal", () => {
    expectUnknown(classify("foo\0bar"), "unsupported-shell-literal", false);
  });

  it("classifies a decoded empty path (e.g. empty quotes) as unsupported", () => {
    expectUnknown(classify('""'), "unsupported-shell-literal", false);
    expectUnknown(classify("''"), "unsupported-shell-literal", false);
  });
});

describe("classifyBashPathFact totality", () => {
  const malformedRaws = [
    "",
    "}",
    "]",
    ")",
    ";;;",
    "<<<",
    "\n\n",
    "*",
    "?",
    "[",
    "{",
    "~",
    "$",
    "`",
    "${",
    "$(",
    "{a,}",
    "{{",
    "}}",
    '"',
    "'",
    "\\",
    "$" + "{UNSET_VAR:-/etc/x}",
    "x".repeat(10_000),
    "a/b/c/../../../..",
  ];

  for (const raw of malformedRaws) {
    it(`never throws for raw ${JSON.stringify(raw.slice(0, 32))}`, () => {
      const fact = classify(raw);
      expect(fact).toBeDefined();
      expect(fact.normalization).toBe("lexical");
      expect(fact.raw).toBe(raw);
      expect(fact.source).toEqual({ start: 0, end: raw.length });
      expect([
        "writable-project",
        "project",
        "temp",
        "home",
        "safe-home",
        "sensitive-home",
        "system",
        "outside",
        "denied",
        "unknown",
      ]).toContain(fact.scope);
      expect(fact.matchedScopes[0]).toBe(fact.scope);
    });
  }
});

describe("classifyBashPathFact passthrough fields", () => {
  it("echoes usage, access, program, stageIndex, and source onto the fact", () => {
    const fact = classify("src/file", {
      usage: "redirect-target",
      access: "read",
      program: "cat",
      stageIndex: 2,
      source: { start: 7, end: 15 },
    });
    expect(fact.usage).toBe("redirect-target");
    expect(fact.access).toBe("read");
    expect(fact.program).toBe("cat");
    expect(fact.stageIndex).toBe(2);
    expect(fact.source).toEqual({ start: 7, end: 15 });
    expect(fact.id).toBe("path:redirect-target:2:7:15");
  });

  it("omits program and stageIndex when not provided", () => {
    const fact = classify("src/file");
    expect(fact.program).toBeUndefined();
    expect(fact.stageIndex).toBeUndefined();
    expect(fact.id).toBe("path:argument:cwd:0:8");
  });
});

describe("defaultSystemPathPrefixes", () => {
  it("returns the unix high-risk roots on linux", () => {
    setPlatform("linux");
    expect(defaultSystemPathPrefixes()).toEqual([
      "/etc",
      "/usr",
      "/bin",
      "/sbin",
      "/var",
      "/dev",
      "/proc",
      "/sys",
      "/boot",
      "/lib",
      "/lib64",
      "/opt",
    ]);
  });

  it("excludes /tmp so the OS temp directory is not treated as system", () => {
    setPlatform("linux");
    expect(defaultSystemPathPrefixes()).not.toContain("/tmp");
  });
});

describe("deriveBashPathFacts / attachBashPathFacts scaffolding", () => {
  it("resolves effectiveCwd from a concrete cwd-prefix and emits a cwd-prefix fact", async () => {
    const shape = await analyzeBashCommand("cd repo && touch file");
    if (shape.kind !== "bash") {
      throw new Error("expected bash shape");
    }
    expect(shape.cwdPrefix).toBe("repo");

    const facts = deriveBashPathFacts(shape, makeContext());

    expect(facts.baseCwd).toBe("/home/user/proj");
    expect(facts.effectiveCwd).toBe("/home/user/proj/repo");
    expect(facts.cwdPrefix?.usage).toBe("cwd-prefix");
    expect(facts.cwdPrefix?.raw).toBe("repo");
    expect(facts.cwdPrefix?.scope).toBe("writable-project");
    expect(facts.cwdPrefix?.access).toBe("cwd");
    expect(facts.cwdPrefix?.program).toBe("cd");
    // Unit 2 extraction: the `touch file` operand is now classified against the
    // resolved effective cwd, so the facts array carries the cwd-prefix fact
    // plus the resolved operand fact (no longer just the cwd-prefix fact).
    expect(facts.facts).toHaveLength(2);
    expect(facts.facts[1]).toMatchObject({
      usage: "argument",
      access: "write",
      raw: "file",
      program: "touch",
      scope: "writable-project",
    });
    expect(facts.facts[1]?.absolutePath).toBe("/home/user/proj/repo/file");
    expect(facts.hasUnknown).toBe(false);
    expect(facts.hasDenied).toBe(false);
  });

  it("keeps effectiveCwd at baseCwd when there is no cwd-prefix", async () => {
    const shape = await analyzeBashCommand("touch file");
    if (shape.kind !== "bash") {
      throw new Error("expected bash shape");
    }
    const facts = deriveBashPathFacts(shape, makeContext());
    expect(facts.baseCwd).toBe("/home/user/proj");
    expect(facts.effectiveCwd).toBe("/home/user/proj");
    expect(facts.cwdPrefix).toBeUndefined();
    // Unit 2 extraction: the `touch file` operand is now a write fact resolved
    // against the base cwd (no cwd-prefix to shift it).
    expect(facts.facts).toEqual([
      expect.objectContaining({
        usage: "argument",
        access: "write",
        raw: "file",
        scope: "writable-project",
      }),
    ]);
    expect(facts.facts[0]?.absolutePath).toBe("/home/user/proj/file");
    expect(facts.hasUnknown).toBe(false);
  });

  it("keeps effectiveCwd at baseCwd when the cwd-prefix is a glob (unknown)", async () => {
    const shape = await analyzeBashCommand("cd re* && echo hi");
    if (shape.kind !== "bash") {
      throw new Error("expected bash shape");
    }
    // `cd re*` only lifts when tree-sitter yields a single word argument;
    // otherwise cwdPrefix is undefined and the unsupported-cwd diagnostic is
    // already on the shape. Either way, derivation must stay total.
    const facts = deriveBashPathFacts(shape, makeContext());
    expect(facts.baseCwd).toBe("/home/user/proj");
    expect(facts.effectiveCwd).toBe("/home/user/proj");
  });

  it("attachBashPathFacts attaches pathFacts to a bash shape and returns a copy", async () => {
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
    // Original shape is not mutated.
    expect(shape.pathFacts).toBeUndefined();
  });

  it("attachBashPathFacts returns non-bash shapes unchanged", () => {
    const unknown = {
      kind: "unknown" as const,
      toolName: "read",
      rawInput: { path: "README.md" },
      diagnostics: [],
    };
    expect(attachBashPathFacts(unknown, makeContext())).toBe(unknown);
  });
});

describe("derivePiBuiltinToolPathFacts / enrichToolShapeWithPathFacts for mutations", () => {
  it("keeps read-tool access unchanged while marking edit as write and write as create", () => {
    const readShape = analyzeBuiltinTool("read", { path: "README.md" });
    const editShape = analyzeMutationTool("edit", {
      path: "src/file.ts",
      edits: [{ oldText: "before", newText: "after" }],
    });
    const writeShape = analyzeMutationTool("write", {
      path: "src/new.ts",
      content: "body",
    });

    expect(
      derivePiBuiltinToolPathFacts(readShape, makeContext()).facts[0]?.access,
    ).toBe("read");
    expect(
      derivePiBuiltinToolPathFacts(editShape, makeContext()).facts[0]?.access,
    ).toBe("write");
    expect(
      derivePiBuiltinToolPathFacts(writeShape, makeContext()).facts[0]?.access,
    ).toBe("create");
  });

  it("does not synthesize implicit-cwd facts for pathless file-mutation shapes", () => {
    const shape = analyzeMutationTool("edit", {
      oldText: "before",
      newText: "after",
    });

    const facts = derivePiBuiltinToolPathFacts(shape, makeContext());

    expect(facts.facts).toEqual([]);
  });

  it("keeps state-mutating Pi tools out of file-mutation trust-boundary enrichment", () => {
    const stateMutation = enrichPiTool(
      analyzeExtensionTool("todo", {
        action: "list",
      }),
    );

    expect(stateMutation.operation).toBe("mutation");
    expect(stateMutation.mutationFacts).toBeUndefined();
    expect(stateMutation.trustBoundary).toBeUndefined();
    expect(stateMutation.pathFacts?.facts).toEqual([
      expect.objectContaining({
        raw: ".",
        usage: "implicit-cwd",
        access: "read",
      }),
    ]);
  });

  it("attaches routine and sensitive trust-boundary classifications to enriched mutations", () => {
    const routine = enrichPiTool(
      analyzeMutationTool("edit", {
        path: "src/file.ts",
        edits: [{ oldText: "before", newText: "after" }],
      }),
    );
    const projectOverlay = enrichPiTool(
      analyzeMutationTool("write", {
        path: "AGENTS.md",
        content: "instructions",
      }),
    );
    const packageScript = enrichPiTool(
      analyzeMutationTool("edit", {
        path: "package.json",
        oldText: "{}",
        newText: '{"scripts":{}}',
      }),
    );

    expect(routine.kind).toBe("pi-tool");
    expect(routine.trustBoundary).toEqual({ kind: "none" });
    expect(routine.pathFacts?.facts[0]).toMatchObject({
      access: "write",
      scope: "writable-project",
    });
    expect(projectOverlay.trustBoundary?.kind).toBe("project-overlay");
    expect(projectOverlay.pathFacts?.facts[0]?.access).toBe("create");
    expect(packageScript.trustBoundary?.kind).toBe("package-script");
  });

  it("classifies dynamic mutation targets as unknown without a concrete absolute path", () => {
    const enriched = enrichPiTool(
      analyzeMutationTool("edit", {
        path: "$TARGET",
        oldText: "before",
        newText: "after",
      }),
    );

    expect(enriched.kind).toBe("pi-tool");
    expect(enriched.pathFacts?.facts[0]).toMatchObject({
      access: "write",
      scope: "unknown",
      unknownReason: "dynamic-expansion",
    });
    expect(enriched.pathFacts?.facts[0]?.absolutePath).toBeUndefined();
    expect(enriched.trustBoundary?.kind).toBe("unknown");
  });

  it("keeps malformed mutation diagnostics fail-closed without inventing a target boundary", () => {
    const pathless = enrichPiTool(analyzeMutationTool("write", {}));
    const concreteMalformed = enrichPiTool(
      analyzeMutationTool("write", { path: "src/file.ts" }),
    );

    expect(pathless.kind).toBe("pi-tool");
    expect(pathless.pathFacts?.facts).toEqual([]);
    expect(pathless.trustBoundary).toBeUndefined();
    expect(pathless.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "pi-tool:malformed-mutation-input",
          severity: "error",
        }),
      ]),
    );

    expect(concreteMalformed.pathFacts?.facts[0]).toMatchObject({
      access: "create",
      scope: "writable-project",
    });
    expect(concreteMalformed.trustBoundary).toEqual({ kind: "none" });
    expect(concreteMalformed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "pi-tool:malformed-mutation-input",
          severity: "error",
        }),
      ]),
    );
  });
});

function analyzeBuiltinTool(
  toolName: string,
  input: unknown,
): PiBuiltinToolShape {
  const spec = SUPPORTED_PI_BUILTIN_TOOL_SPECS.find(
    (candidate) => candidate.toolName === toolName,
  );
  if (spec === undefined) {
    throw new Error(`unsupported builtin test tool ${toolName}`);
  }
  return analyzePiBuiltinTool(spec, input);
}

function analyzeMutationTool(
  toolName: "edit" | "write",
  input: unknown,
): PiBuiltinToolShape {
  const spec = SUPPORTED_PI_MUTATION_TOOL_SPECS.find(
    (candidate) => candidate.toolName === toolName,
  );
  if (spec === undefined) {
    throw new Error(`unsupported mutation test tool ${toolName}`);
  }
  return analyzePiBuiltinTool(spec, input);
}

function analyzeExtensionTool(
  toolName: string,
  input: unknown,
): PiBuiltinToolShape {
  const spec = SUPPORTED_PI_EXTENSION_TOOL_SPECS.find(
    (candidate) => candidate.toolName === toolName,
  );
  if (spec === undefined) {
    throw new Error(`unsupported extension test tool ${toolName}`);
  }
  return analyzePiBuiltinTool(spec, input);
}

function enrichPiTool(shape: PiBuiltinToolShape): PiBuiltinToolShape {
  const enriched = enrichToolShapeWithPathFacts(shape, makeContext());
  if (enriched.kind !== "pi-tool") {
    throw new Error("expected pi-tool shape");
  }
  return enriched;
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}
