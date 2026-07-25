import { describe, expect, it } from "vitest";

import { analyzeBashCommand } from "../../src/parse/native-parser.ts";
import {
  attachBashPathFacts,
  enrichToolShapeWithPathFacts,
} from "../../src/parse/native-path-facts.ts";
import {
  analyzePiBuiltinTool,
  SUPPORTED_PI_BUILTIN_TOOL_SPECS,
  SUPPORTED_PI_MUTATION_TOOL_SPECS,
} from "../../src/parse/native-tool.ts";
import type {
  BashBlock,
  BashCommandShape,
  BashPipeline,
  BashStage,
  PathScope,
  PiBuiltinToolShape,
  SourceSpan,
  ToolShape,
} from "../../src/parse/shape.ts";
import type { MatcherExpr } from "../../src/policy/core.ts";
import {
  all,
  always,
  any,
  anyArgMatches,
  arg0In,
  argAt,
  argMatches,
  bodyStagesAllReadOnly,
  bodyStagesAllScopeIn,
  compileMatch,
  composition,
  compoundForm,
  diagnosticCode,
  envAssignmentNameIn,
  evalMatcher,
  flagMatches,
  flagPresent,
  inspectable,
  iteratorScopesAllIn,
  matcherSpecificity,
  mutationShape,
  mutationTool,
  mutationTrustBoundary,
  noBodyRedirectTo,
  noBodyShellWrap,
  noBodySubstitution,
  noStdoutRedirect,
  noSubstitution,
  not,
  operator,
  pathScopesAllIn,
  pathScopesNoneIn,
  pathScopesSomeIn,
  pipeline,
  program,
  redirect,
  specificity,
  stageEvery,
  stageSome,
  tool,
} from "../../src/policy/core.ts";
import { defaultResolvedProjectScope } from "../fixtures/resolved-config.ts";

const span = (start: number, end: number): SourceSpan => ({ start, end });
const ir = inspectable;

async function bash(command: string): Promise<BashCommandShape> {
  const shape = await analyzeBashCommand(command);
  expect(shape.kind).toBe("bash");
  if (shape.kind !== "bash") {
    throw new Error("expected bash shape");
  }
  return shape;
}

function piTool(
  toolName: string,
  input: unknown,
  cwd = "/repo",
): PiBuiltinToolShape {
  const spec = SUPPORTED_PI_BUILTIN_TOOL_SPECS.find(
    (candidate) => candidate.toolName === toolName,
  );
  if (spec === undefined) {
    throw new Error(`unsupported test pi tool ${toolName}`);
  }
  const enriched = enrichToolShapeWithPathFacts(
    analyzePiBuiltinTool(spec, input),
    {
      cwd,
      projectScope: {
        ...defaultResolvedProjectScope(),
        roots: ["/repo"],
        writableDirectories: ["/repo"],
        tempDirectories: ["/tmp/os-tmp"],
        deniedDirectories: ["/repo/denied"],
      },
    },
  );
  if (enriched.kind !== "pi-tool") {
    throw new Error("expected pi-tool shape");
  }
  return enriched;
}

function piMutationTool(
  toolName: "edit" | "write",
  input: unknown,
  cwd = "/repo",
): PiBuiltinToolShape {
  const spec = SUPPORTED_PI_MUTATION_TOOL_SPECS.find(
    (candidate) => candidate.toolName === toolName,
  );
  if (spec === undefined) {
    throw new Error(`unsupported test mutation tool ${toolName}`);
  }
  const enriched = enrichToolShapeWithPathFacts(
    analyzePiBuiltinTool(spec, input),
    {
      cwd,
      projectScope: {
        ...defaultResolvedProjectScope(),
        roots: ["/repo"],
        writableDirectories: ["/repo"],
        tempDirectories: ["/tmp/os-tmp"],
        deniedDirectories: ["/repo/denied"],
      },
    },
  );
  if (enriched.kind !== "pi-tool") {
    throw new Error("expected pi-tool shape");
  }
  return enriched;
}

function unknownShape(toolName = "file"): ToolShape {
  return {
    kind: "unknown",
    toolName,
    rawInput: { path: "README.md" },
    diagnostics: [],
  };
}

function nonCommandShape(
  stage: Exclude<BashStage, { readonly kind: "command" }>,
): BashCommandShape {
  const pipe: BashPipeline = {
    stages: [stage],
    pipeTargets: [],
    span: stage.span,
  };
  const block: BashBlock = { pipeline: pipe, span: stage.span };

  return {
    kind: "bash",
    rawCommand: "unsupported",
    blocks: [block],
    stages: [stage],
    diagnostics: [],
  };
}

function unsupportedShapes(): readonly BashCommandShape[] {
  return [
    nonCommandShape({ kind: "subshell", span: span(0, 9) }),
    nonCommandShape({
      kind: "control-flow",
      construct: "if",
      span: span(0, 20),
    }),
    nonCommandShape({
      kind: "unsupported",
      reason: "mystery",
      span: span(0, 7),
    }),
  ];
}

