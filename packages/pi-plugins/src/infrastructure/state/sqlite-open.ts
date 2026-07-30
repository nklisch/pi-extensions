import { chmodSync, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LOCAL_LOCK_DATABASE_MODE } from "./local-lock-filesystem.js";

const SQLITE_BUSY = 5;
// Waiting out a busy database must tolerate loaded hosts (parallel test
// runners, several Pi sessions on one agent dir); the budget below totals
// roughly five seconds while staying sub-second locally.
const MAX_RETRIES = 24;

export type OpenSqliteDatabase = Readonly<{
  database: DatabaseSync;
  close(): void;
}>;

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

function assertRegularFile(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("SQLite database path is not a regular file");
}

/**
 * Open (creating when absent) a SQLite database and validate its schema.
 * Schema inspection, first-use initialization, and validation run inside one
 * exclusive transaction so concurrent first-use processes serialize on the
 * database itself; no sidecar marker or claim files exist to drift, go stale,
 * or strand a later process. Busy contention retries with backoff until the
 * caller's signal aborts or the budget is exhausted.
 */
export async function openSqliteDatabase(input: Readonly<{
  path: string;
  signal: AbortSignal;
  busyTimeoutMs?: number;
  /** Connection and journal pragmas, executed once after open before any transaction. */
  configure?(database: DatabaseSync): void;
  /** First-use schema and seed data (DDL/DML only — no journal pragmas). */
  initialize(database: DatabaseSync): void;
  validate(database: DatabaseSync): void;
}>): Promise<OpenSqliteDatabase> {
  const busyTimeoutMs = input.busyTimeoutMs ?? 0;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) throw new TypeError("SQLite busy timeout is invalid");
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    input.signal.throwIfAborted();
    const database = new DatabaseSync(input.path, { allowExtension: false, defensive: true, enableForeignKeyConstraints: true, timeout: busyTimeoutMs });
    try {
      input.configure?.(database);
      assertRegularFile(input.path);
      chmodSync(input.path, LOCAL_LOCK_DATABASE_MODE);
      database.exec("BEGIN EXCLUSIVE");
      try {
        const objects = database.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
        if (objects.length === 0) input.initialize(database);
        input.validate(database);
        database.exec("COMMIT");
      } catch (error) {
        try { if (database.isTransaction) database.exec("ROLLBACK"); } catch { /* preserve primary failure */ }
        throw error;
      }
      let closed = false;
      return Object.freeze({
        database,
        close() { if (closed) return; closed = true; database.close(); },
      });
    } catch (error) {
      try { database.close(); } catch { /* preserve primary failure */ }
      if (!isBusy(error) || attempt === MAX_RETRIES) throw error;
      await wait(input.signal, attempt);
    }
  }
  throw new Error("SQLite database open retry budget exhausted");
}
