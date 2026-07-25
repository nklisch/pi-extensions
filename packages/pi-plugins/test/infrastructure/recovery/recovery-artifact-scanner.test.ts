import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContentStoreLayout } from "../../../src/infrastructure/filesystem/content-store-layout.js";
import { createStagingAllocator } from "../../../src/infrastructure/filesystem/staging-allocator.js";
import { createRecoveryArtifactScanner } from "../../../src/infrastructure/recovery/recovery-artifact-scanner.js";

describe("recovery artifact scanner", () => {
  it("issues an opaque live-owner candidate and refuses takeover", async () => {
    const root = await mkdtemp(join(process.cwd(), ".test-recovery-artifacts-"));
    try {
      const layout = await createContentStoreLayout(root);
      const allocator = createStagingAllocator(layout, { randomBytes: async () => Uint8Array.from({ length: 16 }, (_, index) => index + 1) });
      await allocator.allocateStaging(new AbortController().signal);
      const scanner = createRecoveryArtifactScanner(layout);
      const scan = await scanner.scan(new AbortController().signal);
      expect(scan.complete).toBe(true);
      expect(scan.candidates).toHaveLength(1);
      expect(scan.candidates[0]?.owner).toBe("live");
      await expect(scanner.remove(scan.candidates[0]!, new AbortController().signal)).rejects.toThrow(/not proven dead/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
