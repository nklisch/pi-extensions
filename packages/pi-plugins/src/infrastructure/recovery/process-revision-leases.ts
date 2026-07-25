import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensurePrivateLockRoot, verifyLocalFilesystemCapability } from "../state/local-lock-filesystem.js";
import { openIdentityBoundSqliteDatabase } from "../state/identity-bound-sqlite.js";
import { RevisionLeaseCollectionSchema, RevisionLeaseSchema, type RevisionLease, type RevisionLeaseCollection, type RevisionLeaseStore } from "../../application/ports/revision-lease-store.js";
import { RetainedArtifactRefSchema } from "../../application/ports/revision-artifact-store.js";
import { classifyProcessIdentity, readLinuxProcessStartToken } from "../process/process-identity.js";

function json(value: unknown): string { return JSON.stringify(value); }
function abort(signal: AbortSignal): void { if (signal.aborted) throw signal.reason; }

export async function createProcessRevisionLeaseStore(options: Readonly<{ hostRoot: string; verifyLocalFilesystem?: (root: string) => Promise<void> }>): Promise<RevisionLeaseStore & Readonly<{ close(): Promise<void> }>> {
  const root = await ensurePrivateLockRoot(join(options.hostRoot, "recovery", "leases", "v1"));
  await (options.verifyLocalFilesystem ?? verifyLocalFilesystemCapability)(root);
  const handle = await openIdentityBoundSqliteDatabase({
    root,
    path: join(root, "leases.sqlite"),
    signal: new AbortController().signal,
    // Multiple Pi sessions legitimately acquire/release leases in this shared
    // database; bounded waiting is required for those ordinary write windows.
    busyTimeoutMs: 30_000,
    initialize(database) {
      database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; CREATE TABLE revision_leases (lease_id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, artifacts_json TEXT NOT NULL, acquired_at INTEGER NOT NULL, owner_pid INTEGER NOT NULL, owner_start_token TEXT NOT NULL, owner_nonce TEXT NOT NULL) STRICT;");
    },
    validate(database) {
      const rows = database.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; type: string }>;
      if (JSON.stringify(rows) !== JSON.stringify([{ name: "revision_leases", type: "table" }])) throw new Error("revision lease schema is invalid");
    },
  });
  const database = handle.database;
  const owned = new WeakMap<object, { leaseId: string; nonce: string }>();
  const issue = (row: { lease_id: string; session_id: string; artifacts_json: string; acquired_at: number }): RevisionLease => {
    const value = RevisionLeaseSchema.parse({ leaseId: row.lease_id, sessionId: row.session_id, artifacts: JSON.parse(row.artifacts_json), acquiredAt: row.acquired_at });
    owned.set(value, { leaseId: row.lease_id, nonce: "local" });
    return value;
  };
  const store: RevisionLeaseStore = {
    async acquire(request, signal) {
      abort(signal);
      handle.assertIdentity();
      const token = readLinuxProcessStartToken(process.pid); if (token === undefined) throw new Error("revision lease process identity unavailable");
      const leaseId = randomUUID();
      const artifacts = request.artifacts.map((ref) => RetainedArtifactRefSchema.parse(ref));
      database.prepare("INSERT INTO revision_leases(lease_id, session_id, artifacts_json, acquired_at, owner_pid, owner_start_token, owner_nonce) VALUES (?, ?, ?, ?, ?, ?, ?)").run(leaseId, request.sessionId, json(artifacts), request.at, process.pid, token, randomUUID());
      return issue({ lease_id: leaseId, session_id: request.sessionId, artifacts_json: json(artifacts), acquired_at: request.at });
    },
    async replace(lease, artifacts, at, signal) {
      abort(signal);
      handle.assertIdentity();
      const owner = owned.get(lease); if (owner === undefined) throw new Error("revision lease capability is not owned");
      const value = RevisionLeaseSchema.parse(lease);
      const parsed = artifacts.map((ref) => RetainedArtifactRefSchema.parse(ref));
      database.prepare("UPDATE revision_leases SET artifacts_json = ?, acquired_at = ? WHERE lease_id = ?").run(json(parsed), at, value.leaseId);
      return issue({ lease_id: value.leaseId, session_id: value.sessionId, artifacts_json: json(parsed), acquired_at: at });
    },
    async release(lease, _at, signal) {
      abort(signal);
      handle.assertIdentity();
      if (owned.get(lease) === undefined) throw new Error("revision lease capability is not owned");
      const value = RevisionLeaseSchema.parse(lease);
      database.prepare("DELETE FROM revision_leases WHERE lease_id = ?").run(value.leaseId);
    },
    async list(signal): Promise<RevisionLeaseCollection> {
      abort(signal);
      handle.assertIdentity();
      const rows = database.prepare("SELECT * FROM revision_leases ORDER BY lease_id").all() as Array<{ lease_id: string; session_id: string; artifacts_json: string; acquired_at: number; owner_pid: number; owner_start_token: string }>;
      const leases: RevisionLease[] = [];
      const owners: Array<{ leaseId: string; status: "live" | "dead" | "unknown" | "released" }> = [];
      for (const row of rows) {
        try { leases.push(issue(row)); owners.push({ leaseId: row.lease_id, status: classifyProcessIdentity({ pid: row.owner_pid, startToken: row.owner_start_token }) }); }
        catch { return { complete: false, leases: [], owners: [] }; }
      }
      return RevisionLeaseCollectionSchema.parse({ complete: true, leases, owners });
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
