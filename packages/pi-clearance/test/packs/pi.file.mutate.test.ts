import { describe, expect, it } from "vitest";

import type { ResolvedProjectScope } from "../../src/config/loader.ts";
import { sealedFloor } from "../../src/packs/floor.ts";
import { piFileMutatePack } from "../../src/packs/pi.file.mutate.ts";
import { enrichToolShapeWithPathFacts } from "../../src/parse/native-path-facts.ts";
import {
  analyzePiBuiltinTool,
  SUPPORTED_PI_MUTATION_TOOL_SPECS,
} from "../../src/parse/native-tool.ts";
import type { PiBuiltinToolShape, ToolShape } from "../../src/parse/shape.ts";
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

function decidePiMutationTool(
  toolName: "edit" | "write",
  input: unknown,
  options: {
    readonly projectScope?: ResolvedProjectScope;
    readonly homeDirectory?: string;
    readonly omitTrustBoundary?: boolean;
  } = {},
): Decision {
  return decide(makePiMutationShape(toolName, input, options), {
    floor: sealedFloor.rules,
    active: piFileMutatePack.rules,
  });
}

function makePiMutationShape(
  toolName: "edit" | "write",
  input: unknown,
  options: {
    readonly projectScope?: ResolvedProjectScope;
    readonly homeDirectory?: string;
    readonly omitTrustBoundary?: boolean;
  } = {},
): ToolShape {
  const spec = SUPPORTED_PI_MUTATION_TOOL_SPECS.find(
    (candidate) => candidate.toolName === toolName,
  );
  if (spec === undefined) {
    throw new Error(`unsupported test pi mutation tool ${toolName}`);
  }

  const enriched = enrichToolShapeWithPathFacts(
    analyzePiBuiltinTool(spec, input),
    {
      cwd: TEST_CWD,
      projectScope: options.projectScope ?? projectScope(),
      ...(options.homeDirectory === undefined
        ? {}
        : { homeDirectory: options.homeDirectory }),
    },
  );

  if (options.omitTrustBoundary !== true || enriched.kind !== "pi-tool") {
    return enriched;
  }

  const { trustBoundary: _trustBoundary, ...withoutTrustBoundary } =
    enriched satisfies PiBuiltinToolShape;
  return withoutTrustBoundary;
}

function editInput(path: string): Record<string, unknown> {
  return { path, oldText: "before", newText: "after" };
}

function batchedEditInput(path: string): Record<string, unknown> {
  return { path, edits: [{ oldText: "before", newText: "after" }] };
}

function writeInput(path: string): Record<string, unknown> {
  return { path, content: "body" };
}

function expectPiFileMutationAllow(decision: Decision): void {
  expect(decision).toMatchObject({
    effect: "allow",
    provenance: {
      source: "shipped",
      packId: "pi.file.mutate",
      ruleId: "pi.file.mutate:allow-project-scoped-mutation",
    },
  });
}

function expectPiFileMutationReview(decision: Decision): void {
  expect(decision).toMatchObject({
    effect: "review",
    provenance: {
      source: "shipped",
      packId: "pi.file.mutate",
      ruleId: "pi.file.mutate:review-trust-boundary-target",
    },
  });
}

function expectNoAllow(decision: Decision): void {
  expect(decision.effect).toBe("review");
  expect(decision.provenance).not.toMatchObject({
    packId: "pi.file.mutate",
    ruleId: "pi.file.mutate:allow-project-scoped-mutation",
  });
}

describe("pi.file.mutate pack", () => {
  it("compiles and loads cleanly against the sealed floor", () => {
    expect(piFileMutatePack).toMatchObject({
      version: 1,
      id: "pi.file.mutate",
    });
    expectCleanLoad(piFileMutatePack);
  });

  it.each([
    ["edit", editInput("src/a.ts")],
    ["edit", batchedEditInput("src/a.ts")],
    ["write", writeInput("src/a.ts")],
  ] as const)("allows routine project-scoped %s with no trust-boundary crossing", (toolName, input) => {
    expectPiFileMutationAllow(decidePiMutationTool(toolName, input));
  });

  it.each([
    ["edit", editInput("AGENTS.md")],
    ["write", writeInput("package.json")],
    ["edit", editInput(".pi/settings.json")],
    ["write", writeInput("src/packs/project.ts")],
  ] as const)("reviews sensitive trust-boundary %s targets", (toolName, input) => {
    expectPiFileMutationReview(decidePiMutationTool(toolName, input));
  });

  it.each([
    {
      label: "temp path",
      toolName: "write" as const,
      input: writeInput(`${TEST_TEMP_DIR}/note.txt`),
    },
    {
      label: "outside path",
      toolName: "edit" as const,
      input: editInput("/srv/outside.txt"),
    },
    {
      label: "system path",
      toolName: "write" as const,
      input: writeInput("/etc/pi/config.json"),
    },
    {
      label: "denied path",
      toolName: "edit" as const,
      input: editInput("denied/secret.txt"),
      projectScope: projectScope({ deniedDirectories: ["/repo/denied"] }),
    },
    {
      label: "unknown dynamic path",
      toolName: "write" as const,
      input: writeInput("$TARGET_FILE"),
    },
    {
      label: "unknown glob path",
      toolName: "edit" as const,
      input: editInput("src/*.ts"),
    },
  ])("reviews $label", ({ toolName, input, projectScope: scope }) => {
    expectNoAllow(
      decidePiMutationTool(toolName, input, {
        ...(scope === undefined ? {} : { projectScope: scope }),
      }),
    );
  });

  it("reviews when trust-boundary enrichment is absent", () => {
    expectNoAllow(
      decidePiMutationTool("edit", editInput("src/a.ts"), {
        omitTrustBoundary: true,
      }),
    );
  });

  it.each([
    { toolName: "edit" as const, input: { path: "src/a.ts" } },
    { toolName: "edit" as const, input: { path: "src/a.ts", newText: 42 } },
    { toolName: "edit" as const, input: { path: "src/a.ts", edits: [] } },
    {
      toolName: "edit" as const,
      input: { path: "src/a.ts", edits: [{ oldText: "before" }] },
    },
    {
      toolName: "edit" as const,
      input: { path: ["src/a.ts"], newText: "after" },
    },
    { toolName: "write" as const, input: { path: "src/a.ts" } },
    { toolName: "write" as const, input: { path: "src/a.ts", content: 42 } },
    { toolName: "write" as const, input: null },
  ])("reviews malformed $toolName inputs", ({ toolName, input }) => {
    expectNoAllow(decidePiMutationTool(toolName, input));
  });
});
