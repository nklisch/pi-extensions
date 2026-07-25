import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ContentManifestSchema,
  createContentManifest,
  hashContent,
  verifyContentManifest,
} from "../../src/domain/content-manifest.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const file = {
  kind: "file" as const,
  path: "a.txt",
  mode: 0o644 as const,
  size: 3,
  digest: hashContent(text("abc"), sha256),
};

describe("content manifest", () => {
  it("uses the binary content-v1 vector and unsigned UTF-8 path ordering", () => {
    const manifest = createContentManifest([file], sha256);
    expect(manifest.rootDigest).toBe("sha256:20eb6bbaeb6ed73388b33945b63fdabf77964941d62442f4f9a15250f245c286");
    expect(verifyContentManifest(manifest, sha256)).toEqual(manifest);
  });

  it("does not depend on caller entry order, archive metadata, or platform separators", () => {
    const directory = { kind: "directory" as const, path: "dir", mode: 0o755 as const };
    const link = {
      kind: "symlink" as const,
      path: "dir/link",
      mode: 0o777 as const,
      target: "../a.txt",
      digest: hashContent(text("../a.txt"), sha256),
    };
    const first = createContentManifest([link, directory, file], sha256);
    const second = createContentManifest([file, directory, link], sha256);
    expect(second).toEqual(first);
    expect(first.rootDigest).toBe("sha256:49d855ae29fb107f08ac1f5130afd03b2b60b81bba04ad5d9067eaba581c1893");
  });

  it("rejects forged roots, missing ancestors, collisions, and unsafe links", () => {
    const manifest = createContentManifest([file], sha256);
    expect(() => verifyContentManifest({ ...manifest, rootDigest: `sha256:${"0".repeat(64)}` }, sha256)).toThrow();
    expect(() => createContentManifest([
      { ...file, path: "dir/file" },
    ], sha256)).toThrow();
    expect(() => ContentManifestSchema.parse({
      ...manifest,
      entries: [file, { ...file, path: "A.TXT" }],
    })).toThrow();
    expect(() => createContentManifest([
      { kind: "symlink", path: "link", mode: 0o777, target: "../outside", digest: hashContent(text("../outside"), sha256) },
    ], sha256)).toThrow();
  });

  it("rejects a broken injected digest port", () => {
    expect(() => hashContent(text("bytes"), () => new Uint8Array(31))).toThrow(/exactly 32/);
  });
});
