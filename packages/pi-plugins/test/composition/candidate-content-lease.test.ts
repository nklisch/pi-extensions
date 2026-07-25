import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPromotionPlan } from "../../src/application/content-promotion.js";
import { CandidateContentCleanupError } from "../../src/application/ports/candidate-content-lease.js";
import { createCandidateContentLeasePort } from "../../src/composition/candidate-content-lease.js";
import { createContentManifest, createMaterializationBinding, hashContent } from "../../src/domain/content-manifest.js";
import { createResolvedPluginSource } from "../../src/domain/source.js";
import { createNodeContentStore } from "../../src/infrastructure/filesystem/create-content-store.js";
import { stagingOwnerSidecarPath } from "../../src/infrastructure/filesystem/staging-allocator.js";

const candidate = {
  entry: { source: { value: { kind: "git", url: "https://example.invalid/plugin.git" } } },
} as never;
const allocation = { slot: { root: "/private/staging", contentRoot: "/private/staging/content", workRoot: "/private/staging/.work" }, identity: { kind: "plugin", key: "x" } } as never;
const materialized = { root: "/private/staging/content", source: { kind: "git" }, content: {}, binding: "binding" } as never;

function setup() {
  const discardStaging = vi.fn(async () => undefined);
  const materialize = vi.fn(async () => materialized);
  const port = createCandidateContentLeasePort({
    content: { allocateStaging: vi.fn(async () => allocation), discardStaging },
    materializer: { materialize },
  } as never);
  return { port, discardStaging, materialize };
}

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const executableBytes = new TextEncoder().encode("#!/usr/bin/env node\nconsole.log('candidate');\n");

async function realLeaseFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-candidate-lease-"));
  const content = await createNodeContentStore({ hostRoot: join(root, "host") });
  const source = createResolvedPluginSource({
    kind: "git",
    url: "https://example.invalid/plugin.git",
    revision: "a".repeat(40),
  }, sha256);
  const manifest = createContentManifest([{
    kind: "directory",
    path: "bin",
    mode: 0o755,
  }, {
    kind: "file",
    path: "bin/plugin.mjs",
    mode: 0o755,
    size: executableBytes.byteLength,
    digest: hashContent(executableBytes, sha256),
  }], sha256);
  const roots: string[] = [];
  const port = createCandidateContentLeasePort({
    content,
    materializer: {
      async materialize(_source, _context, slot, signal) {
        signal.throwIfAborted();
        const contentRoot = join(slot.root, "content");
        const executable = join(contentRoot, "bin", "plugin.mjs");
        await mkdir(join(contentRoot, "bin"), { recursive: true });
        await writeFile(executable, executableBytes, { mode: 0o755 });
        await chmod(executable, 0o755);
        roots.push(slot.root);
        signal.throwIfAborted();
        return {
          root: contentRoot,
          source,
          content: manifest,
          binding: createMaterializationBinding(source.hash, manifest.rootDigest, sha256),
        };
      },
    },
  });
  return { root, content, port, source, manifest, roots };
}

async function expectAllocationRemoved(root: string): Promise<void> {
  await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(stagingOwnerSidecarPath(root))).rejects.toMatchObject({ code: "ENOENT" });
}

async function makeDirectoriesWritable(root: string): Promise<void> {
  const stat = await lstat(root).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) return;
  await chmod(root, 0o700).catch(() => undefined);
  for (const name of await readdir(root).catch(() => [])) await makeDirectoriesWritable(join(root, name));
}

