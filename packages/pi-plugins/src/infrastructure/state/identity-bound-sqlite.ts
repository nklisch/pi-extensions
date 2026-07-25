import { randomUUID } from "node:crypto";
import { chmodSync, linkSync, lstatSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, join } from "node:path";
import { classifyProcessIdentity, readLinuxProcessStartToken } from "../process/process-identity.js";
import { LOCAL_LOCK_DATABASE_MODE } from "./local-lock-filesystem.js";

const SQLITE_BUSY = 5;
// Waiting out a live initializer or a busy database must tolerate loaded
// hosts (parallel test runners, several Pi sessions on one agent dir); the
// budget below totals roughly five seconds while staying sub-second locally.
const MAX_RETRIES = 24;

type Identity = Readonly<{ device: string; inode: string }>;
type Owner = Readonly<{ pid: number; startToken: string; nonce: string }>;
type RootMarker = Readonly<{ protocol: "pi-plugin-host-sqlite-root"; version: 1; identity: string }>;
type DatabaseMarker = Readonly<{
  protocol: "pi-plugin-host-identity-bound-sqlite";
  version: 1;
  rootIdentity: string;
  database: string;
  identity: Identity;
}>;

type Claim = Readonly<{
  protocol: "pi-plugin-host-identity-bound-sqlite-claim";
  version: 1;
  rootIdentity: string;
  database: string;
  owner: Owner;
}>;

export type IdentityBoundSqliteDatabase = Readonly<{
  database: DatabaseSync;
  path: string;
  identity: Identity;
  assertIdentity(): void;
  close(): void;
}>;

function identity(path: string): Identity {
  const value = lstatSync(path);
  if (!value.isFile() || value.isSymbolicLink()) throw new Error("SQLite database identity path is not a regular file");
  return { device: String(value.dev), inode: String(value.ino) };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function removeRegular(path: string): void {
  try { identity(path); unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function publishExclusive(path: string, value: unknown): boolean {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: LOCAL_LOCK_DATABASE_MODE });
  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    removeRegular(temporary);
  }
}

function rootIdentity(root: string): string {
  const path = join(root, ".sqlite-root.identity");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const created: RootMarker = { protocol: "pi-plugin-host-sqlite-root", version: 1, identity: randomUUID() };
    publishExclusive(path, created);
    raw = JSON.parse(readFileSync(path, "utf8"));
  }
  const marker = raw as Partial<RootMarker>;
  if (marker.protocol !== "pi-plugin-host-sqlite-root" || marker.version !== 1 || typeof marker.identity !== "string" || marker.identity.length === 0) {
    throw new Error("SQLite root identity is invalid");
  }
  chmodSync(path, LOCAL_LOCK_DATABASE_MODE);
  return marker.identity;
}

function owner(): Owner {
  const startToken = readLinuxProcessStartToken(process.pid);
  if (startToken === undefined) throw new Error("SQLite initialization process identity is unavailable");
  return { pid: process.pid, startToken, nonce: randomUUID() };
}

function readJson(path: string): unknown | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function marker(path: string): DatabaseMarker | undefined {
  const raw = readJson(`${path}.identity`);
  if (raw === undefined) return undefined;
  const value = raw as Partial<DatabaseMarker>;
  if (value.protocol !== "pi-plugin-host-identity-bound-sqlite" || value.version !== 1 ||
      typeof value.rootIdentity !== "string" || typeof value.database !== "string" ||
      value.identity === undefined || typeof value.identity.device !== "string" || typeof value.identity.inode !== "string") {
    throw new Error("SQLite database identity marker is invalid");
  }
  return value as DatabaseMarker;
}

function claim(path: string): Claim | undefined {
  const raw = readJson(`${path}.initializing`);
  if (raw === undefined) return undefined;
  const value = raw as Partial<Claim>;
  if (value.protocol !== "pi-plugin-host-identity-bound-sqlite-claim" || value.version !== 1 ||
      typeof value.rootIdentity !== "string" || typeof value.database !== "string" ||
      value.owner === undefined || typeof value.owner.pid !== "number" || typeof value.owner.startToken !== "string" || typeof value.owner.nonce !== "string") {
    throw new Error("SQLite initialization claim is invalid");
  }
  return value as Claim;
}

function isBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { errcode?: unknown }).errcode === SQLITE_BUSY;
}

async function wait(signal: AbortSignal, attempt: number): Promise<void> {
  signal.throwIfAborted();
  const delay = Math.min(250, 2 ** Math.min(attempt, 8));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, delay);
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function validateMarker(path: string, rootId: string, databaseName: string, expected: DatabaseMarker): void {
  const current = marker(path);
  if (current === undefined || current.rootIdentity !== rootId || current.database !== databaseName ||
      !sameIdentity(current.identity, expected.identity) || !sameIdentity(identity(path), expected.identity)) {
    throw new Error("SQLite database identity changed");
  }
}

