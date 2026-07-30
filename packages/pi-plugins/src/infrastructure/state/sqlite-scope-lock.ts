import { DatabaseSync } from "node:sqlite";
import { chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { BoundaryError } from "../../domain/errors.js";
import {
  ScopeReferenceSchema,
  type ScopeReference,
} from "../../domain/state/scope.js";
import type { ScopeLockLease, ScopeLockManager } from "../../application/ports/scope-lock.js";
import {
  ensurePrivateLockRoot,
  LOCAL_LOCK_DATABASE_MODE,
  verifyLocalFilesystemCapability,
} from "./local-lock-filesystem.js";

const PROTOCOL = "pi-plugin-host-scope-lock";
const PROTOCOL_VERSION = 1;
const PROTOCOL_TABLE = "scope_lock_protocol";
const DEFAULT_RETRY_DELAY = Object.freeze({ minimum: 2, maximum: 25 });
const SQLITE_BUSY = 5;

export type SqliteScopeLockOptions = Readonly<{
  lockRoot: string;
  retryDelayMs: Readonly<{ minimum: number; maximum: number }>;
  random?: () => number;
  verifyLocalFilesystem?: (root: string) => Promise<void>;
}>;

type SqliteError = {
  readonly errcode?: unknown;
};

type SqliteRow = Record<string, unknown>;

function assertSignal(signal: AbortSignal): void {
  if (
    signal === null ||
    typeof signal !== "object" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function" ||
    typeof signal.aborted !== "boolean"
  ) {
    throw new TypeError("scope lock acquisition requires an AbortSignal");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function isBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as SqliteError).errcode === SQLITE_BUSY;
}

function adapterFailure(operation: string, cause: unknown): BoundaryError {
  return new BoundaryError({
    code: "ADAPTER_FAILED",
    operation,
    message: "local scope lock capability failed",
    cause,
  });
}

function cleanupCause(rollback: unknown, close: unknown): unknown {
  if (rollback !== undefined && close !== undefined) return { rollback, close };
  return rollback ?? close;
}

function validateRetryDelay(input: Readonly<{ minimum: number; maximum: number }>): Readonly<{ minimum: number; maximum: number }> {
  if (
    input === null ||
    typeof input !== "object" ||
    !Number.isSafeInteger(input.minimum) ||
    !Number.isSafeInteger(input.maximum) ||
    input.minimum < 0 ||
    input.maximum < input.minimum
  ) {
    throw new TypeError("scope lock retry delays must be ordered non-negative safe integers");
  }
  return { minimum: input.minimum, maximum: input.maximum };
}

function validateRandom(random: () => number): void {
  if (typeof random !== "function") throw new TypeError("scope lock jitter source must be a function");
}

function scopeDatabaseName(scope: ScopeReference): string {
  const value = ScopeReferenceSchema.parse(scope);
  if (value.kind === "user") return "user.sqlite";
  // Keep the domain's key grammar out of the adapter. URI escaping is injective
  // for the validated key and remains a legal filename on every supported OS.
  return `project-${encodeURIComponent(value.projectKey)}.sqlite`;
}

function databasePath(root: string, scope: ScopeReference): string {
  return join(root, scopeDatabaseName(scope));
}

function createProtocolSchema(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS ${PROTOCOL_TABLE} (protocol TEXT PRIMARY KEY NOT NULL CHECK (protocol = '${PROTOCOL}'), version INTEGER NOT NULL CHECK (version = ${PROTOCOL_VERSION})) STRICT;`);
  database.prepare(`INSERT OR IGNORE INTO ${PROTOCOL_TABLE} (protocol, version) VALUES ('${PROTOCOL}', ${PROTOCOL_VERSION})`).run();
}

function validateProtocolSchema(database: DatabaseSync): void {
  const objects = database
    .prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as SqliteRow[];
  if (objects.length !== 1 || objects[0]?.name !== PROTOCOL_TABLE || objects[0]?.type !== "table") {
    throw new Error("scope lock database contains an unexpected object");
  }

  const tableDefinition = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(PROTOCOL_TABLE) as SqliteRow | undefined;
  const expectedDefinition = `CREATE TABLE ${PROTOCOL_TABLE} (protocol TEXT PRIMARY KEY NOT NULL CHECK (protocol = '${PROTOCOL}'), version INTEGER NOT NULL CHECK (version = ${PROTOCOL_VERSION})) STRICT`;
  if (typeof tableDefinition?.sql !== "string" || tableDefinition.sql.replaceAll(/\s+/g, " ").trim() !== expectedDefinition) {
    throw new Error("scope lock protocol table definition is invalid");
  }

  const columns = database.prepare(`PRAGMA table_info(${PROTOCOL_TABLE})`).all() as SqliteRow[];
  const expected = [
    { name: "protocol", type: "TEXT", notnull: 1, pk: 1 },
    { name: "version", type: "INTEGER", notnull: 1, pk: 0 },
  ];
  if (
    columns.length !== expected.length ||
    columns.some((column, index) => {
      const wanted = expected[index];
      return wanted === undefined ||
        column.name !== wanted.name ||
        column.type !== wanted.type ||
        column.notnull !== wanted.notnull ||
        column.pk !== wanted.pk ||
        column.dflt_value !== null;
    })
  ) {
    throw new Error("scope lock protocol schema is invalid");
  }

  const rows = database.prepare(`SELECT protocol, version FROM ${PROTOCOL_TABLE}`).all() as SqliteRow[];
  if (
    rows.length !== 1 ||
    rows[0]?.protocol !== PROTOCOL ||
    rows[0]?.version !== PROTOCOL_VERSION
  ) {
    throw new Error("scope lock protocol version is invalid");
  }
}

/**
 * Open the scope database and take the write lock. The lock itself is the
 * held BEGIN IMMEDIATE transaction; first-use schema setup runs under the
 * same transaction so concurrent creators serialize on the database. No
 * sidecar marker, claim, or alias files exist to drift across mounts or
 * strand a later process — a killed holder's transaction is released by the
 * OS and the next acquirer proceeds after the busy window.
 */
function openLockedDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly: false,
    timeout: 0,
  });
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("scope lock database is not a regular file");
    chmodSync(path, LOCAL_LOCK_DATABASE_MODE);
    if (process.platform !== "win32" && (lstatSync(path).mode & 0o777) !== LOCAL_LOCK_DATABASE_MODE) {
      throw new Error("scope lock database is not private");
    }
    database.exec("PRAGMA journal_mode = DELETE; PRAGMA locking_mode = NORMAL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
    database.exec("BEGIN IMMEDIATE");
    createProtocolSchema(database);
    validateProtocolSchema(database);
    const journal = database.prepare("PRAGMA journal_mode").get() as SqliteRow | undefined;
    if (journal?.journal_mode !== "delete") throw new Error("scope lock database is not using rollback journal mode");
    return database;
  } catch (error) {
    try { database.close(); } catch { /* preserve primary failure */ }
    throw error;
  }
}

async function waitForRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timer = undefined;
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

class SqliteScopeLockLease implements ScopeLockLease {
  readonly scope: ScopeReference;
  private status: "held" | "released" | "uncertain" = "held";

  constructor(
    scope: ScopeReference,
    private readonly database: DatabaseSync,
  ) {
    this.scope = scope;
  }

  async assertOwned(signal: AbortSignal): Promise<void> {
    assertSignal(signal);
    throwIfAborted(signal);
    if (this.status !== "held" || !this.database.isOpen || !this.database.isTransaction) {
      throw adapterFailure("scope-lock.assert-owned", new Error("scope lock is no longer held"));
    }
  }

  async release(): Promise<void> {
    if (this.status === "released") return;
    let rollbackError: unknown;
    let closeError: unknown;
    try {
      if (this.database.isOpen && this.database.isTransaction) this.database.exec("ROLLBACK");
    } catch (error) {
      rollbackError = error;
    } finally {
      try {
        if (this.database.isOpen) this.database.close();
      } catch (error) {
        closeError = error;
      }
    }

    if (!this.database.isOpen && closeError === undefined) this.status = "released";
    else this.status = "uncertain";
    if (rollbackError !== undefined || closeError !== undefined) {
      throw adapterFailure("scope-lock.release", cleanupCause(rollbackError, closeError));
    }
  }
}

class SqliteScopeLockManager implements ScopeLockManager {
  constructor(
    private readonly root: string,
    private readonly retryDelayMs: Readonly<{ minimum: number; maximum: number }>,
    private readonly random: () => number,
  ) {}

  async acquire(input: ScopeReference, signal: AbortSignal): Promise<ScopeLockLease> {
    assertSignal(signal);
    const scope = ScopeReferenceSchema.parse(input);
    const path = databasePath(this.root, scope);

    for (;;) {
      throwIfAborted(signal);
      let database: DatabaseSync | undefined;
      try {
        database = openLockedDatabase(path);
        if (signal.aborted) throw signal.reason;
        return new SqliteScopeLockLease(scope, database);
      } catch (error) {
        if (database !== undefined) {
          try {
            if (database.isOpen) database.close();
          } catch (closeError) {
            throw adapterFailure("scope-lock.acquire", cleanupCause(error, closeError));
          }
        }
        if (signal.aborted) throw signal.reason;
        if (!isBusy(error)) throw adapterFailure("scope-lock.acquire", error);
        const delay = await this.retryDelay();
        await waitForRetry(delay, signal);
      }
    }
  }

  private async retryDelay(): Promise<number> {
    let value: number;
    try {
      value = this.random();
    } catch (error) {
      throw adapterFailure("scope-lock.retry", error);
    }
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw adapterFailure("scope-lock.retry", new Error("invalid retry jitter"));
    }
    return Math.floor(this.retryDelayMs.minimum + value * (this.retryDelayMs.maximum - this.retryDelayMs.minimum));
  }
}

/** Create a scope lock manager rooted at a private, local-filesystem directory. */
export async function createSqliteScopeLockManager(
  options: SqliteScopeLockOptions,
): Promise<ScopeLockManager> {
  if (options === null || typeof options !== "object") throw new TypeError("scope lock options are required");
  const retryDelayMs = validateRetryDelay(options.retryDelayMs ?? DEFAULT_RETRY_DELAY);
  const random = options.random ?? Math.random;
  validateRandom(random);
  const root = await ensurePrivateLockRoot(options.lockRoot).catch((error) => {
    throw adapterFailure("scope-lock.initialize", error);
  });
  try {
    await (options.verifyLocalFilesystem ?? verifyLocalFilesystemCapability)(root);
    return new SqliteScopeLockManager(root, retryDelayMs, random);
  } catch (error) {
    if (error instanceof BoundaryError) throw error;
    throw adapterFailure("scope-lock.initialize", error);
  }
}

export { scopeDatabaseName };
