import { join } from "node:path";
import { RetainedArtifactRefSchema, type RetainedArtifactRef } from "../../application/ports/revision-artifact-store.js";
import { RevisionRetentionSnapshotSchema, type RevisionRetentionStore, type RevisionRetentionSnapshot } from "../../application/ports/revision-retention-store.js";
import { EpochMillisecondsSchema } from "../../application/ports/lifecycle-clock.js";
import { ensurePrivateLockRoot, verifyLocalFilesystemCapability } from "../state/local-lock-filesystem.js";
import { openIdentityBoundSqliteDatabase } from "../state/identity-bound-sqlite.js";

function key(ref: RetainedArtifactRef): string { return JSON.stringify(ref); }
function abort(signal: AbortSignal): void { if (signal.aborted) throw signal.reason; }

export async function createSqliteRevisionRetention(options: Readonly<{ hostRoot: string; verifyLocalFilesystem?: (root: string) => Promise<void> }>): Promise<RevisionRetentionStore & Readonly<{ close(): Promise<void> }>> {
  const root = await ensurePrivateLockRoot(join(options.hostRoot, "recovery", "retention", "v1"));
  await (options.verifyLocalFilesystem ?? verifyLocalFilesystemCapability)(root);
  const path = join(root, "retention.sqlite");
  const handle = await openIdentityBoundSqliteDatabase({
    root,
    path,
    signal: new AbortController().signal,
    initialize(database) {
      database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; CREATE TABLE retention_marks (reference TEXT PRIMARY KEY NOT NULL, first_unreferenced_at INTEGER NOT NULL) STRICT;");
    },
    validate(database) {
      const rows = database.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; type: string }>;
      if (JSON.stringify(rows) !== JSON.stringify([{ name: "retention_marks", type: "table" }])) throw new Error("revision retention schema is invalid");
    },
  });
  const database = handle.database;
  const store: RevisionRetentionStore = {
    async reconcile(request, signal): Promise<RevisionRetentionSnapshot> {
      abort(signal);
      handle.assertIdentity();
      const at = EpochMillisecondsSchema.parse(request.completeScanAt);
      const referenced = new Set(request.referenced.map((ref) => key(RetainedArtifactRefSchema.parse(ref))));
      const observed = new Map(request.observed.map((ref) => [key(RetainedArtifactRefSchema.parse(ref)), RetainedArtifactRefSchema.parse(ref)]));
      database.exec("BEGIN IMMEDIATE");
      try {
        const rows = database.prepare("SELECT reference, first_unreferenced_at FROM retention_marks ORDER BY reference").all() as Array<{ reference: string; first_unreferenced_at: number }>;
        for (const row of rows) if (referenced.has(row.reference) || !observed.has(row.reference)) database.prepare("DELETE FROM retention_marks WHERE reference = ?").run(row.reference);
        for (const [ref] of observed) if (!referenced.has(ref)) database.prepare("INSERT OR IGNORE INTO retention_marks(reference, first_unreferenced_at) VALUES (?, ?)").run(ref, at);
        database.exec("COMMIT");
      } catch (error) { try { database.exec("ROLLBACK"); } catch { /* preserve primary */ } throw error; }
      const marks = (database.prepare("SELECT reference, first_unreferenced_at FROM retention_marks ORDER BY reference").all() as Array<{ reference: string; first_unreferenced_at: number }>).map((row) => ({ reference: RetainedArtifactRefSchema.parse(JSON.parse(row.reference)), firstUnreferencedAt: row.first_unreferenced_at }));
      return RevisionRetentionSnapshotSchema.parse({ complete: true, marks });
    },
    async markRemoved(reference, _at, signal): Promise<void> {
      abort(signal);
      handle.assertIdentity();
      database.prepare("DELETE FROM retention_marks WHERE reference = ?").run(key(RetainedArtifactRefSchema.parse(reference)));
    },
  };
  let closed = false;
  return Object.freeze({
    ...store,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      handle.close();
    },
  });
}
