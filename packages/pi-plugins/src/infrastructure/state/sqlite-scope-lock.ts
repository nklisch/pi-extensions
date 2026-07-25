import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { chmodSync, closeSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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
import { classifyProcessIdentity, readLinuxProcessStartToken } from "../process/process-identity.js";

const PROTOCOL = "pi-plugin-host-scope-lock";
const PROTOCOL_VERSION = 1;
const PROTOCOL_TABLE = "scope_lock_protocol";
const ROOT_MARKER_NAME = ".scope-lock-root.identity";
const DATABASE_MARKER_SUFFIX = ".identity";
const DATABASE_INITIALIZATION_CLAIM_SUFFIX = ".initializing";
const DATABASE_HANDLE_ALIAS_SUFFIX = ".handle";
const ROOT_MARKER_PROTOCOL = "pi-plugin-host-scope-lock-root";
const DATABASE_MARKER_PROTOCOL = "pi-plugin-host-scope-lock-database";
const DEFAULT_RETRY_DELAY = Object.freeze({ minimum: 2, maximum: 25 });
const SQLITE_BUSY = 5;

type InitializationMarkerReadHook = (context: Readonly<{
  path: string;
  databaseName: string;
  markerState: "absent" | "initializing" | "ready";
}>) => Promise<void> | void;

export type SqliteScopeLockOptions = Readonly<{
  lockRoot: string;
  retryDelayMs: Readonly<{ minimum: number; maximum: number }>;
  random?: () => number;
  verifyLocalFilesystem?: (root: string) => Promise<void>;
  /** Test seam for forcing a cross-process marker/path interleaving. */
  initializationMarkerRead?: InitializationMarkerReadHook;
}>;

type SqliteError = {
  readonly errcode?: unknown;
};

type SqliteRow = Record<string, unknown>;
type FileIdentity = Readonly<{ device: string; inode: string }>;
type InitializationOwner = Readonly<{ pid: number; startTime: string }>;
type RootIdentityMarker = Readonly<{
  protocol: typeof ROOT_MARKER_PROTOCOL;
  version: 1;
  identity: string;
}>;
type DatabaseIdentityMarker = Readonly<
  | {
      protocol: typeof DATABASE_MARKER_PROTOCOL;
      version: 1;
      rootIdentity: string;
      database: string;
      state: "initializing";
      owner: InitializationOwner;
    }
  | {
      protocol: typeof DATABASE_MARKER_PROTOCOL;
      version: 1;
      rootIdentity: string;
      database: string;
      state: "ready";
      identity: FileIdentity;
    }
>;
type PreparedDatabase = Readonly<{
  database: DatabaseSync;
  aliasPath: string;
}>;

class DatabaseInitializationInProgress extends Error {
  constructor(readonly owner?: InitializationOwner) {
    super("scope lock database initialization is in progress");
    this.name = "DatabaseInitializationInProgress";
  }
}

class DatabaseInitializationSnapshotChanged extends Error {
  constructor() {
    super("scope lock database initialization snapshot changed");
    this.name = "DatabaseInitializationSnapshotChanged";
  }
}

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

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function regularFileIdentity(path: string): FileIdentity {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("scope lock identity path is not a regular file");
  return { device: String(stats.dev), inode: String(stats.ino) };
}

function currentInitializationOwner(): InitializationOwner {
  const startTime = readLinuxProcessStartToken(process.pid);
  if (startTime === undefined) throw new Error("scope lock cannot establish process identity");
  return { pid: process.pid, startTime };
}

function ownerStatus(owner: InitializationOwner): "dead" | "live" | "unknown" {
  return classifyProcessIdentity({ pid: owner.pid, startToken: owner.startTime });
}

function parseInitializationOwner(input: unknown): InitializationOwner {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("scope lock initialization owner is invalid");
  }
  const value = input as Record<string, unknown>;
  const pid = value.pid;
  const startTime = value.startTime;
  if (
    Object.keys(value).length !== 2 ||
    typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 ||
    typeof startTime !== "string" || !/^\d+$/.test(startTime)
  ) {
    throw new Error("scope lock initialization owner is invalid");
  }
  return { pid, startTime };
}

