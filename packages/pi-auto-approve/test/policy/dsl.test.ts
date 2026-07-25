import { describe, expect, it } from "vitest";

import {
  compileMatch,
  compilePack,
  compilePackMetadata,
} from "../../src/policy/core.ts";

const validPack = {
  version: 1,
  id: "pack:git-read",
  rules: [
    {
      id: "allow-read-only-git",
      effect: "allow",
      match: {
        all: [
          { tool: "bash" },
          { stageEvery: { program: "git" } },
          { arg0In: ["status", "log", "diff", "show", "ls-files"] },
          { noSubstitution: true },
          { noStdoutRedirect: true },
        ],
      },
      reason: "read-only Git inspection",
      provenance: { source: "shipped" },
    },
  ],
} as const;

const pathScopedPack = {
  version: 1,
  id: "pack:path-scoped-touch",
  rules: [
    {
      id: "allow-touch-project-temp",
      effect: "allow",
      match: {
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
      },
      reason: "fixture path-scoped touch",
      provenance: { source: "shipped" },
    },
  ],
} as const;

describe("compilePack", () => {
  it("compiles a SPEC-like git policy pack to inspectable matcher IR", () => {
    const result = compilePack(validPack);

    expect(result.errors).toEqual([]);
    expect(result.pack).not.toBeNull();
    const rule = result.pack?.rules[0];

    expect(rule).toMatchObject({
      id: "allow-read-only-git",
      effect: "allow",
      reason: "read-only Git inspection",
      provenance: {
        source: "shipped",
        packId: "pack:git-read",
        ruleId: "allow-read-only-git",
      },
    });
    expect(rule?.match).toEqual({
      kind: "ir",
      expr: {
        kind: "all",
        of: [
          { kind: "tool", tool: "bash" },
          { kind: "stageEvery", inner: { kind: "program", name: "git" } },
          {
            kind: "arg0In",
            values: ["status", "log", "diff", "show", "ls-files"],
          },
          { kind: "noSubstitution" },
          { kind: "noStdoutRedirect" },
        ],
      },
    });
  });

  it("rejects unknown combinators with a JSON path and null pack", () => {
    const result = compilePack({
      ...validPack,
      rules: [
        {
          ...validPack.rules[0],
          match: { frobnicate: 1 },
        },
      ],
    });

    expect(result.pack).toBeNull();
    expect(result.errors).toContainEqual({
      packId: "pack:git-read",
      ruleId: "allow-read-only-git",
      path: "rules[0].match.frobnicate",
      message: "unknown combinator",
    });
  });

  it("rejects ambiguous matcher objects", () => {
    const result = compilePack({
      ...validPack,
      rules: [
        {
          ...validPack.rules[0],
          match: { tool: "bash", program: "git" },
        },
      ],
    });

    expect(result.pack).toBeNull();
    expect(result.errors).toContainEqual({
      packId: "pack:git-read",
      ruleId: "allow-read-only-git",
      path: "rules[0].match",
      message: "ambiguous matcher object",
    });
  });

  it("rejects empty logical matcher arrays instead of compiling accidental always", () => {
    const result = compilePack({
      ...validPack,
      rules: [
        {
          ...validPack.rules[0],
          match: { all: [] },
        },
      ],
    });

    expect(result.pack).toBeNull();
    expect(result.errors).toContainEqual({
      packId: "pack:git-read",
      ruleId: "allow-read-only-git",
      path: "rules[0].match.all",
      message: "matcher array must be non-empty",
    });
  });

  it("validates effect, id, provenance source, and unknown rule fields", () => {
    const result = compilePack({
      version: 1,
      id: "pack:bad",
      rules: [
        {
          effect: "maybe",
          match: { always: true },
          reason: "bad rule",
          provenance: { source: "elsewhere" },
          extra: true,
        },
      ],
    });

    expect(result.pack).toBeNull();
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "rules[0].id" }),
        expect.objectContaining({ path: "rules[0].effect" }),
        expect.objectContaining({ path: "rules[0].provenance.source" }),
        expect.objectContaining({ path: "rules[0].extra" }),
      ]),
    );
  });

  it("defaults provenance.source to generated only when it is absent", () => {
    const result = compilePack({
      version: 1,
      id: "pack:generated",
      rules: [
        {
          id: "generated-rule",
          effect: "review",
          match: { always: true },
          reason: "proposal",
        },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.pack?.rules[0]?.provenance).toEqual({
      source: "generated",
      packId: "pack:generated",
      ruleId: "generated-rule",
    });
  });

  it("rejects unknown provenance fields", () => {
    const result = compilePack({
      ...validPack,
      rules: [
        {
          ...validPack.rules[0],
          provenance: { source: "shipped", note: "typo" },
        },
      ],
    });

    expect(result.pack).toBeNull();
    expect(result.errors).toContainEqual({
      packId: "pack:git-read",
      ruleId: "allow-read-only-git",
      path: "rules[0].provenance.note",
      message: "unknown provenance field",
    });
  });

  it("accepts package as a provenance source and compiles it through", () => {
    const result = compilePack({
      ...validPack,
      rules: [
        {
          ...validPack.rules[0],
          provenance: { source: "package" },
        },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.pack?.rules[0]?.provenance).toEqual({
      source: "package",
      packId: "pack:git-read",
      ruleId: "allow-read-only-git",
    });
  });

  it("returns errors instead of throwing on malformed and adversarial input", () => {
    const malformedInputs: unknown[] = [
      null,
      "string",
      [validPack],
      { rules: "oops" },
      { version: 1, id: "pack:bad", rules: ["oops"] },
      deepMatcherPack(80),
    ];

    for (const input of malformedInputs) {
      expect(() => compilePack(input)).not.toThrow();
      const result = compilePack(input);
      expect(result.pack).toBeNull();
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("compilePack metadata", () => {
  it("omits metadata when absent so existing packs compile unchanged", () => {
    const result = compilePack(validPack);

    expect(result.errors).toEqual([]);
    expect(result.pack?.metadata).toBeUndefined();
    expect(result.pack).not.toHaveProperty("metadata");
  });

  it("preserves valid metadata without changing compiled rules", () => {
    const result = compilePack({
      ...validPack,
      metadata: {
        title: "Git read pack",
        description: "Read-only git inspection.",
        docs: [{ label: "Rule packs", href: "docs/RULE_PACKS.md" }],
        tags: ["vcs", "read"],
        warnings: [{ level: "info", message: "Read-only only." }],
        examples: [
          { outcome: "allow", shape: "git status" },
          { outcome: "review", shape: "git diff > patch", note: "redirect" },
        ],
      },
    });

    expect(result.errors).toEqual([]);
    expect(result.pack?.metadata).toEqual({
      title: "Git read pack",
      description: "Read-only git inspection.",
      docs: [{ label: "Rule packs", href: "docs/RULE_PACKS.md" }],
      tags: ["vcs", "read"],
      warnings: [{ level: "info", message: "Read-only only." }],
      examples: [
        { outcome: "allow", shape: "git status" },
        { outcome: "review", shape: "git diff > patch", note: "redirect" },
      ],
    });
    // Metadata is inert: the compiled rule is unchanged.
    expect(result.pack?.rules[0]?.id).toBe("allow-read-only-git");
    expect(result.pack?.rules[0]?.provenance).toEqual({
      source: "shipped",
      packId: "pack:git-read",
      ruleId: "allow-read-only-git",
    });
  });

  it("preserves partial metadata", () => {
    const result = compilePack({
      ...validPack,
      metadata: { title: "Just a title" },
    });

    expect(result.errors).toEqual([]);
    expect(result.pack?.metadata).toEqual({ title: "Just a title" });
  });

  it("preserves an empty metadata object", () => {
    const result = compilePack({ ...validPack, metadata: {} });

    expect(result.errors).toEqual([]);
    expect(result.pack?.metadata).toEqual({});
  });

  it.each([
    ["string", "nope"],
    ["null", null],
    ["number", 42],
    ["array", []],
  ])("rejects metadata that is not an object (%s)", (_label, value) => {
    const result = compilePack({ ...validPack, metadata: value });

    expect(result.pack).toBeNull();
    expect(result.errors).toContainEqual({
      packId: "pack:git-read",
      ruleId: null,
      path: "metadata",
      message: "expected metadata object",
    });
  });

  it("rejects unknown metadata fields with a useful path", () => {
    const result = compilePack({
      ...validPack,
      metadata: { title: "x", provenance: "no" },
    });

    expect(result.pack).toBeNull();
    expect(result.errors).toContainEqual({
      packId: "pack:git-read",
      ruleId: null,
      path: "metadata.provenance",
      message: "unknown metadata field",
    });
  });

  it("rejects empty docs href and unknown docs fields with indexed paths", () => {
    const result = compilePack({
      ...validPack,
      metadata: {
        docs: [{ label: "ok", href: "", extra: true }],
      },
    });

    expect(result.pack).toBeNull();
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "metadata.docs[0].href",
          message: "expected non-empty string",
        }),
        expect.objectContaining({
          path: "metadata.docs[0].extra",
          message: "unknown docs field",
        }),
      ]),
    );
  });

  it("rejects invalid warning level and empty tag with indexed paths", () => {
    const result = compilePack({
      ...validPack,
      metadata: {
        tags: ["ok", ""],
        warnings: [{ level: "critical", message: "watch out" }],
      },
    });

    expect(result.pack).toBeNull();
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "metadata.tags[1]",
          message: "expected non-empty string",
        }),
        expect.objectContaining({
          path: "metadata.warnings[0].level",
          message: "invalid warning level",
        }),
      ]),
    );
  });

  it("rejects malformed examples with indexed paths", () => {
    const result = compilePack({
      ...validPack,
      metadata: {
        examples: [
          { outcome: "approve", shape: "git status" },
          { outcome: "allow", shape: "" },
          { outcome: "review", shape: 42 },
          { outcome: "deny", shape: "rm -rf /", extra: true },
          { outcome: "review", shape: "pnpm test", note: 42 },
        ],
      },
    });

    expect(result.pack).toBeNull();
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "metadata.examples[0].outcome",
          message: "invalid example outcome",
        }),
        expect.objectContaining({
          path: "metadata.examples[1].shape",
          message: "expected non-empty string",
        }),
        expect.objectContaining({
          path: "metadata.examples[2].shape",
          message: "expected non-empty string",
        }),
        expect.objectContaining({
          path: "metadata.examples[3].extra",
          message: "unknown example field",
        }),
        expect.objectContaining({
          path: "metadata.examples[4].note",
          message: "expected string",
        }),
      ]),
    );
  });

  it("rejects non-array docs/tags/warnings/examples", () => {
    const result = compilePack({
      ...validPack,
      metadata: { docs: "nope", tags: {}, warnings: true, examples: 1 },
    });

    expect(result.pack).toBeNull();
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "metadata.docs",
          message: "expected docs array",
        }),
        expect.objectContaining({
          path: "metadata.tags",
          message: "expected string array",
        }),
        expect.objectContaining({
          path: "metadata.warnings",
          message: "expected warnings array",
        }),
        expect.objectContaining({
          path: "metadata.examples",
          message: "expected examples array",
        }),
      ]),
    );
  });
});

