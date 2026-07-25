import {
  chmod,
  lstat,
  mkdir,
  statfs,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, parse } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_DATABASE_MODE = 0o600;

/**
 * Filesystem types whose locking semantics are known to be local enough for
 * the SQLite adapter. The allowlist is intentionally conservative: an
 * unknown mount is a capability failure, not permission to silently fall back
 * to process-local coordination.
 */
const LOCAL_FILESYSTEM_TYPES_BY_PLATFORM: Readonly<Record<string, ReadonlySet<number>>> = {
  // Only filesystems whose SQLite locking behavior is covered by this
  // adapter's capability boundary are accepted. Unknown platform/type pairs
  // fail closed rather than inheriting a Linux guess.
  linux: new Set([
    0x0000ef53, // ext2/3/4
    0x01021994, // tmpfs
    0x3153464a, // jfs
    0x52654973, // reiserfs
    0x58465342, // xfs
    0x794c7630, // overlayfs
    0x9123683e, // btrfs
    0xf2f52010, // f2fs
    0x2fc12fc1, // zfs
    0x858458f6, // ramfs
  ]),
  win32: new Set([0x5346544e]), // NTFS
  darwin: new Set([0x41504653, 0x48465300]), // APFS, HFS+
  freebsd: new Set([0x011954, 0x09011954]), // UFS, UFS2
};

function filesystemMode(mode: number): number {
  return mode & 0o777;
}

function filesystemFailure(message: string): Error {
  return new Error(message);
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw filesystemFailure("lock root contains a symbolic link");
    if (!stats.isDirectory()) throw filesystemFailure("lock root component is not a directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (mkdirError) {
      // Another process may create the same first-use component after our
      // ENOENT observation. Accept only that race, then revalidate the winner
      // without following a symlink below.
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw filesystemFailure("lock root component is not a private directory");
    }
  }
}

/** Create and validate a private root without following any path symlink. */
export async function ensurePrivateLockRoot(input: string): Promise<string> {
  if (typeof input !== "string" || input.length === 0 || !isAbsolute(input)) {
    throw new TypeError("lockRoot must be a non-empty absolute path");
  }
  const root = resolve(input);
  const parsed = parse(root);
  const remainder = relative(parsed.root, root);
  let current = parsed.root;
  for (const component of remainder.split(sep)) {
    if (component.length === 0) continue;
    current = join(current, component);
    await ensureDirectory(current);
  }
  await chmod(root, PRIVATE_DIRECTORY_MODE);
  const stats = await lstat(root);
  if (stats.isSymbolicLink() || !stats.isDirectory() || filesystemMode(stats.mode) !== PRIVATE_DIRECTORY_MODE) {
    throw filesystemFailure("lock root is not private");
  }
  return root;
}

/**
 * Verify the mounted filesystem rather than assuming that a successful SQLite
 * open proves cross-process exclusion. Callers may inject a stricter policy
 * when a platform has a better local-filesystem classifier.
 */
export async function verifyLocalFilesystemCapability(root: string): Promise<void> {
  const stats = await statfs(root);
  const type = Number(stats.type);
  const supportedTypes = LOCAL_FILESYSTEM_TYPES_BY_PLATFORM[process.platform];
  if (supportedTypes === undefined || !Number.isSafeInteger(type) || !supportedTypes.has(type >>> 0)) {
    throw filesystemFailure("filesystem locking capability is unknown or unsupported on this platform");
  }
}

export const LOCAL_LOCK_DIRECTORY_MODE = PRIVATE_DIRECTORY_MODE;
export const LOCAL_LOCK_DATABASE_MODE = PRIVATE_DATABASE_MODE;
