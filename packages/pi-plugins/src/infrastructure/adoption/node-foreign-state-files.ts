import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { ForeignStateFileObservation } from "../../application/adoption-contract.js";
import type { ForeignStateFilesPort } from "../../application/ports/foreign-state-files.js";

export const ForeignStateLocationRegistry = {
  claudeKnownMarketplaces: {
    host: "claude",
    document: "claude-known-marketplaces",
    relativePath: ["plugins", "known_marketplaces.json"],
    logicalPath: ".claude/plugins/known_marketplaces.json",
  },
  claudeUserSettings: {
    host: "claude",
    document: "claude-user-settings",
    relativePath: ["settings.json"],
    logicalPath: ".claude/settings.json",
  },
  codexUserConfig: {
    host: "codex",
    document: "codex-user-config",
    relativePath: ["config.toml"],
    logicalPath: ".codex/config.toml",
  },
} as const;

export type NodeForeignStateFilesOptions = Readonly<{
  userHome: string;
  claudeRoot?: string;
  codexHome?: string;
  maxDocumentBytes?: number;
}>;

const DEFAULT_MAX_DOCUMENT_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

type ReadOutcome =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "present"; source: string }>
  | Readonly<{ kind: "changed-during-read" }>
  | Readonly<{ kind: "unreadable"; code: "SYMLINK" | "ESCAPES_ROOT" | "NOT_REGULAR" | "TOO_LARGE" | "INVALID_UTF8" | "IO_FAILED" }>;

type FileIdentity = Readonly<{ dev: bigint; ino: bigint; size: bigint }>;

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  signal.throwIfAborted();
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR");
}

function isSymlinkFailure(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    (error as { code?: unknown }).code === "ELOOP";
}

function validateOptions(options: NodeForeignStateFilesOptions): Required<Pick<NodeForeignStateFilesOptions, "userHome" | "maxDocumentBytes">> {
  if (typeof options.userHome !== "string" || options.userHome.length === 0 || !isAbsolute(options.userHome)) {
    throw new TypeError("userHome must be an absolute non-empty path");
  }
  const maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  if (!Number.isSafeInteger(maxDocumentBytes) || maxDocumentBytes <= 0) {
    throw new TypeError("maxDocumentBytes must be a positive safe integer");
  }
  return { userHome: options.userHome, maxDocumentBytes };
}