describe("compilePackMetadata", () => {
  it("returns null metadata and no errors when absent", () => {
    const result = compilePackMetadata(undefined);

    expect(result.metadata).toBeNull();
    expect(result.errors).toEqual([]);
  });

  it("validates and returns valid metadata using the same rules as compilePack", () => {
    const result = compilePackMetadata({
      title: "Standalone metadata",
      docs: [{ label: "Rule packs", href: "docs/RULE_PACKS.md" }],
      tags: ["vcs"],
      warnings: [{ level: "info", message: "note" }],
      examples: [{ outcome: "deny", shape: "rm -rf /" }],
    });

    expect(result.errors).toEqual([]);
    expect(result.metadata).toEqual({
      title: "Standalone metadata",
      docs: [{ label: "Rule packs", href: "docs/RULE_PACKS.md" }],
      tags: ["vcs"],
      warnings: [{ level: "info", message: "note" }],
      examples: [{ outcome: "deny", shape: "rm -rf /" }],
    });
  });

  it("reports metadata errors with metadata-rooted paths without throwing", () => {
    expect(() =>
      compilePackMetadata({ docs: [{ label: "ok", href: "" }] }),
    ).not.toThrow();
    const result = compilePackMetadata({
      docs: [{ label: "ok", href: "" }],
      warnings: [{ level: "critical", message: "x" }],
    });

    expect(result.metadata).toBeNull();
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "metadata.docs[0].href" }),
        expect.objectContaining({ path: "metadata.warnings[0].level" }),
      ]),
    );
  });

  it("reports malformed example metadata with metadata-rooted paths", () => {
    const result = compilePackMetadata({
      examples: [
        { outcome: "approve", shape: "git status" },
        { outcome: "allow", shape: "" },
        { outcome: "review", shape: 42 },
        { outcome: "deny", shape: "rm -rf /", extra: true },
      ],
    });

    expect(result.metadata).toBeNull();
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "metadata.examples[0].outcome" }),
        expect.objectContaining({ path: "metadata.examples[1].shape" }),
        expect.objectContaining({ path: "metadata.examples[2].shape" }),
        expect.objectContaining({ path: "metadata.examples[3].extra" }),
      ]),
    );
  });
});