describe("matcher constructors", () => {
  it("return plain inspectable MatcherExpr data", () => {
    expect(always()).toEqual({ kind: "always" });
    expect(tool("bash")).toEqual({ kind: "tool", tool: "bash" });
    expect(program("git")).toEqual({ kind: "program", name: "git" });
    expect(arg0In(["status", "log"])).toEqual({
      kind: "arg0In",
      values: ["status", "log"],
    });
    expect(argMatches({ index: 0, pattern: "[A-Za-z]+" })).toEqual({
      kind: "argMatches",
      index: 0,
      pattern: "[A-Za-z]+",
    });
    expect(anyArgMatches("^of=/dev/")).toEqual({
      kind: "anyArgMatches",
      pattern: "^of=/dev/",
    });
    expect(
      flagMatches({ names: ["replace"], prefixes: ["pre"], shortChars: ["r"] }),
    ).toEqual({
      kind: "flagMatches",
      names: ["replace"],
      prefixes: ["pre"],
      shortChars: ["r"],
    });
    expect(
      envAssignmentNameIn({
        names: ["LD_PRELOAD"],
        prefixes: ["DYLD_"],
        caseInsensitivePrefixes: ["npm_config_"],
      }),
    ).toEqual({
      kind: "envAssignmentNameIn",
      names: ["LD_PRELOAD"],
      prefixes: ["DYLD_"],
      caseInsensitivePrefixes: ["npm_config_"],
    });
    expect(all([program("git"), noSubstitution()])).toEqual({
      kind: "all",
      of: [{ kind: "program", name: "git" }, { kind: "noSubstitution" }],
    });
    expect(mutationTool({ tools: ["edit", "write"] })).toEqual({
      kind: "mutationTool",
      tools: ["edit", "write"],
    });
    expect(mutationShape({ shape: "well-formed" })).toEqual({
      kind: "mutationShape",
      shape: "well-formed",
    });
    expect(mutationTrustBoundary({ in: ["none"] })).toEqual({
      kind: "mutationTrustBoundary",
      in: ["none"],
    });
    expect(compoundForm("for")).toEqual({
      kind: "compoundForm",
      form: "for",
    });
    expect(bodyStagesAllReadOnly()).toEqual({
      kind: "bodyStagesAllReadOnly",
    });
    expect(
      bodyStagesAllScopeIn({ scopes: ["project", "writable-project"] }),
    ).toEqual({
      kind: "bodyStagesAllScopeIn",
      scopes: ["project", "writable-project"],
    });
    expect(iteratorScopesAllIn({ scopes: ["project"] })).toEqual({
      kind: "iteratorScopesAllIn",
      scopes: ["project"],
    });
    expect(noBodySubstitution()).toEqual({ kind: "noBodySubstitution" });
    expect(noBodyShellWrap()).toEqual({ kind: "noBodyShellWrap" });
    expect(noBodyRedirectTo()).toEqual({ kind: "noBodyRedirectTo" });
    expect(diagnosticCode("bash:compound-body-unsupported")).toEqual({
      kind: "diagnosticCode",
      code: "bash:compound-body-unsupported",
    });
  });

  it("copies array inputs so callers cannot mutate the IR through aliases", () => {
    const values = ["status"];
    const expr = arg0In(values);
    values.push("rm");

    expect(expr).toEqual({ kind: "arg0In", values: ["status"] });

    const tools: ("edit" | "write")[] = ["edit"];
    const mutationExpr = mutationTool({ tools });
    tools.push("write");
    expect(mutationExpr).toEqual({ kind: "mutationTool", tools: ["edit"] });

    const kinds = ["none"] as const;
    const trustExpr = mutationTrustBoundary({ in: kinds });
    expect(trustExpr).toEqual({ kind: "mutationTrustBoundary", in: ["none"] });

    const scopes: PathScope[] = ["project"];
    const bodyScopeExpr = bodyStagesAllScopeIn({ scopes });
    const iteratorScopeExpr = iteratorScopesAllIn({ scopes });
    scopes.push("temp");
    expect(bodyScopeExpr).toEqual({
      kind: "bodyStagesAllScopeIn",
      scopes: ["project"],
    });
    expect(iteratorScopeExpr).toEqual({
      kind: "iteratorScopesAllIn",
      scopes: ["project"],
    });
  });
});

