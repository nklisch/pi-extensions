import { chmod, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ScopeReferenceSchema, type ScopeReference } from "../../domain/state/scope.js";
import { ensurePrivateLockRoot, verifyLocalFilesystemCapability, LOCAL_LOCK_DIRECTORY_MODE } from "../state/local-lock-filesystem.js";

export type RecoveryFilesystem = Readonly<{
  hostRoot: string;
  recoveryRoot: string;
  journalRoot: string;
  journalDatabasePath(scope: ScopeReference): string;
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
  await (options.verifyLocalFilesystem ?? verifyLocalFilesystemCapability)(recoveryRoot);
  return Object.freeze({
    hostRoot,
    recoveryRoot,
    journalRoot,
    journalDatabasePath: (scope) => join(journalRoot, scopeDatabaseName(scope)),
  });
}

export function digestJournalBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export { scopeDatabaseName };
