import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { hashContent, type ContentDigest } from "../../domain/content-manifest.js";
import type { Sha256 } from "../../domain/source.js";
import { NativeLifecycleOperationSessionPolicy } from "../../application/native-lifecycle-operation-contract.js";
import { deriveProjectIntentObservationId } from "../../application/native-lifecycle-operation-identifiers.js";
import { decodeProjectIntentBytes, encodeProjectIntentDeclaration } from "../../application/project-intent-codec.js";
import type {
  ProjectIntentFilePort,
  ProjectIntentReadResult,
  VerifiedProjectIntentObservation,
} from "../../application/ports/project-intent-file.js";
import type { ProjectRootAuthorityPort, TrustedProjectRoot } from "../../application/ports/project-root-authority.js";
import { ProjectIntentWriteIdSchema } from "../../application/ports/project-intent-write-id.js";
import { revalidateTrustedProjectRoot } from "./node-project-path-authority.js";

const FILE = "plugins.json";
const DIRECTORY = ".pi";
const TEMP_PREFIX = ".plugins.json.project-intent-write-v1-";
const TEMP_SUFFIX = ".tmp";

type FileIdentity = Readonly<{ device: string; inode: string; size: number }>;
type DirectoryIdentity = Readonly<{ device: string; inode: string }>;
type ObservationEvidence = Readonly<{
  root: DirectoryIdentity;
  parent: Readonly<{ kind: "missing" }> | Readonly<{ kind: "found"; identity: DirectoryIdentity }>;
  leaf: Readonly<{ kind: "missing" }> | Readonly<{ kind: "found"; identity: FileIdentity; rawDigest: ContentDigest }>;
  declarationDigest?: ContentDigest;
}>;

class FileAuthorityError extends Error {
  constructor(readonly code: Extract<ProjectIntentReadResult, { kind: "unavailable" }>["code"]) { super(code); }
}

function directoryIdentity(stats: Awaited<ReturnType<typeof lstat>>): DirectoryIdentity {
  return Object.freeze({ device: String(stats.dev), inode: String(stats.ino) });
}
function fileIdentity(stats: Awaited<ReturnType<typeof lstat>>): FileIdentity {
  return Object.freeze({ device: String(stats.dev), inode: String(stats.ino), size: Number(stats.size) });
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

async function readBounded(handle: Awaited<ReturnType<typeof open>>, size: number, signal: AbortSignal): Promise<Uint8Array> {
  if (size > NativeLifecycleOperationSessionPolicy.maxProjectIntentBytes) throw new FileAuthorityError("FILE_TOO_LARGE");
  const output = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    signal.throwIfAborted();
    const result = await handle.read(output, offset, size - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset !== size) throw new FileAuthorityError("FILE_UNSAFE");
  const extra = new Uint8Array(1);
  if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0) throw new FileAuthorityError("FILE_TOO_LARGE");
  return output;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}

