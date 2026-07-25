import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type BashPathFactContext,
  defaultSystemPathPrefixes,
  type PathFactProjectScope,
  reduceForLoopIterator,
  reduceIteratorEntry,
} from "../../src/parse/native-path-facts.ts";
import type {
  BashIteratorEntry,
  BashStage,
  PathScope,
} from "../../src/parse/shape.ts";

const ORIGINAL_PLATFORM = process.platform;

beforeEach(() => {
  setPlatform("linux");
});
afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
});

const SYSTEM_PREFIXES = defaultSystemPathPrefixes();
const CWD = "/home/user/proj";
const HOME = "/home/user";

function makeScope(
  overrides: Partial<PathFactProjectScope> = {},
): PathFactProjectScope {
  return {
    roots: ["/home/user/proj", "/home/user/readonly-area"],
    writableDirectories: ["/home/user/proj", "/home/user/proj/build"],
    tempDirectories: ["/var/tmp", "/tmp/os-tmp"],
    deniedDirectories: ["/home/user/proj/secrets", "/opt/secret"],
    safeHomeDirectories: ["/home/user/dev", "/home/user/repos"],
    unknownPathBehavior: "review",
    ...overrides,
  };
}

function makeContext(
  overrides: Partial<BashPathFactContext> = {},
): BashPathFactContext {
  return {
    cwd: CWD,
    projectScope: makeScope(),
    homeDirectory: HOME,
    systemPathPrefixes: SYSTEM_PREFIXES,
    ...overrides,
  };
}

function entry(
  raw: string,
  kind: BashIteratorEntry["kind"] = "literal-word",
  quote: BashIteratorEntry["quote"] = "none",
): BashIteratorEntry {
  return {
    kind,
    raw,
    literal: raw,
    quote,
    span: { start: 0, end: raw.length },
  };
}

function loopStage(
  iterator: readonly BashIteratorEntry[],
): Extract<BashStage, { readonly kind: "for-loop" }> {
  return {
    kind: "for-loop",
    variable: "f",
    variableSpan: { start: 4, end: 5 },
    iterator,
    body: {
      pipeline: { stages: [], pipeTargets: [], span: { start: 0, end: 0 } },
      span: { start: 0, end: 0 },
    },
    keywordSpans: {},
    span: { start: 0, end: 0 },
  };
}

function reduceEntry(
  item: BashIteratorEntry,
  context: BashPathFactContext = makeContext(),
) {
  return reduceIteratorEntry(item, context.cwd, context, context.homeDirectory);
}

function reduceLoop(
  iterator: readonly BashIteratorEntry[],
  context: BashPathFactContext = makeContext(),
) {
  return reduceForLoopIterator(
    loopStage(iterator),
    context.cwd,
    context,
    context.homeDirectory,
  );
}

function expectEntryScope(
  item: BashIteratorEntry,
  scope: PathScope,
  context: BashPathFactContext = makeContext(),
) {
  const reduced = reduceEntry(item, context);
  expect(reduced.scope).toBe(scope);
  expect(reduced.matchedScopes[0]).toBe(scope);
  expect(reduced.unknownReason).toBeUndefined();
  return reduced;
}

describe("reduceIteratorEntry literal words", () => {
  it("re-classifies a concrete literal word from raw and records its concrete path", () => {
    const reduced = expectEntryScope(
      entry(".work/backlog/x.md"),
      "writable-project",
    );

    expect(reduced).toMatchObject({
      raw: ".work/backlog/x.md",
      literal: ".work/backlog/x.md",
      concreteAbsolutePath: path.join(CWD, ".work/backlog/x.md"),
      quote: "none",
    });
    expect(reduced.staticPrefixAbsolutePath).toBeUndefined();
  });

  it("preserves quoted glob characters as a concrete literal word", () => {
    const reduced = expectEntryScope(
      entry("'*.md'", "literal-word", "single"),
      "writable-project",
    );

    expect(reduced.literal).toBe("*.md");
    expect(reduced.concreteAbsolutePath).toBe(path.join(CWD, "*.md"));
    expect(reduced.quote).toBe("single");
  });

  it("fails closed for tilde when no home directory is configured", () => {
    const context: BashPathFactContext = {
      cwd: CWD,
      projectScope: makeScope(),
      systemPathPrefixes: SYSTEM_PREFIXES,
    };
    const reduced = reduceIteratorEntry(
      entry("~/x"),
      context.cwd,
      context,
      undefined,
    );

    expect(reduced).toMatchObject({
      raw: "~/x",
      scope: "unknown",
      matchedScopes: ["unknown"],
      unknownReason: "unsupported-shell-literal",
    });
    expect(reduced.literal).toBeUndefined();
    expect(reduced.concreteAbsolutePath).toBeUndefined();
  });

  it("expands tilde through the existing classifier when home is configured", () => {
    const reduced = expectEntryScope(entry("~/x"), "home");

    expect(reduced.literal).toBe("/home/user/x");
    expect(reduced.concreteAbsolutePath).toBe("/home/user/x");
  });

  it("rejects another user's tilde form", () => {
    const reduced = reduceEntry(entry("~root/x"));

    expect(reduced.scope).toBe("unknown");
    expect(reduced.unknownReason).toBe("unsupported-shell-literal");
  });

  it("does not trust the shape-layer literal when raw fails closed", () => {
    const reduced = reduceEntry({
      ...entry("~root/x"),
      literal: ".work/backlog/safe.md",
    });

    expect(reduced.scope).toBe("unknown");
    expect(reduced.literal).toBeUndefined();
    expect(reduced.unknownReason).toBe("unsupported-shell-literal");
  });

  it("classifies denied, system, and outside concrete literal words", () => {
    expectEntryScope(entry("/opt/secret/x"), "denied");
    expectEntryScope(entry("/etc/x"), "system");
    expectEntryScope(entry("/outside/x"), "outside");
  });
});