describe("evalMatcher structural leaves", () => {
  it("matches bash tools and non-bash unknown tool names", async () => {
    expect(evalMatcher(ir(tool("bash")), await bash("git status"))).toBe(true);
    expect(evalMatcher(ir(tool("bash")), unknownShape("bash"))).toBe(false);
    expect(evalMatcher(ir(tool("file")), unknownShape("file"))).toBe(true);
  });

  it("matches programs with implicit every-command-stage semantics", async () => {
    expect(evalMatcher(ir(program("git")), await bash("git status"))).toBe(
      true,
    );
    expect(
      evalMatcher(ir(program("git")), await bash("git status && rm -rf /")),
    ).toBe(false);
  });

  it("matches argument and flag predicates on every command stage", async () => {
    const gitShort = await bash("git status --short && git diff --short");
    const mixedArg = await bash("git status && git log");

    expect(evalMatcher(ir(arg0In(["status", "diff"])), gitShort)).toBe(true);
    expect(
      evalMatcher(ir(argMatches({ index: 0, pattern: "stat.*" })), mixedArg),
    ).toBe(false);
    expect(
      evalMatcher(
        ir(argMatches({ index: 0, pattern: "stat.*" })),
        await bash("git status"),
      ),
    ).toBe(true);
    expect(
      evalMatcher(
        ir(argMatches({ index: 1, pattern: "x" })),
        await bash("git status"),
      ),
    ).toBe(false);
    expect(evalMatcher(ir(argAt(0, "status")), mixedArg)).toBe(false);
    expect(evalMatcher(ir(flagPresent("short")), gitShort)).toBe(true);
    expect(evalMatcher(ir(flagPresent("--short")), gitShort)).toBe(true);
  });

  it("matches flags by exact name, prefix, and bundled short characters", async () => {
    expect(
      evalMatcher(
        ir(flagMatches({ names: ["replace"] })),
        await bash("rg --replace=x pattern file"),
      ),
    ).toBe(true);
    expect(
      evalMatcher(
        ir(flagMatches({ prefixes: ["pre"] })),
        await bash("rg --pre-glob='*.txt' pattern file"),
      ),
    ).toBe(true);
    expect(
      evalMatcher(
        ir(flagMatches({ shortChars: ["r"] })),
        await bash("rg -r replacement pattern file"),
      ),
    ).toBe(true);
    expect(
      evalMatcher(
        ir(flagMatches({ shortChars: ["o"] })),
        await bash("sort -uo out file"),
      ),
    ).toBe(true);
    expect(
      evalMatcher(
        ir(flagMatches({ names: ["replace"] })),
        await bash("rg pattern file"),
      ),
    ).toBe(false);
    // Nested inside a modeled compound body: the matcher must see body stages,
    // not only top-level stages (review-blocker regression, 2026-07-23).
    expect(
      evalMatcher(
        ir(flagMatches({ names: ["replace"] })),
        await bash('for f in src/*.ts; do rg --replace=x pattern "$f"; done'),
      ),
    ).toBe(true);
  });

  it("matches dangerous environment names across stages", async () => {
    const matcher = envAssignmentNameIn({
      names: ["LD_PRELOAD"],
      prefixes: ["DYLD_"],
      caseInsensitivePrefixes: ["npm_config_"],
    });
    expect(evalMatcher(ir(matcher), await bash("LD_PRELOAD=x pnpm test"))).toBe(
      true,
    );
    expect(
      evalMatcher(ir(matcher), await bash("NPM_CONFIG_REGISTRY=x npm i")),
    ).toBe(true);
    expect(
      evalMatcher(
        ir(matcher),
        await bash("FOO=1 pnpm test && CI=true cargo test"),
      ),
    ).toBe(false);
    expect(evalMatcher(ir(matcher), unknownShape())).toBe(false);
    // Nested inside a modeled compound body: a dangerous assignment in a
    // for-loop body must match, or it rides compound allow rules.
    expect(
      evalMatcher(
        ir(matcher),
        await bash(
          'for f in .work/backlog/*.md; do LD_PRELOAD=/tmp/evil.so cat "$f"; done',
        ),
      ),
    ).toBe(true);
    expect(
      evalMatcher(
        ir(matcher),
        await bash(
          'for f in .work/backlog/*.md; do env LD_PRELOAD=/tmp/evil.so cat "$f"; done',
        ),
      ),
    ).toBe(true);
  });

  it("matches any positional argument with an anchored pattern", async () => {
    expect(
      evalMatcher(
        ir(anyArgMatches("^of=/dev/.*")),
        await bash("dd of=/dev/sda"),
      ),
    ).toBe(true);
    expect(
      evalMatcher(
        ir(anyArgMatches("^of=/dev/.*")),
        await bash("dd if=/dev/sda"),
      ),
    ).toBe(false);
    expect(
      evalMatcher(
        ir(anyArgMatches("^/dev/.*")),
        await bash("mkfs -t ext4 /dev/sda"),
      ),
    ).toBe(true);
    expect(evalMatcher(ir(anyArgMatches("^of=/dev/.*")), unknownShape())).toBe(
      false,
    );
  });

  it("matches substitution and stdout redirect safety predicates", async () => {
    expect(evalMatcher(ir(noSubstitution()), await bash("git status"))).toBe(
      true,
    );
    expect(evalMatcher(ir(noSubstitution()), await bash("echo $(pwd)"))).toBe(
      false,
    );
    expect(
      evalMatcher(ir(noStdoutRedirect()), await bash("echo hi 2> err.txt")),
    ).toBe(true);
    expect(
      evalMatcher(ir(noStdoutRedirect()), await bash("echo hi > out.txt")),
    ).toBe(false);
  });

  it("matches redirect predicates when every command stage has a matching redirect", async () => {
    const stdoutShape = await bash("echo hi > out.txt");
    const stderrShape = await bash("echo hi 2> err.txt");

    expect(evalMatcher(ir(redirect()), stdoutShape)).toBe(true);
    expect(
      evalMatcher(
        ir(redirect({ stream: "stdout", target: "out.txt" })),
        stdoutShape,
      ),
    ).toBe(true);
    expect(evalMatcher(ir(redirect({ stream: "stdout" })), stderrShape)).toBe(
      false,
    );
  });

  it("returns false for command-stage predicates on unknown and unsupported shapes", async () => {
    const bashOnly = [
      program("git"),
      arg0In(["status"]),
      argAt(0, "status"),
      argMatches({ index: 0, pattern: "status" }),
      flagPresent("short"),
      noSubstitution(),
      noStdoutRedirect(),
      redirect(),
    ];

    for (const expr of bashOnly) {
      expect(evalMatcher(ir(expr), unknownShape())).toBe(false);
      for (const shape of unsupportedShapes()) {
        expect(evalMatcher(ir(expr), shape)).toBe(false);
      }
    }
  });
});

describe("matcher visibility of enriched path facts", () => {
  it("exposes precomputed path facts as plain shape data", async () => {
    const enriched = enrichToolShapeWithPathFacts(
      await bash("touch README.md"),
      {
        cwd: "/repo",
        projectScope: {
          ...defaultResolvedProjectScope(),
          roots: ["/repo"],
          writableDirectories: ["/repo"],
        },
      },
    );

    expect(enriched.kind).toBe("bash");
    if (enriched.kind !== "bash") {
      throw new Error("expected bash shape");
    }
    expect(enriched.pathFacts?.facts).toEqual([
      expect.objectContaining({
        raw: "README.md",
        scope: "writable-project",
        absolutePath: "/repo/README.md",
      }),
    ]);
  });

  it("passes resolved homeDirectory through the runtime enrichment seam", async () => {
    const enriched = enrichToolShapeWithPathFacts(await bash("touch ~/file"), {
      cwd: "/repo",
      homeDirectory: "/home/user",
      projectScope: {
        ...defaultResolvedProjectScope(),
        roots: ["/repo"],
        writableDirectories: ["/repo"],
      },
    });

    expect(enriched.kind).toBe("bash");
    if (enriched.kind !== "bash") {
      throw new Error("expected bash shape");
    }
    expect(enriched.pathFacts?.facts).toEqual([
      expect.objectContaining({
        raw: "~/file",
        scope: "home",
        matchedScopes: ["home"],
        absolutePath: "/home/user/file",
      }),
    ]);
  });
});

