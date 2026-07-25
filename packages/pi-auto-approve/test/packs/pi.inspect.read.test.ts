import { describe, expect, it } from "vitest";

import type { ResolvedProjectScope } from "../../src/config/loader.ts";
import { sealedFloor } from "../../src/packs/floor.ts";
import { piInspectReadPack } from "../../src/packs/pi.inspect.read.ts";
import { enrichToolShapeWithPathFacts } from "../../src/parse/native-path-facts.ts";
import {
  analyzePiBuiltinTool,
  SUPPORTED_PI_BUILTIN_TOOL_SPECS,
  SUPPORTED_PI_MUTATION_TOOL_SPECS,
} from "../../src/parse/native-tool.ts";
import type { Decision } from "../../src/policy/core.ts";
import { decide } from "../../src/policy/core.ts";
import { expectCleanLoad } from "./helpers.ts";

const TEST_CWD = "/repo";
const TEST_TEMP_DIR = "/tmp/os-tmp";
const TEST_HOME = "/home/user";
const AGENT_SUPPORT_ROOT = `${TEST_HOME}/.pi/agent/skills`;

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

function decidePiTool(
  toolName: string,
  input: unknown,
  options: {
    readonly cwd?: string;
    readonly homeDirectory?: string;
    readonly projectScope?: ResolvedProjectScope;
  } = {},
): Decision {
  const spec = SUPPORTED_PI_BUILTIN_TOOL_SPECS.find(
    (candidate) => candidate.toolName === toolName,
  );
  if (spec === undefined) {
    throw new Error(`unsupported test pi tool ${toolName}`);
  }
  const enriched = enrichToolShapeWithPathFacts(
    analyzePiBuiltinTool(spec, input),
    {
      cwd: options.cwd ?? TEST_CWD,
      homeDirectory: options.homeDirectory ?? TEST_HOME,
      projectScope: options.projectScope ?? projectScope(),
    },
  );
  return decide(enriched, {
    floor: sealedFloor.rules,
    active: piInspectReadPack.rules,
  });
}

function expectPiInspectAllow(decision: Decision): void {
  expect(decision).toMatchObject({
    effect: "allow",
    provenance: {
      source: "shipped",
      packId: "pi.inspect.read",
      ruleId: "pi.inspect.read:allow-scoped-read-tools",
    },
  });
}

describe("pi.inspect.read pack", () => {
  it("compiles and loads cleanly against the sealed floor", () => {
    expect(piInspectReadPack).toMatchObject({
      version: 1,
      id: "pi.inspect.read",
    });
    expectCleanLoad(piInspectReadPack);
  });

  it.each(
    SUPPORTED_PI_BUILTIN_TOOL_SPECS,
  )("allows project-scoped %s inputs from the supported-tool registry", (spec) => {
    expectPiInspectAllow(decidePiTool(spec.toolName, { path: "README.md" }));
  });

  it("allows optional pathless list/search tools as implicit project cwd reads", () => {
    for (const spec of SUPPORTED_PI_BUILTIN_TOOL_SPECS.filter(
      (entry) => entry.pathOptional === true,
    )) {
      expectPiInspectAllow(decidePiTool(spec.toolName, {}));
    }
  });

  it("does not allow mutation tools from the read pack", () => {
    for (const spec of SUPPORTED_PI_MUTATION_TOOL_SPECS) {
      const input =
        spec.toolName === "edit"
          ? { path: "src/a.ts", newText: "replacement" }
          : { path: "src/a.ts", content: "body" };
      const enriched = enrichToolShapeWithPathFacts(
        analyzePiBuiltinTool(spec, input),
        { cwd: TEST_CWD, projectScope: projectScope() },
      );

      expect(
        decide(enriched, {
          floor: sealedFloor.rules,
          active: piInspectReadPack.rules,
        }),
      ).toMatchObject({
        effect: "review",
        provenance: { source: "default" },
      });
    }
  });

  it("allows configured temp-scope inputs", () => {
    expectPiInspectAllow(decidePiTool("grep", { path: TEST_TEMP_DIR }));
  });

  it("allows every typed read/search/list operation inside agent-support", () => {
    const supportScope = projectScope({
      agentSupportDirectories: [AGENT_SUPPORT_ROOT],
    });

    for (const spec of SUPPORTED_PI_BUILTIN_TOOL_SPECS) {
      expectPiInspectAllow(
        decidePiTool(
          spec.toolName,
          { path: `${AGENT_SUPPORT_ROOT}/SKILL.md` },
          { projectScope: supportScope },
        ),
      );
    }
  });

  it.each([
    { path: "~/dev/notes.md", why: "ordinary home development notes" },
    { path: "~/.pi/agent/sessions/x", why: "Pi session context" },
  ])("allows non-secret home reads: $why", ({ path }) => {
    for (const spec of SUPPORTED_PI_BUILTIN_TOOL_SPECS) {
      expectPiInspectAllow(decidePiTool(spec.toolName, { path }));
    }
  });

  it.each([
    { path: "~/.ssh/id_rsa", why: "SSH key material" },
    { path: "~/.pi/agent/auth.json", why: "Pi auth material" },
    { path: "~/.config/gh/hosts.yml", why: "GitHub credentials" },
    { path: "/etc/passwd", why: "system path" },
    { path: "/srv/outside", why: "outside-project path" },
  ])("reviews typed reads outside the non-secret home baseline: $why", ({
    path,
  }) => {
    expect(
      decidePiTool(
        "read",
        { path },
        {
          projectScope: projectScope({
            agentSupportDirectories: [AGENT_SUPPORT_ROOT],
          }),
        },
      ),
    ).toMatchObject({ effect: "review" });
  });

  it.each([
    { path: "/home/user/.ssh/id_rsa", why: "home/outside path" },
    { path: "/etc/passwd", why: "system path" },
    { path: "/srv/outside", why: "outside-project path" },
    { path: "../outside", why: "parent traversal outside project" },
    { path: "/repo/denied/secret", why: "denied directory" },
    { path: "src/*", why: "glob/dynamic path" },
    { path: "$FILE", why: "runtime expansion path" },
    { path: "~/.ssh/config", why: "unresolved home path" },
  ])("reviews $why", ({ path }) => {
    expect(
      decidePiTool(
        "read",
        { path },
        {
          projectScope: projectScope({ deniedDirectories: ["/repo/denied"] }),
        },
      ),
    ).toMatchObject({ effect: "review" });
  });

  it.each([
    { input: {}, why: "missing required read path" },
    { input: { path: ["README.md"] }, why: "array path" },
    { input: { path: "" }, why: "empty path" },
    { input: null, why: "malformed non-object input" },
  ])("reviews malformed inputs: $why", ({ input }) => {
    expect(decidePiTool("read", input)).toMatchObject({ effect: "review" });
  });
});