function parseRootIdentityMarker(input: unknown): RootIdentityMarker {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("scope lock root identity marker is invalid");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 3 ||
    value.protocol !== ROOT_MARKER_PROTOCOL ||
    value.version !== 1 ||
    typeof value.identity !== "string" ||
    value.identity.length === 0
  ) throw new Error("scope lock root identity marker is invalid");
  return value as RootIdentityMarker;
}

function rootIdentityMarkerPath(root: string): string {
  return join(root, ROOT_MARKER_NAME);
}

function ensureRootIdentityMarker(root: string): string {
  const path = rootIdentityMarkerPath(root);
  let markerExists = false;
  try {
    regularFileIdentity(path);
    markerExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!markerExists) {
    const marker: RootIdentityMarker = {
      protocol: ROOT_MARKER_PROTOCOL,
      version: 1,
      identity: randomUUID(),
    };
    // Exclusive creation exposes an empty file before writeFileSync has
    // populated it. Publish a complete marker through a hard-link so another
    // first-use process can never parse a partially-written identity.
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(marker)}\n`, {
      flag: "wx",
      mode: LOCAL_LOCK_DATABASE_MODE,
    });
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  chmodSync(path, LOCAL_LOCK_DATABASE_MODE);
  return parseRootIdentityMarker(JSON.parse(readFileSync(path, "utf8"))).identity;
}

function databaseIdentityMarkerPath(path: string): string {
  return `${path}${DATABASE_MARKER_SUFFIX}`;
}

function databaseInitializationClaimPath(path: string): string {
  return `${path}${DATABASE_INITIALIZATION_CLAIM_SUFFIX}`;
}

function parseDatabaseIdentityMarker(input: unknown): DatabaseIdentityMarker {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("scope lock database identity marker is invalid");
  const value = input as Record<string, unknown>;
  if (
    (value.state !== "initializing" && value.state !== "ready") ||
    Object.keys(value).length !== (value.state === "ready" ? 6 : 6) ||
    value.protocol !== DATABASE_MARKER_PROTOCOL ||
    value.version !== 1 ||
    typeof value.rootIdentity !== "string" ||
    value.rootIdentity.length === 0 ||
    typeof value.database !== "string" ||
    value.database.length === 0
  ) throw new Error("scope lock database identity marker is invalid");
  if (value.state === "initializing") return {
    protocol: DATABASE_MARKER_PROTOCOL,
    version: 1,
    rootIdentity: value.rootIdentity,
    database: value.database,
    state: "initializing",
    owner: parseInitializationOwner(value.owner),
  };
  const identity = value.identity;
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("scope lock database identity marker is invalid");
  }
  const fileIdentity = identity as Record<string, unknown>;
  if (
    Object.keys(fileIdentity).length !== 2 ||
    typeof fileIdentity.device !== "string" ||
    typeof fileIdentity.inode !== "string" ||
    fileIdentity.device.length === 0 ||
    fileIdentity.inode.length === 0
  ) throw new Error("scope lock database identity marker is invalid");
  return {
    protocol: DATABASE_MARKER_PROTOCOL,
    version: 1,
    rootIdentity: value.rootIdentity,
    database: value.database,
    state: "ready",
    identity: { device: fileIdentity.device, inode: fileIdentity.inode },
  };
}

function readDatabaseIdentityMarker(path: string): DatabaseIdentityMarker | undefined {
  const markerPath = databaseIdentityMarkerPath(path);
  try {
    regularFileIdentity(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
  chmodSync(markerPath, LOCAL_LOCK_DATABASE_MODE);
  return parseDatabaseIdentityMarker(JSON.parse(readFileSync(markerPath, "utf8")));
}

function readInitializationClaim(path: string): DatabaseIdentityMarker | undefined {
  const claimPath = databaseInitializationClaimPath(path);
  try {
    regularFileIdentity(claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const claim = parseDatabaseIdentityMarker(JSON.parse(readFileSync(claimPath, "utf8")));
  if (claim.state !== "initializing") throw new Error("scope lock initialization claim is invalid");
  return claim;
}

function sameDatabaseMarker(left: DatabaseIdentityMarker, right: DatabaseIdentityMarker): boolean {
  if (
    left.protocol !== right.protocol || left.version !== right.version ||
    left.rootIdentity !== right.rootIdentity || left.database !== right.database ||
    left.state !== right.state
  ) return false;
  if (left.state === "initializing" && right.state === "initializing") {
    return left.owner.pid === right.owner.pid && left.owner.startTime === right.owner.startTime;
  }
  return left.state === "ready" && right.state === "ready" &&
    left.identity.device === right.identity.device && left.identity.inode === right.identity.inode;
}

function markerMatchesDatabase(
  marker: DatabaseIdentityMarker,
  rootIdentity: string,
  databaseName: string,
): boolean {
  return marker.rootIdentity === rootIdentity && marker.database === databaseName;
}

function removeIfRegular(path: string): void {
  try {
    regularFileIdentity(path);
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function reclaimDeadInitialization(
  path: string,
  marker: DatabaseIdentityMarker,
  rootIdentity: string,
  databaseName: string,
): void {
  if (marker.state !== "initializing") throw new Error("scope lock initialization marker is not reclaimable");
  if (!markerMatchesDatabase(marker, rootIdentity, databaseName)) {
    throw new Error("scope lock initialization marker does not match its path");
  }
  const status = ownerStatus(marker.owner);
  if (status !== "dead") {
    throw new DatabaseInitializationInProgress(marker.owner);
  }
  // Only a proven-dead owner permits removing the marker, claim, and any
  // partially-created database. Unknown and live owners remain cancellable.
  removeIfRegular(databaseIdentityMarkerPath(path));
  removeIfRegular(databaseInitializationClaimPath(path));
  removeIfRegular(path);
}

function createExclusiveClaim(path: string, marker: DatabaseIdentityMarker): void {
  const claimPath = databaseInitializationClaimPath(path);
  const temporary = `${claimPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(marker)}\n`, {
    flag: "wx",
    mode: LOCAL_LOCK_DATABASE_MODE,
  });
  try {
    linkSync(temporary, claimPath);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function validateDatabaseIdentity(
  root: string,
  rootIdentity: string,
  path: string,
  databaseName: string,
  marker: DatabaseIdentityMarker,
): FileIdentity {
  if (marker.state === "initializing") throw new DatabaseInitializationInProgress(marker.owner);
  if (
    marker.rootIdentity !== rootIdentity ||
    marker.database !== databaseName ||
    basename(path) !== databaseName
  ) throw new Error("scope lock database identity marker does not match its path");
  regularFileIdentity(rootIdentityMarkerPath(root));
  if (parseRootIdentityMarker(JSON.parse(readFileSync(rootIdentityMarkerPath(root), "utf8"))).identity !== rootIdentity) {
    throw new Error("scope lock root identity marker changed");
  }
  const identity = regularFileIdentity(path);
  if (marker.identity === undefined || !sameFileIdentity(identity, marker.identity)) throw new Error("scope lock database path was replaced");
  return identity;
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

function validateOpenedDatabaseIdentity(
  prepared: PreparedDatabase,
  root: string,
  rootIdentity: string,
  path: string,
  databaseName: string,
  marker: DatabaseIdentityMarker,
): void {
  const pathIdentity = validateDatabaseIdentity(root, rootIdentity, path, databaseName, marker);
  const aliasIdentity = regularFileIdentity(prepared.aliasPath);
  if (!sameFileIdentity(pathIdentity, aliasIdentity)) {
    throw new Error("scope lock opened database handle identity does not match its marker");
  }
}

async function prepareDatabase(
  root: string,
  rootIdentity: string,
  path: string,
  databaseName: string,
  retryingMissingMarkerDatabase = false,
  initializationMarkerRead?: InitializationMarkerReadHook,
): Promise<PreparedDatabase> {
  const owner = currentInitializationOwner();
  for (;;) {
    let marker = readDatabaseIdentityMarker(path);
    await initializationMarkerRead?.({
      path,
      databaseName,
      markerState: marker?.state ?? "absent",
    });
    let existing = true;
    try {
      regularFileIdentity(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existing = false;
    }

    if (marker?.state === "initializing") {
      reclaimDeadInitialization(path, marker, rootIdentity, databaseName);
      continue;
    }
    if (marker === undefined && existing) {
      // The marker and database path are independent files. A first-use loser
      // can read the old marker state, yield to the winner, then observe the
      // newly-created database through its later path check. That combination
      // is stale evidence, not proof of an orphan. Retry once through the
      // caller's cancellable acquisition loop; if the same coherent state is
      // still present, fail closed rather than adopting the database.
      const claim = readInitializationClaim(path);
      if (claim !== undefined) {
        reclaimDeadInitialization(path, claim, rootIdentity, databaseName);
        continue;
      }
      if (retryingMissingMarkerDatabase) throw new Error("scope lock database identity marker is missing");
      throw new DatabaseInitializationSnapshotChanged();
    }
    if (marker === undefined) {
      if (existing) throw new Error("scope lock database identity marker is missing");
      const initializing: DatabaseIdentityMarker = {
        protocol: DATABASE_MARKER_PROTOCOL,
        version: 1,
        rootIdentity,
        database: databaseName,
        state: "initializing",
        owner,
      };
      try {
        // The claim is a complete atomically-linked file. The marker is then
        // published by rename, so a crash at either boundary leaves an owner
        // identity that a later process can evaluate without guessing.
        createExclusiveClaim(path, initializing);
        const temporary = `${databaseIdentityMarkerPath(path)}.${randomUUID()}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(initializing)}\n`, {
          flag: "wx",
          mode: LOCAL_LOCK_DATABASE_MODE,
        });
        try {
          renameSync(temporary, databaseIdentityMarkerPath(path));
        } finally {
          try {
            unlinkSync(temporary);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        marker = initializing;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const observed = readDatabaseIdentityMarker(path) ?? readInitializationClaim(path);
        if (observed === undefined) throw new Error("scope lock initialization claim disappeared");
        if (observed.state === "initializing") reclaimDeadInitialization(path, observed, rootIdentity, databaseName);
        continue;
      }
    }

    if (marker === undefined) throw new Error("scope lock database identity marker disappeared");
    if (marker.state === "ready" && !existing) {
      throw new Error("scope lock database is missing after initialization");
    }

    let created = false;
    if (!existing) {
      let descriptor: number;
      try {
        descriptor = openSync(path, "wx", LOCAL_LOCK_DATABASE_MODE);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          const observed = readDatabaseIdentityMarker(path) ?? readInitializationClaim(path);
          if (observed?.state === "initializing") throw new DatabaseInitializationInProgress(observed.owner);
          throw new DatabaseInitializationInProgress();
        }
        throw error;
      }
      closeSync(descriptor);
      const identity = regularFileIdentity(path);
      marker = {
        protocol: DATABASE_MARKER_PROTOCOL,
        version: 1,
        rootIdentity,
        database: databaseName,
        state: "ready",
        identity,
      };
      created = true;
    }

    validateDatabaseIdentity(root, rootIdentity, path, databaseName, marker);
    const aliasPath = `${path}${DATABASE_HANDLE_ALIAS_SUFFIX}-${randomUUID()}`;
    let database: DatabaseSync | undefined;
    let aliasLinked = false;
    try {
      // DatabaseSync accepts a path rather than an fd. A private hard-link
      // alias pins the exact inode the native handle opens; the durable path
      // and marker are checked separately before BEGIN and on every assert.
      linkSync(path, aliasPath);
      aliasLinked = true;
      database = new DatabaseSync(aliasPath, {
        allowExtension: false,
        defensive: true,
        enableDoubleQuotedStringLiterals: false,
        enableForeignKeyConstraints: true,
        readOnly: false,
        timeout: 0,
      });
      const prepared: PreparedDatabase = { database, aliasPath };
      validateOpenedDatabaseIdentity(prepared, root, rootIdentity, path, databaseName, marker);
      database.enableLoadExtension(false);
      database.enableDefensive(true);
      chmodSync(path, LOCAL_LOCK_DATABASE_MODE);
      if (process.platform !== "win32" && (lstatSync(path).mode & 0o777) !== LOCAL_LOCK_DATABASE_MODE) {
        throw new Error("scope lock database is not private");
      }
      database.exec("PRAGMA journal_mode = DELETE; PRAGMA locking_mode = NORMAL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
      if (created) {
        database.exec(`CREATE TABLE ${PROTOCOL_TABLE} (protocol TEXT PRIMARY KEY NOT NULL CHECK (protocol = '${PROTOCOL}'), version INTEGER NOT NULL CHECK (version = ${PROTOCOL_VERSION})) STRICT;`);
        database.exec(`INSERT INTO ${PROTOCOL_TABLE} (protocol, version) VALUES ('${PROTOCOL}', ${PROTOCOL_VERSION});`);
      }
      validateProtocolSchema(database);
      validateOpenedDatabaseIdentity(prepared, root, rootIdentity, path, databaseName, marker);
      const journal = database.prepare("PRAGMA journal_mode").get() as SqliteRow | undefined;
      if (journal?.journal_mode !== "delete") throw new Error("scope lock database is not using rollback journal mode");
      if (created) {
        const temporary = `${databaseIdentityMarkerPath(path)}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { flag: "wx", mode: LOCAL_LOCK_DATABASE_MODE });
          renameSync(temporary, databaseIdentityMarkerPath(path));
          unlinkSync(databaseInitializationClaimPath(path));
        } catch (error) {
          throw new Error("scope lock database identity marker could not be finalized", { cause: error });
        }
      }
      const durableMarker = readDatabaseIdentityMarker(path);
      if (durableMarker === undefined || !sameDatabaseMarker(durableMarker, marker)) {
        throw new Error("scope lock database identity marker changed during setup");
      }
      validateOpenedDatabaseIdentity(prepared, root, rootIdentity, path, databaseName, durableMarker);
      return prepared;
    } catch (error) {
      let closeError: unknown;
      try {
        if (database?.isOpen) database.close();
      } catch (cause) {
        closeError = cause;
      }
      if (aliasLinked) {
        try {
          unlinkSync(aliasPath);
        } catch (cause) {
          closeError = closeError === undefined ? cause : { close: closeError, unlink: cause };
        }
      }
      if (closeError !== undefined) throw new Error("scope lock database setup and cleanup failed", { cause: { error, closeError } });
      throw error;
    }
  }
}

