import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContentStoreLayout } from "../../../src/infrastructure/filesystem/content-store-layout.js";
import { createRevisionArtifactStore } from "../../../src/infrastructure/recovery/revision-artifact-store.js";

describe("revision artifact store", () => {
  it("scans immutable roots only and never enumerates persistent data", async () => {
    const root = await mkdtemp(join(process.cwd(), ".test-revision-artifacts-"));
    try {
      const layout = await createContentStoreLayout(root);
      const store = createRevisionArtifactStore(layout, () => new Uint8Array(32));
      const scan = await store.scan(new AbortController().signal);
      expect(scan.complete).toBe(true);
      expect(scan.artifacts).toEqual([]);
      expect(layout.dataRoot).not.toContain("stores");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
