import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { z } from "zod";
import { BoundaryError, DomainContractError, ErrorCodeRegistry } from "../../domain/errors.js";
import { ScopeReferenceSchema, type ScopeReference } from "../../domain/state/scope.js";
import { PendingTransitionRefSchema, type PendingTransitionRef } from "../../domain/state/references.js";
import { deriveLifecyclePendingTransitionRef } from "../../application/plugin-lifecycle-contract.js";
import {
  LifecycleTransitionJournalEntrySchemaV2,
  LifecycleUninstallCleanupStatusSchema,
  lifecycleCleanupStatus,
  type LifecycleTransitionPrepareRequest,
  LifecycleTransitionRecordSchemaV1,
  TransitionJournalReadResultSchema,
  type LifecycleTransitionCollection,
  type LifecycleTransitionJournalEntry,
  type LifecycleTransitionPrepareResult,
  type LifecycleTransitionRecord,
  type LifecycleTransitionSettleRequest,
  type LifecycleTransitionStore,
  type TransitionJournalReadResult,
} from "../../application/ports/lifecycle-transition-store.js";
import { EpochMillisecondsSchema, type EpochMilliseconds } from "../../application/ports/lifecycle-clock.js";
import { createLocalRecoveryFilesystem, digestJournalBytes, type RecoveryFilesystem } from "./local-recovery-filesystem.js";
import { classifyProcessIdentity, readLinuxProcessStartToken } from "../process/process-identity.js";

const PROTOCOL = "pi-plugin-host-recovery-journal";
const VERSION = 2;
const MODE = 0o600;
const BUSY = 5;
// Loaded hosts serialize many processes on one scope database; keep the
// busy budget in the same ~5s class as initialization waits.
const MAX_BUSY_RETRIES = 24;

type SqliteRow = Record<string, unknown>;
type FileIdentity = Readonly<{ device: string; inode: string }>;
type Owner = Readonly<{ pid: number; startToken: string; nonce: string }>;
export type OwnerStatus = "live" | "dead" | "unknown" | "released";

const OwnerSchema = z.object({ pid: z.number().int().positive(), startToken: z.string().regex(/^\d+$/), nonce: z.string().uuid() }).strict();

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}
function canonicalBytes(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(canonicalize(value))); }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError"); }
function isBusy(error: unknown): boolean { return typeof error === "object" && error !== null && (error as { errcode?: unknown }).errcode === BUSY; }
async function waitForBusyRetry(signal: AbortSignal, attempt: number): Promise<void> {
  throwIfAborted(signal);
  const delay = Math.min(250, 1 << Math.min(attempt, 8));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, delay);
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
function identity(path: string): FileIdentity { const value = lstatSync(path); if (!value.isFile() || value.isSymbolicLink()) throw new Error("recovery journal database is not a regular file"); return { device: String(value.dev), inode: String(value.ino) }; }
function dbError(operation: string, cause: unknown): BoundaryError { return new BoundaryError({ code: "ADAPTER_FAILED", operation, message: "recovery journal adapter failed", details: { operation }, cause }); }
function corruptError(operation: string): DomainContractError { return new DomainContractError({ code: ErrorCodeRegistry.transitionJournalCorrupt, operation, message: "transition journal evidence is corrupt", details: { operation } }); }
function conflictError(operation: string): DomainContractError { return new DomainContractError({ code: ErrorCodeRegistry.recoveryConflict, operation, message: "transition journal status or evidence conflicts", details: { operation } }); }
function currentOwner(): Owner { const startToken = readLinuxProcessStartToken(process.pid); if (startToken === undefined) throw new Error("process start identity is unavailable"); return { pid: process.pid, startToken, nonce: randomUUID() }; }
function parseStatus(kind: unknown, generation: unknown): LifecycleTransitionJournalEntry["status"] {
  if (kind === "prepared") return { kind: "prepared" };
  if (kind === "recovery-required") return { kind, ...(typeof generation === "number" ? { generation: EpochMillisecondsSchema.parse(generation) as never } : {}) } as LifecycleTransitionJournalEntry["status"];
  if (kind === "completed" || kind === "rolled-back" || kind === "abandoned") return { kind, ...(typeof generation === "number" ? { generation } : {}) } as LifecycleTransitionJournalEntry["status"];
  if (kind === "quarantined") return { kind, code: "TRANSITION_JOURNAL_CORRUPT" };
  throw new Error("unknown transition status");
}