async function closeDatabase(prepared: PreparedDatabase): Promise<void> {
  let closeError: unknown;
  try {
    if (prepared.database.isOpen) prepared.database.close();
  } catch (error) {
    closeError = error;
  } finally {
    try {
      unlinkSync(prepared.aliasPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        closeError = closeError === undefined ? error : { close: closeError, unlink: error };
      }
    }
  }
  if (closeError !== undefined) throw closeError;
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
    private readonly prepared: PreparedDatabase,
    private readonly root: string,
    private readonly rootIdentity: string,
    private readonly path: string,
    private readonly databaseName: string,
    private readonly marker: DatabaseIdentityMarker,
  ) {
    this.scope = scope;
  }

  async assertOwned(signal: AbortSignal): Promise<void> {
    assertSignal(signal);
    throwIfAborted(signal);
    if (this.status !== "held" || !this.prepared.database.isOpen || !this.prepared.database.isTransaction) {
      throw adapterFailure("scope-lock.assert-owned", new Error("scope lock is no longer held"));
    }
    try {
      const marker = readDatabaseIdentityMarker(this.path);
      if (marker === undefined || !sameDatabaseMarker(marker, this.marker)) {
        throw new Error("scope lock database identity marker changed during ownership");
      }
      validateOpenedDatabaseIdentity(this.prepared, this.root, this.rootIdentity, this.path, this.databaseName, marker);
    } catch (error) {
      throw adapterFailure("scope-lock.assert-owned", error);
    }
  }

  async release(): Promise<void> {
    if (this.status === "released") return;
    let rollbackError: unknown;
    let closeError: unknown;
    try {
      if (this.prepared.database.isOpen && this.prepared.database.isTransaction) this.prepared.database.exec("ROLLBACK");
    } catch (error) {
      rollbackError = error;
    } finally {
      try {
        await closeDatabase(this.prepared);
      } catch (error) {
        closeError = error;
      }
    }

    if (!this.prepared.database.isOpen && closeError === undefined) this.status = "released";
    else this.status = "uncertain";
    if (rollbackError !== undefined || closeError !== undefined) {
      throw adapterFailure("scope-lock.release", cleanupCause(rollbackError, closeError));
    }
  }
}