/** Exclusive, process-identity-bound first use with cancellable loser retry. */
export async function openIdentityBoundSqliteDatabase(input: Readonly<{
  root: string;
  path: string;
  signal: AbortSignal;
  busyTimeoutMs?: number;
  initialize(database: DatabaseSync): void;
  validate(database: DatabaseSync): void;
}>): Promise<IdentityBoundSqliteDatabase> {
  const rootId = rootIdentity(input.root);
  const databaseName = basename(input.path);
  const busyTimeoutMs = input.busyTimeoutMs ?? 0;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) throw new TypeError("SQLite busy timeout is invalid");
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    input.signal.throwIfAborted();
    let currentMarker = marker(input.path);
    if (currentMarker !== undefined) {
      if (currentMarker.rootIdentity !== rootId || currentMarker.database !== databaseName ||
          !sameIdentity(identity(input.path), currentMarker.identity)) throw new Error("SQLite database identity marker does not match its path");
      const database = new DatabaseSync(input.path, { allowExtension: false, defensive: true, enableForeignKeyConstraints: true, timeout: busyTimeoutMs });
      try {
        input.validate(database);
        validateMarker(input.path, rootId, databaseName, currentMarker);
        let closed = false;
        return Object.freeze({
          database,
          path: input.path,
          identity: currentMarker.identity,
          assertIdentity() { if (closed) throw new Error("SQLite database is closed"); validateMarker(input.path, rootId, databaseName, currentMarker!); },
          close() { if (closed) return; closed = true; database.close(); },
        });
      } catch (error) {
        database.close();
        if (isBusy(error) && attempt < MAX_RETRIES) {
          await wait(input.signal, attempt);
          continue;
        }
        throw error;
      }
    }

    const currentClaim = claim(input.path);
    if (currentClaim !== undefined) {
      if (currentClaim.rootIdentity !== rootId || currentClaim.database !== databaseName) throw new Error("SQLite initialization claim does not match its path");
      const status = classifyProcessIdentity({ pid: currentClaim.owner.pid, startToken: currentClaim.owner.startToken });
      if (status === "dead") {
        removeRegular(`${input.path}.initializing`);
        removeRegular(input.path);
        removeRegular(`${input.path}.identity`);
        continue;
      }
      if (attempt === MAX_RETRIES) throw new Error("SQLite initialization remained in progress");
      await wait(input.signal, attempt);
      continue;
    }

    try {
      identity(input.path);
      // Marker and database publication are separate filesystem operations.
      // Retry a bounded coherent snapshot before treating an unclaimed path as
      // orphaned; this covers the first-use loser interleaving.
      if (attempt === MAX_RETRIES) throw new Error("SQLite database identity marker is missing");
      await wait(input.signal, attempt);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const initializationClaim: Claim = {
      protocol: "pi-plugin-host-identity-bound-sqlite-claim",
      version: 1,
      rootIdentity: rootId,
      database: databaseName,
      owner: owner(),
    };
    if (!publishExclusive(`${input.path}.initializing`, initializationClaim)) {
      await wait(input.signal, attempt);
      continue;
    }

    let database: DatabaseSync | undefined;
    try {
      const descriptor = openSync(input.path, "wx", LOCAL_LOCK_DATABASE_MODE);
      closeSync(descriptor);
      database = new DatabaseSync(input.path, { allowExtension: false, defensive: true, enableForeignKeyConstraints: true, timeout: busyTimeoutMs });
      // The exclusive identity-bound claim is the initialization lock. No
      // contender opens the path until the ready marker is published, so
      // journal-mode setup can happen outside a SQLite transaction.
      input.initialize(database);
      input.validate(database);
      const databaseIdentity = identity(input.path);
      const ready: DatabaseMarker = {
        protocol: "pi-plugin-host-identity-bound-sqlite",
        version: 1,
        rootIdentity: rootId,
        database: databaseName,
        identity: databaseIdentity,
      };
      const temporary = `${input.path}.identity.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(ready)}\n`, { flag: "wx", mode: LOCAL_LOCK_DATABASE_MODE });
      renameSync(temporary, `${input.path}.identity`);
      removeRegular(`${input.path}.initializing`);
      currentMarker = ready;
      let closed = false;
      return Object.freeze({
        database,
        path: input.path,
        identity: databaseIdentity,
        assertIdentity() { if (closed) throw new Error("SQLite database is closed"); validateMarker(input.path, rootId, databaseName, ready); },
        close() { if (closed) return; closed = true; database!.close(); },
      });
    } catch (error) {
      try { database?.close(); } catch { /* preserve primary */ }
      removeRegular(`${input.path}.initializing`);
      removeRegular(input.path);
      removeRegular(`${input.path}.identity`);
      if (isBusy(error) && attempt < MAX_RETRIES) { await wait(input.signal, attempt); continue; }
      throw error;
    }
  }
  throw new Error("SQLite database initialization retry budget exhausted");
}
