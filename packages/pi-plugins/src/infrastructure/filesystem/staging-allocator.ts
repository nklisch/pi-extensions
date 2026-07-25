import { randomBytes as nodeRandomBytes } from "node:crypto";
import { lstat, mkdir, chmod, realpath, readdir, writeFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DomainContractError, ErrorCodeRegistry } from "../../domain/errors.js";
import type { StagingSlot } from "../../application/ports/source-acquisition.js";
import type { StagingAllocation } from "../../application/ports/content-store.js";
import {
  assertLayoutRoot,
  assertOwnedDirectory,
  stagingAllocationPath,
  type ContentStoreLayout,
} from "./content-store-layout.js";
import { removePreparedTree, type PreparedTreeIdentity } from "./prepared-tree-cleanup.js";
import { readLinuxProcessStartToken } from "../process/process-identity.js";

export type RandomBytes = (size: number) => Uint8Array | Promise<Uint8Array>;

export type StagingAllocator = Readonly<{
  allocateStaging(signal: AbortSignal): Promise<StagingAllocation>;
  discardStaging(allocation: StagingAllocation, signal: AbortSignal): Promise<void>;
}>;

type AllocationRecord = Readonly<{
  allocation: StagingAllocation;
  root: string;
  parent: string;
  dev: number;
  ino: number;
  parentCapability: ContentStoreLayout["rootCapabilities"]["stagingRoot"];
}>;

