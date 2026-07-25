import { describe, expect, it } from "vitest";

import { piInspectReadPack } from "../../src/packs/pi.inspect.read.ts";
import {
  createPiBuiltinToolAnalyzers,
  SUPPORTED_PI_BUILTIN_TOOL_SPECS,
  SUPPORTED_PI_EXTENSION_TOOL_SPECS,
  SUPPORTED_PI_MUTATION_TOOL_SPECS,
} from "../../src/parse/native-tool.ts";
import {
  createAnalyzerRegistry,
  createDefaultAnalyzerRegistry,
} from "../../src/parse/registry.ts";

describe("Pi built-in tool analyzers", () => {
  it("registers every supported tool from the shared spec registry", async () => {
    const registry = createDefaultAnalyzerRegistry();

    for (const spec of SUPPORTED_PI_BUILTIN_TOOL_SPECS) {
      const input = spec.pathKey === undefined ? {} : { [spec.pathKey]: "src" };
      const shape = await registry.analyze(spec.toolName, input);

      expect(shape).toEqual(
        expect.objectContaining({
          kind: "pi-tool",
          toolName: spec.toolName,
          operation: spec.operation,
          rawInput: input,
          diagnostics: [],
        }),
      );
      if (shape.kind !== "pi-tool") {
        throw new Error(`${spec.toolName} did not produce a pi-tool shape`);
      }
      expect(shape.pathInputs).toEqual(
        spec.pathKey === undefined
          ? []
          : [
              {
                key: spec.pathKey,
                raw: "src",
                required: spec.pathOptional !== true,
              },
            ],
      );
    }
  });

  it("derives standalone analyzer registration from the same supported-tool registry", async () => {
    const registry = createAnalyzerRegistry(createPiBuiltinToolAnalyzers());

    await expect(
      registry.analyze("read", { path: "README.md" }),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: "pi-tool",
        toolName: "read",
        operation: "read-file",
        pathInputs: [{ key: "path", raw: "README.md", required: true }],
      }),
    );
  });

  it("allows optional path-bearing tools to omit the path input", async () => {
    const registry = createDefaultAnalyzerRegistry();

    await expect(registry.analyze("ls", {})).resolves.toEqual(
      expect.objectContaining({
        kind: "pi-tool",
        toolName: "ls",
        operation: "list-directory",
        pathInputs: [],
        diagnostics: [],
      }),
    );
  });

  it("registers typed public extension tools without treating them as unknown", async () => {
    const registry = createDefaultAnalyzerRegistry();

    for (const spec of SUPPORTED_PI_EXTENSION_TOOL_SPECS) {
      const input =
        spec.operation === "embedded-shell" ? { command: "pnpm test" } : {};
      await expect(registry.analyze(spec.toolName, input)).resolves.toEqual(
        expect.objectContaining({
          kind: "pi-tool",
          toolName: spec.toolName,
          operation: spec.operation,
          pathInputs: [],
          diagnostics: [],
        }),
      );
    }
  });

  it("registers edit and write as built-in mutation analyzers", async () => {
    const registry = createDefaultAnalyzerRegistry();

    // Keep the historical flat shape as explicit backward compatibility for
    // existing fixtures; current Pi sends the batched `edits[]` shape below.
    await expect(
      registry.analyze("edit", {
        path: "src/parse/pi-tools.ts",
        oldText: "before",
        newText: "after text",
        replaceAll: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: "pi-tool",
        toolName: "edit",
        operation: "mutation",
        pathInputs: [
          { key: "path", raw: "src/parse/pi-tools.ts", required: true },
        ],
        diagnostics: [],
        mutationFacts: {
          kind: "edit",
          targetPath: "src/parse/pi-tools.ts",
          editCount: 1,
          oldTextLength: 6,
          newTextLength: 10,
          replaceAll: true,
          createsContent: false,
        },
      }),
    );

    await expect(
      registry.analyze("edit", {
        path: "src/parse/pi-tools.ts",
        edits: [{ oldText: "before", newText: "after text" }],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: "pi-tool",
        toolName: "edit",
        operation: "mutation",
        pathInputs: [
          { key: "path", raw: "src/parse/pi-tools.ts", required: true },
        ],
        diagnostics: [],
        mutationFacts: {
          kind: "edit",
          targetPath: "src/parse/pi-tools.ts",
          editCount: 1,
          oldTextLength: 6,
          newTextLength: 10,
          createsContent: false,
        },
      }),
    );

    await expect(
      registry.analyze("write", {
        path: "docs/NOTE.md",
        content: "hello\n",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: "pi-tool",
        toolName: "write",
        operation: "mutation",
        pathInputs: [{ key: "path", raw: "docs/NOTE.md", required: true }],
        diagnostics: [],
        mutationFacts: {
          kind: "write",
          targetPath: "docs/NOTE.md",
          contentLength: 6,
          overwrites: "unknown",
        },
      }),
    );
  });

  it("returns diagnostic pi-tool shapes for malformed supported-tool input", async () => {
    const registry = createDefaultAnalyzerRegistry();

    await expect(registry.analyze("read", {})).resolves.toEqual(
      expect.objectContaining({
        kind: "pi-tool",
        toolName: "read",
        diagnostics: [
          expect.objectContaining({
            code: "pi-tool:missing-path-input",
            severity: "error",
          }),
        ],
      }),
    );

    await expect(
      registry.analyze("grep", { path: ["src"], pattern: "TODO" }),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: "pi-tool",
        toolName: "grep",
        diagnostics: [
          expect.objectContaining({
            code: "pi-tool:invalid-path-input",
            severity: "error",
          }),
        ],
      }),
    );
  });

  it("diagnoses unresolved path syntax without dropping the declared path input", async () => {
    const registry = createDefaultAnalyzerRegistry();

    await expect(
      registry.analyze("fffind", { pattern: "profile", path: "src/**/*.ts" }),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: "pi-tool",
        toolName: "fffind",
        operation: "find-files",
        pathInputs: [{ key: "path", raw: "src/**/*.ts", required: false }],
        diagnostics: [
          expect.objectContaining({
            code: "pi-tool:unresolved-path-input",
            severity: "warning",
          }),
        ],
      }),
    );
  });

  it.each([
    {
      toolName: "edit",
      input: { oldText: "a", newText: "b" },
      description: "edit missing path",
    },
    {
      toolName: "edit",
      input: { path: "src/a.ts", oldText: "a" },
      description: "edit missing edits array or legacy newText",
    },
    {
      toolName: "edit",
      input: { path: "src/a.ts", edits: [] },
      description: "edit empty edits array",
    },
    {
      toolName: "edit",
      input: { path: "src/a.ts", edits: [null] },
      description: "edit non-object batched entry",
    },
    {
      toolName: "edit",
      input: { path: "src/a.ts", edits: [{ oldText: "a" }] },
      description: "edit batched entry missing newText",
    },
    {
      toolName: "edit",
      input: { path: "src/a.ts", edits: [{ oldText: "a", newText: 42 }] },
      description: "edit batched entry non-string newText",
    },
    {
      toolName: "edit",
      input: {
        path: "src/a.ts",
        oldText: "a",
        newText: "b",
        edits: [{ oldText: "a", newText: "b" }],
      },
      description: "edit mixed legacy and batched shape",
    },
    {
      toolName: "edit",
      input: { path: "src/a.ts", oldText: 1, newText: "b" },
      description: "edit non-string oldText",
    },
    {
      toolName: "edit",
      input: { path: "src/a.ts", oldText: "a", newText: false },
      description: "edit non-string newText",
    },
    {
      toolName: "write",
      input: { content: "body" },
      description: "write missing path",
    },
    {
      toolName: "write",
      input: { path: "src/a.ts" },
      description: "write missing content",
    },
    {
      toolName: "write",
      input: { path: "src/a.ts", content: ["body"] },
      description: "write non-string content",
    },
  ])("diagnoses malformed mutation input: $description", async ({
    toolName,
    input,
  }) => {
    const registry = createDefaultAnalyzerRegistry();

    const shape = await registry.analyze(toolName, input);

    expect(shape).toEqual(
      expect.objectContaining({
        kind: "pi-tool",
        toolName,
        operation: "mutation",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "pi-tool:malformed-mutation-input",
            severity: "error",
          }),
        ]),
      }),
    );
  });

  it("names the missing batched edit entry field in malformed diagnostics", async () => {
    const registry = createDefaultAnalyzerRegistry();

    const shape = await registry.analyze("edit", {
      path: "src/a.ts",
      edits: [{ oldText: "before" }],
    });

    expect(shape.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "pi-tool:malformed-mutation-input",
          message: expect.stringContaining("edits[0].newText"),
        }),
      ]),
    );
  });

  it("marks edit as creating content when oldText is empty or absent", async () => {
    const registry = createDefaultAnalyzerRegistry();

    await expect(
      registry.analyze("edit", {
        path: "src/new.ts",
        oldText: "",
        newText: "export {};",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: "pi-tool",
        toolName: "edit",
        operation: "mutation",
        diagnostics: [
          expect.objectContaining({
            code: "pi-tool:edit-empty-replacement",
            severity: "warning",
          }),
        ],
        mutationFacts: expect.objectContaining({
          kind: "edit",
          targetPath: "src/new.ts",
          oldTextLength: 0,
          newTextLength: 10,
          createsContent: true,
        }),
      }),
    );

    await expect(
      registry.analyze("edit", {
        path: "src/new.ts",
        newText: "export {};",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        diagnostics: [],
        mutationFacts: expect.objectContaining({
          kind: "edit",
          editCount: 1,
          createsContent: true,
        }),
      }),
    );

    await expect(
      registry.analyze("edit", {
        path: "src/new.ts",
        edits: [{ oldText: "", newText: "export {};" }],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            code: "pi-tool:edit-empty-replacement",
            severity: "warning",
          }),
        ],
        mutationFacts: expect.objectContaining({
          kind: "edit",
          editCount: 1,
          oldTextLength: 0,
          newTextLength: 10,
          createsContent: true,
        }),
      }),
    );
  });

  it("is total for adversarial mutation inputs", async () => {
    const registry = createDefaultAnalyzerRegistry();
    const throwingPath = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(throwingPath, "path", {
      enumerable: true,
      get() {
        throw new Error("path getter failed");
      },
    });

    for (const [toolName, input] of [
      ["edit", null],
      ["edit", []],
      ["edit", { path: { nested: true }, oldText: {}, newText: Symbol("x") }],
      ["write", null],
      ["write", { path: 1, content: { nested: true } }],
      ["write", throwingPath],
    ] as const) {
      await expect(registry.analyze(toolName, input)).resolves.toEqual(
        expect.objectContaining({
          kind: "pi-tool",
          toolName,
          operation: "mutation",
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ severity: "error" }),
          ]),
        }),
      );
    }
  });

  it("keeps mutation tools out of the read-pack source registry", () => {
    const readToolNames = SUPPORTED_PI_BUILTIN_TOOL_SPECS.map(
      (spec) => spec.toolName,
    );
    const mutationToolNames = SUPPORTED_PI_MUTATION_TOOL_SPECS.map(
      (spec) => spec.toolName,
    );

    expect(mutationToolNames).toEqual(["edit", "write"]);
    expect(readToolNames).not.toContain("edit");
    expect(readToolNames).not.toContain("write");
    expect(JSON.stringify(piInspectReadPack.rules)).not.toContain('"edit"');
    expect(JSON.stringify(piInspectReadPack.rules)).not.toContain('"write"');
  });
});