describe("compileMatch", () => {
  it("compiles anyArgMatches with inspectable anchored pattern data", () => {
    expect(compileMatch({ anyArgMatches: "^of=/dev/" })).toEqual({
      expr: { kind: "anyArgMatches", pattern: "^of=/dev/" },
    });
    expect(matchErrors({ anyArgMatches: "" }).length).toBeGreaterThan(0);
    expect(matchErrors({ anyArgMatches: "[" }).length).toBeGreaterThan(0);
  });

  it("compiles argMatches with inspectable anchored pattern data", () => {
    expect(
      compileMatch({
        argMatches: { index: 1, pattern: "[A-Za-z][A-Za-z0-9:_-]*" },
      }),
    ).toEqual({
      expr: {
        kind: "argMatches",
        index: 1,
        pattern: "[A-Za-z][A-Za-z0-9:_-]*",
      },
    });
  });

  it.each([
    { argMatches: { index: -1, pattern: "x" } },
    { argMatches: { index: 0.5, pattern: "x" } },
    { argMatches: { index: 0, pattern: "" } },
    { argMatches: { index: 0, pattern: "[" } },
    { argMatches: { index: 0, pattern: "x", extra: true } },
  ])("rejects malformed argMatches: %j", (matcher) => {
    expect(matchErrors(matcher).length).toBeGreaterThan(0);
  });

  it("compiles flagMatches and envAssignmentNameIn criteria", () => {
    expect(
      compileMatch({
        flagMatches: {
          names: ["replace"],
          prefixes: ["pre"],
          shortChars: ["r"],
        },
      }),
    ).toEqual({
      expr: {
        kind: "flagMatches",
        names: ["replace"],
        prefixes: ["pre"],
        shortChars: ["r"],
      },
    });
    expect(
      compileMatch({
        envAssignmentNameIn: {
          names: ["LD_PRELOAD"],
          prefixes: ["DYLD_"],
          caseInsensitivePrefixes: ["npm_config_"],
        },
      }),
    ).toEqual({
      expr: {
        kind: "envAssignmentNameIn",
        names: ["LD_PRELOAD"],
        prefixes: ["DYLD_"],
        caseInsensitivePrefixes: ["npm_config_"],
      },
    });
  });

  it.each([
    { flagMatches: {} },
    { envAssignmentNameIn: {} },
    { flagMatches: { names: [] } },
    { envAssignmentNameIn: { prefixes: [""] } },
  ])("rejects empty matcher criteria: %j", (matcher) => {
    expect(matchErrors(matcher).length).toBeGreaterThan(0);
  });

  it("reports the missing criterion on an empty matcher object", () => {
    expect(matchErrors({ flagMatches: {} })).toContainEqual(
      expect.objectContaining({
        path: "$.flagMatches",
        message: "flagMatches requires at least one criterion",
      }),
    );
    expect(matchErrors({ envAssignmentNameIn: {} })).toContainEqual(
      expect.objectContaining({
        path: "$.envAssignmentNameIn",
        message: "envAssignmentNameIn requires at least one criterion",
      }),
    );
  });

  it("is independently callable", () => {
    expect(
      compileMatch({ any: [{ program: "git" }, { program: "gh" }] }),
    ).toEqual({
      expr: {
        kind: "any",
        of: [
          { kind: "program", name: "git" },
          { kind: "program", name: "gh" },
        ],
      },
    });
  });

  it("is total on garbage inputs", () => {
    const garbageInputs: unknown[] = [
      null,
      "string",
      [],
      { frobnicate: 1 },
      { all: [null] },
      deepMatcher(80),
    ];

    for (const input of garbageInputs) {
      expect(() => compileMatch(input)).not.toThrow();
      const result = compileMatch(input);
      expect("errors" in result).toBe(true);
    }
  });
});

