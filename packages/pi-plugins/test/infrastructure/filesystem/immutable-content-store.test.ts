import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createContentManifest,
  createMaterializationBinding,
  hashContent,
} from "../../../src/domain/content-manifest.js";
import { createResolvedMarketplaceSource, createResolvedPluginSource } from "../../../src/domain/source.js";
import { createPromotionPlan } from "../../../src/application/content-promotion.js";
import { createContentStoreLayout } from "../../../src/infrastructure/filesystem/content-store-layout.js";
import { createStagingAllocator } from "../../../src/infrastructure/filesystem/staging-allocator.js";
import {
  createImmutableContentStore,
  inspectPublishedRevision,
} from "../../../src/infrastructure/filesystem/immutable-content-store.js";
import {
  createNodeContentStorePlatform,
  renameNoReplaceByProbe,
} from "../../../src/infrastructure/filesystem/content-store-durability.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;

async function makeStore() {
  const root = await mkdtemp(join(tmpdir(), "pi-immutable-store-"));
  const layout = await createContentStoreLayout(join(root, "host"));
  const allocator = createStagingAllocator(layout, { randomBytes: () => Uint8Array.from({ length: 16 }, (_, i) => i + 1) });
  const platform = createNodeContentStorePlatform({ renameNoReplace: renameNoReplaceByProbe });
  const store = createImmutableContentStore({ layout, allocator, platform, sha256, randomBytes: () => Uint8Array.from({ length: 16 }, (_, i) => 31 - i) });
  return { root, layout, allocator, store };
}

async function makePlan(allocator: Awaited<ReturnType<typeof makeStore>>["allocator"], root: string, value = "plugin") {
  const allocation = await allocator.allocateStaging(signal);
  await mkdir(join(allocation.slot.root, "content"), { mode: 0o755 });
  await writeFile(join(allocation.slot.root, "content", "plugin.txt"), value, { mode: 0o644 });
  const bytes = new TextEncoder().encode(value);
  const manifest = createContentManifest([{ kind: "file", path: "plugin.txt", mode: 0o644, size: bytes.byteLength, digest: hashContent(bytes, sha256) }], sha256);
  const source = createResolvedPluginSource({ kind: "git", url: "https://example.com/plugin.git", revision: "a".repeat(40) }, sha256);
  return createPromotionPlan({
    kind: "plugin",
    allocation,
    materialized: {
      root: join(allocation.slot.root, "content"),
      source,
      content: manifest,
      binding: createMaterializationBinding(source.hash, manifest.rootDigest, sha256),
    },
  }, sha256);
}

async function makeMarketplacePlan(allocator: Awaited<ReturnType<typeof makeStore>>["allocator"]) {
  const allocation = await allocator.allocateStaging(signal);
  await mkdir(join(allocation.slot.root, "content"), { mode: 0o755 });
  await writeFile(join(allocation.slot.root, "content", "marketplace.txt"), "marketplace", { mode: 0o644 });
  const bytes = new TextEncoder().encode("marketplace");
  const manifest = createContentManifest([{ kind: "file", path: "marketplace.txt", mode: 0o644, size: bytes.byteLength, digest: hashContent(bytes, sha256) }], sha256);
  const source = createResolvedMarketplaceSource({ declared: { kind: "git", url: "https://example.com/marketplace.git" }, revision: "b".repeat(40) }, sha256);
  return createPromotionPlan({
    kind: "marketplace",
    allocation,
    materialized: {
      root: join(allocation.slot.root, "content"),
      source,
      content: manifest,
      binding: createMaterializationBinding(source.hash, manifest.rootDigest, sha256),
    },
  }, sha256);
}