function rowEntry(row: SqliteRow): LifecycleTransitionJournalEntry {
  const record = LifecycleTransitionRecordSchemaV1.parse(JSON.parse(String(row.record_json)));
  const expectedReference = deriveLifecyclePendingTransitionRef({ operationId: record.operationId, scope: record.scope, plugin: record.plugin, startingGeneration: record.startingGeneration }, (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest()));
  if (record.reference !== expectedReference) throw corruptError("readTransitionJournal");
  const bytes = canonicalBytes(record);
  const digest = digestJournalBytes(bytes);
  if (digest !== row.record_digest) throw corruptError("readTransitionJournal");
  const status = parseStatus(row.status, row.generation);
  const cleanup = row.cleanup_status === undefined || row.cleanup_status === null
    ? lifecycleCleanupStatus(record, status)
    : LifecycleUninstallCleanupStatusSchema.parse(row.cleanup_status);
  return LifecycleTransitionJournalEntrySchemaV2.parse({
    schemaVersion: 2,
    record,
    status,
    cleanup,
    preparedAt: row.prepared_at,
    statusAt: row.status_at,
    ...(row.collection_completed_at === null || row.collection_completed_at === undefined ? {} : { collectionCompletedAt: row.collection_completed_at }),
  });
}

function validateSchema(database: DatabaseSync): void {
  const rows = database.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as SqliteRow[];
  const names = rows.map((row) => `${row.name}:${row.type}`).join(",");
  if (names !== "lifecycle_transitions:table,recovery_protocol:table,transition_quarantine:table") throw new Error("recovery journal contains an unexpected object");
  const protocol = database.prepare("SELECT protocol, version FROM recovery_protocol").all() as SqliteRow[];
  if (protocol.length !== 1 || protocol[0]?.protocol !== PROTOCOL || protocol[0]?.version !== VERSION) throw new Error("recovery journal protocol is invalid");
  const transitionColumns = database.prepare("PRAGMA table_info(lifecycle_transitions)").all() as SqliteRow[];
  if (!transitionColumns.some((column) => column.name === "cleanup_status")) throw new Error("recovery journal cleanup status is missing");
  const quarantineColumns = database.prepare("PRAGMA table_info(transition_quarantine)").all() as SqliteRow[];
  if (quarantineColumns.length === 0) throw new Error("recovery journal quarantine table is invalid");
}

function migrateSchema(database: DatabaseSync): void {
  const protocol = database.prepare("SELECT protocol, version FROM recovery_protocol").all() as SqliteRow[];
  if (protocol.length !== 1 || protocol[0]?.protocol !== PROTOCOL) throw new Error("recovery journal protocol is invalid");
  if (protocol[0]?.version === VERSION) return;
  if (protocol[0]?.version !== 1) throw new Error("recovery journal protocol is unsupported");
  const columns = database.prepare("PRAGMA table_info(lifecycle_transitions)").all() as SqliteRow[];
  if (!columns.some((column) => column.name === "cleanup_status")) database.exec("ALTER TABLE lifecycle_transitions ADD COLUMN cleanup_status TEXT NOT NULL DEFAULT 'not-required'");
  const rows = database.prepare("SELECT reference, record_json, status, generation FROM lifecycle_transitions").all() as SqliteRow[];
  const update = database.prepare("UPDATE lifecycle_transitions SET cleanup_status = ? WHERE reference = ?");
  for (const row of rows) {
    const record = LifecycleTransitionRecordSchemaV1.parse(JSON.parse(String(row.record_json)));
    update.run(lifecycleCleanupStatus(record, parseStatus(row.status, row.generation)), String(row.reference));
  }
  database.exec(`CREATE TABLE recovery_protocol_v2 (protocol TEXT PRIMARY KEY NOT NULL CHECK (protocol = '${PROTOCOL}'), version INTEGER NOT NULL CHECK (version = ${VERSION})) STRICT;
    INSERT INTO recovery_protocol_v2(protocol, version) VALUES ('${PROTOCOL}', ${VERSION});
    DROP TABLE recovery_protocol;
    ALTER TABLE recovery_protocol_v2 RENAME TO recovery_protocol;`);
}

