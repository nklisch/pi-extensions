import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const packageManifestUrl = new URL(
  "../../../node_modules/@nklisch/pi-subagents/package.json",
  import.meta.url,
);
const lockfileUrl = new URL("../../../package-lock.json", import.meta.url);

describe("published pi-subagents package receipt", () => {
  it("pins the exact registry bytes and root-only public surface", async () => {
    const [manifestText, lockText] = await Promise.all([
      readFile(packageManifestUrl, "utf8"),
      readFile(lockfileUrl, "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    const lock = JSON.parse(lockText) as {
      packages?: Record<string, { version?: string; integrity?: string }>;
    };

    expect(manifest).toMatchObject({
      name: "@nklisch/pi-subagents",
      version: "18.0.4-nklisch.0",
      license: "MIT",
      engines: { node: ">=22" },
      peerDependencies: {
        "@earendil-works/pi-ai": ">=0.75.0",
        "@earendil-works/pi-coding-agent": ">=0.75.0",
        "@earendil-works/pi-tui": ">=0.75.0",
      },
      exports: {
        ".": { types: "./dist/public.d.ts", default: "./src/service/service.ts" },
        "./settings": { types: "./dist/settings.d.ts", default: "./src/layered-settings.ts" },
      },
    });
    expect(lock.packages?.["node_modules/@nklisch/pi-subagents"]).toMatchObject({
      version: "18.0.4-nklisch.0",
      resolved: "https://registry.npmjs.org/@nklisch/pi-subagents/-/pi-subagents-18.0.4-nklisch.0.tgz",
      integrity: "sha512-33Q8JDffXUuiT1M3XjLXCI4If9p+3AOwsUp/b5f1+B7Y5JI8Z8SVU+Dncq0umAG2IjgVYKnT9FHToFHNoZGWoQ==",
      license: "MIT",
      engines: { node: ">=22" },
      peerDependencies: {
        "@earendil-works/pi-ai": ">=0.75.0",
        "@earendil-works/pi-coding-agent": ">=0.75.0",
        "@earendil-works/pi-tui": ">=0.75.0",
      },
    });
  });
});
