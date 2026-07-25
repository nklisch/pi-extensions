import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedProjectScope } from "../../src/config/loader.ts";
import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import {
  type BashPathFactContext,
  defaultSystemPathPrefixes,
  deriveBashPathFacts,
  enrichToolShapeWithPathFacts,
} from "../../src/parse/native-path-facts.ts";
import {
  analyzePiBuiltinTool,
  SUPPORTED_PI_MUTATION_TOOL_SPECS,
} from "../../src/parse/native-tool.ts";
import type {
  BashPathFact,
  PathAccess,
  PathScope,
  PathUnknownReason,
  PathUsageKind,
  PiBuiltinToolShape,
  ToolPathFact,
} from "../../src/parse/shape.ts";

const ORIGINAL_PLATFORM = process.platform;

beforeEach(() => {
  setPlatform("linux");
});
afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
});

/**
 * Compact safety-matrix fixtures for the path-facts layer. These lock the
 * scope/usage/access classification that downstream path matchers and
 * constructive-pack cleanup will consume as data, so behavior changes show up
 * as fixture drift rather than silent policy shifts.
 *
 * The scope mirrors the classification/extraction tests: cwd `/home/user/proj`
 * is a root + writable (so paths under it are `writable-project`),
 * `/home/user/readonly-area` is a non-writable root (exercises the `project`
 * scope), `/var/tmp` + `/tmp/os-tmp` are configured temp, and
 * `/home/user/proj/secrets` + `/opt/secret` are denied. Facts are derived with a
 * full `BashPathFactContext` (including `homeDirectory`) so tilde/home cases
 * classify realistically. The runtime enrichment seam is covered separately in
 * handler/matcher tests.
 */
interface PathFactsFixture {
  readonly label: string;
  readonly command: string;
  readonly cwd: string;
  readonly projectScope: ResolvedProjectScope;
  readonly homeDirectory?: string;
  readonly expectedFacts: readonly ExpectedFact[];
}

interface ExpectedFact {
  readonly usage: PathUsageKind;
  readonly scope: PathScope;
  readonly access?: PathAccess;
  readonly program?: string;
  readonly absolutePath?: string;
  readonly unknownReason?: PathUnknownReason;
  readonly hasParentTraversal?: boolean;
  readonly quote?: BashPathFact["quote"];
  readonly dynamic?: boolean;
}

const PROJECT_CWD = "/home/user/proj";
const DEFAULT_HOME = "/home/user";

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

const PROJECT_SCOPE = makeScope();

function makeContext(fixture: PathFactsFixture): BashPathFactContext {
  return {
    cwd: fixture.cwd,
    projectScope: fixture.projectScope,
    homeDirectory: fixture.homeDirectory ?? DEFAULT_HOME,
    systemPathPrefixes: defaultSystemPathPrefixes(),
  };
}

/**
 * Assert the produced facts match `expectedFacts` in count, order, and the
 * specified fields. Omitted `ExpectedFact` fields are not asserted (subset
 * semantics) except that `scope: "unknown"` facts additionally must carry no
 * `absolutePath`/`literal` — locking the fail-closed contract that unknowns
 * never look like concrete paths.
 */
function expectFacts(
  facts: readonly BashPathFact[],
  expected: readonly ExpectedFact[],
): void {
  expect(facts).toHaveLength(expected.length);
  facts.forEach((fact, index) => {
    const expectedFact = expected[index];
    if (expectedFact === undefined) {
      throw new Error(`no expected fact at index ${index}`);
    }
    const partial: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(expectedFact)) {
      if (value !== undefined) {
        partial[key] = value;
      }
    }
    expect(fact).toEqual(expect.objectContaining(partial));
    if (expectedFact.scope === "unknown") {
      // Unknown facts must never present a decoded literal or resolved path.
      expect(fact.absolutePath).toBeUndefined();
      expect(fact.literal).toBeUndefined();
    }
  });
}