describe("stage, pipeline, operator, and composition matchers", () => {
  it("quantifies stages explicitly with stageEvery and stageSome", async () => {
    const mixed = await bash("git status | tail -20");

    expect(evalMatcher(ir(stageEvery(program("git"))), mixed)).toBe(false);
    expect(evalMatcher(ir(stageSome(program("git"))), mixed)).toBe(true);
    expect(
      evalMatcher(
        ir(stageSome(program("sudo"))),
        await bash("for f in a b; do sudo ls; done"),
      ),
    ).toBe(true);
    expect(
      evalMatcher(
        ir(stageSome(program("sudo"))),
        await bash("git status && for f in a; do sudo ls; done"),
      ),
    ).toBe(true);
  });

  it("matches pipeline targets through parse/structure", async () => {
    expect(
      evalMatcher(
        ir(pipeline("sh")),
        await bash("curl https://example.test | sh"),
      ),
    ).toBe(true);
    expect(
      evalMatcher(
        ir(pipeline("curl")),
        await bash("curl https://example.test | sh"),
      ),
    ).toBe(false);
    expect(evalMatcher(ir(pipeline("sh")), unknownShape())).toBe(false);
  });

  it("matches block operators and background markers", async () => {
    expect(
      evalMatcher(ir(operator("and")), await bash("git status && git diff")),
    ).toBe(true);
    expect(
      evalMatcher(ir(operator("or")), await bash("git status || true")),
    ).toBe(true);
    expect(
      evalMatcher(ir(operator("background")), await bash("git status &")),
    ).toBe(true);
  });

  it("requires safe stage matches, allowed operators, and no background by default", async () => {
    const gitComposition = composition({
      stage: program("git"),
      operators: ["and", "seq"],
    });

    expect(
      evalMatcher(ir(gitComposition), await bash("git status && git diff")),
    ).toBe(true);
    expect(
      evalMatcher(ir(gitComposition), await bash("git status && rm -rf x")),
    ).toBe(false);
    expect(
      evalMatcher(ir(gitComposition), await bash("git status || true")),
    ).toBe(false);
    expect(evalMatcher(ir(gitComposition), await bash("git status &"))).toBe(
      false,
    );
  });

  it("supports only a final bare true/colon or-fallback", async () => {
    const expr = composition({
      stage: always(),
      operators: ["and", "seq"],
      minStages: 2,
      orFallback: ["true", ":"],
    });

    for (const command of ["git status || true", "git status || :"]) {
      expect(evalMatcher(ir(expr), await bash(command))).toBe(true);
    }

    for (const command of [
      "git status || true && git log",
      "git status || true || true",
      "git status || true arg",
      "git status || FOO=1 true",
      "git status || true > out",
      "git status || true | wc -l",
      "git status || true &",
    ]) {
      expect(evalMatcher(ir(expr), await bash(command))).toBe(false);
    }
  });

  it("requires the configured minimum stage count", async () => {
    const expr = composition({
      stage: always(),
      operators: ["and", "seq"],
      minStages: 2,
    });

    expect(evalMatcher(ir(expr), await bash("git status"))).toBe(false);
    expect(evalMatcher(ir(expr), await bash("git status && git log"))).toBe(
      true,
    );
  });

  it("does not let orFallback change specificity", () => {
    const base = composition({ stage: program("git"), operators: ["and"] });
    const withFallback = composition({
      stage: program("git"),
      operators: ["and"],
      orFallback: ["true", ":"],
    });

    expect(specificity(withFallback)).toBe(specificity(base));
    expect(matcherSpecificity(withFallback)).toBe(matcherSpecificity(base));
  });

  it("rejects non-command stages in composition", () => {
    const expr = composition({ stage: always(), operators: ["and", "seq"] });

    for (const shape of unsupportedShapes()) {
      expect(evalMatcher(ir(expr), shape)).toBe(false);
    }
  });
});

describe("logical combinators and accessors", () => {
  it("combines expressions with all, any, and not", async () => {
    const shape = await bash("git status");

    expect(evalMatcher(ir(all([tool("bash"), program("git")])), shape)).toBe(
      true,
    );
    expect(evalMatcher(ir(any([program("rm"), program("git")])), shape)).toBe(
      true,
    );
    expect(evalMatcher(ir(not(program("rm"))), shape)).toBe(true);
  });

  it("treats empty logical constructor arrays as non-matches", async () => {
    const shape = await bash("git status");

    expect(evalMatcher(ir(all([])), shape)).toBe(false);
    expect(evalMatcher(ir(any([])), shape)).toBe(false);
  });

  it("keeps specificity advisory but monotonic for constrained combinations", () => {
    const simple = program("git");
    const constrained = all([
      program("git"),
      arg0In(["status"]),
      noSubstitution(),
    ]);

    expect(specificity(constrained)).toBeGreaterThan(specificity(simple));
    expect(specificity(any([simple, constrained]))).toBe(
      specificity(constrained),
    );
    expect(specificity(not(constrained))).toBe(0);
  });

  it("keeps advisory specificity in parity with the authoritative path-scope scoring", () => {
    const base = pathScopesAllIn({ scopes: ["project"] });
    // Path-scope outranks broad safety sentinels, matching `matcherSpecificity`.
    expect(specificity(base)).toBeGreaterThan(specificity(noSubstitution()));
    // Per-command-stage coverage adds a small bonus; `programs` only adds its
    // bonus when that guard makes the program list load-bearing.
    expect(
      specificity(
        pathScopesAllIn({ scopes: ["project"], programs: ["touch"] }),
      ),
    ).toBe(specificity(base));
    const perStage = pathScopesAllIn({
      scopes: ["project"],
      requireFacts: "per-command-stage",
    });
    expect(specificity(perStage)).toBeGreaterThan(specificity(base));
    expect(
      specificity(
        pathScopesAllIn({
          scopes: ["project"],
          programs: ["touch"],
          requireFacts: "per-command-stage",
        }),
      ),
    ).toBeGreaterThan(specificity(perStage));
  });
});

