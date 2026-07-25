import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertRootCapability, type RootCapability } from "./content-store-layout.js";

export type PreparedTreeIdentity = Readonly<{
  dev: number;
  ino: number;
}>;

type CleanupEntry = Readonly<{ path: string; kind: "directory" | "file" | "symlink"; dev: number; ino: number }>;

async function collectEntries(path: string, entries: CleanupEntry[]): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) {
    entries.push({ path, kind: "symlink", dev: stat.dev, ino: stat.ino });
    return;
  }
  if (stat.isDirectory()) {
    for (const child of await readdir(path)) {
      await collectEntries(join(path, child), entries);
    }
    entries.push({ path, kind: "directory", dev: stat.dev, ino: stat.ino });
    return;
  }
  entries.push({ path, kind: "file", dev: stat.dev, ino: stat.ino });
}

/** Restore permissions bottom-up before removing a sealed tree. */
async function restorePermissions(path: string): Promise<void> {
  const entries: CleanupEntry[] = [];
  await collectEntries(path, entries);
  for (const entry of entries) {
    if (entry.kind === "symlink") continue;
    const current = await lstat(entry.path);
    if (current.isSymbolicLink() || current.dev !== entry.dev || current.ino !== entry.ino) {
      throw new Error("prepared cleanup entry identity changed");
    }
    if (entry.kind === "file") await chmod(entry.path, 0o600);
  }
  for (const entry of entries) {
    if (entry.kind !== "directory") continue;
    const current = await lstat(entry.path);
    if (current.isSymbolicLink() || current.dev !== entry.dev || current.ino !== entry.ino) {
      throw new Error("prepared cleanup entry identity changed");
    }
    await chmod(entry.path, 0o700);
  }
}

/**
 * Remove an adapter-owned prepared tree without following a substituted root.
 * The caller may provide the identity captured immediately after creation;
 * mismatches are reported instead of mutating a foreign directory.
 */
export async function removePreparedTree(
  path: string,
  expected?: PreparedTreeIdentity,
  parent?: RootCapability,
): Promise<"removed" | "already-absent"> {
  if (parent !== undefined) await assertRootCapability(parent, "removePreparedTree");
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "already-absent";
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("prepared cleanup root is not an owned directory");
  }
  if (expected !== undefined && (stat.dev !== expected.dev || stat.ino !== expected.ino)) {
    throw new Error("prepared cleanup root identity changed");
  }
  await restorePermissions(path);
  if (parent !== undefined) await assertRootCapability(parent, "removePreparedTree");
  const final = await lstat(path);
  if (final.isSymbolicLink() || !final.isDirectory() || (expected !== undefined && (final.dev !== expected.dev || final.ino !== expected.ino))) {
    throw new Error("prepared cleanup root identity changed");
  }
  await rm(path, { recursive: true, force: false });
  return "removed";
}
