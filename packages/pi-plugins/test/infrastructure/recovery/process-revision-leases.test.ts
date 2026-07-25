import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProcessRevisionLeaseStore } from "../../../src/infrastructure/recovery/process-revision-leases.js";

describe("process revision leases", () => {
  it("pins an artifact while its owner is live and releases explicitly", async () => {
    const root = await mkdtemp(join(process.cwd(), ".test-revision-leases-"));
    try {
      const store = await createProcessRevisionLeaseStore({ hostRoot: root, verifyLocalFilesystem: async () => {} });
      const ref = { kind: "plugin" as const, key: "plugin-store-v1:sha256:" + "a".repeat(64) as never };
      const lease = await store.acquire({ sessionId: "session", artifacts: [ref], at: 10 }, new AbortController().signal);
      const listed = await store.list(new AbortController().signal);
      expect(listed.owners[0]?.status).toBe("live");
      expect(listed.leases[0]?.artifacts).toEqual([ref]);
      await store.release(lease, 11, new AbortController().signal);
      expect((await store.list(new AbortController().signal)).leases).toHaveLength(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