describe("mutation matcher evaluator", () => {
  it("matches well-formed edit and write mutation tools", () => {
    const editShape = piMutationTool("edit", {
      path: "src/file.ts",
      oldText: "old",
      newText: "new",
    });
    const writeShape = piMutationTool("write", {
      path: "src/file.ts",
      content: "new content",
    });

    expect(evalMatcher(ir(mutationTool({ tools: [] })), editShape)).toBe(true);
    expect(evalMatcher(ir(mutationTool({ tools: [] })), writeShape)).toBe(true);
    expect(evalMatcher(ir(mutationTool({ tools: ["edit"] })), editShape)).toBe(
      true,
    );
    expect(evalMatcher(ir(mutationTool({ tools: ["edit"] })), writeShape)).toBe(
      false,
    );
    expect(
      evalMatcher(ir(mutationShape({ shape: "well-formed" })), editShape),
    ).toBe(true);
    expect(
      evalMatcher(ir(mutationShape({ shape: "well-formed" })), writeShape),
    ).toBe(true);
  });

  it("distinguishes edit create and replace shapes without guessing write overwrite state", () => {
    const createEdit = piMutationTool("edit", {
      path: "src/file.ts",
      oldText: "",
      newText: "new",
    });
    const replaceEdit = piMutationTool("edit", {
      path: "src/file.ts",
      oldText: "old",
      newText: "new",
    });
    const absentOldTextEdit = piMutationTool("edit", {
      path: "src/file.ts",
      newText: "new",
    });
    const writeShape = piMutationTool("write", {
      path: "src/file.ts",
      content: "new content",
    });

    expect(
      evalMatcher(ir(mutationShape({ shape: "create" })), createEdit),
    ).toBe(true);
    expect(
      evalMatcher(ir(mutationShape({ shape: "create" })), absentOldTextEdit),
    ).toBe(true);
    expect(
      evalMatcher(ir(mutationShape({ shape: "replace" })), replaceEdit),
    ).toBe(true);
    expect(
      evalMatcher(ir(mutationShape({ shape: "replace" })), createEdit),
    ).toBe(false);
    expect(
      evalMatcher(ir(mutationShape({ shape: "create" })), writeShape),
    ).toBe(false);
    expect(
      evalMatcher(ir(mutationShape({ shape: "replace" })), writeShape),
    ).toBe(false);
  });

  it("matches trust-boundary classifications and fails closed when absent", () => {
    const routine = piMutationTool("write", {
      path: "src/file.ts",
      content: "new content",
    });
    const packageScript = piMutationTool("edit", {
      path: "package.json",
      oldText: "old",
      newText: "new",
    });
    const unenriched = analyzePiBuiltinTool(
      SUPPORTED_PI_MUTATION_TOOL_SPECS[0],
      {
        path: "src/file.ts",
        oldText: "old",
        newText: "new",
      },
    );

    expect(
      evalMatcher(ir(mutationTrustBoundary({ in: ["none"] })), routine),
    ).toBe(true);
    expect(
      evalMatcher(
        ir(mutationTrustBoundary({ in: ["package-script"] })),
        packageScript,
      ),
    ).toBe(true);
    expect(
      evalMatcher(ir(mutationTrustBoundary({ in: ["none"] })), packageScript),
    ).toBe(false);
    expect(
      evalMatcher(ir(mutationTrustBoundary({ in: ["none"] })), unenriched),
    ).toBe(false);
  });

  it("fails closed on missing facts, error diagnostics, and non-mutation shapes", () => {
    const malformedEdit = piMutationTool("edit", {
      path: "src/file.ts",
      oldText: "old",
    });
    const noFactsMutation: PiBuiltinToolShape = {
      kind: "pi-tool",
      toolName: "edit",
      operation: "mutation",
      rawInput: {},
      pathInputs: [],
      diagnostics: [],
    };
    const readShape = piTool("read", { path: "README.md" });

    for (const expr of [
      mutationTool({ tools: [] }),
      mutationShape({ shape: "well-formed" }),
      mutationShape({ shape: "create" }),
      mutationTrustBoundary({ in: ["none"] }),
    ]) {
      expect(evalMatcher(ir(expr), unknownShape())).toBe(false);
      expect(evalMatcher(ir(expr), readShape)).toBe(false);
      expect(evalMatcher(ir(expr), noFactsMutation)).toBe(false);
    }

    // mutationTool only proves a typed mutation-family shape with facts; the
    // well-formed refiner is what fails closed on error diagnostics.
    expect(evalMatcher(ir(mutationTool({ tools: [] })), malformedEdit)).toBe(
      true,
    );
    expect(
      evalMatcher(ir(mutationShape({ shape: "well-formed" })), malformedEdit),
    ).toBe(false);
  });
});

// --- path-scope matcher tests -------------------------------------------------

/**
 * Project scope for the constructive-baseline fixtures: `/repo` is both a root
 * and a writable directory. Temp directories are intentionally empty; bare
 * `mktemp` still produces an implicit-temp fact whose scope is `temp` by
 * definition, so it satisfies an allow listing `temp`.
 */
function enrichInRepo(
  shape: BashCommandShape,
  overrides: {
    readonly roots?: readonly string[];
    readonly writableDirectories?: readonly string[];
    readonly tempDirectories?: readonly string[];
    readonly deniedDirectories?: readonly string[];
  } = {},
): BashCommandShape {
  const enriched = enrichToolShapeWithPathFacts(shape, {
    cwd: "/repo",
    projectScope: {
      ...defaultResolvedProjectScope(),
      roots: ["/repo"],
      writableDirectories: ["/repo"],
      ...overrides,
    },
  });
  if (enriched.kind !== "bash") {
    throw new Error("expected bash shape");
  }
  return enriched;
}

/**
 * Lower-level enrichment that supplies `homeDirectory` directly. Used to
 * produce a `home`-scope fact for rejection coverage without coupling these
 * matcher tests to full runtime/config fixtures.
 */
function enrichWithHome(
  shape: BashCommandShape,
  homeDirectory: string,
): BashCommandShape {
  const enriched = attachBashPathFacts(shape, {
    cwd: "/repo",
    projectScope: {
      ...defaultResolvedProjectScope(),
      roots: ["/repo"],
      writableDirectories: ["/repo"],
    },
    homeDirectory,
  });
  if (enriched.kind !== "bash") {
    throw new Error("expected bash shape");
  }
  return enriched;
}

/** Baseline constructive matcher: project/temp scopes, one fact per command stage. */
const constructiveAllIn = () =>
  pathScopesAllIn({
    scopes: ["writable-project", "project", "temp"],
    requireFacts: "per-command-stage",
    programs: ["mkdir", "touch", "mktemp"],
  });

const compoundScopes: readonly PathScope[] = [
  "writable-project",
  "project",
  "temp",
];

const compoundAllowShape = () =>
  all([
    compoundForm("for"),
    bodyStagesAllReadOnly(),
    bodyStagesAllScopeIn({ scopes: compoundScopes }),
    iteratorScopesAllIn({ scopes: compoundScopes }),
    noBodySubstitution(),
    noBodyShellWrap(),
    noBodyRedirectTo(),
  ]);

