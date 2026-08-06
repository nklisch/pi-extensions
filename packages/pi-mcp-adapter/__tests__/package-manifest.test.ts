import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  files?: string[];
  exports?: Record<string, unknown>;
  name?: string;
  license?: string;
  engines?: Record<string, string>;
  types?: string;
};

describe("package.json files", () => {
  it("exports only the built extension and documented programmatic lifecycle", () => {
    expect(packageJson.name).toBe("@nklisch/pi-mcp-adapter");
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.engines?.node).toBe(">=22.19.0");
    expect(packageJson.types).toBe("./dist/index.d.ts");
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

  it("publishes every root runtime TypeScript module", () => {
    const publishedFiles = new Set(packageJson.files ?? []);
    const runtimeModules = readdirSync(repoRoot)
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) => !entry.endsWith(".test.ts"))
      .filter((entry) => entry !== "vitest.config.ts");

    expect(runtimeModules.length).toBeGreaterThan(0);
    expect(runtimeModules.filter((entry) => !publishedFiles.has(entry))).toEqual([]);
    expect([...publishedFiles].filter((entry) => entry !== "dist" && !existsSync(join(repoRoot, entry)))).toEqual([]);
  });

  it("does not import the peer-dependent MCP app bridge from runtime modules", () => {
    const runtimeModules = readdirSync(repoRoot)
      .filter((entry) => entry.endsWith(".ts"))
      .filter((entry) => !entry.endsWith(".test.ts"))
      .filter((entry) => entry !== "vitest.config.ts");

    const offenders = runtimeModules.filter((entry) =>
      readFileSync(join(repoRoot, entry), "utf-8").includes("@modelcontextprotocol/ext-apps/app-bridge")
    );

    expect(offenders).toEqual([]);
  });
});

describe("package.json dependency policy", () => {
  it("requires the compatible Pi host surface and keeps exact repository dev pins", () => {
    for (const name of [
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
    ]) {
      expect(packageJson.peerDependencies?.[name]).toBe(">=0.82.0 <1");
      expect(packageJson.dependencies?.[name]).toBeUndefined();
      expect(packageJson.devDependencies?.[name]).toBe("0.82.0");
    }
  });

  it("uses stable modular SDK v2 without the legacy monolithic SDK", () => {
    expect(packageJson.dependencies?.["@modelcontextprotocol/ext-apps"]).toBeDefined();
    expect(packageJson.dependencies?.["@modelcontextprotocol/sdk"]).toBeUndefined();
    expect(packageJson.dependencies?.["@modelcontextprotocol/client"]).toBe("2.0.0");
    expect(packageJson.dependencies?.["@modelcontextprotocol/core"]).toBe("2.0.0");
  });
});
