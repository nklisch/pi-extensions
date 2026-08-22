import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir, rmdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JsonValueSchema } from "../../domain/schema.js";
import {
  decodeStateDocument,
  encodeStateDocument,
  hashStateDocument,
  type StateDocumentFor,
} from "../../domain/state/codec.js";
import { GenerationSchema, type Generation } from "../../domain/state/config-state.js";
import { StatePointersDocumentSchema, createStatePointersDocument, type PointerDocumentKind } from "../../domain/state/pointers.js";
import { deriveStateBlobRef, PluginDataRefSchema } from "../../domain/state/references.js";
import { createScopeContext, ScopeReferenceSchema, toScopeReference, type ScopeContext, type ScopeReference } from "../../domain/state/scope.js";
import type { Sha256 } from "../../domain/source.js";
import { PluginKeySchema } from "../../domain/identity.js";
import { createPendingDeleteMarkerStore, type PendingDeleteMarker } from "../cleanup/pending-data-deletion.js";

const STATE_PROTOCOL = "pi-plugin-host-lifecycle-state";
const STATE_PROTOCOL_VERSION = 1;
const JOURNAL_DIRECTORY = join("recovery", "journal", "v1");
const LEGACY_DATABASE_DIRECTORIES = [
  join("recovery", "leases", "v1"),
  join("recovery", "retention", "v1"),
  join("locks", "v1"),
] as const;

type SqliteRow = Record<string, unknown>;

type StateMigrationOutcome = Readonly<{
  path: string;
  scope?: ScopeReference;
  changed: boolean;
  deferred: boolean;
  error?: string;
}>;

export type LifecycleConvergenceMigrationReport = Readonly<{
  scopes: readonly StateMigrationOutcome[];
  harvestedMarkers: number;
  deletedLegacyDatabases: number;
  deferred: boolean;
}>;

