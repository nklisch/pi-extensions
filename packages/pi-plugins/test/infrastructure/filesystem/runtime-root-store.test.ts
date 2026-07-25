import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMaterializationBinding, createContentManifest, hashContent } from "../../../src/domain/content-manifest.js";
import { createResolvedPluginSource } from "../../../src/domain/source.js";
import { createPluginStoreIdentity } from "../../../src/domain/content-store.js";
import { derivePluginDataRef, deriveProjectionRootRef } from "../../../src/domain/state/references.js";
import { createContentStoreLayout } from "../../../src/infrastructure/filesystem/content-store-layout.js";
import { createRuntimeRootStore, hashProjectionRoot, inspectProjection, inspectPublishedProjection } from "../../../src/infrastructure/filesystem/runtime-root-store.js";
import { createNodeContentStorePlatform } from "../../../src/infrastructure/filesystem/content-store-durability.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;

describe("runtime data and projection roots", () => {
  it("normalizes missing projection publication controls", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-projection-marker-"));
    try {
      const layout = await createContentStoreLayout(join(root, "host"));
      const missing = join(layout.generatedRoot, "missing");
      await mkdir(missing);
      const error = await inspectProjection(missing, sha256).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: "CONTENT_VERIFICATION_FAILED" });
      expect((error as Error).message).not.toContain("ENOENT");
      expect(JSON.stringify((error as { toDiagnostic(): unknown }).toDiagnostic())).not.toContain(missing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps data stable and physically separate from immutable content", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-runtime-roots-"));
    try {
      const layout = await createContentStoreLayout(join(root, "host"));
      const runtime = createRuntimeRootStore({
        layout,
        platform: createNodeContentStorePlatform(),
        sha256,
      });
      const userDataRef = derivePluginDataRef({ scope: { kind: "user" }, plugin: "demo@market", purpose: "persistent-plugin-data" }, sha256);
      const first = await runtime.ensureDataRoot({ scope: { kind: "user" }, plugin: "demo@market", dataRef: userDataRef }, signal);
      await writeFile(join(first.root, "state.json"), "survives");
      const second = await runtime.ensureDataRoot({ scope: { kind: "user" }, plugin: "demo@market", dataRef: userDataRef }, signal);
      expect(second.root).toBe(first.root);
      expect(await readFile(join(second.root, "state.json"), "utf8")).toBe("survives");
      const projectRef = derivePluginDataRef({ scope: { kind: "project", projectKey: `project-v1:sha256:${"1".repeat(64)}` }, plugin: "demo@market", purpose: "persistent-plugin-data" }, sha256);
      const project = await runtime.ensureDataRoot({ scope: { kind: "project", projectKey: `project-v1:sha256:${"1".repeat(64)}` }, plugin: "demo@market", dataRef: projectRef }, signal);
      expect(project.root).not.toBe(first.root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a data-root parent swap before touching a foreign tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-data-parent-swap-"));
    try {
      const layout = await createContentStoreLayout(join(root, "host"));
      const runtime = createRuntimeRootStore({ layout, platform: createNodeContentStorePlatform(), sha256 });
      const foreign = await mkdtemp(join(root, "foreign-"));
      await writeFile(join(foreign, "foreign.txt"), "untouched");
      const dataParent = join(layout.dataRoot, "..");
      const displaced = `${dataParent}.displaced`;
      await rename(dataParent, displaced);
      await symlink(foreign, dataParent);
      const dataRef = derivePluginDataRef({ scope: { kind: "user" }, plugin: "demo@market", purpose: "persistent-plugin-data" }, sha256);
      await expect(runtime.ensureDataRoot({ scope: { kind: "user" }, plugin: "demo@market", dataRef }, signal)).rejects.toThrow();
      expect(await readFile(join(foreign, "foreign.txt"), "utf8")).toBe("untouched");
      await rm(dataParent, { force: true });
      await rename(displaced, dataParent);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an allocation symlink swap before touching a foreign tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-projection-symlink-"));
    let allocationRoot: string | undefined;
    try {
      const layout = await createContentStoreLayout(join(root, "host"));
      const platform = createNodeContentStorePlatform();
      const runtime = createRuntimeRootStore({ layout, platform, sha256 });
      const payload = await mkdtemp(join(root, "payload-"));
      const projectionDigest = await hashProjectionRoot(payload, sha256);
      const scope = { kind: "user" } as const;
      const plugin = "demo@market" as const;
      const projectionRef = deriveProjectionRootRef({ scope, plugin, projectionDigest }, sha256);
      const allocation = await runtime.allocateProjectionRoot({ scope, plugin, projectionDigest, projectionRef }, signal);
      allocationRoot = allocation.root;
      const foreign = await mkdtemp(join(root, "foreign-"));
      await writeFile(join(foreign, "foreign.txt"), "untouched");
      const displaced = `${allocation.root}.displaced`;
      await rename(allocation.root, displaced);
      await symlink(foreign, allocation.root);

      await expect(runtime.sealProjectionRoot(allocation, signal)).rejects.toMatchObject({ code: "STAGING_ALLOCATION_INVALID" });
      expect(await readFile(join(foreign, "foreign.txt"), "utf8")).toBe("untouched");
      await expect(lstat(join(foreign, "metadata.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await rm(displaced, { recursive: true, force: true });
      await rm(allocation.root, { force: true });
      await rm(payload, { recursive: true, force: true });
    } finally {
      if (allocationRoot !== undefined) {
        await rm(allocationRoot, { recursive: true, force: true }).catch(() => undefined);
        await rm(`${allocationRoot}.displaced`, { recursive: true, force: true }).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a projection parent swap before allocation can write", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-projection-parent-swap-"));
    try {
      const layout = await createContentStoreLayout(join(root, "host"));
      const runtime = createRuntimeRootStore({ layout, platform: createNodeContentStorePlatform(), sha256 });
      const foreign = await mkdtemp(join(root, "foreign-"));
      await writeFile(join(foreign, "foreign.txt"), "untouched");
      const generatedParent = join(layout.generatedRoot, "..");
      const displaced = `${generatedParent}.displaced`;
      await rename(generatedParent, displaced);
      await symlink(foreign, generatedParent);
      const payload = await mkdtemp(join(root, "payload-"));
      const projectionDigest = await hashProjectionRoot(payload, sha256);
      const scope = { kind: "user" } as const;
      const plugin = "demo@market" as const;
      const projectionRef = deriveProjectionRootRef({ scope, plugin, projectionDigest }, sha256);
      await expect(runtime.allocateProjectionRoot({ scope, plugin, projectionDigest, projectionRef }, signal)).rejects.toThrow();
      expect(await readFile(join(foreign, "foreign.txt"), "utf8")).toBe("untouched");
      await rm(generatedParent, { force: true });
      await rename(displaced, generatedParent);
      await rm(payload, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("hashes and seals nested control-name payload entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-projection-controls-"));
    try {
      const layout = await createContentStoreLayout(join(root, "host"));
      const platform = createNodeContentStorePlatform();
      const runtime = createRuntimeRootStore({ layout, platform, sha256 });
      const payload = await mkdtemp(join(root, "payload-"));
      await mkdir(join(payload, "nested"));
      await writeFile(join(payload, "nested", "READY"), "payload-ready");
      await writeFile(join(payload, "nested", "metadata.json"), "payload-metadata");
      const projectionDigest = await hashProjectionRoot(payload, sha256);
      const scope = { kind: "user" } as const;
      const plugin = "demo@market" as const;
      const projectionRef = deriveProjectionRootRef({ scope, plugin, projectionDigest }, sha256);
      const allocation = await runtime.allocateProjectionRoot({ scope, plugin, projectionDigest, projectionRef }, signal);
      await mkdir(join(allocation.root, "nested"));
      await writeFile(join(allocation.root, "nested", "READY"), "payload-ready");
      await writeFile(join(allocation.root, "nested", "metadata.json"), "payload-metadata");
      const resolved = await runtime.sealProjectionRoot(allocation, signal);

      expect(await inspectProjection(resolved.root, sha256)).toMatchObject({ projectionRef, projectionDigest });
      expect((await lstat(join(resolved.root, "nested", "READY"))).mode & 0o777).toBe(0o444);
      expect((await lstat(join(resolved.root, "nested", "metadata.json"))).mode & 0o777).toBe(0o444);
      expect((await lstat(join(resolved.root, "nested"))).mode & 0o777).toBe(0o555);
      await chmod(join(resolved.root, "nested", "READY"), 0o644);
      await chmod(join(resolved.root, "nested", "metadata.json"), 0o644);
      await chmod(join(resolved.root, "nested"), 0o755);
      await chmod(join(resolved.root, "descriptor.json"), 0o644).catch(() => undefined);
      await chmod(join(resolved.root, "metadata.json"), 0o644);
      await chmod(join(resolved.root, "READY"), 0o644);
      await chmod(resolved.root, 0o755);
      await rm(payload, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores sealed permissions before removing a cancelled projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-projection-cancel-"));
    try {
      const layout = await createContentStoreLayout(join(root, "host"));
      const base = createNodeContentStorePlatform();
      const controller = new AbortController();
      let allocationRoot: string | undefined;
      const platform = {
        ...base,
        async syncDirectory(path: string): Promise<void> {
          await base.syncDirectory(path);
          if (dirname(path) === layout.generatedRoot && basename(path).startsWith(".payload-")) controller.abort();
        },
      };
      const runtime = createRuntimeRootStore({ layout, platform, sha256 });
      const payload = await mkdtemp(join(root, "payload-"));
      await writeFile(join(payload, "descriptor.json"), "cancel");
      const projectionDigest = await hashProjectionRoot(payload, sha256);
      const scope = { kind: "user" } as const;
      const plugin = "demo@market" as const;
      const projectionRef = deriveProjectionRootRef({ scope, plugin, projectionDigest }, sha256);
      const allocation = await runtime.allocateProjectionRoot({ scope, plugin, projectionDigest, projectionRef }, signal);
      allocationRoot = allocation.root;
      await writeFile(join(allocation.root, "descriptor.json"), "cancel");

      await expect(runtime.sealProjectionRoot(allocation, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      await expect(lstat(allocation.root)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(layout.projectionStagingRoot)).toEqual([]);
      await rm(payload, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts cleanup failures when a sealed projection root is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-projection-cleanup-"));
    try {
      const layout = await createContentStoreLayout(join(root, "host"));
      const base = createNodeContentStorePlatform();
      const foreign = await mkdtemp(join(root, "foreign-"));
      await writeFile(join(foreign, "foreign.txt"), "untouched");
      let displacedPrepared: string | undefined;
      const platform = {
        ...base,
        async syncDirectory(path: string): Promise<void> {
          if (displacedPrepared === undefined && dirname(path) === layout.generatedRoot && basename(path).startsWith(".payload-")) {
            await base.syncDirectory(path);
            displacedPrepared = `${path}.displaced`;
            await rename(path, displacedPrepared);
            await symlink(foreign, path);
            throw new Error("/native/private/path cleanup failure");
          }
          await base.syncDirectory(path);
        },
      };
      const runtime = createRuntimeRootStore({ layout, platform, sha256 });
      const payload = await mkdtemp(join(root, "payload-"));
      await writeFile(join(payload, "descriptor.json"), "cleanup");
      const projectionDigest = await hashProjectionRoot(payload, sha256);
      const scope = { kind: "user" } as const;
      const plugin = "demo@market" as const;
      const projectionRef = deriveProjectionRootRef({ scope, plugin, projectionDigest }, sha256);
      const allocation = await runtime.allocateProjectionRoot({ scope, plugin, projectionDigest, projectionRef }, signal);
      await writeFile(join(allocation.root, "descriptor.json"), "cleanup");

      const error = await runtime.sealProjectionRoot(allocation, signal).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: "ADAPTER_FAILED", details: { cleanup: "incomplete" } });
      expect((error as Error).message).not.toContain("private/path");
      expect(JSON.stringify((error as { toDiagnostic(): unknown }).toDiagnostic())).not.toContain("private/path");
      expect(await readFile(join(foreign, "foreign.txt"), "utf8")).toBe("untouched");
      if (displacedPrepared !== undefined) await rm(displacedPrepared, { recursive: true, force: true });
      await rm(allocation.root, { recursive: true, force: true });
      await rm(payload, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects tampered scope or plugin metadata even when the stored ref is unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-projection-metadata-binding-"));
    let published: string | undefined;
    try {
      const layout = await createContentStoreLayout(join(root, "host"));
      const runtime = createRuntimeRootStore({ layout, platform: createNodeContentStorePlatform(), sha256 });
      const payload = await mkdtemp(join(root, "payload-"));
      await writeFile(join(payload, "descriptor.json"), "bound");
      const projectionDigest = await hashProjectionRoot(payload, sha256);
      const scope = { kind: "user" } as const;
      const plugin = "demo@market" as const;
      const projectionRef = deriveProjectionRootRef({ scope, plugin, projectionDigest }, sha256);
      const allocation = await runtime.allocateProjectionRoot({ scope, plugin, projectionDigest, projectionRef }, signal);
      await writeFile(join(allocation.root, "descriptor.json"), "bound");
      const resolved = await runtime.sealProjectionRoot(allocation, signal);
      published = resolved.root;

      const metadataPath = join(published, "metadata.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
      const original = JSON.stringify(metadata);
      for (const tampered of [
        { ...metadata, plugin: "other@market" },
        { ...metadata, scope: { kind: "project", projectKey: `project-v1:sha256:${"e".repeat(64)}` } },
      ]) {
        await chmod(metadataPath, 0o644);
        await writeFile(metadataPath, JSON.stringify(tampered));
        await chmod(metadataPath, 0o444);
        await expect(inspectProjection(published, sha256)).rejects.toMatchObject({ code: "CONTENT_VERIFICATION_FAILED" });
        await chmod(metadataPath, 0o644);
        await writeFile(metadataPath, original);
        await chmod(metadataPath, 0o444);
      }
      await rm(payload, { recursive: true, force: true });
    } finally {
      if (published !== undefined) {
        await chmod(join(published, "descriptor.json"), 0o644).catch(() => undefined);
        await chmod(join(published, "metadata.json"), 0o644).catch(() => undefined);
        await chmod(join(published, "READY"), 0o644).catch(() => undefined);
        await chmod(published, 0o755).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes a digest-verified replaceable projection root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-projection-roots-"));
    let published: string | undefined;
    let allocationRoot: string | undefined;
    try {
      const layout = await createContentStoreLayout(join(root, "host"));
      const platform = createNodeContentStorePlatform();
      const runtime = createRuntimeRootStore({ layout, platform, sha256 });
      const source = await mkdtemp(join(root, "payload-"));
      await writeFile(join(source, "descriptor.json"), "one");
      const projectionDigest = await hashProjectionRoot(source, sha256);
      const scope = { kind: "user" } as const;
      const plugin = "demo@market" as const;
      const projectionRef = deriveProjectionRootRef({ scope, plugin, projectionDigest }, sha256);
      const allocation = await runtime.allocateProjectionRoot({ scope, plugin, projectionDigest, projectionRef }, signal);
      allocationRoot = allocation.root;
      await writeFile(join(allocation.root, "descriptor.json"), "one");
      const resolved = await runtime.sealProjectionRoot(allocation, signal);
      published = resolved.root;
      expect(await inspectProjection(resolved.root, sha256)).toMatchObject({ projectionRef, projectionDigest });
      expect(dirname(resolved.root)).toBe(layout.generatedRoot);
      expect(basename(resolved.root)).toMatch(/^\.payload-[0-9a-f]{32}$/u);
      expect(await inspectPublishedProjection(layout.projectionPath(projectionRef), sha256)).toMatchObject({ root: resolved.root, metadata: { projectionRef, projectionDigest } });
      expect((await lstat(layout.projectionPath(projectionRef))).isFile()).toBe(true);
      await expect(writeFile(join(resolved.root, "new.txt"), "blocked")).rejects.toThrow();
      await chmod(join(resolved.root, "descriptor.json"), 0o644).catch(() => undefined);
      await chmod(resolved.root, 0o755).catch(() => undefined);
      await rm(source, { recursive: true, force: true });
    } finally {
      if (allocationRoot !== undefined) {
        await chmod(join(allocationRoot, "descriptor.json"), 0o644).catch(() => undefined);
        await chmod(join(allocationRoot, "metadata.json"), 0o644).catch(() => undefined);
        await chmod(join(allocationRoot, "READY"), 0o644).catch(() => undefined);
        await chmod(allocationRoot, 0o755).catch(() => undefined);
      }
      if (published !== undefined) {
        await chmod(join(published, "descriptor.json"), 0o644).catch(() => undefined);
        await chmod(join(published, "metadata.json"), 0o644).catch(() => undefined);
        await chmod(join(published, "READY"), 0o644).catch(() => undefined);
        await chmod(published, 0o755).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