describe("compileMatch composition combinator", () => {
  it("compiles minStages and the restricted fallback list", () => {
    expect(
      compileMatch({
        composition: {
          stage: { program: "git" },
          operators: ["and", "seq"],
          minStages: 2,
          orFallback: ["true", ":"],
        },
      }),
    ).toEqual({
      expr: {
        kind: "composition",
        stage: { kind: "program", name: "git" },
        operators: ["and", "seq"],
        minStages: 2,
        orFallback: ["true", ":"],
      },
    });
  });

  it.each([
    {
      composition: {
        stage: { program: "git" },
        operators: ["and"],
        minStages: 0,
      },
    },
    {
      composition: {
        stage: { program: "git" },
        operators: ["and"],
        minStages: 1.5,
      },
    },
    {
      composition: {
        stage: { program: "git" },
        operators: ["and"],
        orFallback: [],
      },
    },
    {
      composition: {
        stage: { program: "git" },
        operators: ["and"],
        orFallback: ["echo"],
      },
    },
    {
      composition: {
        stage: { program: "git" },
        operators: ["and"],
        orFallback: [42],
      },
    },
    {
      composition: {
        stage: { program: "git" },
        operators: ["and"],
        orFallback: "true",
      },
    },
  ])("rejects unsafe composition options: %j", (matcher) => {
    expect(matchErrors(matcher).length).toBeGreaterThan(0);
  });
});