const FIXTURES: readonly PathFactsFixture[] = [
  {
    label: "writable-project relative operand",
    command: "touch file",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "writable-project",
        absolutePath: "/home/user/proj/file",
      },
    ],
  },
  {
    label: "non-writable project root (project scope)",
    command: "mkdir /home/user/readonly-area/sub",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "create",
        program: "mkdir",
        scope: "project",
        absolutePath: "/home/user/readonly-area/sub",
      },
    ],
  },
  {
    label: "configured temp path",
    command: "touch /var/tmp/note",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "temp",
        absolutePath: "/var/tmp/note",
      },
    ],
  },
  {
    label: "OS temp path",
    command: "touch /tmp/os-tmp/note",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "temp",
        absolutePath: "/tmp/os-tmp/note",
      },
    ],
  },
  {
    label: "implicit temp from bare mktemp",
    command: "mktemp",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "implicit-temp",
        access: "temp",
        program: "mktemp",
        scope: "temp",
      },
    ],
  },
  {
    label: "home path (outside project, under home)",
    command: "touch /home/user/other",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "home",
        absolutePath: "/home/user/other",
      },
    ],
  },
  {
    label: "safe-home path (outside project, under configured safe home)",
    command: "touch /home/user/dev/foo.ts",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "safe-home",
        absolutePath: "/home/user/dev/foo.ts",
      },
    ],
  },
  {
    label: "sensitive-home path beats configured safe home",
    command: "touch /home/user/.ssh/config",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "sensitive-home",
        absolutePath: "/home/user/.ssh/config",
      },
    ],
  },
  {
    label: "outside-project path",
    command: "touch /outside/random",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "outside",
        absolutePath: "/outside/random",
      },
    ],
  },
  {
    label: "system path",
    command: "touch /etc/passwd",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "system",
        absolutePath: "/etc/passwd",
      },
    ],
  },
  {
    label: "denied precedence over system",
    command: "touch /opt/secret/x",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "denied",
        absolutePath: "/opt/secret/x",
      },
    ],
  },
  {
    label: "denied precedence over writable-project/project/home",
    command: "touch /home/user/proj/secrets/key",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "denied",
        absolutePath: "/home/user/proj/secrets/key",
      },
    ],
  },
  {
    label: "parent traversal escaping to home",
    command: "touch ../sibling",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "home",
        absolutePath: "/home/user/sibling",
        hasParentTraversal: true,
      },
    ],
  },
  {
    label: "parent traversal that stays in project scope",
    command: "touch src/../file",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "writable-project",
        absolutePath: "/home/user/proj/file",
        hasParentTraversal: true,
      },
    ],
  },
  {
    label: "supported cd-prefix shifts effective cwd",
    command: "cd repo && touch file",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "cwd-prefix",
        access: "cwd",
        program: "cd",
        scope: "writable-project",
        absolutePath: "/home/user/proj/repo",
      },
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "writable-project",
        absolutePath: "/home/user/proj/repo/file",
      },
    ],
  },
  {
    label: "cd-prefix with parent traversal escapes effective cwd",
    command: "cd .. && touch file",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "cwd-prefix",
        access: "cwd",
        program: "cd",
        scope: "home",
        absolutePath: "/home/user",
        hasParentTraversal: true,
      },
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "home",
        absolutePath: "/home/user/file",
      },
    ],
  },
  {
    label: "unsupported multi-arg cd fails closed for later operands",
    command: "cd a b && touch file",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "unknown",
        unknownReason: "unresolved-cwd-prefix",
        dynamic: false,
      },
    ],
  },
  {
    label: "dynamic cwd-prefix fails closed for later operands",
    command: 'cd "$DIR" && touch file',
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "cwd-prefix",
        access: "cwd",
        program: "cd",
        scope: "unknown",
        unknownReason: "dynamic-expansion",
        dynamic: true,
      },
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "unknown",
        unknownReason: "unresolved-cwd-prefix",
        dynamic: false,
      },
    ],
  },
  {
    label: "single-quoted literal operand",
    command: "touch 'src/file'",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "writable-project",
        absolutePath: "/home/user/proj/src/file",
        quote: "single",
      },
    ],
  },
  {
    label: "double-quoted literal operand",
    command: 'touch "src/file"',
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "writable-project",
        absolutePath: "/home/user/proj/src/file",
        quote: "double",
      },
    ],
  },
  {
    label: "mixed single+double quoted literal operand",
    command: "touch 'a'/\"b\"",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "writable-project",
        absolutePath: "/home/user/proj/a/b",
        quote: "mixed",
      },
    ],
  },
  {
    label: "stdout redirect target",
    command: "echo hi > out.txt",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "redirect-target",
        access: "write",
        program: "echo",
        scope: "writable-project",
        absolutePath: "/home/user/proj/out.txt",
      },
    ],
  },
  {
    label: "stderr redirect target",
    command: "cmd 2> err.log",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "redirect-target",
        access: "write",
        program: "cmd",
        scope: "writable-project",
        absolutePath: "/home/user/proj/err.log",
      },
    ],
  },
  {
    label: "stdin redirect target",
    command: "cat < input.txt",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "redirect-target",
        access: "read",
        program: "cat",
        scope: "writable-project",
        absolutePath: "/home/user/proj/input.txt",
      },
    ],
  },
  {
    label: "command substitution operand is unknown",
    command: "mkdir $(pwd)",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "create",
        program: "mkdir",
        scope: "unknown",
        unknownReason: "dynamic-expansion",
        dynamic: true,
      },
    ],
  },
  {
    label: "variable expansion operand is unknown",
    command: "touch $FILE",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "unknown",
        unknownReason: "dynamic-expansion",
        dynamic: true,
      },
    ],
  },
  {
    label: "glob operand is unknown",
    command: "touch re*",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "unknown",
        unknownReason: "glob-expansion",
        dynamic: true,
      },
    ],
  },
  {
    label: "brace expansion operand is unknown",
    command: "touch {a,b}",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "unknown",
        unknownReason: "brace-expansion",
        dynamic: true,
      },
    ],
  },
  {
    label: "~user operand is unknown",
    command: "touch ~root/x",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        program: "touch",
        scope: "unknown",
        unknownReason: "unsupported-shell-literal",
        dynamic: true,
      },
    ],
  },
  {
    label: "variable-expanded redirect target is unknown",
    command: "echo hi > $OUT",
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedFacts: [
      {
        usage: "redirect-target",
        access: "write",
        program: "echo",
        scope: "unknown",
        unknownReason: "dynamic-expansion",
        dynamic: true,
      },
    ],
  },
];