describe("compound matcher evaluator", () => {
  it("matches a modeled safe for-loop body using body stages and enriched facts", async () => {
    const shape = enrichInRepo(
      await bash(
        "for f in .work/backlog/*.md; do echo '---' \"$f\"; sed -n '1,120p' \"$f\"; done",
      ),
    );

    expect(evalMatcher(ir(compoundForm("for")), shape)).toBe(true);
    expect(evalMatcher(ir(compoundForm("brace-group")), shape)).toBe(false);
    expect(evalMatcher(ir(bodyStagesAllReadOnly()), shape)).toBe(true);
    expect(
      evalMatcher(ir(bodyStagesAllScopeIn({ scopes: compoundScopes })), shape),
    ).toBe(true);
    expect(
      evalMatcher(ir(iteratorScopesAllIn({ scopes: compoundScopes })), shape),
    ).toBe(true);
    expect(evalMatcher(ir(noBodySubstitution()), shape)).toBe(true);
    expect(evalMatcher(ir(noBodyShellWrap()), shape)).toBe(true);
    expect(evalMatcher(ir(noBodyRedirectTo()), shape)).toBe(true);
    expect(evalMatcher(ir(compoundAllowShape()), shape)).toBe(true);
  });

  it("matches top-level brace groups and conditionals by form", async () => {
    expect(
      evalMatcher(ir(compoundForm("brace-group")), await bash("{ echo hi; }")),
    ).toBe(true);
    expect(
      evalMatcher(
        ir(compoundForm("if")),
        await bash("if git diff --quiet; then echo ok; fi"),
      ),
    ).toBe(true);
  });

  it("fails closed for non-bash, missing path facts, unsupported diagnostics, and nested forms", async () => {
    const enriched = enrichInRepo(
      await bash('for f in *.md; do cat "$f"; done'),
    );
    const unsupported = await bash("for ((i=0; i<3; i++)); do echo $i; done");
    const nested = await bash(
      "for f in a; do for g in b; do cat $g; done; done",
    );

    expect(evalMatcher(ir(compoundForm("for")), unknownShape())).toBe(false);
    expect(
      evalMatcher(
        ir(bodyStagesAllScopeIn({ scopes: compoundScopes })),
        await bash('for f in *.md; do cat "$f"; done'),
      ),
    ).toBe(false);
    expect(evalMatcher(ir(bodyStagesAllReadOnly()), unsupported)).toBe(false);
    expect(evalMatcher(ir(bodyStagesAllReadOnly()), nested)).toBe(false);
    expect(evalMatcher(ir(compoundAllowShape()), enriched)).toBe(true);
  });

  it("fails closed on destructive, substitution, shell-wrap, and redirect body stages", async () => {
    const destructive = enrichInRepo(
      await bash('for f in *.md; do rm "$f"; done'),
    );
    const substitution = enrichInRepo(
      await bash('for f in *.md; do echo "$(cat "$f")"; done'),
    );
    const shellWrap = enrichInRepo(
      await bash('for f in *.md; do sh -c "cat $1" sh "$f"; done'),
    );
    const redirect = enrichInRepo(
      await bash('for f in *.md; do cat "$f" > out; done'),
    );
    const groupRedirect = enrichInRepo(await bash("{ echo hi; } > out"));

    expect(evalMatcher(ir(bodyStagesAllReadOnly()), destructive)).toBe(false);
    expect(evalMatcher(ir(noBodySubstitution()), substitution)).toBe(false);
    expect(evalMatcher(ir(bodyStagesAllReadOnly()), substitution)).toBe(false);
    expect(evalMatcher(ir(noBodyShellWrap()), shellWrap)).toBe(false);
    expect(evalMatcher(ir(bodyStagesAllReadOnly()), shellWrap)).toBe(false);
    expect(evalMatcher(ir(noBodyRedirectTo()), redirect)).toBe(false);
    expect(evalMatcher(ir(bodyStagesAllReadOnly()), redirect)).toBe(false);
    expect(evalMatcher(ir(noBodyRedirectTo()), groupRedirect)).toBe(false);
  });

  it("fails scope and iterator predicates for out-of-scope or missing compound facts", async () => {
    const outsideBody = enrichInRepo(await bash("{ cat /etc/passwd; }"));
    const outsideIterator = enrichInRepo(
      await bash('for f in /etc/*.conf; do cat "$f"; done'),
    );
    const echoOnlyIterator = enrichInRepo(
      await bash('for f in *.md; do echo "$f"; done'),
    );

    expect(
      evalMatcher(
        ir(bodyStagesAllScopeIn({ scopes: compoundScopes })),
        outsideBody,
      ),
    ).toBe(false);
    expect(
      evalMatcher(
        ir(iteratorScopesAllIn({ scopes: compoundScopes })),
        outsideIterator,
      ),
    ).toBe(false);
    expect(
      evalMatcher(
        ir(iteratorScopesAllIn({ scopes: compoundScopes })),
        echoOnlyIterator,
      ),
    ).toBe(false);
  });

  it("matches diagnostic codes exactly", async () => {
    const shape = await bash("case x in a) echo;; esac");

    expect(
      evalMatcher(
        ir(diagnosticCode("bash:compound-feature-unsupported")),
        shape,
      ),
    ).toBe(true);
    expect(evalMatcher(ir(diagnosticCode("bash:other")), shape)).toBe(false);
    expect(evalMatcher(ir(diagnosticCode("bash:compound")), shape)).toBe(false);
  });

  it("keeps safety sentinel and compound specificity in parity with precedence", () => {
    for (const expr of [
      flagMatches({ names: ["replace"] }),
      envAssignmentNameIn({ names: ["LD_PRELOAD"] }),
      compoundForm("for"),
      bodyStagesAllReadOnly(),
      bodyStagesAllScopeIn({ scopes: compoundScopes }),
      iteratorScopesAllIn({ scopes: compoundScopes }),
      noBodySubstitution(),
      noBodyShellWrap(),
      noBodyRedirectTo(),
      diagnosticCode("bash:compound-body-unsupported"),
    ]) {
      expect(specificity(expr)).toBe(matcherSpecificity(expr));
    }
  });
});

describe("path-scope matcher constructors", () => {
  it("return plain inspectable pathScope IR with copied arrays", () => {
    expect(
      pathScopesAllIn({ scopes: ["writable-project", "project"] }),
    ).toEqual({
      kind: "pathScope",
      mode: "all-in",
      scopes: ["writable-project", "project"],
      requireFacts: "one-or-more",
    });

    const scopes: PathScope[] = ["writable-project", "project"];
    const expr = pathScopesAllIn({ scopes });
    scopes.push("temp");
    expect(expr).toEqual({
      kind: "pathScope",
      mode: "all-in",
      scopes: ["writable-project", "project"],
      requireFacts: "one-or-more",
    });

    const programs = ["touch"];
    const withPrograms = pathScopesSomeIn({
      scopes: ["temp"],
      programs,
    });
    programs.push("mkdir");
    expect(withPrograms).toEqual({
      kind: "pathScope",
      mode: "some-in",
      scopes: ["temp"],
      programs: ["touch"],
      requireFacts: "one-or-more",
    });
  });

  it("defaults all-in/some-in to one-or-more and leaves none-in without a requirement", () => {
    expect(pathScopesSomeIn({ scopes: ["unknown"] })).toEqual({
      kind: "pathScope",
      mode: "some-in",
      scopes: ["unknown"],
      requireFacts: "one-or-more",
    });
    expect(pathScopesNoneIn({ scopes: ["denied"] })).toEqual({
      kind: "pathScope",
      mode: "none-in",
      scopes: ["denied"],
    });
  });
});

