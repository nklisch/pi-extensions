import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createSqliteScopeLockManager,
  scopeDatabaseName,
} from "../../../src/infrastructure/state/sqlite-scope-lock.js";
import { BoundaryError } from "../../../src/domain/errors.js";
import type { ScopeReference } from "../../../src/domain/state/scope.js";

const user: ScopeReference = { kind: "user" };
const project: ScopeReference = {
  kind: "project",
  projectKey: `project-v1:sha256:${"b".repeat(64)}` as never,
};
const child = resolve(process.cwd(), "test/fixtures/locking/child-lock-holder.mjs");

async function root(): Promise<string> {
  return mkdtemp(join(process.cwd(), ".test-scope-lock-"));
}

async function manager(lockRoot: string) {
  return createSqliteScopeLockManager({
    lockRoot,
    retryDelayMs: { minimum: 1, maximum: 2 },
    verifyLocalFilesystem: async () => {},
  });
}

async function waitForExit(childProcess: ChildProcessWithoutNullStreams): Promise<void> {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => childProcess.once("close", () => resolvePromise()));
}

describe("SQLite scope lock adapter", () => {
  it("accepts the host platform's local filesystem under the default capability gate", async () => {
    // Regression for issue #2: the default `verifyLocalFilesystemCapability`
    // must not fail closed on the host. Platforms with a magic-number table
    // (linux/win32/freebsd) accept the host's real local FS; platforms
    // without a table (darwin and anything else Node cannot introspect) skip
    // the integer check entirely. Either way, scope-lock creation succeeds.
    const lockRoot = await root();
    try {
      const locks = await createSqliteScopeLockManager({
        lockRoot,
        retryDelayMs: { minimum: 1, maximum: 1 },
      });
      const lease = await locks.acquire(user, new AbortController().signal);
      await lease.release();
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it("uses fixed scope names and permits independent scopes", async () => {
    const lockRoot = await root();
    try {
      expect(scopeDatabaseName(user)).toBe("user.sqlite");
      expect(scopeDatabaseName(project)).toBe(`project-project-v1%3Asha256%3A${"b".repeat(64)}.sqlite`);
      const locks = await manager(lockRoot);
      const userLease = await locks.acquire(user, new AbortController().signal);
      const projectLease = await locks.acquire(project, new AbortController().signal);
      await Promise.all([userLease.release(), projectLease.release()]);
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it("serializes same-scope contenders and proceeds after release", async () => {
    const lockRoot = await root();
    try {
      const locks = await manager(lockRoot);
      const first = await locks.acquire(user, new AbortController().signal);
      const controller = new AbortController();
      const reason = new Error("caller deadline");
      const waiting = locks.acquire(user, controller.signal);
      setTimeout(() => controller.abort(reason), 10);
      await expect(waiting).rejects.toBe(reason);
      await first.release();
      const second = await locks.acquire(user, new AbortController().signal);
      await second.release();
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it("does not let a paused child owner expire, then acquires after SIGKILL", async () => {
    const lockRoot = await root();
    const dbPath = join(lockRoot, "user.sqlite");
    const locks = await manager(lockRoot);
    const initialized = await locks.acquire(user, new AbortController().signal);
    await initialized.release();
    const holder = spawn(process.execPath, [child, dbPath], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: "", VITEST: undefined },
      stdio: ["pipe", "pipe", "ignore"],
    });
    try {
      await new Promise<void>((resolvePromise, reject) => {
        holder.stdout.once("data", () => resolvePromise());
        holder.once("error", reject);
        holder.once("exit", (code, signal) => reject(new Error(`lock holder exited before ready: ${code ?? signal}`)));
      });
      const controller = new AbortController();
      const reason = new Error("caller deadline");
      const waiting = locks.acquire(user, controller.signal);
      setTimeout(() => controller.abort(reason), 10);
      await expect(waiting).rejects.toBe(reason);
      expect(holder.exitCode).toBeNull();
      holder.kill("SIGKILL");
      await waitForExit(holder);

      const lease = await locks.acquire(user, new AbortController().signal);
      await lease.release();
    } finally {
      if (holder.exitCode === null) holder.kill("SIGKILL");
      await waitForExit(holder);
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it("ignores stale marker debris left by pre-removal host versions", async () => {
    const lockRoot = await root();
    try {
      const locks = await manager(lockRoot);
      const first = await locks.acquire(user, new AbortController().signal);
      await first.release();
      // Pre-removal hosts wrote .identity markers, .initializing claims, and
      // .handle-* aliases next to each lock database. All are inert debris.
      const dbPath = join(lockRoot, "user.sqlite");
      await writeFile(`${dbPath}.identity`, JSON.stringify({ protocol: "pi-plugin-host-scope-lock-database", identity: { device: "old-epoch", inode: "0" } }));
      await writeFile(`${dbPath}.initializing`, JSON.stringify({ state: "initializing", owner: { pid: 1, startTime: "0" } }));
      await writeFile(`${dbPath}.handle-stale`, "");
      await writeFile(join(lockRoot, ".scope-lock-root.identity"), JSON.stringify({ identity: "old-root" }));
      const lease = await locks.acquire(user, new AbortController().signal);
      await lease.assertOwned(new AbortController().signal);
      await lease.release();
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it("recreates a missing lock database; its only content is the protocol row", async () => {
    const lockRoot = await root();
    try {
      const locks = await manager(lockRoot);
      const lease = await locks.acquire(user, new AbortController().signal);
      await lease.release();
      await rm(join(lockRoot, "user.sqlite"));
      const recreated = await locks.acquire(user, new AbortController().signal);
      await recreated.release();
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on a database whose schema is not the lock protocol", async () => {
    const lockRoot = await root();
    try {
      const database = new DatabaseSync(join(lockRoot, "user.sqlite"));
      database.exec("CREATE TABLE unrelated (value TEXT) STRICT;");
      database.close();
      const locks = await manager(lockRoot);
      await expect(locks.acquire(user, new AbortController().signal)).rejects.toBeInstanceOf(BoundaryError);
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it("releases idempotently and keeps the scope reusable", async () => {
    const lockRoot = await root();
    try {
      const locks = await manager(lockRoot);
      const lease = await locks.acquire(user, new AbortController().signal);
      await lease.release();
      await lease.release();
      const second = await locks.acquire(user, new AbortController().signal);
      await second.release();
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for capability and symlink failures", async () => {
    const lockRoot = await root();
    const link = `${lockRoot}-link`;
    try {
      const capabilityFailure = await createSqliteScopeLockManager({
        lockRoot,
        retryDelayMs: { minimum: 1, maximum: 1 },
        verifyLocalFilesystem: async () => { throw new Error("network filesystem"); },
      }).catch((error: unknown) => error);
      expect(capabilityFailure).toBeInstanceOf(BoundaryError);
      expect((capabilityFailure as BoundaryError).code).toBe("ADAPTER_FAILED");
      await symlink(lockRoot, link);
      const symlinkFailure = await createSqliteScopeLockManager({
        lockRoot: link,
        retryDelayMs: { minimum: 1, maximum: 1 },
        verifyLocalFilesystem: async () => {},
      }).catch((error: unknown) => error);
      expect(symlinkFailure).toBeInstanceOf(BoundaryError);
      expect((symlinkFailure as BoundaryError).code).toBe("ADAPTER_FAILED");
    } finally {
      await rm(link, { recursive: true, force: true });
      await rm(lockRoot, { recursive: true, force: true });
    }
  });
});
