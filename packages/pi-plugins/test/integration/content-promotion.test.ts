import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createContentManifest, createMaterializationBinding, hashContent } from "../../src/domain/content-manifest.js";
import { createResolvedPluginSource } from "../../src/domain/source.js";
import { createPromotionPlan } from "../../src/application/content-promotion.js";
import { createNodeContentStore, createNodeContentStoreWithPlatform } from "../../src/infrastructure/filesystem/create-content-store.js";
import { createNodeContentStorePlatform, renameNoReplaceByProbe } from "../../src/infrastructure/filesystem/content-store-durability.js";
import { inspectPublishedRevision } from "../../src/infrastructure/filesystem/immutable-content-store.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;
const crashFixture = resolve(process.cwd(), "test/fixtures/marketplace/child-content-publication-crash.mjs");
const sourceLoader = resolve(process.cwd(), "test/fixtures/locking/source-loader.mjs");

async function makeDirectoriesWritable(root: string): Promise<void> {
  const stat = await lstat(root).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) return;
  await chmod(root, 0o700).catch(() => undefined);
  for (const name of await readdir(root).catch(() => [])) await makeDirectoriesWritable(join(root, name));
}

describe("content store composition", () => {
  it("capability-probes the production atomic visibility protocol", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-content-public-"));
    try {
      const store = await createNodeContentStore({ hostRoot: join(root, "host") });
      await expect(store.capabilities(signal)).resolves.toEqual({
        atomicNoReplaceDirectory: true,
        fileSync: true,
        directorySync: true,
        readOnlyModeEnforcement: "posix-mode",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers exactly after a publisher crashes before atomic visibility", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-content-crash-publication-"));
    const hostRoot = join(root, "host");
    try {
      const child = spawn(process.execPath, [
        "--experimental-strip-types",
        "--experimental-transform-types",
        "--loader",
        sourceLoader,
        crashFixture,
        hostRoot,
      ], { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: "", VITEST: undefined }, stdio: ["ignore", "pipe", "pipe"] });
      const ready = await new Promise<string>((resolvePromise, rejectPromise) => {
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        child.stdout.once("data", (chunk) => resolvePromise(chunk.toString()));
        child.once("error", rejectPromise);
        child.once("close", (code) => {
          if (code !== null && code !== 0) rejectPromise(new Error(`publication child exited before crash point: ${stderr}`));
        });
      });
      expect(JSON.parse(ready)).toMatchObject({ source: expect.stringContaining(".payload-") });
      child.kill("SIGKILL");
      await new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));

      const store = await createNodeContentStore({ hostRoot });
      const prepare = async () => {
        const allocation = await store.allocateStaging(signal);
        await mkdir(join(allocation.slot.root, "content"));
        await writeFile(join(allocation.slot.root, "content", "plugin.txt"), "crash-safe");
        const bytes = new TextEncoder().encode("crash-safe");
        const manifest = createContentManifest([{ kind: "file", path: "plugin.txt", mode: 0o644, size: bytes.byteLength, digest: hashContent(bytes, sha256) }], sha256);
        const source = createResolvedPluginSource({ kind: "git", url: "https://example.com/crash-safe.git", revision: "e".repeat(40) }, sha256);
        return createPromotionPlan({ kind: "plugin", allocation, materialized: { root: join(allocation.slot.root, "content"), source, content: manifest, binding: createMaterializationBinding(source.hash, manifest.rootDigest, sha256) } }, sha256);
      };
      const first = await store.promote(await prepare(), signal);
      expect(first.kind).toBe("promoted");
      expect(await readFile(join(first.root, "plugin.txt"), "utf8")).toBe("crash-safe");
      const marker = (await readdir(join(hostRoot, "stores", "v1", "plugins"))).find((name) => /^[0-9a-f]{64}$/.test(name))!;
      const inspected = await inspectPublishedRevision(join(hostRoot, "stores", "v1", "plugins", marker), sha256);
      const retryPlan = await prepare();
      expect(inspected.identity).toEqual(retryPlan.identity);
      expect(inspected.binding).toBe(retryPlan.binding);
      expect(inspected.manifest).toEqual(retryPlan.manifest);
      const second = await store.promote(retryPlan, signal);
      expect(second.kind).toBe("already-present");
      const entries = await readdir(join(hostRoot, "stores", "v1", "plugins"));
      const markers = entries.filter((name) => /^[0-9a-f]{64}$/.test(name));
      expect(markers).toHaveLength(1);
      await expect(lstat(join(hostRoot, "stores", "v1", "plugins", markers[0]!))).resolves.toMatchObject({});
      expect((await lstat(join(hostRoot, "stores", "v1", "plugins", markers[0]!))).isFile()).toBe(true);
    } finally {
      await makeDirectoriesWritable(root);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("promotes a caller-owned materializer handoff through the composed port", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-content-composed-"));
    let publishedRoot: string | undefined;
    try {
      const store = await createNodeContentStoreWithPlatform({
        hostRoot: join(root, "host"),
        platform: createNodeContentStorePlatform({ renameNoReplace: renameNoReplaceByProbe }),
        randomBytes: () => Uint8Array.from({ length: 16 }, (_, index) => index + 3),
      });
      const allocation = await store.allocateStaging(signal);
      await mkdir(join(allocation.slot.root, "content"));
      await writeFile(join(allocation.slot.root, "content", "README.md"), "hello");
      const bytes = new TextEncoder().encode("hello");
      const manifest = createContentManifest([{ kind: "file", path: "README.md", mode: 0o644, size: bytes.byteLength, digest: hashContent(bytes, sha256) }], sha256);
      const source = createResolvedPluginSource({ kind: "git", url: "https://example.com/composed.git", revision: "c".repeat(40) }, sha256);
      const plan = createPromotionPlan({
        kind: "plugin",
        allocation,
        materialized: { root: join(allocation.slot.root, "content"), source, content: manifest, binding: createMaterializationBinding(source.hash, manifest.rootDigest, sha256) },
      }, sha256);
      const result = await store.promote(plan, signal);
      publishedRoot = result.root.replace(/[/\\]content$/, "");
      expect(result.kind).toBe("promoted");
      expect(await readFile(join(result.root, "README.md"), "utf8")).toBe("hello");
      expect(Object.keys(store).sort()).toEqual([
        "allocateProjectionRoot",
        "allocateStaging",
        "capabilities",
        "discardProjectionRoot",
        "discardStaging",
        "ensureDataRoot",
        "promote",
        "resolveMarketplace",
        "resolvePlugin",
        "resolveProjectionRoot",
        "sealProjectionRoot",
      ]);
    } finally {
      if (publishedRoot !== undefined) {
        await chmod(join(publishedRoot, "content", "README.md"), 0o644).catch(() => undefined);
        await chmod(join(publishedRoot, "content"), 0o755).catch(() => undefined);
        await chmod(join(publishedRoot, "metadata.json"), 0o644).catch(() => undefined);
        await chmod(join(publishedRoot, "READY"), 0o644).catch(() => undefined);
        await chmod(publishedRoot, 0o755).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
