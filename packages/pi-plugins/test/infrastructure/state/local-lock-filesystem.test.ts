import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensurePrivateLockRoot,
  verifyLocalFilesystemCapability,
} from "../../../src/infrastructure/state/local-lock-filesystem.js";

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-lock-fs-"));
}

describe("ensurePrivateLockRoot", () => {
  it("creates and enforces a private leaf directory", async () => {
    const root = await freshRoot();
    const target = join(root, "a", "b", "lock-root");
    try {
      const resolved = await ensurePrivateLockRoot(target);
      expect(resolved).toBe(target);
      const stats = await lstat(target);
      expect(stats.isDirectory()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
      expect(stats.mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a path whose ancestor is an OS-managed symlink (regression: macOS /tmp -> /private/tmp)", async () => {
    // Earlier versions walked every path component and rejected any symlink.
    // That broke legitimate OS-managed symlinks (macOS `/tmp -> /private/tmp`,
    // BSD `/home -> /usr/home`). The walk is gone; only the leaf is validated.
    const root = await freshRoot();
    const realParent = join(root, "real-parent");
    const linkParent = join(root, "link-parent");
    const target = join(linkParent, "lock-root");
    try {
      await mkdir(realParent, { recursive: true });
      await symlink(realParent, linkParent);
      const resolved = await ensurePrivateLockRoot(target);
      expect(resolved).toBe(target);
      // The leaf exists, is private, and is not itself a symlink.
      const stats = await lstat(target);
      expect(stats.isDirectory()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
      expect(stats.mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a leaf symlink at the lock root", async () => {
    const root = await freshRoot();
    const real = join(root, "real");
    const link = join(root, "link");
    try {
      await mkdir(real);
      await symlink(real, link);
      await expect(ensurePrivateLockRoot(link)).rejects.toThrow(/lock root is not private/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("narrows an existing non-private leaf to 0o700 and rejects a non-directory leaf", async () => {
    const root = await freshRoot();
    const target = join(root, "lock-root");
    try {
      // A pre-existing leaf with a wider mode is narrowed to 0o700; the
      // post-chmod revalidation is what carries the privacy guarantee.
      await mkdir(target, { mode: 0o755 });
      const resolved = await ensurePrivateLockRoot(target);
      expect(resolved).toBe(target);
      const stats = await lstat(target);
      expect(stats.mode & 0o777).toBe(0o700);

      // A non-directory leaf (regular file) is rejected.
      const { writeFile } = await import("node:fs/promises");
      const fileTarget = join(root, "file-leaf");
      await writeFile(fileTarget, "x");
      await expect(ensurePrivateLockRoot(fileTarget)).rejects.toThrow(/lock root is not private/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects non-absolute and empty input", async () => {
    await expect(ensurePrivateLockRoot("")).rejects.toThrow(/absolute path/);
    await expect(ensurePrivateLockRoot("relative/path")).rejects.toThrow(/absolute path/);
  });
});

describe("verifyLocalFilesystemCapability", () => {
  it("does not fail closed on the host platform (regression: issue #2 macOS APFS)", async () => {
    // The integer magic-number allowlist is now Linux-only — Linux is the
    // only platform where `statfs.f_type` carries a disk magic. On Windows
    // libuv returns `0`; on FreeBSD `f_type` is the kernel-assigned `vfc_typenum`
    // (a small enum, not a disk magic); on Darwin it is vestigial `0x1a`.
    // The host's own temp directory must pass on every platform.
    //
    // The Linux rejection path (an unfamiliar magic number throws) is
    // exercised end-to-end by sqlite-scope-lock.test.ts via the injected
    // `verifyLocalFilesystem` failure path.
    const root = await freshRoot();
    try {
      await expect(verifyLocalFilesystemCapability(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips the magic-number check on non-Linux platforms (regression: silent breakage on win32/freebsd)", async () => {
    // The original table included win32 and freebsd entries with Linux-style
    // disk magics. libuv returns 0 on Windows and FreeBSD's f_type is a small
    // kernel enum, so both entries always failed closed — silently breaking
    // those platforms because no one runs pi-plugins there. The table is now
    // Linux-only; assert the no-op behavior on every non-Linux platform.
    const root = await freshRoot();
    const original = process.platform;
    const set = (value: string) => Object.defineProperty(process, "platform", { configurable: true, value });
    try {
      for (const platform of ["darwin", "win32", "freebsd", "openbsd", "aix", "sunos"]) {
        set(platform);
        await expect(verifyLocalFilesystemCapability(root)).resolves.toBeUndefined();
      }
    } finally {
      set(original);
      await rm(root, { recursive: true, force: true });
    }
  });
});
