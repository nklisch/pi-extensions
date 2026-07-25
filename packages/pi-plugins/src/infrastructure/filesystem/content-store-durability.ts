import { randomBytes } from "node:crypto";
import { open as openFile } from "node:fs/promises";
import { chmod, link, lstat, mkdir, rename as renamePath, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DomainContractError, ErrorCodeRegistry } from "../../domain/errors.js";
import type { ContentManifest } from "../../domain/content-manifest.js";
import type { ContentStoreCapabilities } from "../../application/ports/content-store.js";
import type { ContentStorePlatform } from "../../application/ports/content-store-platform.js";

export type RenameNoReplace = (source: string, destination: string) => Promise<"published" | "exists">;

export type NodeContentStorePlatformOptions = Readonly<{
  /** A platform-specific no-replace primitive. Plain rename is never used as a fallback. */
  renameNoReplace?: RenameNoReplace;
}>;

function unavailable(operation: string, cause?: unknown): DomainContractError {
  return new DomainContractError({
    code: ErrorCodeRegistry.durabilityUnavailable,
    operation,
    message: "immutable content store durability capability is unavailable",
    details: { operation, capability: "atomic-no-replace-directory" },
    ...(cause === undefined ? {} : { cause }),
  });
}

async function syncHandle(path: string, operation: string): Promise<void> {
  let handle;
  try {
    handle = await openFile(path, "r");
    await handle.sync();
  } catch (error) {
    throw unavailable(operation, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function sealEntry(root: string, entry: ContentManifest["entries"][number]): Promise<void> {
  const target = join(root, "content", ...entry.path.split("/"));
  const stat = await lstat(target);
  if (entry.kind === "directory") {
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable("sealReadOnly");
    await chmod(target, 0o555);
    return;
  }
  if (entry.kind === "file") {
    if (!stat.isFile() || stat.isSymbolicLink()) throw unavailable("sealReadOnly");
    await chmod(target, entry.mode === 0o755 ? 0o555 : 0o444);
    return;
  }
  if (!stat.isSymbolicLink()) throw unavailable("sealReadOnly");
  // chmod on a symlink follows the link on several supported platforms. The
  // link text is immutable by publication and is intentionally left untouched.
}

const PUBLICATION_ENTRY = "metadata.json";

/**
 * Publish one already-durable hidden payload by hard-linking its immutable
 * metadata into the canonical digest path. `link(2)` is the Node primitive we
 * need here: creation is atomic and fails with EEXIST instead of replacing a
 * concurrent winner. Readers resolve the payload only through that complete
 * marker, so a crash exposes either no revision or the whole sealed revision.
 */
async function linkPublication(source: string, destination: string): Promise<"published" | "exists"> {
  try {
    await link(join(source, PUBLICATION_ENTRY), destination);
    return "published";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    throw error;
  }
}

async function probePublication(root: string): Promise<void> {
  if (process.platform === "win32") throw unavailable("probe");
  const nonce = randomBytes(16).toString("hex");
  const first = join(root, `.publication-probe-${nonce}-first`);
  const second = join(root, `.publication-probe-${nonce}-second`);
  const target = join(root, `.publication-probe-${nonce}-target`);
  try {
    await mkdir(first, { mode: 0o700 });
    await mkdir(second, { mode: 0o700 });
    await writeFile(join(first, PUBLICATION_ENTRY), "first", { flag: "wx", mode: 0o600 });
    await writeFile(join(second, PUBLICATION_ENTRY), "second", { flag: "wx", mode: 0o600 });
    await syncHandle(join(first, PUBLICATION_ENTRY), "probe");
    await syncHandle(join(second, PUBLICATION_ENTRY), "probe");
    await syncHandle(first, "probe");
    await syncHandle(second, "probe");
    if (await linkPublication(first, target) !== "published") throw new Error("publication probe did not publish");
    if (await linkPublication(second, target) !== "exists") throw new Error("publication probe replaced its winner");
    const [sourceStat, targetStat] = await Promise.all([lstat(join(first, PUBLICATION_ENTRY)), lstat(target)]);
    if (!targetStat.isFile() || targetStat.isSymbolicLink() || sourceStat.dev !== targetStat.dev || sourceStat.ino !== targetStat.ino) {
      throw new Error("publication probe did not create an exact hard-link marker");
    }
    await syncHandle(target, "probe");
    await syncHandle(root, "probe");
  } catch (error) {
    throw unavailable("probe", error);
  } finally {
    await unlink(target).catch(() => undefined);
    await rm(first, { recursive: true, force: true }).catch(() => undefined);
    await rm(second, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Node does not expose renameat2(RENAME_NOREPLACE) for direct directory moves.
 * Immutable revisions therefore use the hard-link visibility protocol above.
 * An injected direct rename remains available only for focused platform tests;
 * it is never the production content or projection publication path.
 */
export function createNodeContentStorePlatform(
  options: NodeContentStorePlatformOptions = {},
): ContentStorePlatform {
  const renameNoReplace = options.renameNoReplace;
  return Object.freeze({
    async probe(root: string): Promise<ContentStoreCapabilities> {
      if (renameNoReplace === undefined) await probePublication(root);
      else if (process.platform === "win32") throw unavailable("probe");
      return {
        atomicNoReplaceDirectory: true,
        fileSync: true,
        directorySync: true,
        readOnlyModeEnforcement: "posix-mode",
      };
    },
    async publishDirectoryNoReplace(source: string, destination: string): Promise<"published" | "exists"> {
      // Injected test/platform adapters retain the old direct-directory shape;
      // production always takes the atomic marker path.
      return renameNoReplace === undefined
        ? linkPublication(source, destination)
        : renameNoReplace(source, destination);
    },
    async syncFile(path: string): Promise<void> {
      await syncHandle(path, "syncFile");
    },
    async syncDirectory(path: string): Promise<void> {
      // O_DIRECTORY is advisory on platforms where directory handles are
      // supported; opening and syncing the handle is the durability boundary.
      if (process.platform === "win32") throw unavailable("syncDirectory");
      await syncHandle(path, "syncDirectory");
    },
    async sealReadOnly(root: string, manifest: ContentManifest): Promise<void> {
      for (const entry of [...manifest.entries].sort((left, right) => right.path.split("/").length - left.path.split("/").length)) {
        await sealEntry(root, entry);
      }
      await chmod(join(root, "content"), 0o555);
      await chmod(root, 0o555);
    },
  });
}

/** Internal helper for tests and platform adapters that need a strict no-replace race. */
export async function renameNoReplaceByProbe(source: string, destination: string): Promise<"published" | "exists"> {
  try {
    await lstat(destination);
    return "exists";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // This helper is intentionally not used by production composition: the
  // check-then-rename sequence is not atomic and would violate the contract.
  await renamePath(source, destination);
  return "published";
}