function allocationError(
  code: "STAGING_ALLOCATION_INVALID" | "ADAPTER_FAILED",
  operation: string,
  message: string,
  cause?: unknown,
): DomainContractError {
  return new DomainContractError({
    code: ErrorCodeRegistry[code === "STAGING_ALLOCATION_INVALID" ? "stagingAllocationInvalid" : "adapterFailed"],
    operation,
    message,
    details: { operation },
    ...(cause === undefined ? {} : { cause }),
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}


export function stagingOwnerSidecarPath(root: string): string { return `${root}.owner`; }

async function writeOwnerSidecar(root: string): Promise<void> {
  const startToken = readLinuxProcessStartToken(process.pid);
  if (startToken === undefined) throw new Error("staging allocation cannot establish process identity");
  const sidecar = stagingOwnerSidecarPath(root);
  const temporary = `${sidecar}.${nodeRandomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify({ protocol: "pi-plugin-host-staging-owner", version: 1, pid: process.pid, startToken, nonce: nodeRandomBytes(16).toString("hex"), createdAt: Date.now() }), { flag: "wx", mode: 0o600 });
  try { await rename(temporary, sidecar); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

async function removeOwnerSidecar(root: string): Promise<void> { await unlink(stagingOwnerSidecarPath(root)).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }

function allocationIdFromBytes(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) {
    throw new TypeError("staging random source must return 16 bytes");
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Allocate only below the layout's private staging root. The WeakMap is a
 * capability boundary: copying the visible slot/token fields does not create
 * authority to promote or remove the directory.
 */
export function createStagingAllocator(
  layout: ContentStoreLayout,
  options: Readonly<{ randomBytes?: RandomBytes }> = {},
): StagingAllocator & {
  assertOwned(allocation: unknown, operation?: string): Promise<AllocationRecord>;
} {
  const randomBytes: RandomBytes = options.randomBytes ?? ((size) => new Uint8Array(nodeRandomBytes(size)));
  const owned = new WeakMap<object, AllocationRecord>();

  async function assertOwned(allocation: unknown, operation = "validateStagingAllocation"): Promise<AllocationRecord> {
    if (allocation === null || typeof allocation !== "object") {
      throw allocationError("STAGING_ALLOCATION_INVALID", operation, "staging allocation capability is invalid");
    }
    const record = owned.get(allocation);
    if (record === undefined) {
      throw allocationError("STAGING_ALLOCATION_INVALID", operation, "staging allocation capability is not owned by this store");
    }
    const value = allocation as StagingAllocation;
    await assertLayoutRoot(layout, "stagingRoot", operation);
    if (
      value.allocationId !== record.allocation.allocationId ||
      value.slot.root !== record.allocation.slot.root ||
      record.parent !== layout.stagingRoot ||
      resolve(dirname(record.root)) !== resolve(layout.stagingRoot)
    ) {
      throw allocationError("STAGING_ALLOCATION_INVALID", operation, "staging allocation capability does not match its owner");
    }
    let current;
    try {
      current = await assertOwnedDirectory(record.root, operation, record, record.parentCapability);
      await assertLayoutRoot(layout, "stagingRoot", operation);
    } catch (error) {
      if (error instanceof DomainContractError) throw error;
      throw allocationError("STAGING_ALLOCATION_INVALID", operation, "staging allocation directory is not owned", error);
    }
    if (current.realpath !== record.root || current.dev !== record.dev || current.ino !== record.ino) {
      throw allocationError("STAGING_ALLOCATION_INVALID", operation, "staging allocation directory identity changed");
    }
    const stat = await lstat(record.root);
    if ((stat.mode & 0o077) !== 0) {
      throw allocationError("STAGING_ALLOCATION_INVALID", operation, "staging allocation directory is not private");
    }
    return record;
  }

  async function allocateStaging(signal: AbortSignal): Promise<StagingAllocation> {
    throwIfAborted(signal);
    for (let attempt = 0; attempt < 32; attempt += 1) {
      throwIfAborted(signal);
      const bytes = await randomBytes(16);
      const allocationId = allocationIdFromBytes(bytes);
      const root = stagingAllocationPath(layout, allocationId);
      await assertLayoutRoot(layout, "stagingRoot", "allocateStaging");
      try {
        await mkdir(root, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw allocationError("ADAPTER_FAILED", "allocateStaging", "staging allocation failed", error);
      }
      let allocationIdentity: PreparedTreeIdentity | undefined;
      try {
        await assertLayoutRoot(layout, "stagingRoot", "allocateStaging");
        await chmod(root, 0o700);
        await assertLayoutRoot(layout, "stagingRoot", "allocateStaging");
        const canonical = await realpath(root);
        if (canonical !== root) throw new Error("staging allocation resolved through a symlink");
        const stat = await lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
          throw new Error("staging allocation is not a private real directory");
        }
        allocationIdentity = { dev: stat.dev, ino: stat.ino };
        await assertLayoutRoot(layout, "stagingRoot", "allocateStaging");
        if ((await readdir(root)).length !== 0) throw new Error("staging allocation is not empty");
        await assertOwnedDirectory(root, "allocateStaging", allocationIdentity, layout.rootCapabilities.stagingRoot);
        await writeOwnerSidecar(canonical);
        const allocation = Object.freeze({
          slot: Object.freeze({ root: canonical }) as StagingSlot,
          allocationId,
        });
        const record: AllocationRecord = Object.freeze({
          allocation,
          root: canonical,
          parent: layout.stagingRoot,
          dev: stat.dev,
          ino: stat.ino,
          parentCapability: layout.rootCapabilities.stagingRoot,
        });
        owned.set(allocation, record);
        throwIfAborted(signal);
        return allocation;
      } catch (error) {
        if (allocationIdentity !== undefined) {
          await removePreparedTree(root, allocationIdentity, layout.rootCapabilities.stagingRoot).catch(() => undefined);
        }
        await removeOwnerSidecar(root).catch(() => undefined);
        if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
        throw allocationError("ADAPTER_FAILED", "allocateStaging", "staging allocation could not be verified", error);
      }
    }
    throw allocationError("ADAPTER_FAILED", "allocateStaging", "staging allocation id collision limit exceeded");
  }

  async function discardStaging(allocation: StagingAllocation, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (allocation === null || typeof allocation !== "object") {
      throw allocationError("STAGING_ALLOCATION_INVALID", "discardStaging", "staging allocation capability is invalid");
    }
    const record = owned.get(allocation);
    if (record === undefined) {
      throw allocationError("STAGING_ALLOCATION_INVALID", "discardStaging", "staging allocation capability is not owned by this store");
    }
    try {
      await assertOwned(allocation, "discardStaging");
    } catch (error) {
      const nativeCause = error instanceof Error ? error.cause : undefined;
      const missing = nativeCause !== undefined && typeof nativeCause === "object" && nativeCause !== null &&
        (nativeCause as NodeJS.ErrnoException).code === "ENOENT";
      if (!missing) throw error;
      // A missing path is the one safe idempotent retry. Confirm the parent
      // still has the adapter's canonical identity before forgetting it.
      await assertLayoutRoot(layout, "stagingRoot", "discardStaging");
      await removeOwnerSidecar(record.root);
      return;
    }
    try {
      await removePreparedTree(record.root, { dev: record.dev, ino: record.ino }, record.parentCapability);
      await removeOwnerSidecar(record.root);
      await assertLayoutRoot(layout, "stagingRoot", "discardStaging");
    } catch (error) {
      throw allocationError("ADAPTER_FAILED", "discardStaging", "staging allocation cleanup failed", error);
    }
  }

  return Object.freeze({ allocateStaging, discardStaging, assertOwned });
}

export type { AllocationRecord };