describe("candidate content lease", () => {
  it("transfers one exact materialization at most once", async () => {
    const { port, discardStaging, materialize } = setup();
    const lease = await port.acquire(candidate, new AbortController().signal);
    expect(materialize).toHaveBeenCalledTimes(1);
    const claimed = await lease.claim(new AbortController().signal);
    expect(claimed.materialized).toBe(materialized);
    expect(claimed.allocation).toBe(allocation);
    await expect(lease.claim(new AbortController().signal)).rejects.toThrow("already settled");
    await lease.release();
    expect(discardStaging).not.toHaveBeenCalled();
  });

  it("releases idempotently with a fresh cleanup signal", async () => {
    const { port, discardStaging } = setup();
    const controller = new AbortController();
    const lease = await port.acquire(candidate, controller.signal);
    controller.abort();
    await lease.release();
    await lease.release();
    expect(discardStaging).toHaveBeenCalledTimes(1);
    expect(discardStaging.mock.calls[0]![1].aborted).toBe(false);
  });

  it("cleans acquisition failure without creating a lease", async () => {
    const discardStaging = vi.fn(async () => undefined);
    const port = createCandidateContentLeasePort({
      content: { allocateStaging: vi.fn(async () => allocation), discardStaging },
      materializer: { materialize: vi.fn(async () => { throw new Error("offline"); }) },
    } as never);
    await expect(port.acquire(candidate, new AbortController().signal)).rejects.toThrow("offline");
    expect(discardStaging).toHaveBeenCalledTimes(1);
  });

  it("returns opaque recoverable ownership when acquisition cleanup fails", async () => {
    let cleanupFails = true;
    const discardStaging = vi.fn(async () => {
      if (cleanupFails) throw new Error("CANARY_PRIVATE_STAGING_PATH");
    });
    const port = createCandidateContentLeasePort({
      content: { allocateStaging: vi.fn(async () => allocation), discardStaging },
      materializer: { materialize: vi.fn(async () => { throw new Error("offline"); }) },
    } as never);
    const failure = await port.acquire(candidate, new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CandidateContentCleanupError);
    expect(JSON.stringify(failure)).not.toContain("/private/staging");
    cleanupFails = false;
    await expect((failure as CandidateContentCleanupError).recovery.retry()).resolves.toBeUndefined();
    expect(discardStaging).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed release retryable instead of marking the lease released", async () => {
    let cleanupFails = true;
    const discardStaging = vi.fn(async () => {
      if (cleanupFails) throw new Error("cleanup failed");
    });
    const port = createCandidateContentLeasePort({
      content: { allocateStaging: vi.fn(async () => allocation), discardStaging },
      materializer: { materialize: vi.fn(async () => materialized) },
    } as never);
    const lease = await port.acquire(candidate, new AbortController().signal);
    await expect(lease.release()).rejects.toBeInstanceOf(CandidateContentCleanupError);
    cleanupFails = false;
    await expect(lease.release()).resolves.toBeUndefined();
    expect(discardStaging).toHaveBeenCalledTimes(2);
  });

  it("physically removes real executable staging after success, callback failure, and cancellation", async () => {
    const fixture = await realLeaseFixture();
    try {
      await expect(fixture.port.withMaterialized(candidate, new AbortController().signal, async (value) => {
        expect(new Uint8Array(await readFile(join(value.root, "bin", "plugin.mjs")))).toEqual(executableBytes);
        return "used";
      })).resolves.toBe("used");
      await expectAllocationRemoved(fixture.roots[0]!);

      await expect(fixture.port.withMaterialized(candidate, new AbortController().signal, async () => {
        throw new Error("callback failed");
      })).rejects.toThrow("callback failed");
      await expectAllocationRemoved(fixture.roots[1]!);

      const cancelled = new AbortController();
      await expect(fixture.port.withMaterialized(candidate, cancelled.signal, async () => {
        cancelled.abort(new DOMException("cancelled", "AbortError"));
        cancelled.signal.throwIfAborted();
      })).rejects.toMatchObject({ name: "AbortError" });
      await expectAllocationRemoved(fixture.roots[2]!);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps claimed bytes until the receiving content-store transfer consumes them", async () => {
    const fixture = await realLeaseFixture();
    try {
      const lease = await fixture.port.acquire(candidate, new AbortController().signal);
      const claimed = await lease.claim(new AbortController().signal);
      const stagingRoot = claimed.allocation.slot.root;
      await lease.release();
      expect(new Uint8Array(await readFile(join(claimed.materialized.root, "bin", "plugin.mjs")))).toEqual(executableBytes);

      const promoted = await fixture.content.promote(createPromotionPlan({
        kind: "plugin",
        allocation: claimed.allocation,
        materialized: claimed.materialized,
      }, sha256), new AbortController().signal);
      expect(new Uint8Array(await readFile(join(promoted.root, "bin", "plugin.mjs")))).toEqual(executableBytes);
      await expectAllocationRemoved(stagingRoot);
    } finally {
      await makeDirectoriesWritable(fixture.root);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
