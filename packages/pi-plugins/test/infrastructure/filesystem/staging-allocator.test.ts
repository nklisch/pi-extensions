import { mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContentStoreLayout } from "../../../src/infrastructure/filesystem/content-store-layout.js";
import { createStagingAllocator } from "../../../src/infrastructure/filesystem/staging-allocator.js";

const signal = new AbortController().signal;

describe("private staging allocator", () => {
  it("allocates empty private slots and only exposes the staging view", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-staging-"));
    try {
      const layout = await createContentStoreLayout(join(root, "host"));
      const allocator = createStagingAllocator(layout, {
        randomBytes: () => Uint8Array.from({ length: 16 }, (_, index) => index + 1),
      });
      const allocation = await allocator.allocateStaging(signal);
      const slot = await stat(allocation.slot.root);
      expect(slot.isDirectory()).toBe(true);
      expect(slot.mode & 0o077).toBe(0);
      expect(allocation.slot.root.startsWith(layout.stagingRoot)).toBe(true);
      expect(allocation.slot.root).not.toContain(layout.pluginStoreRoot);
      expect(allocation.slot.root).not.toContain(layout.dataRoot);
      await allocator.discardStaging(allocation, signal);
      await expect(stat(allocation.slot.root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a swapped staging parent before allocation can touch a foreign tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-staging-parent-swap-"));
    try {
      const layout = await createContentStoreLayout(join(root, "host"));
      const allocator = createStagingAllocator(layout);
      const foreign = await mkdtemp(join(root, "foreign-"));
      await writeFile(join(foreign, "foreign.txt"), "untouched");
      const stagingParent = join(layout.stagingRoot, "..");
      const displaced = `${stagingParent}.displaced`;
      await rename(stagingParent, displaced);
      await symlink(foreign, stagingParent);
      await expect(allocator.allocateStaging(signal)).rejects.toThrow();
      expect(await readFile(join(foreign, "foreign.txt"), "utf8")).toBe("untouched");
      await rm(stagingParent, { force: true });
      await rename(displaced, stagingParent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects copied capabilities and cancellation before allocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-staging-forge-"));
    try {
      const layout = await createContentStoreLayout(join(root, "host"));
      const allocator = createStagingAllocator(layout, {
        randomBytes: () => Uint8Array.from({ length: 16 }, () => 7),
      });
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(allocator.allocateStaging(cancelled.signal)).rejects.toThrow();
      const allocation = await allocator.allocateStaging(signal);
      const forged = { slot: { ...allocation.slot }, allocationId: allocation.allocationId };
      await expect(allocator.discardStaging(forged, signal)).rejects.toThrow(/owned|capability/i);
      await allocator.discardStaging(allocation, signal);
      await allocator.discardStaging(allocation, signal);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
