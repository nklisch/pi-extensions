import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const parseSourceDir = fileURLToPath(new URL("../src/parse", import.meta.url));

interface SourceFile {
  readonly name: string;
  readonly source: string;
}

function readParseSourceFiles(): readonly SourceFile[] {
  return readdirSync(parseSourceDir)
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => ({
      name: entry,
      source: readFileSync(join(parseSourceDir, entry), "utf8"),
    }));
}

function expectNoMatch(
  sourceFiles: readonly SourceFile[],
  pattern: RegExp,
  description: string,
): void {
  const offenders = sourceFiles
    .filter(({ source }) => pattern.test(source))
    .map(({ name }) => basename(name));

  expect(offenders, description).toEqual([]);
}

describe("parse module boundaries", () => {
  it("does not import the native tree-sitter-bash entrypoint", () => {
    const sourceFiles = readParseSourceFiles();

    expectNoMatch(
      sourceFiles,
      /^\s*import\s*["']tree-sitter-bash["']/m,
      "side-effect imports of tree-sitter-bash hit the native entrypoint",
    );
    expectNoMatch(
      sourceFiles,
      /\bfrom\s*["']tree-sitter-bash["']/,
      "from-imports of tree-sitter-bash hit the native entrypoint",
    );
    expectNoMatch(
      sourceFiles,
      /\b(?:require|import)\(\s*["']tree-sitter-bash["']\s*\)/,
      "dynamic require/import of tree-sitter-bash hits the native entrypoint",
    );
    expectNoMatch(
      sourceFiles,
      /\brequire\.resolve\(\s*["']tree-sitter-bash["']\s*\)/,
      "require.resolve of the bare tree-sitter-bash package targets the native entrypoint",
    );

    expect(sourceFiles.some(({ name }) => name === "native-parser.ts")).toBe(
      true,
    );
    expectNoMatch(
      sourceFiles,
      /tree-sitter-bash\/tree-sitter-bash\.wasm/,
      "the WASM parser is removed after the native cutover",
    );
  });

  it("keeps parse modules independent of Pi runtime and config edges", () => {
    const sourceFiles = readParseSourceFiles();

    expectNoMatch(
      sourceFiles,
      /(?:\bfrom\s*|import\s*\(\s*)["']@earendil-works\/pi-coding-agent(?:\/[^"']*)?["']/,
      "parse modules must not import Pi runtime APIs",
    );
    expectNoMatch(
      sourceFiles,
      /(?:\bfrom\s*|import\s*\(\s*)["']\.\.\/(?:runtime|config)(?:\/[^"']*)?["']/,
      "parse modules must not import runtime/config edges",
    );
  });
});
