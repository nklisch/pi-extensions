import { chmod, lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ScopeReferenceSchema, type ScopeReference } from "../../domain/state/scope.js";
import { ensurePrivateLockRoot, verifyLocalFilesystemCapability, LOCAL_LOCK_DATABASE_MODE, LOCAL_LOCK_DIRECTORY_MODE } from "../state/local-lock-filesystem.js";

export type RecoveryFilesystem = Readonly<{
  hostRoot: string;
  recoveryRoot: string;
  journalRoot: string;
  journalDatabasePath(scope: ScopeReference): string;
  rootIdentity: string;
  verify(): Promise<void>;
}>;

function scopeDatabaseName(scope: ScopeReference): string {
  const value = ScopeReferenceSchema.parse(scope);
  return value.kind === "user" ? "user.sqlite" : `project-${encodeURIComponent(value.projectKey)}.sqlite`;
}

async function ensurePrivateDirectory(path: string): Promise<string> {
  const root = await ensurePrivateLockRoot(path);
  await chmod(root, LOCAL_LOCK_DIRECTORY_MODE);
  return await realpath(root);
}

/** Bootstrap the recovery-owned roots without exposing a path codec to application code. */
export async function createLocalRecoveryFilesystem(options: Readonly<{
  hostRoot: string;
  verifyLocalFilesystem?: (root: string) => Promise<void>;
}>): Promise<RecoveryFilesystem> {
  if (options === null || typeof options !== "object" || typeof options.hostRoot !== "string" || !isAbsolute(options.hostRoot)) throw new TypeError("recovery hostRoot must be absolute");
  const hostRoot = resolve(options.hostRoot);
  const recoveryRoot = await ensurePrivateDirectory(join(hostRoot, "recovery"));
  const journalParent = await ensurePrivateDirectory(join(recoveryRoot, "journal"));
  const journalRoot = await ensurePrivateDirectory(join(journalParent, "v1"));
  const markerPath = join(recoveryRoot, ".recovery-root.identity");
  let marker: { protocol: "pi-plugin-host-recovery-root"; version: 1; identity: string };
  try {
    const stats = await lstat(markerPath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("recovery identity marker is invalid");
    marker = JSON.parse(await (await import("node:fs/promises")).readFile(markerPath, "utf8")) as typeof marker;
    if (marker.protocol !== "pi-plugin-host-recovery-root" || marker.version !== 1 || typeof marker.identity !== "string" || marker.identity.length === 0) throw new Error("recovery identity marker is invalid");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    marker = { protocol: "pi-plugin-host-recovery-root", version: 1, identity: randomUUID() };
    const temporary = `${markerPath}.${randomUUID()}.tmp`;
    const { writeFile, link, unlink, readFile } = await import("node:fs/promises");
    await writeFile(temporary, `${JSON.stringify(marker)}\n`, { flag: "wx", mode: LOCAL_LOCK_DATABASE_MODE });
    try {
      await link(temporary, markerPath);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    } finally {
      try { await unlink(temporary); } catch { /* preserve first failure */ }
    }
    marker = JSON.parse(await readFile(markerPath, "utf8")) as typeof marker;
    if (marker.protocol !== "pi-plugin-host-recovery-root" || marker.version !== 1 || typeof marker.identity !== "string" || marker.identity.length === 0) {
      throw new Error("recovery identity marker is invalid");
    }
  }
  const verify = async (): Promise<void> => {
    const stats = await lstat(recoveryRoot);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("recovery root identity changed");
    const markerStats = await lstat(markerPath);
    if (!markerStats.isFile() || markerStats.isSymbolicLink()) throw new Error("recovery identity marker changed");
    const current = JSON.parse(await (await import("node:fs/promises")).readFile(markerPath, "utf8")) as typeof marker;
    if (current.protocol !== marker.protocol || current.version !== marker.version || current.identity !== marker.identity) throw new Error("recovery identity marker changed");
  };
  await (options.verifyLocalFilesystem ?? verifyLocalFilesystemCapability)(recoveryRoot);
  await verify();
  return Object.freeze({
    hostRoot,
    recoveryRoot,
    journalRoot,
    journalDatabasePath: (scope) => join(journalRoot, scopeDatabaseName(scope)),
    rootIdentity: marker.identity,
    verify,
  });
}

export function digestJournalBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export { scopeDatabaseName };