function createSchema(database: DatabaseSync): void {
  database.exec(`CREATE TABLE recovery_protocol (protocol TEXT PRIMARY KEY NOT NULL CHECK (protocol = '${PROTOCOL}'), version INTEGER NOT NULL CHECK (version = ${VERSION})) STRICT;
    CREATE TABLE lifecycle_transitions (
      reference TEXT PRIMARY KEY NOT NULL,
      scope_json TEXT NOT NULL,
      plugin TEXT NOT NULL,
      record_json TEXT NOT NULL,
      record_digest TEXT NOT NULL,
      status TEXT NOT NULL,
      generation INTEGER,
      prepared_at INTEGER NOT NULL,
      status_at INTEGER NOT NULL,
      collection_completed_at INTEGER,
      cleanup_status TEXT NOT NULL CHECK (cleanup_status IN ('not-required', 'pending-data-delete', 'completed', 'recovery-required')),
      owner_pid INTEGER,
      owner_start_token TEXT,
      owner_nonce TEXT
    ) STRICT;
    CREATE TABLE transition_quarantine (
      reference TEXT PRIMARY KEY NOT NULL,
      scope_json TEXT,
      record_json TEXT,
      record_digest TEXT,
      code TEXT NOT NULL CHECK (code = 'TRANSITION_JOURNAL_CORRUPT'),
      quarantined_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO recovery_protocol(protocol, version) VALUES ('${PROTOCOL}', ${VERSION});`);
  validateSchema(database);
}

