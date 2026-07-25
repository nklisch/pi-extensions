import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createManifestContentReader } from "../../../src/infrastructure/filesystem/manifest-content-reader.js";
import { createContentManifest, hashContent, type ContentManifestEntry } from "../../../src/domain/content-manifest.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

function file(path: string, bytes: Uint8Array): Extract<ContentManifestEntry, { kind: "file" }> {
  return {
    kind: "file",
    path,
    mode: 0o644,
    size: bytes.byteLength,
    digest: hashContent(bytes, sha256),
  };
}

describe("manifest-backed Node content reader", () => {
  it("reads only the exact indexed regular file and verifies its digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-plugin-reader-"));
    try {
      await mkdir(join(root, "nested"));
      const bytes = new TextEncoder().encode("exact content");
      await writeFile(join(root, "nested", "file.txt"), bytes);
      const entry = file("nested/file.txt", bytes);
      const content = createContentManifest([
        { kind: "directory", path: "nested", mode: 0o755 },
        entry,
      ], sha256);
      void content;
      const result = await createManifestContentReader(sha256).readFile(
        { root, entry },
        1024,
        new AbortController().signal,
      );
      expect(result).toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects final and ancestor symlinks as path-boundary failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-plugin-reader-"));
    try {
      const bytes = new TextEncoder().encode("secret");
      await mkdir(join(root, "nested"));
      await writeFile(join(root, "target.txt"), bytes);
      await symlink("../target.txt", join(root, "nested", "file.txt"));
      const entry = file("nested/file.txt", bytes);
      await expect(createManifestContentReader(sha256).readFile(
        { root, entry },
        1024,
        new AbortController().signal,
      )).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED" });

      await unlink(join(root, "nested", "file.txt"));
      await rm(join(root, "nested"), { recursive: true, force: true });
      await symlink(root, join(root, "link"));
      await expect(createManifestContentReader(sha256).readFile(
        { root: join(root, "link"), entry: file("target.txt", bytes) },
        1024,
        new AbortController().signal,
      )).rejects.toMatchObject({ code: "PATH_CONTAINMENT_FAILED" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves caller cancellation instead of converting it to adapter diagnostics", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(createManifestContentReader(sha256).readFile(
      { root: "/unused", entry: file("file.txt", new Uint8Array()) },
      1024,
      controller.signal,
    )).rejects.toBe(reason);
  });
});