describe("immutable content promotion", () => {
  it("normalizes missing revision publication controls", async () => {
    const { root, layout } = await makeStore();
    try {
      const missing = join(layout.pluginStoreRoot, "missing");
      await mkdir(missing);
      const error = await inspectPublishedRevision(missing, sha256).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: "CONTENT_VERIFICATION_FAILED" });
      expect((error as Error).message).not.toContain("ENOENT");
      expect(JSON.stringify((error as { toDiagnostic(): unknown }).toDiagnostic())).not.toContain(missing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a plugin-store parent swap before foreign publication", async () => {
    const { root, layout, allocator, store } = await makeStore();
    try {
      const plan = await makePlan(allocator, root);
      const foreign = await mkdtemp(join(root, "foreign-plugin-"));
      await writeFile(join(foreign, "foreign.txt"), "untouched");
      const displaced = `${layout.pluginStoreRoot}.displaced`;
      await rename(layout.pluginStoreRoot, displaced);
      await symlink(foreign, layout.pluginStoreRoot);
      await expect(store.promote(plan, signal)).rejects.toThrow();
      expect(await readFile(join(foreign, "foreign.txt"), "utf8")).toBe("untouched");
      await expect(readFile(join(foreign, "metadata.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await rm(layout.pluginStoreRoot, { force: true });
      await rename(displaced, layout.pluginStoreRoot);
      await allocator.discardStaging(plan.allocation, signal);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a marketplace-store parent swap before foreign publication", async () => {
    const { root, layout, allocator, store } = await makeStore();
    try {
      const plan = await makeMarketplacePlan(allocator);
      const foreign = await mkdtemp(join(root, "foreign-marketplace-"));
      await writeFile(join(foreign, "foreign.txt"), "untouched");
      const displaced = `${layout.marketplaceStoreRoot}.displaced`;
      await rename(layout.marketplaceStoreRoot, displaced);
      await symlink(foreign, layout.marketplaceStoreRoot);
      await expect(store.promote(plan, signal)).rejects.toThrow();
      expect(await readFile(join(foreign, "foreign.txt"), "utf8")).toBe("untouched");
      await expect(readFile(join(foreign, "metadata.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await rm(layout.marketplaceStoreRoot, { force: true });
      await rename(displaced, layout.marketplaceStoreRoot);
      await allocator.discardStaging(plan.allocation, signal);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a prepared-root parent swap before cleanup can touch foreign content", async () => {
    const { root, layout, allocator } = await makeStore();
    const foreign = await mkdtemp(join(root, "foreign-prepared-"));
    await writeFile(join(foreign, "foreign.txt"), "untouched");
    const displaced = `${layout.pluginStoreRoot}.displaced`;
    const prepared = `${layout.pluginStoreRoot}/.payload-1f1e1d1c1b1a19181716151413121110`;
    let swapped = false;
    try {
      const base = createNodeContentStorePlatform({ renameNoReplace: renameNoReplaceByProbe });
      const platform = {
        ...base,
        async syncDirectory(path: string): Promise<void> {
          await base.syncDirectory(path);
          if (!swapped && path === prepared) {
            swapped = true;
            await rename(layout.pluginStoreRoot, displaced);
            await symlink(foreign, layout.pluginStoreRoot);
          }
        },
      };
      const store = createImmutableContentStore({ layout, allocator, platform, sha256, randomBytes: () => Uint8Array.from({ length: 16 }, (_, i) => 31 - i) });
      const plan = await makePlan(allocator, root, "prepared-parent");
      await expect(store.promote(plan, signal)).rejects.toThrow();
      expect(await readFile(join(foreign, "foreign.txt"), "utf8")).toBe("untouched");
      await expect(readFile(join(foreign, "metadata.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await rm(layout.pluginStoreRoot, { force: true });
      await rename(displaced, layout.pluginStoreRoot);
      await allocator.discardStaging(plan.allocation, signal);
    } finally {
      await chmod(join(layout.pluginStoreRoot, ".payload-1f1e1d1c1b1a19181716151413121110", "READY"), 0o644).catch(() => undefined);
      await chmod(join(displaced, ".payload-1f1e1d1c1b1a19181716151413121110", "READY"), 0o644).catch(() => undefined);
      await chmod(join(layout.pluginStoreRoot, ".payload-1f1e1d1c1b1a19181716151413121110", "metadata.json"), 0o644).catch(() => undefined);
      await chmod(join(displaced, ".payload-1f1e1d1c1b1a19181716151413121110", "metadata.json"), 0o644).catch(() => undefined);
      await chmod(join(layout.pluginStoreRoot, ".payload-1f1e1d1c1b1a19181716151413121110", "content", "plugin.txt"), 0o644).catch(() => undefined);
      await chmod(join(displaced, ".payload-1f1e1d1c1b1a19181716151413121110", "content", "plugin.txt"), 0o644).catch(() => undefined);
      await chmod(join(layout.pluginStoreRoot, ".payload-1f1e1d1c1b1a19181716151413121110", "content"), 0o755).catch(() => undefined);
      await chmod(join(displaced, ".payload-1f1e1d1c1b1a19181716151413121110", "content"), 0o755).catch(() => undefined);
      await chmod(join(layout.pluginStoreRoot, ".payload-1f1e1d1c1b1a19181716151413121110"), 0o755).catch(() => undefined);
      await chmod(join(displaced, ".payload-1f1e1d1c1b1a19181716151413121110"), 0o755).catch(() => undefined);
      await chmod(layout.pluginStoreRoot, 0o755).catch(() => undefined);
      await chmod(displaced, 0o755).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes a complete read-only revision and is idempotent", async () => {
    const { root, allocator, store } = await makeStore();
    let publishedRoot: string | undefined;
    try {
      const plan = await makePlan(allocator, root);
      const first = await store.promote(plan, signal);
      publishedRoot = first.root.replace(/[/\\]content$/, "");
      expect(first.kind).toBe("promoted");
      expect(await readFile(join(first.root, "plugin.txt"), "utf8")).toBe("plugin");
      const secondPlan = await makePlan(allocator, root);
      const second = await store.promote(secondPlan, signal);
      expect(second.kind).toBe("already-present");
      expect((await inspectPublishedRevision(first.root.replace(/[/\\]content$/, ""), sha256)).identity).toEqual(first.identity);
    } finally {
      if (publishedRoot !== undefined) {
        await chmod(join(publishedRoot, "content", "plugin.txt"), 0o644).catch(() => undefined);
        await chmod(join(publishedRoot, "content"), 0o755).catch(() => undefined);
        await chmod(publishedRoot, 0o755).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims a prepared loser after an identical publication race", async () => {
    const { root, layout, allocator } = await makeStore();
    let publishedRoot: string | undefined;
    try {
      const base = createNodeContentStorePlatform({ renameNoReplace: renameNoReplaceByProbe });
      const platform = {
        ...base,
        async publishDirectoryNoReplace(source: string, destination: string): Promise<"published" | "exists"> {
          const winner = `${destination}.winner`;
          await cp(source, winner, { recursive: true });
          await rename(winner, destination);
          return "exists";
        },
      };
      const store = createImmutableContentStore({ layout, allocator, platform, sha256, randomBytes: () => Uint8Array.from({ length: 16 }, (_, i) => 31 - i) });
      const plan = await makePlan(allocator, root, "race");
      const result = await store.promote(plan, signal);
      publishedRoot = result.root.replace(/[/\\\\]content$/, "");
      expect(result.kind).toBe("already-present");
      expect((await readdir(layout.pluginStoreRoot)).filter((entry) => entry.startsWith(".payload-")).length).toBe(0);
    } finally {
      if (publishedRoot !== undefined) {
        await chmod(join(publishedRoot, "content", "plugin.txt"), 0o644).catch(() => undefined);
        await chmod(join(publishedRoot, "content"), 0o755).catch(() => undefined);
        await chmod(join(publishedRoot, "metadata.json"), 0o644).catch(() => undefined);
        await chmod(join(publishedRoot, "READY"), 0o644).catch(() => undefined);
        await chmod(publishedRoot, 0o755).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a sealed prepared tree after cancellation", async () => {
    const { root, layout, allocator } = await makeStore();
    try {
      const base = createNodeContentStorePlatform({ renameNoReplace: renameNoReplaceByProbe });
      const controller = new AbortController();
      let preparedPath: string | undefined;
      const platform = {
        ...base,
        async syncDirectory(path: string): Promise<void> {
          await base.syncDirectory(path);
          if (preparedPath !== undefined && path === preparedPath) controller.abort();
        },
      };
      const store = createImmutableContentStore({ layout, allocator, platform, sha256, randomBytes: () => Uint8Array.from({ length: 16 }, (_, i) => 31 - i) });
      const plan = await makePlan(allocator, root, "cancel");
      // The allocator uses a fixed id and the store uses a fixed prepared id.
      preparedPath = `${layout.pluginStoreRoot}/.payload-1f1e1d1c1b1a19181716151413121110`;
      await expect(store.promote(plan, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect((await readdir(layout.pluginStoreRoot)).filter((entry) => entry.startsWith(".payload-")).length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a handoff mutation before publication", async () => {
    const { root, allocator, store } = await makeStore();
    try {
      const plan = await makePlan(allocator, root);
      await writeFile(join(plan.root, "plugin.txt"), "tampered", { mode: 0o644 });
      await expect(store.promote(plan, signal)).rejects.toThrow(/verification|content/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
