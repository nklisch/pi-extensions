import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeRecoveryAdapters } from "../../src/infrastructure/recovery/create-node-recovery-adapters.js";

describe("node revision collection boundaries", () => {
  it("keeps persistent data outside the artifact inventory", async () => {
    const root = await mkdtemp(join(process.cwd(), ".test-revision-collection-"));
    try {
      const adapters = await createNodeRecoveryAdapters({ hostRoot: root, verifyLocalFilesystem: async () => {} });
      const scan = await adapters.artifacts.scan(new AbortController().signal);
      expect(scan.artifacts.some((candidate) => candidate.reference.kind === "plugin" && candidate.key.includes("data"))).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