describe("compileMatch path-scope combinators", () => {
  it("compiles pathScopesAllIn to inspectable pathScope IR with full options", () => {
    expect(
      compileMatch({
        pathScopesAllIn: {
          scopes: ["writable-project", "project", "temp"],
          programs: ["touch"],
          requireFacts: "per-command-stage",
        },
      }),
    ).toEqual({
      expr: {
        kind: "pathScope",
        mode: "all-in",
        scopes: ["writable-project", "project", "temp"],
        programs: ["touch"],
        requireFacts: "per-command-stage",
      },
    });
  });

  it("defaults pathScopesAllIn requireFacts to one-or-more and omits programs", () => {
    expect(compileMatch({ pathScopesAllIn: { scopes: ["project"] } })).toEqual({
      expr: {
        kind: "pathScope",
        mode: "all-in",
        scopes: ["project"],
        requireFacts: "one-or-more",
      },
    });
  });

  it("defaults pathScopesSomeIn requireFacts to one-or-more", () => {
    expect(compileMatch({ pathScopesSomeIn: { scopes: ["unknown"] } })).toEqual(
      {
        expr: {
          kind: "pathScope",
          mode: "some-in",
          scopes: ["unknown"],
          requireFacts: "one-or-more",
        },
      },
    );
  });

  it("preserves explicit requireFacts for positive path-scope modes", () => {
    expect(
      compileMatch({
        pathScopesAllIn: { scopes: ["project"], requireFacts: "one-or-more" },
      }),
    ).toEqual({
      expr: {
        kind: "pathScope",
        mode: "all-in",
        scopes: ["project"],
        requireFacts: "one-or-more",
      },
    });
    expect(
      compileMatch({
        pathScopesSomeIn: {
          scopes: ["unknown"],
          requireFacts: "per-command-stage",
        },
      }),
    ).toEqual({
      expr: {
        kind: "pathScope",
        mode: "some-in",
        scopes: ["unknown"],
        requireFacts: "per-command-stage",
      },
    });
  });

  it("omits pathScopesNoneIn requireFacts by default and honors it when supplied", () => {
    expect(
      compileMatch({ pathScopesNoneIn: { scopes: ["unknown", "denied"] } }),
    ).toEqual({
      expr: {
        kind: "pathScope",
        mode: "none-in",
        scopes: ["unknown", "denied"],
      },
    });
    expect(
      compileMatch({
        pathScopesNoneIn: { scopes: ["unknown"], requireFacts: "one-or-more" },
      }),
    ).toEqual({
      expr: {
        kind: "pathScope",
        mode: "none-in",
        scopes: ["unknown"],
        requireFacts: "one-or-more",
      },
    });
    expect(
      compileMatch({
        pathScopesNoneIn: {
          scopes: ["unknown"],
          requireFacts: "per-command-stage",
        },
      }),
    ).toEqual({
      expr: {
        kind: "pathScope",
        mode: "none-in",
        scopes: ["unknown"],
        requireFacts: "per-command-stage",
      },
    });
  });

  it("de-duplicates programs preserving first-occurrence order", () => {
    expect(
      compileMatch({
        pathScopesAllIn: {
          scopes: ["project"],
          programs: ["touch", "mkdir", "printf", "touch", "mktemp", "printf"],
          requireFacts: "per-command-stage",
        },
      }),
    ).toEqual({
      expr: {
        kind: "pathScope",
        mode: "all-in",
        scopes: ["project"],
        programs: ["touch", "mkdir", "printf", "mktemp"],
        requireFacts: "per-command-stage",
      },
    });
  });

  it("rejects programs unless per-command-stage makes the coverage guard active", () => {
    for (const matcher of [
      { pathScopesAllIn: { scopes: ["project"], programs: ["touch"] } },
      {
        pathScopesSomeIn: {
          scopes: ["unknown"],
          programs: ["touch"],
          requireFacts: "one-or-more",
        },
      },
      {
        pathScopesNoneIn: {
          scopes: ["outside"],
          programs: ["touch"],
          requireFacts: "one-or-more",
        },
      },
    ]) {
      const key = Object.keys(matcher)[0];
      expect(matchErrors(matcher)).toContainEqual({
        packId: null,
        ruleId: null,
        path: `$.${key}.programs`,
        message: `${key}.programs requires requireFacts "per-command-stage"`,
      });
    }
  });

  it("nests under stageEvery like other single-key combinators", () => {
    expect(
      compileMatch({
        stageEvery: { pathScopesSomeIn: { scopes: ["unknown"] } },
      }),
    ).toEqual({
      expr: {
        kind: "stageEvery",
        inner: {
          kind: "pathScope",
          mode: "some-in",
          scopes: ["unknown"],
          requireFacts: "one-or-more",
        },
      },
    });
  });

  it("rejects ambiguous objects that contain multiple path-scope combinators", () => {
    expect(
      matchErrors({
        pathScopesAllIn: { scopes: ["project"] },
        pathScopesNoneIn: { scopes: ["unknown"] },
      }),
    ).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$",
      message: "ambiguous matcher object",
    });
  });

  it("rejects invalid scope strings with an indexed path", () => {
    expect(
      matchErrors({
        pathScopesAllIn: { scopes: ["project", "bogus", "temp"] },
      }),
    ).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.pathScopesAllIn.scopes[1]",
      message: "invalid scope",
    });
  });

  it("rejects empty scopes array and missing scopes with field paths", () => {
    expect(matchErrors({ pathScopesAllIn: { scopes: [] } })).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.pathScopesAllIn.scopes",
      message: "pathScopesAllIn.scopes must be a non-empty array",
    });
    expect(
      matchErrors({ pathScopesAllIn: { programs: ["touch"] } }),
    ).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.pathScopesAllIn.scopes",
      message: "pathScopesAllIn.scopes is required",
    });
  });

  it("rejects invalid requireFacts with a field path", () => {
    expect(
      matchErrors({
        pathScopesSomeIn: { scopes: ["unknown"], requireFacts: "always" },
      }),
    ).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.pathScopesSomeIn.requireFacts",
      message: "invalid requireFacts",
    });
  });

  it("rejects empty program names with indexed paths", () => {
    expect(
      matchErrors({
        pathScopesAllIn: { scopes: ["project"], programs: ["touch", ""] },
      }),
    ).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.pathScopesAllIn.programs[1]",
      message: "expected non-empty string",
    });
  });

  it("rejects non-array and empty-array programs", () => {
    expect(
      matchErrors({
        pathScopesAllIn: { scopes: ["project"], programs: "touch" },
      }),
    ).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.pathScopesAllIn.programs",
      message: "pathScopesAllIn.programs must be a non-empty array",
    });
    expect(
      matchErrors({ pathScopesAllIn: { scopes: ["project"], programs: [] } }),
    ).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.pathScopesAllIn.programs",
      message: "pathScopesAllIn.programs must be a non-empty array",
    });
  });

  it("rejects unknown option fields with precise paths", () => {
    expect(
      matchErrors({ pathScopesNoneIn: { scopes: ["unknown"], extra: true } }),
    ).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.pathScopesNoneIn.extra",
      message: "unknown pathScopesNoneIn field",
    });
  });

  it("rejects non-object matcher values", () => {
    for (const value of [true, "project", ["project"], null, 42]) {
      expect(matchErrors({ pathScopesAllIn: value })).toContainEqual({
        packId: null,
        ruleId: null,
        path: "$.pathScopesAllIn",
        message: "pathScopesAllIn must be an object",
      });
    }
  });

  it("remains total on malformed and adversarial path-scope input", () => {
    const garbage: unknown[] = [
      { pathScopesAllIn: true },
      { pathScopesAllIn: "project" },
      { pathScopesAllIn: ["project"] },
      { pathScopesAllIn: null },
      { pathScopesAllIn: { scopes: [null, 1, {}, []] } },
      { pathScopesNoneIn: { programs: "touch" } },
      { pathScopesSomeIn: { requireFacts: "always" } },
      { pathScopesAllIn: { scopes: "project", programs: 5, requireFacts: 1 } },
      circularPathScopeMatcher(),
    ];

    for (const input of garbage) {
      expect(() => compileMatch(input)).not.toThrow();
      const result = compileMatch(input);
      expect("errors" in result).toBe(true);
    }
  });
});

