import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  probePublishedPackage,
  type PublishedPackageReceipt,
} from "../../src/runtime/published-package-receipt.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<Readonly<{ root: string; entry: string; receipt: PublishedPackageReceipt }>> {
  const root = await mkdtemp(join(tmpdir(), "published-package-receipt-"));
  roots.push(root);
  await writeFile(join(root, "entry.js"), "export const marker = 'exact';\n", { mode: 0o755 });
  await writeFile(join(root, "LICENSE"), "fixture license\n");
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "@fixture/runtime",
    version: "1.2.3",
    license: "MIT",
    engines: { node: ">=24" },
    peerDependencies: { "@earendil-works/pi-coding-agent": ">=0.80.0 <0.81.0" },
    exports: { ".": { import: "./entry.js" } },
    pi: { extensions: ["./entry.js"] },
  }, null, 2)}\n`);
  return {
    root,
    entry: join(root, "entry.js"),
    receipt: {
      packageName: "@fixture/runtime",
      version: "1.2.3",
      license: "MIT",
      nodeEngine: ">=24",
      piPeerRange: ">=0.80.0 <0.81.0",
      requiredExports: ["."],
      piExtensions: ["./entry.js"],
    },
  };
}

describe("published package receipt", () => {
  it("verifies the manifest contract, exports, and declared Pi resources", async () => {
    const value = await fixture();
    await expect(probePublishedPackage({
      entrySpecifier: pathToFileURL(value.entry).href,
      receipt: value.receipt,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: "verified", packageRoot: value.root, entry: value.entry });
  });

  it("fails closed for manifest drift: version, license, engine, peer, exports, resources", async () => {
    const value = await fixture();
    const mutations: Array<(manifest: Record<string, unknown>) => void> = [
      (manifest) => { manifest.version = "9.9.9"; },
      (manifest) => { manifest.license = "Apache-2.0"; },
      (manifest) => { manifest.engines = { node: ">=99" }; },
      (manifest) => { manifest.peerDependencies = { "@earendil-works/pi-coding-agent": ">=99" }; },
      (manifest) => { manifest.exports = { "./other": { import: "./entry.js" } }; },
      (manifest) => { manifest.pi = { extensions: ["./missing.js"] }; },
    ];
    for (const applyMutation of mutations) {
      const copy = await mkdtemp(join(tmpdir(), "published-package-drift-"));
      roots.push(copy);
      await cp(value.root, copy, { recursive: true, force: true });
      const manifest = JSON.parse(String(await import("node:fs/promises").then((fs) => fs.readFile(join(copy, "package.json"), "utf8"))));
      applyMutation(manifest);
      await writeFile(join(copy, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      await expect(probePublishedPackage({
        entrySpecifier: pathToFileURL(join(copy, "entry.js")).href,
        receipt: value.receipt,
        signal: new AbortController().signal,
      })).resolves.toEqual({ kind: "unavailable", code: "PACKAGE_DRIFT" });
    }
  });

  it("fails closed when the package is missing entirely", async () => {
    const value = await fixture();
    await expect(probePublishedPackage({
      entrySpecifier: "definitely-not-an-installed-package-xyz",
      receipt: value.receipt,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: "unavailable", code: "PACKAGE_MISSING" });
  });

  it("rejects package-root escapes: a linked entry that realpaths outside the root", async () => {
    const value = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "published-package-outside-"));
    roots.push(outside);
    const foreignTarget = join(outside, "foreign.js");
    await writeFile(foreignTarget, "export {};\n");
    const { symlink, rm: rmFile } = await import("node:fs/promises");
    await rmFile(value.entry, { force: true });
    await symlink(foreignTarget, value.entry);
    await expect(probePublishedPackage({
      entrySpecifier: pathToFileURL(value.entry).href,
      receipt: value.receipt,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: "unavailable", code: "PACKAGE_DRIFT" });
  });
});