export type LifecycleConvergenceMigrationOptions = Readonly<{
  stateRoot: string;
  stateDatabase(scope: ScopeReference): string;
  hostRoot: string;
  sha256: Sha256;
  /** U1 keeps the legacy field shipped; U2 enables this before removing it. */
  enabled?: boolean;
  signal?: AbortSignal;
}>;

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function abort(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScopeEqual(left: ScopeReference, right: ScopeReference): boolean {
  return left.kind === right.kind && (left.kind === "user" || (right.kind === "project" && left.projectKey === right.projectKey));
}

function stateScope(database: DatabaseSync, sha256: Sha256): ScopeContext {
  const row = database.prepare("SELECT protocol, version, scope_json FROM protocol WHERE singleton = 1").get() as SqliteRow | undefined;
  if (row?.protocol !== STATE_PROTOCOL || row.version !== STATE_PROTOCOL_VERSION) throw new Error("lifecycle state protocol is invalid");
  return createScopeContext(JSON.parse(String(row.scope_json)), sha256);
}

function stripPendingTransition(raw: unknown): Readonly<{ value: unknown; changed: boolean }> {
  if (!isRecord(raw) || !Array.isArray(raw.plugins)) return { value: raw, changed: false };
  let changed = false;
  const plugins = raw.plugins.map((candidate) => {
    if (!isRecord(candidate) || !Object.prototype.hasOwnProperty.call(candidate, "pendingTransition")) return candidate;
    changed = true;
    const { pendingTransition: _legacy, ...withoutPending } = candidate;
    return withoutPending;
  });
  return changed ? { value: { ...raw, plugins }, changed } : { value: raw, changed: false };
}

function decodeForGeneration(kind: PointerDocumentKind, raw: unknown, scope: ScopeContext, generation: Generation, sha256: Sha256): unknown {
  switch (kind) {
    case "hostConfig": return decodeStateDocument("hostConfig", raw, { scope, generation, sha256 }).value;
    case "installedUser": return decodeStateDocument("installedUser", raw, { scope, generation, sha256 }).value;
    case "trust": return decodeStateDocument("trust", raw, { scope, generation, sha256 }).value;
    case "projectLocal": return decodeStateDocument("projectLocal", raw, { scope, generation, sha256 }).value;
  }
}

function encodeForGeneration(kind: PointerDocumentKind, value: unknown, scope: ScopeContext, generation: Generation, sha256: Sha256) {
  switch (kind) {
    case "hostConfig": return encodeStateDocument("hostConfig", value as StateDocumentFor<"hostConfig">, { scope, generation, sha256 });
    case "installedUser": return encodeStateDocument("installedUser", value as StateDocumentFor<"installedUser">, { scope, generation, sha256 });
    case "trust": return encodeStateDocument("trust", value as StateDocumentFor<"trust">, { scope, generation, sha256 });
    case "projectLocal": return encodeStateDocument("projectLocal", value as StateDocumentFor<"projectLocal">, { scope, generation, sha256 });
  }
}

function assertRawDigest(raw: unknown, expected: string, sha256: Sha256): void {
  const value = JsonValueSchema.parse(raw);
  if (hashStateDocument(value, sha256) !== expected) throw new Error("state blob digest does not match before migration");
}

function migrateStateScope(path: string, sha256: Sha256): StateMigrationOutcome {
  let database: DatabaseSync | undefined;
  let scope: ScopeReference | undefined;
  try {
    database = new DatabaseSync(path, { allowExtension: false, defensive: true, readOnly: false, timeout: 0 });
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
    scope = toScopeReference(stateScope(database, sha256));
    database.exec("BEGIN IMMEDIATE");
    const current = database.prepare("SELECT generation, pointer_json FROM current_pointer WHERE singleton = 1").get() as SqliteRow | undefined;
    if (current === undefined) throw new Error("lifecycle state current pointer is missing");
    const generation = GenerationSchema.parse(current.generation);
    const pointer = StatePointersDocumentSchema.parse(JSON.parse(String(current.pointer_json)));
    if (!isScopeEqual(pointer.scope, scope)) throw new Error("lifecycle state pointer scope does not match protocol");

    const rawByKind = new Map<PointerDocumentKind, unknown>();
    const changedKinds = new Set<PointerDocumentKind>();
    for (const entry of pointer.documents) {
      const row = database.prepare("SELECT blob_ref, kind, generation, digest, document FROM state_blobs WHERE blob_ref = ?").get(entry.blob) as SqliteRow | undefined;
      if (row === undefined || row.blob_ref !== entry.blob || row.kind !== entry.kind || row.generation !== generation || row.digest !== entry.digest) {
        throw new Error(`state blob ${entry.kind} is missing or inconsistent`);
      }
      const raw = JSON.parse(String(row.document));
      assertRawDigest(raw, entry.digest, sha256);
      const stripped = entry.kind === "installedUser" || entry.kind === "projectLocal" ? stripPendingTransition(raw) : { value: raw, changed: false };
      rawByKind.set(entry.kind, stripped.value);
      if (stripped.changed) changedKinds.add(entry.kind);
    }

    if (changedKinds.size === 0) {
      database.exec("COMMIT");
      return { path, scope, changed: false, deferred: false };
    }

    const next = GenerationSchema.parse(generation + 1);
    const encoded = pointer.documents.map((entry) => {
      const decoded = decodeForGeneration(entry.kind, rawByKind.get(entry.kind), pointer.scope.kind === "user"
        ? createScopeContext({ kind: "user" }, sha256)
        : createScopeContext(pointer.scope, sha256), generation, sha256);
      const nextValue = isRecord(decoded) ? { ...decoded, generation: next } : decoded;
      const document = encodeForGeneration(entry.kind, nextValue, pointer.scope.kind === "user"
        ? createScopeContext({ kind: "user" }, sha256)
        : createScopeContext(pointer.scope, sha256), next, sha256);
      const digest = hashStateDocument(document, sha256);
      const blob = deriveStateBlobRef({ scope: pointer.scope, generation: next, kind: entry.kind, digest }, sha256);
      return { kind: entry.kind, generation: next, blob, digest, document: JSON.stringify(document) };
    });
    for (const entry of encoded) {
      database.prepare("INSERT INTO state_blobs(blob_ref, kind, generation, digest, document) VALUES (?, ?, ?, ?, ?)")
        .run(entry.blob, entry.kind, entry.generation, entry.digest, entry.document);
    }
    const nextPointer = createStatePointersDocument({
      schemaVersion: 1,
      scope: pointer.scope,
      generation: next,
      previousGeneration: generation,
      documents: encoded.map(({ kind, generation: entryGeneration, blob, digest }) => ({ kind, generation: entryGeneration, blob, digest })),
    });
    const pointerJson = JSON.stringify(nextPointer);
    database.prepare("INSERT INTO generation_pointers(generation, pointer_json) VALUES (?, ?)").run(next, pointerJson);
    database.prepare("UPDATE current_pointer SET generation = ?, pointer_json = ? WHERE singleton = 1").run(next, pointerJson);
    database.prepare("DELETE FROM generation_pointers WHERE generation < ?").run(next - 1);
    database.prepare("DELETE FROM state_blobs WHERE generation < ?").run(next - 1);
    database.exec("COMMIT");
    return { path, scope, changed: true, deferred: false };
  } catch (error) {
    try { if (database?.isTransaction) database.exec("ROLLBACK"); } catch { /* preserve the migration failure */ }
    return { path, ...(scope === undefined ? {} : { scope }), changed: false, deferred: true, error: error instanceof Error ? error.message : String(error) };
  } finally {
    try { database?.close(); } catch { /* preserve the migration result */ }
  }
}

function journalMarker(row: SqliteRow): PendingDeleteMarker {
  const record = JSON.parse(String(row.record_json));
  if (!isRecord(record)) throw new Error("journal record is not an object");
  const scope = ScopeReferenceSchema.parse(record.scope);
  const plugin = String(record.plugin);
  const previous = record.previous;
  if (!isRecord(previous) || !Array.isArray(previous.revisions)) throw new Error("journal uninstall previous state is missing");
  const selectedRevision = String(previous.selectedRevision);
  const selected = previous.revisions.find((revision) => isRecord(revision) && revision.revision === selectedRevision);
  if (!isRecord(selected) || typeof selected.dataRef !== "string") throw new Error("journal uninstall data reference is missing");
  // Parsing here is intentionally minimal: the state codec remains the
  // authority for installed records, while this queue only needs deletion facts.
  return {
    scope,
    plugin: PluginKeySchema.parse(plugin),
    dataRef: PluginDataRefSchema.parse(selected.dataRef),
    requestedAt: typeof row.status_at === "number" ? row.status_at : Date.now(),
  };
}

async function harvestJournals(hostRoot: string, signal: AbortSignal | undefined): Promise<Readonly<{ markers: number; deleted: number; complete: boolean }>> {
  const journalRoot = join(hostRoot, JOURNAL_DIRECTORY);
  let names: string[];
  try { names = await readdir(journalRoot); }
  catch (error) { if (isMissing(error)) return { markers: 0, deleted: 0, complete: true }; throw error; }
  const markerStore = createPendingDeleteMarkerStore({ root: join(hostRoot, "cleanup", "v1", "pending-deletes") });
  let markers = 0;
  let deleted = 0;
  const seenReferences = new Set<string>();
  for (const name of names.filter((entry) => entry.endsWith(".sqlite")).sort()) {
    abort(signal);
    const path = join(journalRoot, name);
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path, { allowExtension: false, defensive: true, readOnly: true, timeout: 0 });
      const rows = database.prepare("SELECT reference, record_json, status, cleanup_status, status_at FROM lifecycle_transitions WHERE cleanup_status = 'pending-data-delete' AND status = 'completed' ORDER BY reference").all() as SqliteRow[];
      for (const row of rows) {
        abort(signal);
        const reference = String(row.reference);
        if (seenReferences.has(reference)) continue;
        seenReferences.add(reference);
        await markerStore.create(journalMarker(row));
        markers += 1;
      }
    } catch (error) {
      try { database?.close(); } catch { /* retain the journal on close failure */ }
      return { markers, deleted, complete: false };
    }
    try { database?.close(); } catch { return { markers, deleted, complete: false }; }
    try { await unlink(path); deleted += 1; }
    catch (error) { if (!isMissing(error)) return { markers, deleted, complete: false }; }
  }
  return { markers, deleted, complete: true };
}

