import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeContentStorePlatform } from "../../../src/infrastructure/filesystem/content-store-durability.js";

describe("content-store durability capability", () => {
  it("probes and enforces atomic no-replace marker publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-content-durability-"));
    try {
      const platform = createNodeContentStorePlatform();
      await expect(platform.probe(root)).resolves.toMatchObject({ atomicNoReplaceDirectory: true });
      const first = join(root, "first");
      const second = join(root, "second");
      const target = join(root, "target");
      await Promise.all([mkdir(first), mkdir(second)]);
      await Promise.all([
        writeFile(join(first, "metadata.json"), "first"),
        writeFile(join(second, "metadata.json"), "second"),
      ]);
      expect(await platform.publishDirectoryNoReplace(first, target)).toBe("published");
      expect(await platform.publishDirectoryNoReplace(second, target)).toBe("exists");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
