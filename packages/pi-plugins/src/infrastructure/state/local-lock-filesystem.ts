import {
  chmod,
  lstat,
  mkdir,
  statfs,
} from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_DATABASE_MODE = 0o600;

/**
 * Platforms where `statfs.f_type` carries a Linux-style filesystem magic
 * number that identifies local-enough locking semantics for the SQLite
 * adapter. This is a Linux-only signal: libuv returns `0` on Windows
 * (libuv does not expose an NTFS magic via `statfs`), and on FreeBSD
 * `statfs.f_type` is the kernel-assigned `vfc_typenum` (a small enum like
 * `0x0095` for UFS, `0x0023` for ZFS), not the disk magics people sometimes
 * copy from Linux headers — so an integer allowlist keyed on Linux magics
 * would always fail closed there. Darwin is the same story (vestigial
 * `0x1a`); see `verifyLocalFilesystemCapability` for the platform dispatch.
 */
const LOCAL_FILESYSTEM_MAGIC_BY_PLATFORM: Readonly<Record<string, ReadonlySet<number>>> = {
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
};

function filesystemMode(mode: number): number {
  return mode & 0o777;
}

function filesystemFailure(message: string): Error {
  return new Error(message);
}

/**
 * Create and validate the lock root, then enforce that the leaf itself is
 * private. The 0o700 leaf mode is the actual security boundary: no other
 * local user can write into a directory the runtime user owns at 0o700,
 * regardless of how the path arrived there.
 *
 * Earlier versions walked every ancestor and rejected any path component
 * symlink. That defense assumed an attacker with write access to a parent of
 * the lock root — at which point the user is already compromised — while it
 * broke legitimate OS-managed symlinks such as macOS `/tmp → /private/tmp`.
 * The walk is gone; the leaf check is what carries the guarantee.
 */
export async function ensurePrivateLockRoot(input: string): Promise<string> {
  if (typeof input !== "string" || input.length === 0 || !isAbsolute(input)) {
    throw new TypeError("lockRoot must be a non-empty absolute path");
  }
  const root = resolve(input);
  try {
    await mkdir(root, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
  } catch (mkdirError) {
    // A concurrent creator may win the race after our first attempt. Accept
    // only that race; the leaf revalidation below catches anything else.
    if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
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
 *
 * The integer magic-number allowlist applies only to Linux, where
 * `statfs.f_type` carries a filesystem magic. On every other platform
 * (Darwin, Windows, FreeBSD, AIX, etc.) the gate is a no-op: libuv returns
 * `0` on Windows, FreeBSD's `f_type` is a kernel enum (`vfc_typenum`), and
 * Darwin's is vestigial `0x1a` (issue #2). A fail-closed stance on those
 * platforms has no signal and breaks real startup. SQLite locking works
 * empirically on those platforms; the allowlist is a defense against
 * known-broken network filesystems on Linux, not a pre-condition for the
 * adapter to function. Callers needing a real classification on other
 * platforms must inject `verifyLocalFilesystem`.
 */
export async function verifyLocalFilesystemCapability(root: string): Promise<void> {
  const supportedTypes = LOCAL_FILESYSTEM_MAGIC_BY_PLATFORM[process.platform];
  if (supportedTypes === undefined) return;
  const stats = await statfs(root);
  const type = Number(stats.type);
  if (!Number.isSafeInteger(type) || !supportedTypes.has(type >>> 0)) {
    throw filesystemFailure("filesystem locking capability is unknown or unsupported on this platform");
  }
}

export const LOCAL_LOCK_DIRECTORY_MODE = PRIVATE_DIRECTORY_MODE;
export const LOCAL_LOCK_DATABASE_MODE = PRIVATE_DATABASE_MODE;