async function removeLegacyDatabases(hostRoot: string): Promise<number> {
  let removed = 0;
  for (const relative of LEGACY_DATABASE_DIRECTORIES) {
    const directory = join(hostRoot, relative);
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if (isMissing(error)) continue; throw error; }
    for (const name of names.filter((entry) => entry.endsWith(".sqlite"))) {
      try { await unlink(join(directory, name)); removed += 1; }
      catch (error) { if (!isMissing(error)) throw error; }
    }
  }
  return removed;
}

async function removeLegacySidecars(root: string, removeEmptyDirectories = false): Promise<void> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (isMissing(error)) return; throw error; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await removeLegacySidecars(path, removeEmptyDirectories);
      if (removeEmptyDirectories) {
        try { await rmdir(path); } catch (error) { if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error; }
      }
      continue;
    }
    if (entry.name.endsWith(".owner") || entry.name === ".identity" || entry.name === ".sqlite-root.identity") {
      try { await unlink(path); } catch (error) { if (!isMissing(error)) throw error; }
    }
  }
}

async function removeRootSidecars(root: string): Promise<void> {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (isMissing(error)) return; throw error; }
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (entry.name.endsWith(".owner") || entry.name === ".identity" || entry.name === ".sqlite-root.identity") {
      try { await unlink(join(root, entry.name)); } catch (error) { if (!isMissing(error)) throw error; }
    }
  }
}