describe("path-scope evaluator", () => {
  it("matches enriched project/temp touch, mkdir, and bare mktemp", async () => {
    const matcher = constructiveAllIn();

    expect(
      evalMatcher(ir(matcher), enrichInRepo(await bash("touch README.md"))),
    ).toBe(true);
    expect(
      evalMatcher(ir(matcher), enrichInRepo(await bash("mkdir -p dist"))),
    ).toBe(true);
    expect(evalMatcher(ir(matcher), enrichInRepo(await bash("mktemp")))).toBe(
      true,
    );
  });

  it("rejects missing pathFacts, non-bash, and zero-fact shapes", async () => {
    const matcher = constructiveAllIn();

    // Missing pathFacts: an unenriched bash shape cannot satisfy an allow.
    expect(evalMatcher(ir(matcher), await bash("touch README.md"))).toBe(false);
    // Non-bash unknown shape.
    expect(evalMatcher(ir(matcher), unknownShape())).toBe(false);
    // Zero path facts: bare `touch` with no operands fails per-command-stage.
    expect(evalMatcher(ir(matcher), enrichInRepo(await bash("touch")))).toBe(
      false,
    );
  });

  it("rejects unknown, home, outside, system, and denied facts", async () => {
    const matcher = constructiveAllIn();

    // Unknown: dynamic expansion.
    expect(
      evalMatcher(ir(matcher), enrichInRepo(await bash('touch "$OUT"'))),
    ).toBe(false);
    // Unknown: `~/file` stays unknown when runtime/config did not resolve home.
    expect(
      evalMatcher(ir(matcher), enrichInRepo(await bash("touch ~/file"))),
    ).toBe(false);
    // Outside project.
    expect(
      evalMatcher(ir(matcher), enrichInRepo(await bash("touch /srv/file"))),
    ).toBe(false);
    // System path.
    expect(
      evalMatcher(ir(matcher), enrichInRepo(await bash("touch /etc/foo"))),
    ).toBe(false);
    // Home scope (requires `homeDirectory` via the lower-level enricher).
    expect(
      evalMatcher(
        ir(matcher),
        enrichWithHome(await bash("touch /home/user/file"), "/home/user"),
      ),
    ).toBe(false);
    // Denied directory.
    expect(
      evalMatcher(
        ir(matcher),
        enrichInRepo(await bash("touch /repo/denied/file"), {
          deniedDirectories: ["/repo/denied"],
        }),
      ),
    ).toBe(false);
  });

  it("rejects unresolved cwd-prefix and unsafe redirect targets", async () => {
    const matcher = constructiveAllIn();

    // `cd "$X"` is dynamic, so the relative `touch file` operand fails closed as
    // an unresolved-cwd-prefix unknown rather than resolving against the base cwd.
    expect(
      evalMatcher(
        ir(matcher),
        enrichInRepo(await bash('cd "$X" && touch file')),
      ),
    ).toBe(false);
    // Unsafe stdout redirect to a system path.
    expect(
      evalMatcher(
        ir(matcher),
        enrichInRepo(await bash("touch file > /etc/out")),
      ),
    ).toBe(false);
  });

  it("matches cd repo && touch file but rejects cd /etc && touch /repo/file", async () => {
    const matcher = constructiveAllIn();

    expect(
      evalMatcher(
        ir(matcher),
        enrichInRepo(await bash("cd repo && touch file")),
      ),
    ).toBe(true);
    expect(
      evalMatcher(
        ir(matcher),
        enrichInRepo(await bash("cd /etc && touch /repo/file")),
      ),
    ).toBe(false);
  });

  it("pathScopesSomeIn matches unknown facts for review/diagnostic rules", async () => {
    const someUnknown = pathScopesSomeIn({ scopes: ["unknown"] });

    expect(
      evalMatcher(ir(someUnknown), enrichInRepo(await bash('touch "$OUT"'))),
    ).toBe(true);
    expect(
      evalMatcher(ir(someUnknown), enrichInRepo(await bash("touch ~/file"))),
    ).toBe(true);
    // A clean project fact is not unknown, so some-in unknown does not match.
    expect(
      evalMatcher(ir(someUnknown), enrichInRepo(await bash("touch README.md"))),
    ).toBe(false);
  });

  it("pathScopesNoneIn rejects listed scopes and documents empty-fact behavior", async () => {
    const noUnsafe = pathScopesNoneIn({
      scopes: ["outside", "system", "denied", "unknown"],
    });

    expect(
      evalMatcher(ir(noUnsafe), enrichInRepo(await bash("touch README.md"))),
    ).toBe(true);
    expect(
      evalMatcher(ir(noUnsafe), enrichInRepo(await bash("touch /srv/file"))),
    ).toBe(false);
    // Missing pathFacts still fails closed.
    expect(evalMatcher(ir(noUnsafe), await bash("touch README.md"))).toBe(
      false,
    );
    // Present-but-empty pathFacts satisfy none-in when no fact requirement is set.
    expect(evalMatcher(ir(noUnsafe), enrichInRepo(await bash("touch")))).toBe(
      true,
    );
  });

  it("rejects per-command-stage facts when the program guard does not cover the stage", async () => {
    const mkdirOnly = pathScopesAllIn({
      scopes: ["writable-project", "project", "temp"],
      requireFacts: "per-command-stage",
      programs: ["mkdir"],
    });

    expect(
      evalMatcher(ir(mkdirOnly), enrichInRepo(await bash("mkdir dist"))),
    ).toBe(true);
    expect(
      evalMatcher(ir(mkdirOnly), enrichInRepo(await bash("touch README.md"))),
    ).toBe(false);
  });

  it("matches project/temp-scoped Pi built-in path facts with one-or-more coverage", () => {
    const matcher = pathScopesAllIn({
      scopes: ["writable-project", "project", "temp"],
      requireFacts: "one-or-more",
    });

    expect(
      evalMatcher(ir(matcher), piTool("read", { path: "README.md" })),
    ).toBe(true);
    expect(evalMatcher(ir(matcher), piTool("ls", {}))).toBe(true);
    expect(
      evalMatcher(ir(matcher), piTool("grep", { path: "/tmp/os-tmp" })),
    ).toBe(true);
    expect(
      evalMatcher(ir(tool("read")), piTool("read", { path: "README.md" })),
    ).toBe(true);
  });

  it("fails closed for Pi built-in missing, unknown, denied, outside, system, and home-like path facts", () => {
    const matcher = pathScopesAllIn({
      scopes: ["writable-project", "project", "temp"],
      requireFacts: "one-or-more",
    });

    expect(evalMatcher(ir(matcher), piTool("read", {}))).toBe(false);
    expect(evalMatcher(ir(matcher), piTool("read", { path: "src/*" }))).toBe(
      false,
    );
    expect(
      evalMatcher(ir(matcher), piTool("read", { path: "/repo/denied/file" })),
    ).toBe(false);
    expect(
      evalMatcher(ir(matcher), piTool("read", { path: "../outside" })),
    ).toBe(false);
    expect(
      evalMatcher(ir(matcher), piTool("read", { path: "/etc/passwd" })),
    ).toBe(false);
    expect(
      evalMatcher(ir(matcher), piTool("read", { path: "~/.ssh/config" })),
    ).toBe(false);
  });
});

