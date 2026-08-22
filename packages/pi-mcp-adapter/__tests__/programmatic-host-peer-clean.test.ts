/**
 * Contract test: importing dist/programmatic.js under native ESM must
 * succeed and yield a working createMcpAdapter, even when @earendil-works/*
 * packages are only resolvable via the monorepo's node_modules (not via
 * pi's jiti aliases).
 *
 * This guards against the production bug where a static top-level
 * `import { complete } from "@earendil-works/pi-ai/compat"` in the
 * programmatic graph crashed module load under native import(), silently
 * disabling the MCP runtime for every pi session.
 *
 * The test works in two layers:
 *
 * 1. **Static analysis**: scans the compiled dist output for static imports
 *    of @earendil-works/pi-ai (the specific package whose /compat subpath
 *    is unresolvable outside jiti). Dynamic import() is fine -- it's
 *    deferred and guarded at the call site.
 *
 * 2. **Runtime import**: directly imports the built programmatic entry and
 *    confirms createMcpAdapter is a function. This catches any transitive
 *    load failure regardless of cause.
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname, basename, join } from "node:path";
import { describe, expect, it } from "vitest";

const DIST_DIR = resolve(import.meta.dirname!, "..", "dist");

/**
 * Walk the static import graph reachable from an entry file.
 * Only follows relative imports; external package specifiers are collected
 * but not traversed. Dynamic import() is intentionally skipped.
 */
async function collectStaticImports(entryPath: string): Promise<{
  externalImports: Map<string, string[]>;
}> {
  const visited = new Set<string>();
  const externalImports = new Map<string, string[]>();
  const queue = [entryPath];

  // Match static import/export-from but not dynamic import().
  const staticImportRe = /(?:^|\n)\s*(?:import|export)\s+(?:(?![\(])[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;

  while (queue.length > 0) {
    const filePath = queue.pop()!;
    const normalized = resolve(filePath);
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    let content: string;
    try {
      content = await readFile(normalized, "utf-8");
    } catch {
      continue;
    }

    for (const match of content.matchAll(staticImportRe)) {
      const specifier = match[1]!;
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        queue.push(resolve(dirname(normalized), specifier));
      } else {
        const sources = externalImports.get(specifier) ?? [];
        sources.push(normalized);
        externalImports.set(specifier, sources);
      }
    }
  }

  return { externalImports };
}

describe("programmatic entry host-peer-cleanliness", () => {
  it("static import graph has no @earendil-works/pi-ai runtime imports", async () => {
    // pi-ai/compat is the specific subpath that requires jiti aliases to
    // resolve. Other @earendil-works/* packages (pi-tui, pi-coding-agent)
    // resolve from the monorepo node_modules in production because they're
    // real npm dependencies. pi-ai/compat is only available through pi's
    // jiti alias mapping.
    const entryPath = join(DIST_DIR, "programmatic.js");
    const { externalImports } = await collectStaticImports(entryPath);

    const piAiImports = [...externalImports.entries()]
      .filter(([specifier]) => specifier.startsWith("@earendil-works/pi-ai"))
      .map(([specifier, sources]) => ({
        specifier,
        importedBy: sources.map(s => basename(s)),
      }));

    expect(piAiImports, [
      "The programmatic entry's compiled static import graph must not contain",
      "@earendil-works/pi-ai runtime imports. This package's /compat subpath",
      "is only resolvable under pi's jiti aliases, not native ESM. Found:",
      ...piAiImports.map(i => `  ${i.specifier} <- ${i.importedBy.join(", ")}`),
    ].join("\n")).toEqual([]);
  });

  it("dist/programmatic.js loads under native ESM and exports createMcpAdapter", async () => {
    const entryPath = join(DIST_DIR, "programmatic.js");
    const mod = await import(entryPath);
    expect(typeof mod.createMcpAdapter).toBe("function");
  });
});