describe("compileMatch compound combinators", () => {
  it("compiles compound matchers to inspectable IR", () => {
    expect(compileMatch({ compoundForm: "for" })).toEqual({
      expr: { kind: "compoundForm", form: "for" },
    });
    expect(compileMatch({ bodyStagesAllReadOnly: true })).toEqual({
      expr: { kind: "bodyStagesAllReadOnly" },
    });
    expect(
      compileMatch({
        bodyStagesAllScopeIn: {
          scopes: ["writable-project", "project", "temp"],
        },
      }),
    ).toEqual({
      expr: {
        kind: "bodyStagesAllScopeIn",
        scopes: ["writable-project", "project", "temp"],
      },
    });
    expect(
      compileMatch({ iteratorScopesAllIn: { scopes: ["project"] } }),
    ).toEqual({
      expr: { kind: "iteratorScopesAllIn", scopes: ["project"] },
    });
    expect(compileMatch({ noBodySubstitution: true })).toEqual({
      expr: { kind: "noBodySubstitution" },
    });
    expect(compileMatch({ noBodyShellWrap: true })).toEqual({
      expr: { kind: "noBodyShellWrap" },
    });
    expect(compileMatch({ noBodyRedirectTo: true })).toEqual({
      expr: { kind: "noBodyRedirectTo" },
    });
    expect(
      compileMatch({ diagnosticCode: "bash:compound-body-unsupported" }),
    ).toEqual({
      expr: {
        kind: "diagnosticCode",
        code: "bash:compound-body-unsupported",
      },
    });
  });

  it("nests compound combinators under all like future pack rules", () => {
    expect(
      compileMatch({
        all: [
          { compoundForm: "for" },
          { bodyStagesAllReadOnly: true },
          {
            bodyStagesAllScopeIn: {
              scopes: ["writable-project", "project", "temp"],
            },
          },
          {
            iteratorScopesAllIn: {
              scopes: ["writable-project", "project", "temp"],
            },
          },
          { noBodySubstitution: true },
          { noBodyShellWrap: true },
          { noBodyRedirectTo: true },
        ],
      }),
    ).toEqual({
      expr: {
        kind: "all",
        of: [
          { kind: "compoundForm", form: "for" },
          { kind: "bodyStagesAllReadOnly" },
          {
            kind: "bodyStagesAllScopeIn",
            scopes: ["writable-project", "project", "temp"],
          },
          {
            kind: "iteratorScopesAllIn",
            scopes: ["writable-project", "project", "temp"],
          },
          { kind: "noBodySubstitution" },
          { kind: "noBodyShellWrap" },
          { kind: "noBodyRedirectTo" },
        ],
      },
    });
  });

  it("rejects malformed compound matcher payloads with precise paths", () => {
    expect(matchErrors({ compoundForm: "while" })).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.compoundForm",
      message: "invalid compound form",
    });
    expect(matchErrors({ bodyStagesAllReadOnly: false })).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.bodyStagesAllReadOnly",
      message: "matcher sentinel must be true",
    });
    expect(matchErrors({ diagnosticCode: "" })).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.diagnosticCode",
      message: "diagnosticCode must be a non-empty string",
    });
    expect(
      matchErrors({ bodyStagesAllScopeIn: { scopes: ["project", "bogus"] } }),
    ).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.bodyStagesAllScopeIn.scopes[1]",
      message: "invalid scope",
    });
    expect(matchErrors({ iteratorScopesAllIn: { scopes: [] } })).toContainEqual(
      {
        packId: null,
        ruleId: null,
        path: "$.iteratorScopesAllIn.scopes",
        message: "iteratorScopesAllIn.scopes must be a non-empty array",
      },
    );
    expect(
      matchErrors({ bodyStagesAllScopeIn: { scopes: ["project"], extra: 1 } }),
    ).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.bodyStagesAllScopeIn.extra",
      message: "unknown bodyStagesAllScopeIn field",
    });
  });

  it("compiles compound combinators inside packs with pack-scoped errors", () => {
    const result = compilePack({
      version: 1,
      id: "pack:compound-fixture",
      rules: [
        {
          id: "review-compound-diagnostic",
          effect: "review",
          match: { diagnosticCode: "bash:compound-body-unsupported" },
          reason: "fixture compound diagnostic",
          provenance: { source: "shipped" },
        },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.pack?.rules[0]?.match).toEqual({
      kind: "ir",
      expr: {
        kind: "diagnosticCode",
        code: "bash:compound-body-unsupported",
      },
    });

    const invalid = compilePack({
      version: 1,
      id: "pack:bad-compound",
      rules: [
        {
          id: "bad-compound",
          effect: "review",
          match: { iteratorScopesAllIn: { scopes: ["bogus"] } },
          reason: "bad compound matcher",
          provenance: { source: "shipped" },
        },
      ],
    });
    expect(invalid.pack).toBeNull();
    expect(invalid.errors).toContainEqual({
      packId: "pack:bad-compound",
      ruleId: "bad-compound",
      path: "rules[0].match.iteratorScopesAllIn.scopes[0]",
      message: "invalid scope",
    });
  });
});