describe("path-scope nested stage evaluation", () => {
  it("stageEvery evaluates each stage against its filtered facts", async () => {
    const allIn = pathScopesAllIn({
      scopes: ["writable-project", "project", "temp"],
      requireFacts: "per-command-stage",
      programs: ["touch"],
    });

    expect(
      evalMatcher(
        ir(stageEvery(allIn)),
        enrichInRepo(await bash("touch a && touch b")),
      ),
    ).toBe(true);
    expect(
      evalMatcher(
        ir(stageEvery(allIn)),
        enrichInRepo(await bash("touch a && touch /etc/b")),
      ),
    ).toBe(false);
  });

  it("stageSome matches when any stage's filtered facts satisfy the predicate", async () => {
    const allIn = pathScopesAllIn({
      scopes: ["writable-project", "project", "temp"],
      requireFacts: "per-command-stage",
      programs: ["touch"],
    });

    expect(
      evalMatcher(
        ir(stageSome(allIn)),
        enrichInRepo(await bash("touch a && touch /etc/b")),
      ),
    ).toBe(true);
    expect(
      evalMatcher(
        ir(
          stageSome(
            pathScopesAllIn({
              scopes: ["writable-project", "project", "temp"],
              requireFacts: "per-command-stage",
              programs: ["cat"],
            }),
          ),
        ),
        enrichInRepo(await bash('for f in *.md; do cat "$f"; done')),
      ),
    ).toBe(true);
  });

  it("composition evaluates stages against block-major path-fact indexes", async () => {
    const allConstructiveStages = composition({
      stage: pathScopesAllIn({
        scopes: ["writable-project", "project", "temp"],
        requireFacts: "per-command-stage",
        programs: ["touch", "mkdir"],
      }),
      operators: ["and", "seq"],
    });

    expect(
      evalMatcher(
        ir(allConstructiveStages),
        enrichInRepo(await bash("touch a && mkdir b")),
      ),
    ).toBe(true);
    expect(
      evalMatcher(
        ir(allConstructiveStages),
        enrichInRepo(await bash("touch a && mkdir /etc/b")),
      ),
    ).toBe(false);
    expect(
      evalMatcher(
        ir(allConstructiveStages),
        enrichInRepo(await bash("touch a || mkdir b")),
      ),
    ).toBe(false);
  });
});

// --- compiled DSL fixture matcher --------------------------------------------
//
// Proves the JSON pack form a pack author would write compiles to the same
// inspectable IR the constructors produce and evaluates identically over
// enriched path facts. This closes the DSL -> IR -> evaluator loop for the
// constructive allow shape the fixture pack ships.

describe("path-scope compiled DSL fixture matcher", () => {
  const constructiveTouchAllowJson = {
    all: [
      { program: "touch" },
      { noSubstitution: true },
      { noStdoutRedirect: true },
      {
        pathScopesAllIn: {
          scopes: ["writable-project", "project", "temp"],
          programs: ["touch"],
          requireFacts: "per-command-stage",
        },
      },
    ],
  };

  const constructiveTouchAllowIR = all([
    program("touch"),
    noSubstitution(),
    noStdoutRedirect(),
    pathScopesAllIn({
      scopes: ["writable-project", "project", "temp"],
      programs: ["touch"],
      requireFacts: "per-command-stage",
    }),
  ]);

  it("compiles the JSON constructive allow to the same IR as the constructor", () => {
    const compiled = compileMatch(constructiveTouchAllowJson);
    expect(compiled).toEqual({ expr: constructiveTouchAllowIR });
  });

  it("evaluates the compiled fixture matcher like the IR over enriched shapes", async () => {
    const compiled = compileMatch(constructiveTouchAllowJson);
    if (!("expr" in compiled)) {
      throw new Error("expected compiled matcher expr");
    }
    const matcher = inspectable(compiled.expr as MatcherExpr);

    // Allow: project-scoped touch operand and a cwd-prefix + operand in scope.
    expect(
      evalMatcher(matcher, enrichInRepo(await bash("touch README.md"))),
    ).toBe(true);
    expect(
      evalMatcher(matcher, enrichInRepo(await bash("cd subdir && touch file"))),
    ).toBe(true);
    // Reject: system target, unknown glob/brace, missing path fact, and an
    // unsafe stderr redirect target — the compiled matcher fails closed on each.
    expect(
      evalMatcher(matcher, enrichInRepo(await bash("touch /etc/passwd"))),
    ).toBe(false);
    expect(evalMatcher(matcher, enrichInRepo(await bash("touch out*")))).toBe(
      false,
    );
    expect(evalMatcher(matcher, enrichInRepo(await bash("touch {a,b}")))).toBe(
      false,
    );
    expect(evalMatcher(matcher, enrichInRepo(await bash("touch")))).toBe(false);
    expect(
      evalMatcher(matcher, enrichInRepo(await bash("touch file 2> /etc/log"))),
    ).toBe(false);
  });
});