class SqliteScopeLockManager implements ScopeLockManager {
  constructor(
    private readonly root: string,
    private readonly rootIdentity: string,
    private readonly retryDelayMs: Readonly<{ minimum: number; maximum: number }>,
    private readonly random: () => number,
    private readonly initializationMarkerRead?: InitializationMarkerReadHook,
  ) {}

  async acquire(input: ScopeReference, signal: AbortSignal): Promise<ScopeLockLease> {
    assertSignal(signal);
    const scope = ScopeReferenceSchema.parse(input);
    const path = databasePath(this.root, scope);
    let retryingMissingMarkerDatabase = false;

    for (;;) {
      throwIfAborted(signal);
      let prepared: PreparedDatabase | undefined;
      try {
        const databaseName = scopeDatabaseName(scope);
        prepared = await prepareDatabase(
          this.root,
          this.rootIdentity,
          path,
          databaseName,
          retryingMissingMarkerDatabase,
          this.initializationMarkerRead,
        );
        prepared.database.exec("BEGIN IMMEDIATE");
        if (signal.aborted) {
          await closeDatabase(prepared);
          throw signal.reason;
        }
        const marker = readDatabaseIdentityMarker(path);
        if (marker === undefined) throw new Error("scope lock database identity marker disappeared");
        validateOpenedDatabaseIdentity(prepared, this.root, this.rootIdentity, path, databaseName, marker);
        return new SqliteScopeLockLease(scope, prepared, this.root, this.rootIdentity, path, databaseName, marker);
      } catch (error) {
        if (prepared !== undefined) {
          try {
            await closeDatabase(prepared);
          } catch (closeError) {
            throw adapterFailure("scope-lock.acquire", cleanupCause(error, closeError));
          }
        }
        if (signal.aborted) throw signal.reason;
        if (error instanceof DatabaseInitializationInProgress) {
          const delay = await this.retryDelay();
          await waitForRetry(delay, signal);
          continue;
        }
        if (error instanceof DatabaseInitializationSnapshotChanged) {
          retryingMissingMarkerDatabase = true;
          const delay = await this.retryDelay();
          await waitForRetry(delay, signal);
          continue;
        }
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

async function probeExclusion(root: string, rootIdentity: string): Promise<void> {
  const probeDirectory = await mkdtemp(join(root, ".scope-lock-probe-"));
  const path = join(probeDirectory, "probe.sqlite");
  let holder: PreparedDatabase | undefined;
  let contender: PreparedDatabase | undefined;
  let released: PreparedDatabase | undefined;
  try {
    holder = await prepareDatabase(root, rootIdentity, path, "probe.sqlite");
    holder.database.exec("BEGIN IMMEDIATE");
    try {
      contender = await prepareDatabase(root, rootIdentity, path, "probe.sqlite");
      contender.database.exec("BEGIN IMMEDIATE");
      throw new Error("SQLite did not exclude a second writer");
    } catch (error) {
      if (!isBusy(error)) throw error;
    }
    if (contender !== undefined) await closeDatabase(contender);
    contender = undefined;
    holder.database.exec("ROLLBACK");
    await closeDatabase(holder);
    holder = undefined;

    released = await prepareDatabase(root, rootIdentity, path, "probe.sqlite");
    released.database.exec("BEGIN IMMEDIATE");
    released.database.exec("ROLLBACK");
    await closeDatabase(released);
    released = undefined;
  } finally {
    for (const prepared of [contender, holder, released]) {
      if (prepared !== undefined) {
        try {
          await closeDatabase(prepared);
        } catch {
          // The probe is failing anyway; cleanup must not expose a native error.
        }
      }
    }
    await rm(probeDirectory, { recursive: true, force: true });
  }
}

/**
 * Create a scope lock manager after proving the configured root has the
 * capabilities this safety boundary needs. No process-local fallback exists.
 */
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
    const rootIdentity = ensureRootIdentityMarker(root);
    await (options.verifyLocalFilesystem ?? verifyLocalFilesystemCapability)(root);
    await probeExclusion(root, rootIdentity);
    return new SqliteScopeLockManager(root, rootIdentity, retryDelayMs, random, options.initializationMarkerRead);
  } catch (error) {
    if (error instanceof BoundaryError) throw error;
    throw adapterFailure("scope-lock.initialize", error);
  }
}

export { scopeDatabaseName };