interface PiMutationPathFactsFixture {
  readonly label: string;
  readonly toolName: "edit" | "write";
  readonly input: unknown;
  readonly cwd: string;
  readonly projectScope: ResolvedProjectScope;
  readonly homeDirectory?: string;
  readonly expectedFacts: readonly ExpectedToolFact[];
  readonly expectedTrustBoundary: string;
}

interface ExpectedToolFact {
  readonly usage: ToolPathFact["usage"];
  readonly access: ToolPathFact["access"];
  readonly scope: PathScope;
  readonly absolutePath?: string;
  readonly unknownReason?: PathUnknownReason;
  readonly dynamic?: boolean;
}

function expectToolFacts(
  facts: readonly ToolPathFact[],
  expected: readonly ExpectedToolFact[],
): void {
  expect(facts).toHaveLength(expected.length);
  facts.forEach((fact, index) => {
    const expectedFact = expected[index];
    if (expectedFact === undefined) {
      throw new Error(`no expected tool fact at index ${index}`);
    }
    expect(fact).toEqual(expect.objectContaining(expectedFact));
    if (expectedFact.scope === "unknown") {
      expect(fact.absolutePath).toBeUndefined();
      expect(fact.literal).toBeUndefined();
    }
  });
}

const PI_MUTATION_FIXTURES: readonly PiMutationPathFactsFixture[] = [
  {
    label: "edit routine project file is a write with no trust boundary",
    toolName: "edit",
    input: { path: "src/file.ts", oldText: "before", newText: "after" },
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedTrustBoundary: "none",
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        scope: "writable-project",
        absolutePath: "/home/user/proj/src/file.ts",
      },
    ],
  },
  {
    label: "write to project overlay is a create at a sensitive boundary",
    toolName: "write",
    input: { path: "AGENTS.md", content: "instructions" },
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedTrustBoundary: "project-overlay",
    expectedFacts: [
      {
        usage: "argument",
        access: "create",
        scope: "writable-project",
        absolutePath: "/home/user/proj/AGENTS.md",
      },
    ],
  },
  {
    label: "dynamic edit target stays unknown and fail-closed",
    toolName: "edit",
    input: { path: "$TARGET", oldText: "before", newText: "after" },
    cwd: PROJECT_CWD,
    projectScope: PROJECT_SCOPE,
    expectedTrustBoundary: "unknown",
    expectedFacts: [
      {
        usage: "argument",
        access: "write",
        scope: "unknown",
        unknownReason: "dynamic-expansion",
        dynamic: true,
      },
    ],
  },
];

describe("path-facts fixtures (safety matrix)", () => {
  it.each<PathFactsFixture>(FIXTURES)("$label", async (fixture) => {
    const shape = await analyzeBashCommand(fixture.command);
    if (shape.kind !== "bash") {
      throw new Error(`expected bash shape for: ${fixture.command}`);
    }
    const facts = deriveBashPathFacts(shape, makeContext(fixture));
    expectFacts(facts.facts, fixture.expectedFacts);
  });
});

describe("pi mutation path-facts fixtures (safety matrix)", () => {
  it.each<PiMutationPathFactsFixture>(
    PI_MUTATION_FIXTURES,
  )("$label", (fixture) => {
    const enriched = enrichToolShapeWithPathFacts(
      analyzeMutationTool(fixture.toolName, fixture.input),
      {
        cwd: fixture.cwd,
        projectScope: fixture.projectScope,
        homeDirectory: fixture.homeDirectory ?? DEFAULT_HOME,
      },
    );
    if (enriched.kind !== "pi-tool") {
      throw new Error("expected pi-tool shape");
    }

    expect(enriched.operation).toBe("mutation");
    expectToolFacts(enriched.pathFacts?.facts ?? [], fixture.expectedFacts);
    expect(enriched.trustBoundary?.kind).toBe(fixture.expectedTrustBoundary);
  });
});

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

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}