describe("compileMatch mutation combinators", () => {
  it("compiles mutationTool, mutationShape, and mutationTrustBoundary", () => {
    expect(
      compileMatch({ mutationTool: { tools: ["edit", "write"] } }),
    ).toEqual({
      expr: { kind: "mutationTool", tools: ["edit", "write"] },
    });
    expect(compileMatch({ mutationTool: { tools: [] } })).toEqual({
      expr: { kind: "mutationTool", tools: [] },
    });
    expect(compileMatch({ mutationShape: { shape: "well-formed" } })).toEqual({
      expr: { kind: "mutationShape", shape: "well-formed" },
    });
    expect(
      compileMatch({ mutationTrustBoundary: { in: ["none", "policy-pack"] } }),
    ).toEqual({
      expr: { kind: "mutationTrustBoundary", in: ["none", "policy-pack"] },
    });
  });

  it("nests mutation combinators under all like shipped mutation pack rules", () => {
    expect(
      compileMatch({
        all: [
          { mutationTool: { tools: ["edit", "write"] } },
          { mutationShape: { shape: "well-formed" } },
          { mutationTrustBoundary: { in: ["none"] } },
        ],
      }),
    ).toEqual({
      expr: {
        kind: "all",
        of: [
          { kind: "mutationTool", tools: ["edit", "write"] },
          { kind: "mutationShape", shape: "well-formed" },
          { kind: "mutationTrustBoundary", in: ["none"] },
        ],
      },
    });
  });

  it("rejects invalid mutation enum values with precise paths", () => {
    expect(
      matchErrors({ mutationTool: { tools: ["edit", "delete"] } }),
    ).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.mutationTool.tools[1]",
      message: "invalid mutation tool",
    });
    expect(matchErrors({ mutationShape: { shape: "append" } })).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.mutationShape.shape",
      message: "invalid mutation shape",
    });
    expect(
      matchErrors({ mutationTrustBoundary: { in: ["none", "root"] } }),
    ).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.mutationTrustBoundary.in[1]",
      message: "invalid mutation trust boundary",
    });
  });

  it("rejects malformed mutation matcher option objects", () => {
    expect(matchErrors({ mutationTool: true })).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.mutationTool",
      message: "mutationTool must be an object",
    });
    expect(matchErrors({ mutationTool: {} })).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.mutationTool.tools",
      message: "mutationTool.tools is required",
    });
    expect(
      matchErrors({ mutationShape: { shape: "create", extra: 1 } }),
    ).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.mutationShape.extra",
      message: "unknown mutationShape field",
    });
    expect(matchErrors({ mutationTrustBoundary: { in: [] } })).toContainEqual({
      packId: null,
      ruleId: null,
      path: "$.mutationTrustBoundary.in",
      message: "mutationTrustBoundary.in must be a non-empty array",
    });
  });

  it("compiles mutation combinators inside packs with pack-scoped errors", () => {
    const result = compilePack({
      version: 1,
      id: "pack:mutation-fixture",
      rules: [
        {
          id: "allow-mutation-fixture",
          effect: "allow",
          match: {
            all: [
              { mutationTool: { tools: ["edit", "write"] } },
              { mutationShape: { shape: "well-formed" } },
              { mutationTrustBoundary: { in: ["none"] } },
            ],
          },
          reason: "fixture mutation allow",
          provenance: { source: "shipped" },
        },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.pack?.rules[0]?.match).toEqual({
      kind: "ir",
      expr: {
        kind: "all",
        of: [
          { kind: "mutationTool", tools: ["edit", "write"] },
          { kind: "mutationShape", shape: "well-formed" },
          { kind: "mutationTrustBoundary", in: ["none"] },
        ],
      },
    });

    const invalid = compilePack({
      version: 1,
      id: "pack:bad-mutation",
      rules: [
        {
          id: "bad-mutation",
          effect: "allow",
          match: { mutationTrustBoundary: { in: ["bogus"] } },
          reason: "bad mutation matcher",
          provenance: { source: "shipped" },
        },
      ],
    });
    expect(invalid.pack).toBeNull();
    expect(invalid.errors).toContainEqual({
      packId: "pack:bad-mutation",
      ruleId: "bad-mutation",
      path: "rules[0].match.mutationTrustBoundary.in[0]",
      message: "invalid mutation trust boundary",
    });
  });
});