/**
 * Detect-and-do migration. State scopes are isolated deliberately: a broken
 * legacy scope is left untouched and remains readable as corrupt-but-
 * recoverable evidence, while healthy sibling scopes and journal cleanup run.
 */
export async function runLifecycleConvergenceMigration(input: LifecycleConvergenceMigrationOptions): Promise<LifecycleConvergenceMigrationReport> {
  if (input === null || typeof input !== "object" || typeof input.stateRoot !== "string" || typeof input.hostRoot !== "string" || typeof input.stateDatabase !== "function" || typeof input.sha256 !== "function") {
    throw new TypeError("lifecycle convergence migration options are required");
  }
  const signal = input.signal;
  abort(signal);
  if (input.enabled === false) {
    return Object.freeze({ scopes: Object.freeze([]), harvestedMarkers: 0, deletedLegacyDatabases: 0, deferred: false });
  }
  await mkdir(input.stateRoot, { recursive: true, mode: 0o700 });
  let names: string[];
  try { names = await readdir(input.stateRoot); }
  catch (error) { if (isMissing(error)) names = []; else throw error; }
  const scopes: StateMigrationOutcome[] = [];
  for (const name of names.filter((entry) => entry === "user.sqlite" || /^project-[0-9a-f]{64}\.sqlite$/u.test(entry)).sort()) {
    abort(signal);
    const path = join(input.stateRoot, name);
    let file;
    try { file = await stat(path); } catch { continue; }
    if (!file.isFile()) continue;
    scopes.push(migrateStateScope(path, input.sha256));
  }

  const harvested = await harvestJournals(resolve(input.hostRoot), signal);
  let deletedLegacyDatabases = harvested.deleted;
  if (harvested.complete) {
    deletedLegacyDatabases += await removeLegacyDatabases(resolve(input.hostRoot));
    const resolvedHostRoot = resolve(input.hostRoot);
    await removeRootSidecars(resolvedHostRoot);
    // Only retired roots are recursively pruned. The state root is created
    // before this migration and must remain available for the first adapter
    // open, even when it has no databases yet.
    const recoveryRoot = join(resolvedHostRoot, "recovery");
    await removeLegacySidecars(recoveryRoot, true);
    try { await rmdir(recoveryRoot); } catch (error) { if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error; }
    await removeLegacySidecars(join(resolvedHostRoot, "locks"), true);
    // Owner sidecars are one level below the two legacy staging roots; avoid
    // walking published content on every migration check.
    await removeRootSidecars(join(resolvedHostRoot, "staging", "v1"));
    await removeRootSidecars(join(resolvedHostRoot, "generated", "v1", ".staging"));
  }
  return Object.freeze({
    scopes: Object.freeze(scopes.map((entry) => Object.freeze(entry))),
    harvestedMarkers: harvested.markers,
    deletedLegacyDatabases,
    deferred: scopes.some((entry) => entry.deferred) || !harvested.complete,
  });
}

/** Short alias for callers that describe startup as a migration step. */
export const migrateLifecycleConvergence = runLifecycleConvergenceMigration;