function contained(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function identity(stat: Readonly<{ dev: number | bigint; ino: number | bigint; size: number | bigint }>): FileIdentity {
  return { dev: BigInt(stat.dev), ino: BigInt(stat.ino), size: BigInt(stat.size) };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

async function readBounded(
  canonicalRoot: string | undefined,
  relativePath: readonly string[],
  maxDocumentBytes: number,
  signal: AbortSignal,
): Promise<ReadOutcome> {
  throwIfAborted(signal);
  if (canonicalRoot === undefined) return { kind: "missing" };
  const path = join(canonicalRoot, ...relativePath);
  let leaf: Awaited<ReturnType<typeof lstat>>;
  try {
    leaf = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return { kind: "missing" };
    return { kind: "unreadable", code: "IO_FAILED" };
  }
  if (leaf.isSymbolicLink()) return { kind: "unreadable", code: "SYMLINK" };
  if (!leaf.isFile()) return { kind: "unreadable", code: "NOT_REGULAR" };
  if (leaf.size > maxDocumentBytes) return { kind: "unreadable", code: "TOO_LARGE" };

  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch (error) {
    if (isMissing(error)) return { kind: "changed-during-read" };
    return { kind: "unreadable", code: "IO_FAILED" };
  }
  if (!contained(canonicalRoot, resolved)) return { kind: "unreadable", code: "ESCAPES_ROOT" };

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    throwIfAborted(signal);
    // O_NOFOLLOW closes the lstat/open race at the leaf. Root canonicalization
    // and realpath containment close the fixed-document parent boundary.
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const beforeStat = await handle.stat();
    if (!beforeStat.isFile()) return { kind: "unreadable", code: "NOT_REGULAR" };
    if (beforeStat.size > maxDocumentBytes) return { kind: "unreadable", code: "TOO_LARGE" };
    const before = identity(beforeStat);

    while (true) {
      throwIfAborted(signal);
      const size = Math.min(READ_CHUNK_BYTES, maxDocumentBytes - total + 1);
      const buffer = Buffer.allocUnsafe(size);
      const result = await handle.read(buffer, 0, size, null);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > maxDocumentBytes) return { kind: "unreadable", code: "TOO_LARGE" };
      chunks.push(buffer.subarray(0, result.bytesRead));
    }

    const after = identity(await handle.stat());
    let current: Awaited<ReturnType<typeof lstat>>;
    let resolvedAfter: string;
    try {
      current = await lstat(path);
      resolvedAfter = await realpath(path);
    } catch (error) {
      if (isMissing(error)) return { kind: "changed-during-read" };
      return { kind: "unreadable", code: "IO_FAILED" };
    }
    if (current.isSymbolicLink()) return { kind: "changed-during-read" };
    if (!contained(canonicalRoot, resolvedAfter)) return { kind: "changed-during-read" };
    const currentIdentity: FileIdentity = { dev: BigInt(current.dev), ino: BigInt(current.ino), size: BigInt(current.size) };
    if (!sameIdentity(before, after) || !sameIdentity(after, currentIdentity) || total !== Number(after.size)) {
      return { kind: "changed-during-read" };
    }
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    if (isSymlinkFailure(error)) return { kind: "unreadable", code: "SYMLINK" };
    return { kind: "unreadable", code: "IO_FAILED" };
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }

  try {
    return {
      kind: "present",
      source: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)),
    };
  } catch {
    return { kind: "unreadable", code: "INVALID_UTF8" };
  }
}

async function canonicalRoot(path: string): Promise<string | undefined> {
  try {
    const root = await realpath(path);
    const metadata = await lstat(root);
    return metadata.isDirectory() ? root : undefined;
  } catch (error) {
    if (isMissing(error)) return undefined;
    return undefined;
  }
}

export function createNodeForeignStateFiles(
  options: NodeForeignStateFilesOptions,
): ForeignStateFilesPort {
  const validated = validateOptions(options);
  const declaredRoots = {
    claude: options.claudeRoot ?? join(validated.userHome, ".claude"),
    codex: options.codexHome ?? process.env.CODEX_HOME ?? join(validated.userHome, ".codex"),
  };
  for (const root of Object.values(declaredRoots)) {
    if (typeof root !== "string" || root.length === 0 || !isAbsolute(root)) {
      throw new TypeError("foreign-state roots must be absolute non-empty paths");
    }
  }
  // Resolve once, lazily on the first explicit read. Construction must remain
  // local and inert so packaged host startup never becomes foreign-state I/O.
  let roots: Promise<Readonly<{ claude: string | undefined; codex: string | undefined }>> | undefined;
  const resolveRoots = () => roots ??= Promise.all([
    canonicalRoot(declaredRoots.claude),
    canonicalRoot(declaredRoots.codex),
  ]).then(([claude, codex]) => ({ claude, codex }));

  return {
    async readAll(signal: AbortSignal): Promise<readonly ForeignStateFileObservation[]> {
      throwIfAborted(signal);
      const canonical = await resolveRoots();
      const observations: ForeignStateFileObservation[] = [];
      for (const location of Object.values(ForeignStateLocationRegistry)) {
        throwIfAborted(signal);
        const result = await readBounded(canonical[location.host], location.relativePath, validated.maxDocumentBytes, signal);
        const common = { document: location.document, host: location.host, path: location.logicalPath } as const;
        if (result.kind === "present") observations.push({ ...common, kind: result.kind, source: result.source });
        else if (result.kind === "unreadable") observations.push({ ...common, kind: result.kind, code: result.code });
        else observations.push({ ...common, kind: result.kind });
      }
      return observations;
    },
  };
}
