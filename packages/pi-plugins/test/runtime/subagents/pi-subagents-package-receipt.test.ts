import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

describe("published pi-subagents package receipt", () => {
  it("pins the exact registry identity and root-only public surface", async () => {
    // In the monorepo the dependency is a workspace link: the sibling manifest
    // is the package-owned source of truth, and the root lockfile records the
    // link rather than a registry SRI.
    const [manifestText, lockText] = await Promise.all([
      readFile(resolve(repoRoot, "packages/pi-subagents/package.json"), "utf8"),
      readFile(resolve(repoRoot, "package-lock.json"), "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    const lock = JSON.parse(lockText) as {
      packages?: Record<string, { version?: string; link?: boolean; resolved?: string }>;
    };

    expect(manifest).toMatchObject({
      name: "@nklisch/pi-subagents",
      version: "18.1.0-nklisch.3",
      license: "MIT",
      engines: { node: ">=22" },
      peerDependencies: {
        "@earendil-works/pi-ai": ">=0.75.0",
        "@earendil-works/pi-coding-agent": ">=0.80.5",
        "@earendil-works/pi-tui": ">=0.75.0",
      },
      exports: {
        ".": { types: "./dist/public.d.ts", default: "./src/service/service.ts" },
        "./settings": { types: "./dist/settings.d.ts", default: "./src/layered-settings.ts" },
      },
    });
    expect(lock.packages?.["node_modules/@nklisch/pi-subagents"]).toMatchObject({
      link: true,
      resolved: "packages/pi-subagents",
    });
    expect(lock.packages?.["packages/pi-subagents"]?.version).toBe("18.1.0-nklisch.3");
  });
});