function markerPath(path: string): string { return `${path}.identity`; }
function ensureDatabaseMarker(path: string, rootIdentity: string, databaseName: string, allowCreate: boolean): FileIdentity {
  const pathIdentity = identity(path);
  const marker = markerPath(path);
  let existing: unknown;
  try { existing = JSON.parse(readFileSync(marker, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing === undefined && !allowCreate) throw new Error("recovery journal database identity marker is missing");
  if (existing !== undefined) {
    const value = existing as Record<string, unknown>;
    if (value.protocol !== "pi-plugin-host-recovery-journal-database" || value.version !== 1 || value.rootIdentity !== rootIdentity || value.database !== databaseName || value.device !== pathIdentity.device || value.inode !== pathIdentity.inode) throw new Error("recovery journal database identity changed");
    return pathIdentity;
  }
  const value = { protocol: "pi-plugin-host-recovery-journal-database", version: 1, rootIdentity, database: databaseName, device: pathIdentity.device, inode: pathIdentity.inode };
  const temp = `${marker}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { flag: "wx", mode: MODE });
  try { renameSync(temp, marker); } catch (error) { try { unlinkSync(temp); } catch { /* preserve first failure */ } throw error; }
  chmodSync(marker, MODE);
  return pathIdentity;
}

async function openDatabase(filesystem: RecoveryFilesystem, scope: ScopeReference): Promise<Readonly<{ database: DatabaseSync; path: string; close(): void }>> {
  await filesystem.verify();
  const path = filesystem.journalDatabasePath(scope);
  const databaseName = path.slice(path.lastIndexOf("/") + 1);
  const database = new DatabaseSync(path, { allowExtension: false, defensive: true, enableDoubleQuotedStringLiterals: false, enableForeignKeyConstraints: true, readOnly: false, timeout: 0 });
  try {
    database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
    // File existence is not creation authority: two processes can both observe
    // ENOENT before SQLite creates the same file. Serialize schema inspection,
    // initialization, and identity-marker publication under one exclusive
    // database transaction so no contender can validate a partial schema.
    database.exec("BEGIN EXCLUSIVE");
    try {
      const objects = database.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
      const initialize = objects.length === 0;
      if (initialize) createSchema(database); else { migrateSchema(database); validateSchema(database); }
      ensureDatabaseMarker(path, filesystem.rootIdentity, databaseName, initialize);
      database.exec("COMMIT");
    } catch (error) {
      try { if (database.isTransaction) database.exec("ROLLBACK"); } catch { /* preserve primary failure */ }
      throw error;
    }
    await filesystem.verify();
    return { database, path, close: () => database.close() };
  } catch (error) { try { database.close(); } catch { /* preserve first failure */ } throw error; }
}

async function transaction<T>(filesystem: RecoveryFilesystem, scope: ScopeReference, signal: AbortSignal, fn: (database: DatabaseSync) => T): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal);
    let handle: Readonly<{ database: DatabaseSync; close(): void }> | undefined;
    try {
      handle = await openDatabase(filesystem, scope);
      handle.database.exec("BEGIN IMMEDIATE");
      const value = fn(handle.database);
      throwIfAborted(signal);
      handle.database.exec("COMMIT");
      await filesystem.verify();
      return value;
    } catch (error) {
      try { if (handle?.database.isTransaction) handle.database.exec("ROLLBACK"); } catch { /* preserve primary failure */ }
      if (signal.aborted) throw signal.reason;
      if (!isBusy(error) || attempt >= MAX_BUSY_RETRIES) throw error;
      await waitForBusyRetry(signal, attempt);
    } finally { try { handle?.close(); } catch { /* close is best effort after transaction result */ } }
  }
}

function requestValue(request: LifecycleTransitionRecord | LifecycleTransitionPrepareRequest): { record: LifecycleTransitionRecord; preparedAt: EpochMilliseconds } {
  const value = "record" in request ? request : { record: request, preparedAt: Date.now() };
  return { record: LifecycleTransitionRecordSchemaV1.parse(value.record), preparedAt: EpochMillisecondsSchema.parse(value.preparedAt) };
}

export type SqliteTransitionJournalOptions = Readonly<{
  filesystem: RecoveryFilesystem;
}>;

export type SqliteTransitionJournal = LifecycleTransitionStore & Readonly<{
  ownerStatus(scope: ScopeReference, reference: PendingTransitionRef, signal: AbortSignal): Promise<OwnerStatus>;
}>;

export function createSqliteTransitionJournal(options: SqliteTransitionJournalOptions): SqliteTransitionJournal {
  if (options === null || typeof options !== "object" || options.filesystem === undefined) throw new TypeError("transition journal filesystem is required");
  const filesystem = options.filesystem;

  async function prepare(request: LifecycleTransitionRecord | LifecycleTransitionPrepareRequest, signal: AbortSignal): Promise<LifecycleTransitionPrepareResult> {
    const value = requestValue(request);
    const bytes = canonicalBytes(value.record);
    const digest = digestJournalBytes(bytes);
    const owner = currentOwner();
    try {
      return await transaction(filesystem, value.record.scope, signal, (database) => {
        const existing = database.prepare("SELECT record_json, record_digest, prepared_at, scope_json, plugin, status FROM lifecycle_transitions WHERE reference = ?").get(value.record.reference) as SqliteRow | undefined;
        if (existing !== undefined) {
          if (existing.record_digest === digest && existing.record_json === new TextDecoder().decode(bytes) && existing.prepared_at === value.preparedAt && existing.scope_json === JSON.stringify(value.record.scope) && existing.plugin === value.record.plugin) return "already-present";
          throw conflictError("prepareTransitionJournal");
        }
        database.prepare(`INSERT INTO lifecycle_transitions(reference, scope_json, plugin, record_json, record_digest, status, generation, prepared_at, status_at, collection_completed_at, cleanup_status, owner_pid, owner_start_token, owner_nonce) VALUES (?, ?, ?, ?, ?, 'prepared', NULL, ?, ?, NULL, ?, ?, ?, ?)`)
          .run(value.record.reference, JSON.stringify(value.record.scope), value.record.plugin, new TextDecoder().decode(bytes), digest, value.preparedAt, value.preparedAt, lifecycleCleanupStatus(value.record, { kind: "prepared" }), owner.pid, owner.startToken, owner.nonce);
        return "stored";
      });
    } catch (error) { if (error instanceof DomainContractError || error instanceof BoundaryError) throw error; throw dbError("prepareTransitionJournal", error); }
  }

  async function read(request: Readonly<{ scope: ScopeReference; reference: PendingTransitionRef }>, signal: AbortSignal): Promise<TransitionJournalReadResult> {
    const scope = ScopeReferenceSchema.parse(request.scope);
    const reference = PendingTransitionRefSchema.parse(request.reference);
    try {
      return await transaction(filesystem, scope, signal, (database) => {
        const row = database.prepare("SELECT * FROM lifecycle_transitions WHERE reference = ?").get(String(reference)) as SqliteRow | undefined;
        if (row === undefined) return TransitionJournalReadResultSchema.parse({ kind: "missing" });
        try { return TransitionJournalReadResultSchema.parse({ kind: "found", entry: rowEntry(row) }); }
        catch {
          const at = Date.now();
          database.prepare("INSERT OR REPLACE INTO transition_quarantine(reference, scope_json, record_json, record_digest, code, quarantined_at) VALUES (?, ?, ?, ?, 'TRANSITION_JOURNAL_CORRUPT', ?)").run(String(reference), String(row.scope_json ?? ""), String(row.record_json ?? ""), String(row.record_digest ?? ""), at);
          database.prepare("DELETE FROM lifecycle_transitions WHERE reference = ?").run(reference);
          return TransitionJournalReadResultSchema.parse({ kind: "corrupt", code: "TRANSITION_JOURNAL_CORRUPT" });
        }
      });
    } catch (error) { if (error instanceof DomainContractError) return { kind: "corrupt", code: "TRANSITION_JOURNAL_CORRUPT" }; throw dbError("readTransitionJournal", error); }
  }

  async function list(scopeInput: ScopeReference, signal: AbortSignal): Promise<LifecycleTransitionCollection> {
    const scope = ScopeReferenceSchema.parse(scopeInput);
    try {
      return await transaction(filesystem, scope, signal, (database) => {
        const rows = database.prepare("SELECT * FROM lifecycle_transitions ORDER BY reference").all() as SqliteRow[];
        const entries: LifecycleTransitionJournalEntry[] = [];
        const diagnostics: Array<{ code: "TRANSITION_JOURNAL_CORRUPT"; scope?: ScopeReference }> = [];
        for (const row of rows) {
          try { entries.push(rowEntry(row)); }
          catch {
            diagnostics.push({ code: "TRANSITION_JOURNAL_CORRUPT", scope });
            database.prepare("INSERT OR REPLACE INTO transition_quarantine(reference, scope_json, record_json, record_digest, code, quarantined_at) VALUES (?, ?, ?, ?, 'TRANSITION_JOURNAL_CORRUPT', ?)").run(String(row.reference), String(row.scope_json ?? ""), String(row.record_json ?? ""), String(row.record_digest ?? ""), Date.now());
            database.prepare("DELETE FROM lifecycle_transitions WHERE reference = ?").run(String(row.reference));
          }
        }
        return { entries, complete: true, diagnostics };
      });
    } catch (error) { throw dbError("listTransitionJournal", error); }
  }

  async function settle(requestInput: LifecycleTransitionSettleRequest, signal: AbortSignal): Promise<void> {
    const request = { ...requestInput, at: requestInput.at ?? Date.now() };
    const outcome = request.outcome === "recovery-required" ? "recovery-required" : request.outcome;
    try {
      const scopeRows = requestInput.scope === undefined
        ? await readdir(filesystem.journalRoot)
        : [filesystem.journalDatabasePath(ScopeReferenceSchema.parse(requestInput.scope)).slice(filesystem.journalRoot.length + 1)];
      let found = false;
      for (const name of scopeRows.filter((entry) => entry.endsWith(".sqlite"))) {
        const scope: ScopeReference = name === "user.sqlite" ? { kind: "user" } : (() => { const encoded = name.slice("project-".length, -".sqlite".length); return { kind: "project", projectKey: decodeURIComponent(encoded) as never }; })();
        const result = await transaction(filesystem, scope, signal, (database) => {
          const row = database.prepare("SELECT status FROM lifecycle_transitions WHERE reference = ?").get(String(request.reference)) as SqliteRow | undefined;
          if (row === undefined) return false;
          found = true;
          const current = String(row.status);
          const terminal = current === "completed" || current === "rolled-back" || current === "abandoned";
          if (terminal) {
            if (current !== outcome) throw conflictError("settleTransitionJournal");
            return true;
          }
          if (current !== "prepared" && current !== "recovery-required") throw conflictError("settleTransitionJournal");
          const cleanup = outcome === "rolled-back" || outcome === "abandoned" ? "not-required" : undefined;
          database.prepare(`UPDATE lifecycle_transitions SET status = ?, generation = ?, status_at = ?, cleanup_status = COALESCE(?, cleanup_status), owner_pid = NULL, owner_start_token = NULL, owner_nonce = NULL WHERE reference = ?`).run(outcome, request.generation ?? null, request.at, cleanup ?? null, String(request.reference));
          return true;
        });
        if (result) break;
      }
      if (!found) throw conflictError("settleTransitionJournal");
    } catch (error) { if (error instanceof DomainContractError) throw error; throw dbError("settleTransitionJournal", error); }
  }

  async function markRecoveryRequired(request: Readonly<{ scope: ScopeReference; reference: PendingTransitionRef; generation?: number; at: EpochMilliseconds }>, signal: AbortSignal): Promise<"stored" | "already-present" | "terminal"> {
    try {
      return await transaction(filesystem, request.scope, signal, (database) => {
        const row = database.prepare("SELECT status, generation FROM lifecycle_transitions WHERE reference = ?").get(String(request.reference)) as SqliteRow | undefined;
        if (row === undefined) return "terminal";
        if (row.status === "completed" || row.status === "rolled-back" || row.status === "abandoned" || row.status === "quarantined") return "terminal";
        if (row.status === "recovery-required" && row.generation === (request.generation ?? null)) return "already-present";
        database.prepare("UPDATE lifecycle_transitions SET status = 'recovery-required', generation = ?, status_at = ?, owner_pid = NULL, owner_start_token = NULL, owner_nonce = NULL WHERE reference = ?").run(request.generation ?? null, request.at, String(request.reference));
        return "stored";
      });
    } catch (error) { if (error instanceof DomainContractError) throw error; throw dbError("markRecoveryRequired", error); }
  }

  async function markCleanup(request: Readonly<{ scope: ScopeReference; reference: PendingTransitionRef; status: "completed" | "recovery-required"; at: EpochMilliseconds }>, signal: AbortSignal): Promise<"stored" | "already-present" | "terminal"> {
    try {
      return await transaction(filesystem, request.scope, signal, (database) => {
        const row = database.prepare("SELECT status, cleanup_status FROM lifecycle_transitions WHERE reference = ?").get(String(request.reference)) as SqliteRow | undefined;
        if (row === undefined || row.status !== "completed" || row.cleanup_status === "not-required") return "terminal";
        if (row.cleanup_status === request.status) return "already-present";
        if (row.cleanup_status === "completed") return "terminal";
        database.prepare("UPDATE lifecycle_transitions SET cleanup_status = ?, status_at = ? WHERE reference = ?").run(request.status, request.at, String(request.reference));
        return "stored";
      });
    } catch (error) { throw dbError("markTransitionCleanup", error); }
  }

  async function markCollectionComplete(request: Readonly<{ scope: ScopeReference; reference: PendingTransitionRef; at: EpochMilliseconds }>, signal: AbortSignal): Promise<void> {
    await transaction(filesystem, request.scope, signal, (database) => {
      database.prepare("UPDATE lifecycle_transitions SET collection_completed_at = ? WHERE reference = ? AND status IN ('completed', 'rolled-back', 'abandoned') AND cleanup_status IN ('not-required', 'completed')").run(request.at, String(request.reference));
    });
  }

  async function pruneTerminal(request: Readonly<{ before: EpochMilliseconds }>, signal: AbortSignal): Promise<number> {
    let removed = 0;
    const names = await readdir(filesystem.journalRoot);
    for (const name of names.filter((entry) => entry.endsWith(".sqlite"))) {
      const scope: ScopeReference = name === "user.sqlite" ? { kind: "user" } : { kind: "project", projectKey: decodeURIComponent(name.slice(8, -7)) as never };
      removed += await transaction(filesystem, scope, signal, (database) => {
        const result = database.prepare("DELETE FROM lifecycle_transitions WHERE status IN ('completed', 'rolled-back', 'abandoned') AND cleanup_status IN ('not-required', 'completed') AND collection_completed_at IS NOT NULL AND collection_completed_at < ?").run(request.before);
        return Number(result.changes ?? 0);
      });
    }
    return removed;
  }

  async function ownerStatus(scope: ScopeReference, reference: PendingTransitionRef, signal: AbortSignal): Promise<OwnerStatus> {
    try {
      return await transaction(filesystem, scope, signal, (database) => {
        const row = database.prepare("SELECT owner_pid, owner_start_token, owner_nonce, status FROM lifecycle_transitions WHERE reference = ?").get(String(reference)) as SqliteRow | undefined;
        if (row === undefined) return "released";
        if (row.status !== "prepared") return "released";
        if (typeof row.owner_pid !== "number" || typeof row.owner_start_token !== "string" || typeof row.owner_nonce !== "string") return "unknown";
        return classifyProcessIdentity({ pid: row.owner_pid, startToken: row.owner_start_token });
      });
    } catch (error) { throw dbError("ownerStatus", error); }
  }

  return Object.freeze({ prepare, read, list, settle, markRecoveryRequired, markCleanup, markCollectionComplete, pruneTerminal, ownerStatus });
}

export async function createNodeTransitionJournal(options: Readonly<{ hostRoot: string; verifyLocalFilesystem?: (root: string) => Promise<void> }>): Promise<SqliteTransitionJournal> {
  const filesystem = await createLocalRecoveryFilesystem(options);
  return createSqliteTransitionJournal({ filesystem });
}

export { OwnerSchema, PROTOCOL as RecoveryJournalProtocol };
