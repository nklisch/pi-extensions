import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ContentDigestSchema,
  createContentManifest,
  hashContent,
  type ContentManifestEntry,
} from "../../src/domain/content-manifest.js";
import { createContentIndex } from "../../src/application/content-index.js";
import { ErrorCodeRegistry } from "../../src/domain/error-contract.js";
import type { Provenance } from "../../src/domain/provenance.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const provenance: Provenance = {
  location: {
    host: "claude",
    documentKind: "manifest",
    path: ".claude-plugin/plugin.json",
    pointer: "/skills",
  },
};

const file = (path: string, body: string): ContentManifestEntry => ({
  kind: "file",
  path,
  mode: 0o644,
  size: text(body).byteLength,
  digest: hashContent(text(body), sha256),
});

describe("manifest-backed content index", () => {
  it("answers finite membership and descendant queries without filesystem discovery", () => {
    const manifest = createContentManifest([
      { kind: "directory", path: "skills", mode: 0o755 },
      { kind: "directory", path: "skills/demo", mode: 0o755 },
      file("README.md", "readme"),
      file("skills/demo/SKILL.md", "---\nname: demo\n---\n"),
    ], sha256);
    const index = createContentIndex(manifest);

    expect(index.get("skills/demo/SKILL.md")?.kind).toBe("file");
    expect(index.get("./skills/demo/SKILL.md")?.path).toBe("skills/demo/SKILL.md");
    expect(index.filesBelow("skills", "SKILL.md").map((entry) => entry.path)).toEqual([
      "skills/demo/SKILL.md",
    ]);
    expect(index.filesBelow("").map((entry) => entry.path)).toEqual([
      "README.md",
      "skills/demo/SKILL.md",
    ]);
    expect(index.requireDirectory("skills", provenance).path).toBe("skills");
    expect(index.requireFile("README.md", provenance).size).toBe(6);
  });

  it("rejects explicit missing, symlink, and wrong-kind targets with provenance", () => {
    const manifest = createContentManifest([
      { kind: "directory", path: "skills", mode: 0o755 },
      { kind: "directory", path: "skills/demo", mode: 0o755 },
      file("skills/demo/SKILL.md", "skill"),
      {
        kind: "symlink",
        path: "skills/current",
        mode: 0o777,
        target: "demo/SKILL.md",
        digest: hashContent(text("demo/SKILL.md"), sha256),
      },
    ], sha256);
    const index = createContentIndex(manifest);

    for (const [method, path] of [
      ["requireFile", "missing.md"],
      ["requireFile", "skills/current"],
      ["requireDirectory", "skills/demo/SKILL.md"],
    ] as const) {
      try {
        index[method](path, provenance);
        throw new Error("expected explicit target failure");
      } catch (error) {
        expect(error).toMatchObject({
          code: ErrorCodeRegistry.pathContainmentFailed,
          location: provenance.location,
        });
      }
    }

    // A conventional query can simply observe absence; it does not turn an
    // optional convention into a bundle error.
    expect(index.get("hooks/hooks.json")).toBeUndefined();
  });

  it("validates the supplied manifest before exposing an index", () => {
    expect(() => createContentIndex({
      version: 1,
      algorithm: "sha256",
      entries: [{ kind: "file", path: "./file.txt", mode: 0o644, size: 0, digest: ContentDigestSchema.parse("sha256:" + "0".repeat(64)) }],
      rootDigest: ContentDigestSchema.parse("sha256:" + "0".repeat(64)),
    })).toThrow();
  });
});