describe("compilePack path-scope combinators", () => {
  it("compiles a path-scoped allow rule inside all into inspectable IR", () => {
    const result = compilePack(pathScopedPack);

    expect(result.errors).toEqual([]);
    expect(result.pack).not.toBeNull();
    const rule = result.pack?.rules[0];
    expect(rule?.id).toBe("allow-touch-project-temp");
    expect(rule?.match).toEqual({
      kind: "ir",
      expr: {
        kind: "all",
        of: [
          { kind: "program", name: "touch" },
          { kind: "noSubstitution" },
          { kind: "noStdoutRedirect" },
          {
            kind: "pathScope",
            mode: "all-in",
            scopes: ["writable-project", "project", "temp"],
            programs: ["touch"],
            requireFacts: "per-command-stage",
          },
        ],
      },
    });
    expect(rule?.provenance).toEqual({
      source: "shipped",
      packId: "pack:path-scoped-touch",
      ruleId: "allow-touch-project-temp",
    });
  });

  it("coexists with structural rules so existing packs compile unchanged", () => {
    const result = compilePack({
      version: 1,
      id: "pack:mixed",
      rules: [
        validPack.rules[0],
        {
          id: "review-unknown-paths",
          effect: "review",
          match: { pathScopesSomeIn: { scopes: ["unknown"] } },
          reason: "flag unknown path facts",
          provenance: { source: "shipped" },
        },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.pack?.rules).toHaveLength(2);
    expect(result.pack?.rules[0]?.id).toBe("allow-read-only-git");
    expect(result.pack?.rules[1]?.match).toEqual({
      kind: "ir",
      expr: {
        kind: "pathScope",
        mode: "some-in",
        scopes: ["unknown"],
        requireFacts: "one-or-more",
      },
    });
  });

  it("returns pack errors instead of throwing on adversarial path-scope input", () => {
    const result = compilePack({
      version: 1,
      id: "pack:circular-path-scope",
      rules: [
        {
          id: "circular-path-scope",
          effect: "review",
          match: circularPathScopeMatcher(),
          reason: "adversarial matcher",
          provenance: { source: "generated" },
        },
      ],
    });

    expect(result.pack).toBeNull();
    expect(result.errors).toContainEqual({
      packId: "pack:circular-path-scope",
      ruleId: "circular-path-scope",
      path: "rules[0].match.pathScopesAllIn.scopes[0]",
      message: "invalid scope",
    });
  });

  it("reports pack-scoped JSON paths for invalid path-scope options", () => {
    const scopeResult = compilePack({
      version: 1,
      id: "pack:bad-scope",
      rules: [
        {
          id: "bad-all-in",
          effect: "allow",
          match: {
            pathScopesAllIn: {
              scopes: ["project", "temp", "bogus"],
              programs: ["touch"],
            },
          },
          reason: "bad scope",
          provenance: { source: "shipped" },
        },
      ],
    });
    expect(scopeResult.pack).toBeNull();
    expect(scopeResult.errors).toContainEqual({
      packId: "pack:bad-scope",
      ruleId: "bad-all-in",
      path: "rules[0].match.pathScopesAllIn.scopes[2]",
      message: "invalid scope",
    });

    const requireResult = compilePack({
      version: 1,
      id: "pack:bad-require",
      rules: [
        {
          id: "bad-some-in",
          effect: "review",
          match: {
            pathScopesSomeIn: { scopes: ["unknown"], requireFacts: "always" },
          },
          reason: "bad requireFacts",
          provenance: { source: "shipped" },
        },
      ],
    });
    expect(requireResult.pack).toBeNull();
    expect(requireResult.errors).toContainEqual({
      packId: "pack:bad-require",
      ruleId: "bad-some-in",
      path: "rules[0].match.pathScopesSomeIn.requireFacts",
      message: "invalid requireFacts",
    });

    const fieldResult = compilePack({
      version: 1,
      id: "pack:bad-field",
      rules: [
        {
          id: "bad-none-in",
          effect: "review",
          match: {
            pathScopesNoneIn: { scopes: ["unknown"], extra: true },
          },
          reason: "bad field",
          provenance: { source: "shipped" },
        },
      ],
    });
    expect(fieldResult.pack).toBeNull();
    expect(fieldResult.errors).toContainEqual({
      packId: "pack:bad-field",
      ruleId: "bad-none-in",
      path: "rules[0].match.pathScopesNoneIn.extra",
      message: "unknown pathScopesNoneIn field",
    });
  });
});

function deepMatcherPack(depth: number): unknown {
  return {
    version: 1,
    id: "pack:deep",
    rules: [
      {
        id: "too-deep",
        effect: "review",
        match: deepMatcher(depth),
        reason: "too deep",
        provenance: { source: "generated" },
      },
    ],
  };
}

function deepMatcher(depth: number): unknown {
  let matcher: unknown = { always: true };

  for (let index = 0; index < depth; index += 1) {
    matcher = { not: matcher };
  }

  return matcher;
}

/** Asserts the standalone matcher compiled to errors and returns them for inspection. */
function matchErrors(input: unknown) {
  const result = compileMatch(input);
  if ("errors" in result) {
    return result.errors;
  }
  throw new Error("expected compile errors");
}

/** A self-referential scopes array; must fail with an indexed path, not recurse. */
function circularPathScopeMatcher(): unknown {
  const scopes: unknown[] = [];
  scopes.push(scopes);
  return { pathScopesAllIn: { scopes } };
}
