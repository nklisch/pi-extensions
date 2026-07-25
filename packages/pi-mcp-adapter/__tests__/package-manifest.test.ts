import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
  files?: string[];
  exports?: Record<string, string>;
  name?: string;
  license?: string;
  engines?: Record<string, string>;
};

describe("package.json files", () => {
  it("publishes every root runtime TypeScript module", () => {
    const publishedFiles = new Set(packageJson.files ?? []);
    const runtimeModules = readdirSync(repoRoot)
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) => !entry.endsWith(".test.ts"))
      .filter((entry) => entry !== "vitest.config.ts");

    expect(runtimeModules.length).toBeGreaterThan(0);
    expect(runtimeModules.filter((entry) => !publishedFiles.has(entry))).toEqual([]);
  });

  it("exports only the extension and documented programmatic lifecycle", () => {
    expect(packageJson.name).toBe("@nklisch/pi-mcp-adapter");
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.engines?.node).toBe(">=22.19.0");
    expect(packageJson.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./programmatic": {
        types: "./dist/programmatic.d.ts",
        import: "./dist/programmatic.js",
      },
    });
    expect(packageJson.exports).not.toHaveProperty("./server-manager");
  });
});
