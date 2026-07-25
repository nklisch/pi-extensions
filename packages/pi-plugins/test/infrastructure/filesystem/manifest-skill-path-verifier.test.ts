import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContentReadPort, ManifestFileRef } from "../../../src/application/ports/content-read.js";
import { createManifestSkillPathVerifier } from "../../../src/infrastructure/filesystem/manifest-skill-path-verifier.js";
import { createManifestContentReader } from "../../../src/infrastructure/filesystem/manifest-content-reader.js";
import { hashContent, type ContentManifestEntry } from "../../../src/domain/content-manifest.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());

function entry(path: string, bytes: Uint8Array): Extract<ContentManifestEntry, { kind: "file" }> {
  return { kind: "file", path, mode: 0o644, size: bytes.byteLength, digest: hashContent(bytes, sha256) };
}

async function fixture(path = "SKILL.md") {
  const root = await mkdtemp(join(tmpdir(), "pi-skill-path-"));
  const bytes = new TextEncoder().encode("---\nname: demo\ndescription: demo\n---\n");
  await mkdir(join(root, path, ".."), { recursive: true }).catch(() => undefined);
  await writeFile(join(root, path), bytes);
  return { root, bytes, file: { root, entry: entry(path, bytes) } satisfies ManifestFileRef };
}

describe("manifest-backed skill path verifier", () => {
  it("returns the exact contained SKILL.md path for root and nested skills", async () => {
    const first = await fixture();
    const second = await fixture("nested/SKILL.md");
    try {
      const verifier = createManifestSkillPathVerifier({ content: createManifestContentReader(sha256) });
      await expect(verifier.verify(first.file, new AbortController().signal)).resolves.toMatchObject({ kind: "ready", value: { path: join(first.root, "SKILL.md"), canonicalPath: join(first.root, "SKILL.md") } });
      await expect(verifier.verify(second.file, new AbortController().signal)).resolves.toMatchObject({ kind: "ready", value: { path: join(second.root, "nested/SKILL.md") } });
    } finally {
      await rm(first.root, { recursive: true, force: true });
      await rm(second.root, { recursive: true, force: true });
    }
  });

  it("classifies missing, symlink, type, and digest mutations without path evidence", async () => {
    const value = await fixture();
    try {
      const verifier = createManifestSkillPathVerifier({ content: createManifestContentReader(sha256) });
      await rm(join(value.root, "SKILL.md"));
      await expect(verifier.verify(value.file, new AbortController().signal)).resolves.toEqual({ kind: "failed", code: "ROOT_MISSING" });

      await writeFile(join(value.root, "target.md"), value.bytes);
      await symlink("target.md", join(value.root, "SKILL.md"));
      await expect(verifier.verify(value.file, new AbortController().signal)).resolves.toEqual({ kind: "failed", code: "ROOT_ESCAPE" });
      await rm(join(value.root, "SKILL.md"));
      await mkdir(join(value.root, "SKILL.md"));
      await expect(verifier.verify(value.file, new AbortController().signal)).resolves.toEqual({ kind: "failed", code: "ROOT_MUTATED" });

      await rm(join(value.root, "SKILL.md"), { recursive: true });
      await writeFile(join(value.root, "SKILL.md"), "changed");
      await expect(verifier.verify(value.file, new AbortController().signal)).resolves.toEqual({ kind: "failed", code: "ROOT_MUTATED" });
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });

  it("maps an unreadable content adapter and cancellation to non-success", async () => {
    const value = await fixture();
    try {
      const unreadable: ContentReadPort = { async readFile() { throw new Error("read failed"); } };
      const verifier = createManifestSkillPathVerifier({ content: unreadable });
      await expect(verifier.verify(value.file, new AbortController().signal)).resolves.toEqual({ kind: "failed", code: "ROOT_UNREADABLE" });

      const before = new AbortController();
      before.abort();
      await expect(verifier.verify(value.file, before.signal)).resolves.toEqual({ kind: "cancelled" });

      const during = new AbortController();
      const cancelling: ContentReadPort = { async readFile(_file, _limit, signal) { signal.throwIfAborted(); during.abort(); throw signal.reason ?? new DOMException("aborted", "AbortError"); } };
      await expect(createManifestSkillPathVerifier({ content: cancelling }).verify(value.file, during.signal)).resolves.toEqual({ kind: "cancelled" });
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  });
});