export function createNodeProjectIntentFilePort(input: Readonly<{
  projectRoots: ProjectRootAuthorityPort;
  sha256: Sha256;
}>): ProjectIntentFilePort {
  if (input === null || typeof input !== "object" || typeof input.sha256 !== "function") throw new TypeError("project intent file dependencies are required");
  const observations = new WeakMap<object, ObservationEvidence>();

  function issue(evidence: ObservationEvidence): VerifiedProjectIntentObservation {
    const observation = Object.freeze({ publicId: deriveProjectIntentObservationId(evidence, input.sha256) }) as VerifiedProjectIntentObservation;
    observations.set(observation, evidence);
    return observation;
  }

  async function inspect(root: TrustedProjectRoot, signal: AbortSignal): Promise<Readonly<{
    rootPath: string;
    parentPath: string;
    leafPath: string;
    evidence: ObservationEvidence;
    declaration?: ReturnType<typeof encodeProjectIntentDeclaration>["declaration"];
    digest?: ContentDigest;
  }>> {
    let authority;
    try { authority = await revalidateTrustedProjectRoot(root, input.projectRoots, signal); }
    catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      throw new FileAuthorityError("PROJECT_ROOT_STALE");
    }
    const rootIdentity = Object.freeze({ device: authority.device, inode: authority.inode });
    const parentPath = resolve(authority.path, DIRECTORY);
    const leafPath = resolve(parentPath, FILE);
    let parentStats;
    try { parentStats = await lstat(parentPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { rootPath: authority.path, parentPath, leafPath, evidence: Object.freeze({ root: rootIdentity, parent: { kind: "missing" }, leaf: { kind: "missing" } }) };
      }
      throw error;
    }
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink() || await realpath(parentPath) !== parentPath) throw new FileAuthorityError("FILE_UNSAFE");
    const parentIdentity = directoryIdentity(parentStats);
    let handle;
    try { handle = await open(leafPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { rootPath: authority.path, parentPath, leafPath, evidence: Object.freeze({ root: rootIdentity, parent: { kind: "found", identity: parentIdentity }, leaf: { kind: "missing" } }) };
      if (code === "ELOOP") throw new FileAuthorityError("FILE_UNSAFE");
      throw error;
    }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.isSymbolicLink()) throw new FileAuthorityError("FILE_UNSAFE");
      const bytes = await readBounded(handle, before.size, signal);
      const after = await handle.stat();
      const pathAfter = await lstat(leafPath);
      if (!after.isFile() || pathAfter.isSymbolicLink() || !pathAfter.isFile() || !same(fileIdentity(before), fileIdentity(after)) || !same(fileIdentity(after), fileIdentity(pathAfter))) throw new FileAuthorityError("FILE_UNSAFE");
      const decoded = decodeProjectIntentBytes(bytes, input.sha256);
      if (decoded.kind === "invalid") throw new FileAuthorityError(decoded.code);
      const rawDigest = hashContent(bytes, input.sha256);
      const evidence = Object.freeze({
        root: rootIdentity,
        parent: { kind: "found" as const, identity: parentIdentity },
        leaf: { kind: "found" as const, identity: fileIdentity(after), rawDigest },
        declarationDigest: decoded.digest,
      });
      return { rootPath: authority.path, parentPath, leafPath, evidence, declaration: decoded.declaration, digest: decoded.digest };
    } finally { await handle.close(); }
  }

  async function read(root: TrustedProjectRoot, signal: AbortSignal): Promise<ProjectIntentReadResult> {
    signal.throwIfAborted();
    try {
      const value = await inspect(root, signal);
      const observation = issue(value.evidence);
      return value.declaration === undefined
        ? { kind: "missing", observation }
        : { kind: "found", observation, declaration: value.declaration, digest: value.digest! };
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return { kind: "unavailable", code: error instanceof FileAuthorityError ? error.code : "ADAPTER_FAILED" };
    }
  }

  async function replace(request: Parameters<ProjectIntentFilePort["replace"]>[0], signal: AbortSignal): ReturnType<ProjectIntentFilePort["replace"]> {
    signal.throwIfAborted();
    const expected = observations.get(request.expected as object);
    if (expected === undefined) return { kind: "stale" };
    let encoded;
    try { encoded = encodeProjectIntentDeclaration(request.declaration, input.sha256); }
    catch { return { kind: "stale" }; }
    const writeId = ProjectIntentWriteIdSchema.parse(request.writeId);
    let current;
    try { current = await inspect(request.root, signal); }
    catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return { kind: "stale" };
    }
    if (!same(current.evidence, expected)) return { kind: "stale" };
    if (current.digest === encoded.digest) return { kind: "unchanged", observation: issue(current.evidence), digest: encoded.digest };
    // Node exposes no conditional replacement primitive for an existing leaf.
    // Check-then-rename would overwrite an editor save, so fail capability-closed.
    if (current.evidence.leaf.kind === "found") return { kind: "unavailable", code: "PROJECT_INTENT_WRITE_UNAVAILABLE" };

    let parentIdentity: DirectoryIdentity;
    if (current.evidence.parent.kind === "missing") {
      try { await mkdir(current.parentPath, { mode: 0o700 }); }
      catch (error) { return (error as NodeJS.ErrnoException).code === "EEXIST" ? { kind: "stale" } : { kind: "unavailable", code: "PROJECT_INTENT_WRITE_UNAVAILABLE" }; }
      try { await syncDirectory(current.rootPath); }
      catch { return { kind: "ambiguous", expectedDigest: encoded.digest }; }
      const parent = await lstat(current.parentPath).catch(() => undefined);
      if (parent === undefined || !parent.isDirectory() || parent.isSymbolicLink() || await realpath(current.parentPath).catch(() => undefined) !== current.parentPath) return { kind: "stale" };
      parentIdentity = directoryIdentity(parent);
    } else {
      parentIdentity = current.evidence.parent.identity;
    }
    const publicationEvidence: ObservationEvidence = Object.freeze({
      root: current.evidence.root,
      parent: { kind: "found", identity: parentIdentity },
      leaf: { kind: "missing" },
    });
    const safeId = writeId.slice("project-intent-write-v1:".length);
    const tempPath = resolve(current.parentPath, `${TEMP_PREFIX}${safeId}${TEMP_SUFFIX}`);
    const probePath = resolve(current.parentPath, `${TEMP_PREFIX}${safeId}.probe${TEMP_SUFFIX}`);
    let temp;
    try {
      temp = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await temp.writeFile(encoded.bytes);
      await temp.sync();
      await temp.close();
      temp = undefined;

      const beforePublish = await inspect(request.root, signal);
      if (!same(beforePublish.evidence, publicationEvidence)) return { kind: "stale" };

      // Hard-link creation is the available platform CAS: the kernel publishes
      // only while the destination is absent. Probe the exact filesystem first;
      // no advisory lock or check-then-rename is treated as authority.
      try {
        await link(tempPath, probePath);
        const source = await lstat(tempPath);
        const probe = await lstat(probePath);
        if (!source.isFile() || !probe.isFile() || source.dev !== probe.dev || source.ino !== probe.ino) {
          return { kind: "unavailable", code: "PROJECT_INTENT_WRITE_UNAVAILABLE" };
        }
        await unlink(probePath);
      } catch {
        return { kind: "unavailable", code: "PROJECT_INTENT_WRITE_UNAVAILABLE" };
      }

      const afterProbe = await inspect(request.root, signal);
      if (!same(afterProbe.evidence, publicationEvidence)) return { kind: "stale" };
      try {
        await link(tempPath, current.leafPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return { kind: "stale" };
        return { kind: "unavailable", code: "PROJECT_INTENT_WRITE_UNAVAILABLE" };
      }
      try { await syncDirectory(current.parentPath); }
      catch { return { kind: "ambiguous", expectedDigest: encoded.digest }; }
      const reconciled = await inspect(request.root, new AbortController().signal).catch(() => undefined);
      if (reconciled?.digest !== encoded.digest) return { kind: "ambiguous", expectedDigest: encoded.digest };
      return { kind: "written", observation: issue(reconciled.evidence), digest: encoded.digest };
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return { kind: "ambiguous", expectedDigest: encoded.digest };
    } finally {
      try { await temp?.close(); } catch { /* retain primary result */ }
      try { await unlink(probePath); } catch { /* absent or already removed */ }
      try { await unlink(tempPath); } catch { /* published hard link retains bytes */ }
    }
  }

  async function cleanup(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    let root;
    try { root = await input.projectRoots.acquire(signal); }
    catch (error) { if (signal.aborted) throw signal.reason ?? error; return; }
    let authority;
    try { authority = await revalidateTrustedProjectRoot(root, input.projectRoots, signal); }
    catch { return; }
    const parent = resolve(authority.path, DIRECTORY);
    let entries: string[];
    try { entries = await readdir(parent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const name of entries.filter((entry) => entry.startsWith(TEMP_PREFIX) && entry.endsWith(TEMP_SUFFIX))) {
      signal.throwIfAborted();
      const path = resolve(parent, name);
      try {
        const stats = await lstat(path);
        if (stats.isFile() && !stats.isSymbolicLink()) await unlink(path);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  return Object.freeze({ read, replace, cleanup });
}
