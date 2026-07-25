import { createHash } from "node:crypto";
import { mkdtemp, readdir, readlink, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createResolvedMarketplaceSource } from "../../../src/domain/source.js";
import { createMaterializationBinding } from "../../../src/domain/content-manifest.js";
import {
  createFilesystemMarketplacePathAcquirer,
  createSecureContentWriterFactory,
  inspectMaterializedContent,
  verifyMaterializedContent,
} from "../../../src/infrastructure/filesystem/secure-content-writer.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = (): AbortSignal => new AbortController().signal;
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const slots: string[] = [];

async function slot(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "pi-content-test-"));
  slots.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(slots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("secure content writer", () => {
  it("writes only its content root and finalizes a stable tree", async () => {
    const root = await slot();
    const sink = await createSecureContentWriterFactory({ sha256 }).open({ root });
    await sink.add({ kind: "file", path: "nested/file", mode: 0o600, body: (async function* () { yield bytes("payload"); })() }, signal());
    const result = await sink.finalize(signal());
    expect(result.root).toBe(join(root, "content"));
    expect(await readdir(root)).toEqual(["content"]);
    expect((await stat(join(result.root, "nested/file"))).isFile()).toBe(true);
    expect(result.content.entries.map((entry) => entry.path)).toEqual(["nested", "nested/file"]);
  });

  it("rejects traversal, platform-dangerous names, collisions, and special modes", async () => {
    const root = await slot();
    const sink = await createSecureContentWriterFactory({ sha256 }).open({ root });
    for (const path of ["../escape", "/absolute", "C:/drive", "a\\b", "CON.txt", ".git/config", "a/../b", "bad "]) {
      await expect(sink.add({ kind: "directory", path, mode: 0o755 }, signal())).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED", classification: "security" });
    }
    await sink.add({ kind: "file", path: "Name", mode: 0o644, body: (async function* () { yield bytes("x"); })() }, signal());
    await expect(sink.add({ kind: "file", path: "name", mode: 0o644, body: (async function* () { yield bytes("x"); })() }, signal())).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED" });
    await expect(sink.add({ kind: "file", path: "setuid", mode: 0o4755, body: (async function* () { yield bytes("x"); })() }, signal())).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED" });
    await sink.abort();
  });

  it("defers links, copies hardlinks as regular files, and rejects escaping targets", async () => {
    const root = await slot();
    const sink = await createSecureContentWriterFactory({ sha256 }).open({ root });
    await sink.add({ kind: "symlink", path: "dir/link", mode: 0o777, target: "file" }, signal());
    await sink.add({ kind: "hardlink", path: "copy", mode: 0o644, target: "dir/file" }, signal());
    await sink.add({ kind: "file", path: "dir/file", mode: 0o644, body: (async function* () { yield bytes("x"); })() }, signal());
    const result = await sink.finalize(signal());
    expect((await stat(join(result.root, "copy"))).isFile()).toBe(true);
    expect(await readlink(join(result.root, "dir/link"))).toBe("file");

    const badRoot = await slot();
    const bad = await createSecureContentWriterFactory({ sha256 }).open({ root: badRoot });
    await expect(bad.add({ kind: "symlink", path: "link", mode: 0o777, target: "../../outside" }, signal())).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED" });
    await bad.abort();
  });

  it("cleans owned paths on cancellation and does not return a partial result", async () => {
    const root = await slot();
    const controller = new AbortController();
    const sink = await createSecureContentWriterFactory({ sha256 }).open({ root });
    const body = (async function* () {
      yield bytes("before");
      controller.abort(new Error("cancelled"));
      yield bytes("after");
    })();
    await expect(sink.add({ kind: "file", path: "partial", mode: 0o644, body }, controller.signal)).rejects.toThrow("cancelled");
    await sink.abort();
    await expect(stat(join(root, "content"))).rejects.toThrow();
    await expect(stat(join(root, ".work"))).rejects.toThrow();
  });

  it("rejects an oversized tree before hashing entries beyond its limit", async () => {
    const root = await slot();
    await mkdir(join(root, "content"), { recursive: true });
    await writeFile(join(root, "content", "first"), "one", "utf8");
    await writeFile(join(root, "content", "second"), "two", "utf8");
    let updates = 0;
    const stream = () => ({
      update() { updates += 1; },
      digest() { return new Uint8Array(32); },
    });
    await expect(inspectMaterializedContent(root + "/content", sha256, {
      limits: { maxEntries: 1 },
      sha256Stream: stream,
    })).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED" });
    expect(updates).toBe(0);
  });

  it("enforces the entry budget before hashing an enumerated sibling after a recursive tree", async () => {
    const root = await slot();
    await mkdir(join(root, "content", "a"), { recursive: true });
    await writeFile(join(root, "content", "a", "first"), "one", "utf8");
    await writeFile(join(root, "content", "a", "second"), "two", "utf8");
    await writeFile(join(root, "content", "z"), "three", "utf8");
    let updates = 0;
    const stream = () => ({
      update() { updates += 1; },
      digest() { return new Uint8Array(32); },
    });
    await expect(inspectMaterializedContent(root + "/content", sha256, {
      limits: { maxEntries: 3 },
      sha256Stream: stream,
    })).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED" });
    expect(updates).toBe(2);
  });

  it("accepts a nested tree exactly at its entry budget in deterministic order", async () => {
    const root = await slot();
    await mkdir(join(root, "content", "a"), { recursive: true });
    await writeFile(join(root, "content", "a", "first"), "one", "utf8");
    await writeFile(join(root, "content", "z"), "two", "utf8");
    let updates = 0;
    const stream = () => ({
      update() { updates += 1; },
      digest() { return new Uint8Array(32); },
    });
    const manifest = await inspectMaterializedContent(root + "/content", sha256, {
      limits: { maxEntries: 3 },
      sha256Stream: stream,
    });
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["a", "a/first", "z"]);
    expect(updates).toBe(2);
  });

  it("copies a marketplace-relative directory through the same sink", async () => {
    const marketplace = await slot();
    await mkdir(join(marketplace, "content", "source", "nested"), { recursive: true });
    await writeFile(join(marketplace, "content", "source", "nested", "plugin.json"), "{}", "utf8");
    const marketplaceContent = join(marketplace, "content");
    const marketplaceManifest = await inspectMaterializedContent(marketplaceContent, sha256);
    const root = await slot();
    const sink = await createSecureContentWriterFactory({ sha256 }).open({ root });
    const source = createResolvedMarketplaceSource({
      declared: { kind: "local-git", path: marketplace },
      revision: "a".repeat(40),
    }, sha256);
    await createFilesystemMarketplacePathAcquirer({ sha256 }).materialize(
      { kind: "marketplace-path", path: "source" },
      {
        root: marketplaceContent,
        source,
        contentRootDigest: marketplaceManifest.rootDigest,
        content: marketplaceManifest,
        binding: createMaterializationBinding(source.hash, marketplaceManifest.rootDigest, sha256),
      },
      sink,
      signal(),
    );
    const result = await sink.finalize(signal());
    expect((await stat(join(result.root, "nested/plugin.json"))).isFile()).toBe(true);
    await expect(verifyMaterializedContent(result.root, result.content)).resolves.toEqual(result.content);
    await writeFile(join(result.root, "nested/plugin.json"), "tampered", "utf8");
    await expect(verifyMaterializedContent(result.root, result.content)).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED" });
  });
});
