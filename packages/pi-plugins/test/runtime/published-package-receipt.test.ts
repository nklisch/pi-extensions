import { chmod, cp, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  digestPublishedPackageTree,
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
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "dist", "entry.js"), "export const marker = 'exact';\n", { mode: 0o755 });
  await writeFile(join(root, "LICENSE"), "fixture license\n");
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "@fixture/runtime",
    version: "1.2.3",
    license: "MIT",
    engines: { node: ">=24" },
    peerDependencies: { "@earendil-works/pi-coding-agent": ">=0.80.0 <0.81.0" },
    exports: { ".": { import: "./dist/entry.js" } },
    pi: { extensions: ["./dist/entry.js"] },
  }, null, 2)}\n`);
  const tree = await digestPublishedPackageTree(root);
  const license = await import("node:crypto").then(({ createHash }) =>
    createHash("sha256").update("fixture license\n").digest("hex"));
  return {
    root,
    entry: join(root, "dist", "entry.js"),
    receipt: {
      packageName: "@fixture/runtime",
      version: "1.2.3",
      registryIntegrity: `sha512-${"A".repeat(86)}==`,
      installedTreeDigest: tree,
      license: "MIT",
      licenseSha256: license,
      releaseTag: "v1.2.3@0123456789abcdef0123456789abcdef01234567",
      releaseCommit: "0123456789abcdef0123456789abcdef01234567",
      upstreamBaseCommit: "89abcdef0123456789abcdef0123456789abcdef",
      nodeEngine: ">=24",
      piPeerRange: ">=0.80.0 <0.81.0",
      requiredExports: ["."],
      piExtensions: ["./dist/entry.js"],
    },
  };
}

describe("published package receipt", () => {
  it("verifies manifest, license, exports/resources, and canonical installed bytes", async () => {
    const value = await fixture();
    await expect(probePublishedPackage({
      entrySpecifier: pathToFileURL(value.entry).href,
      receipt: value.receipt,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: "verified", packageRoot: value.root, entry: value.entry });
  });

  it("fails closed for missing, extra, modified, executable-mode, and manifest drift", async () => {
    const value = await fixture();
    for (const mutate of [
      async (root: string) => writeFile(join(root, "dist", "entry.js"), "globalThis.DRIFT_SENTINEL = true;\n"),
      async (root: string) => writeFile(join(root, "extra.js"), "extra\n"),
      async (root: string) => chmod(join(root, "dist", "entry.js"), 0o644),
      async (root: string) => writeFile(join(root, "package.json"), "{}\n"),
    ]) {
      const copy = await mkdtemp(join(tmpdir(), "published-package-drift-"));
      roots.push(copy);
      await cp(value.root, copy, { recursive: true, force: true });
      await mutate(copy);
      await expect(probePublishedPackage({
        entrySpecifier: pathToFileURL(join(copy, "dist", "entry.js")).href,
        receipt: value.receipt,
        signal: new AbortController().signal,
      })).resolves.toEqual({ kind: "unavailable", code: "PACKAGE_DRIFT" });
    }
    expect((globalThis as { DRIFT_SENTINEL?: boolean }).DRIFT_SENTINEL).toBeUndefined();
  });

  it("rejects links and package-root escapes without following them", async () => {
    const value = await fixture();
    const linked = await mkdtemp(join(tmpdir(), "published-package-link-"));
    roots.push(linked);
    await cp(value.root, linked, { recursive: true });
    await symlink(value.entry, join(linked, "linked.js"));
    await expect(digestPublishedPackageTree(linked)).rejects.toThrow(/symbolic link/i);
    await expect(probePublishedPackage({
      entrySpecifier: pathToFileURL(join(linked, "dist", "entry.js")).href,
      receipt: value.receipt,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: "unavailable", code: "PACKAGE_DRIFT" });
  });
});