describe("reduceIteratorEntry literal globs", () => {
  it("classifies only the static directory prefix for a project-local glob", () => {
    const reduced = expectEntryScope(
      entry(".work/backlog/*.md", "literal-glob"),
      "writable-project",
    );

    expect(reduced).toMatchObject({
      raw: ".work/backlog/*.md",
      literal: ".work/backlog/",
      staticPrefixAbsolutePath: path.join(CWD, ".work/backlog"),
      quote: "none",
    });
    expect(reduced.concreteAbsolutePath).toBeUndefined();
  });

  it("uses dot as the prefix when the first glob has no preceding slash", () => {
    const reduced = expectEntryScope(
      entry("*.md", "literal-glob"),
      "writable-project",
    );

    expect(reduced.literal).toBe(".");
    expect(reduced.staticPrefixAbsolutePath).toBe(CWD);
  });

  it("handles a glob in a filename by reducing to the containing directory", () => {
    const reduced = expectEntryScope(
      entry("docs/file*.md", "literal-glob"),
      "writable-project",
    );

    expect(reduced.literal).toBe("docs/");
    expect(reduced.staticPrefixAbsolutePath).toBe(path.join(CWD, "docs"));
  });

  it("rejects dynamic, brace, extglob, tilde-user, and parent-traversal glob forms", () => {
    expect(reduceEntry(entry("$DIR/*.md", "literal-glob"))).toMatchObject({
      scope: "unknown",
      unknownReason: "dynamic-expansion",
    });
    expect(reduceEntry(entry("{src,test}/*.md", "literal-glob"))).toMatchObject(
      {
        scope: "unknown",
        unknownReason: "brace-expansion",
      },
    );
    expect(
      reduceEntry(entry("@(src|test)/*.md", "literal-glob")),
    ).toMatchObject({
      scope: "unknown",
      unknownReason: "unsupported-shell-literal",
    });
    expect(reduceEntry(entry("~root/*.md", "literal-glob"))).toMatchObject({
      scope: "unknown",
      unknownReason: "unsupported-shell-literal",
    });
    expect(reduceEntry(entry("../*.md", "literal-glob"))).toMatchObject({
      scope: "unknown",
      unknownReason: "unsupported-shell-literal",
    });
  });

  it("fails closed for undecodable quote state in a glob", () => {
    const reduced = reduceEntry(entry("'docs/*.md", "literal-glob", "single"));

    expect(reduced.scope).toBe("unknown");
    expect(reduced.unknownReason).toBe("unsupported-shell-literal");
  });
});

describe("reduceForLoopIterator aggregation", () => {
  it("reduces a single literal glob without claiming a concrete path", () => {
    const reduced = reduceLoop([entry(".work/backlog/*.md", "literal-glob")]);

    expect(reduced).toMatchObject({
      sourceKind: "literal-glob",
      scope: "writable-project",
      matchedScopes: ["writable-project"],
      globApproximation: true,
      staticPrefixAbsolutePath: path.join(CWD, ".work/backlog"),
    });
    expect(reduced.concreteAbsolutePath).toBeUndefined();
    expect(reduced.entries[0]?.staticPrefixAbsolutePath).toBe(
      path.join(CWD, ".work/backlog"),
    );
  });

  it("records a concrete path only when every literal word is the same path", () => {
    const same = reduceLoop([entry("a.md"), entry("a.md")]);
    const different = reduceLoop([entry("a.md"), entry("b.md")]);

    expect(same).toMatchObject({
      sourceKind: "literal-word",
      scope: "writable-project",
      globApproximation: false,
      concreteAbsolutePath: path.join(CWD, "a.md"),
    });
    expect(different.concreteAbsolutePath).toBeUndefined();
  });

  it("marks mixed literal word/glob iterators and keeps the glob approximation flag", () => {
    const reduced = reduceLoop([
      entry(".work/in/*.md", "literal-glob"),
      entry("a.md"),
    ]);

    expect(reduced.sourceKind).toBe("mixed");
    expect(reduced.scope).toBe("writable-project");
    expect(reduced.globApproximation).toBe(true);
  });

  it("aggregates over each entry's winning scope instead of all matched scope trails", () => {
    const reduced = reduceLoop([
      entry(".work/in/*.md", "literal-glob"),
      entry("/etc/x"),
    ]);

    expect(reduced.scope).toBe("system");
    expect(reduced.matchedScopes).toEqual(["system", "writable-project"]);
    expect(reduced.entries[0]?.matchedScopes).toEqual([
      "writable-project",
      "project",
      "home",
    ]);
  });

  it("taints the aggregate when any entry is opaque while preserving glob approximation", () => {
    const reduced = reduceLoop([
      entry(".work/in/*.md", "literal-glob"),
      entry("$DIR/*.md", "literal-glob"),
    ]);

    expect(reduced).toMatchObject({
      sourceKind: "opaque",
      scope: "unknown",
      matchedScopes: ["unknown"],
      globApproximation: true,
      unknownReason: "opaque-iterator",
    });
    expect(reduced.concreteAbsolutePath).toBeUndefined();
    expect(reduced.staticPrefixAbsolutePath).toBeUndefined();
    expect(reduced.entries[1]).toMatchObject({
      scope: "unknown",
      unknownReason: "dynamic-expansion",
    });
  });

  it("treats an empty iterator defensively as opaque", () => {
    const reduced = reduceLoop([]);

    expect(reduced).toMatchObject({
      sourceKind: "opaque",
      scope: "unknown",
      matchedScopes: ["unknown"],
      globApproximation: false,
      unknownReason: "opaque-iterator",
    });
  });
});

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}
