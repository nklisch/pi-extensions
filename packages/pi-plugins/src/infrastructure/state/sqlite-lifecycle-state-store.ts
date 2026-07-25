import { readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { basename } from "node:path";
import type { LifecycleStateInventoryPort } from "../../application/ports/lifecycle-state-inventory.js";
import type { LifecycleStateStore } from "../../application/ports/lifecycle-state-store.js";
import {
  isVerifiedStateMutation,
  type GenerationSnapshot,
  type StateCommitResult,
  type StateLoadResult,
  type VerifiedStateMutation,
} from "../../application/state-contract.js";
import { hashStateDocument, decodeStateDocument, encodeStateDocument, StateCodecError, StateVersionCutoverError, StateCorruptionSchema } from "../../domain/state/codec.js";
import { GenerationSchema } from "../../domain/state/config-state.js";
import { createStatePointersDocument, type PointerDocumentKind, type StatePointersDocument } from "../../domain/state/pointers.js";
import { deriveStateBlobRef } from "../../domain/state/references.js";
import { createScopeContext, ScopeContextSchema, toScopeReference, type ScopeContext } from "../../domain/state/scope.js";
import type { Sha256 } from "../../domain/source.js";
import { createLifecycleStateDefaultDocuments } from "./lifecycle-state-defaults.js";
import { ensurePrivateLockRoot, verifyLocalFilesystemCapability } from "./local-lock-filesystem.js";
import { openIdentityBoundSqliteDatabase, type IdentityBoundSqliteDatabase } from "./identity-bound-sqlite.js";

const PROTOCOL = "pi-plugin-host-lifecycle-state";
const VERSION = 1;
const SQLITE_BUSY = 5;
// Loaded hosts serialize many processes on one scope database; keep the
// busy budget in the same ~5s class as initialization waits.
const MAX_BUSY_RETRIES = 24;

type OpenScopeDatabase = {
  readonly database: DatabaseSync;
  readonly handle: IdentityBoundSqliteDatabase;
  readonly path: string;
  readonly scope: ScopeContext;
  closed: boolean;
};

type BlobRow = {
  blob_ref: string;
  kind: string;
  generation: number;
  digest: string;
  document: string;
};

type PointerRow = { generation: number; pointer_json: string };

export class LifecycleStateAdapterError extends Error {
  readonly code: "STATE_CORRUPT" | "STATE_ADAPTER_FAILED";

  constructor(code: LifecycleStateAdapterError["code"], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LifecycleStateAdapterError";
    this.code = code;
  }

  toJSON(): Readonly<{ code: string; message: string }> {
    return Object.freeze({ code: this.code, message: this.message });
  }
}

function safeCorruption(scope: ScopeContext, code: "DOCUMENT_INVALID" | "DIGEST_MISMATCH" = "DOCUMENT_INVALID") {
  return StateCorruptionSchema.parse({
    document: "pointers",
    scope: toScopeReference(scope),
    code,
    location: { kind: "field", id: code === "DIGEST_MISMATCH" ? "digest" : "root" },
    summary: code === "DIGEST_MISMATCH"
      ? "state document digest does not match"
      : "state document is invalid",
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertFileIdentity(handle: OpenScopeDatabase): void {
  if (handle.closed) throw new LifecycleStateAdapterError("STATE_ADAPTER_FAILED", "lifecycle state adapter is closed");
  try { handle.handle.assertIdentity(); }
  catch (cause) { throw new LifecycleStateAdapterError("STATE_ADAPTER_FAILED", "lifecycle state database identity changed", cause); }
}

function begin(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
}

function rollback(database: DatabaseSync): void {
  try { if (database.isTransaction) database.exec("ROLLBACK"); } catch { /* preserve the operation failure */ }
}

function isBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { errcode?: unknown }).errcode === SQLITE_BUSY;
}

async function waitForBusy(signal: AbortSignal, attempt: number): Promise<void> {
  signal.throwIfAborted();
  const delay = Math.min(250, 2 ** Math.min(attempt, 8));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, delay);
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function initializeSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 0;
    CREATE TABLE IF NOT EXISTS protocol (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      protocol TEXT NOT NULL,
      version INTEGER NOT NULL,
      scope_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS state_blobs (
      blob_ref TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation >= 0),
      digest TEXT NOT NULL,
      document TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS generation_pointers (
      generation INTEGER PRIMARY KEY CHECK (generation >= 0),
      pointer_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS current_pointer (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      generation INTEGER NOT NULL CHECK (generation >= 0),
      pointer_json TEXT NOT NULL
    ) STRICT;
  `);
}

function validateSchema(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
  const rows = database.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; type: string }>;
  const expected = ["current_pointer", "generation_pointers", "protocol", "state_blobs"];
  if (rows.length !== expected.length || rows.some((row, index) => row.name !== expected[index] || row.type !== "table")) {
    throw new LifecycleStateAdapterError("STATE_CORRUPT", "lifecycle state schema is invalid");
  }
}

function readProtocol(database: DatabaseSync): { protocol: string; version: number; scope_json: string } | undefined {
  return database.prepare("SELECT protocol, version, scope_json FROM protocol WHERE singleton = 1")
    .get() as { protocol: string; version: number; scope_json: string } | undefined;
}

function scopeFromProtocol(database: DatabaseSync, sha256: Sha256): ScopeContext {
  const row = readProtocol(database);
  if (row === undefined || row.protocol !== PROTOCOL || row.version !== VERSION) {
    throw new LifecycleStateAdapterError("STATE_CORRUPT", "lifecycle state protocol is invalid");
  }
  try {
    return createScopeContext(JSON.parse(row.scope_json), sha256);
  } catch (cause) {
    throw new LifecycleStateAdapterError("STATE_CORRUPT", "lifecycle state scope evidence is invalid", cause);
  }
}

function withGeneration<T extends Readonly<{ generation: number }>>(document: T, generation: number): T {
  return { ...document, generation } as T;
}

function encodeDocument(
  kind: PointerDocumentKind,
  document: unknown,
  scope: ScopeContext,
  generation: number,
  sha256: Sha256,
) {
  const context = { scope, generation: GenerationSchema.parse(generation), sha256 };
  switch (kind) {
    case "hostConfig": return encodeStateDocument("hostConfig", document as never, context);
    case "installedUser": return encodeStateDocument("installedUser", document as never, context);
    case "trust": return encodeStateDocument("trust", document as never, context);
    case "projectLocal": return encodeStateDocument("projectLocal", document as never, context);
  }
}

function writeGeneration(
  database: DatabaseSync,
  scope: ScopeContext,
  generation: number,
  documents: Readonly<Record<string, unknown>>,
  sha256: Sha256,
  previousGeneration?: number,
): StatePointersDocument {
  const pointers = Object.entries(documents).map(([rawKind, document]) => {
    const kind = rawKind as PointerDocumentKind;
    const encoded = encodeDocument(kind, document, scope, generation, sha256);
    const digest = hashStateDocument(encoded, sha256);
    const blob = deriveStateBlobRef({
      scope: toScopeReference(scope),
      generation,
      kind,
      digest,
    }, sha256);
    database.prepare(`
      INSERT INTO state_blobs(blob_ref, kind, generation, digest, document)
      VALUES (?, ?, ?, ?, ?)
    `).run(blob, kind, generation, digest, JSON.stringify(encoded));
    return { kind, generation, blob, digest };
  });
  const pointer = createStatePointersDocument({
    schemaVersion: 1,
    scope: toScopeReference(scope),
    generation,
    ...(previousGeneration === undefined ? {} : { previousGeneration }),
    documents: pointers,
  });
  const pointerJson = JSON.stringify(pointer);
  database.prepare("INSERT INTO generation_pointers(generation, pointer_json) VALUES (?, ?)")
    .run(generation, pointerJson);
  database.prepare(`
    INSERT INTO current_pointer(singleton, generation, pointer_json) VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation, pointer_json = excluded.pointer_json
  `).run(generation, pointerJson);
  const oldest = generation - 1;
  database.prepare("DELETE FROM generation_pointers WHERE generation < ?").run(oldest);
  database.prepare("DELETE FROM state_blobs WHERE generation < ?").run(oldest);
  return pointer;
}

function initializeScope(database: DatabaseSync, scope: ScopeContext, sha256: Sha256): void {
  if (readProtocol(database) !== undefined) throw new LifecycleStateAdapterError("STATE_CORRUPT", "new lifecycle state database is not empty");
  database.prepare("INSERT INTO protocol(singleton, protocol, version, scope_json) VALUES (1, ?, ?, ?)")
    .run(PROTOCOL, VERSION, JSON.stringify(scope));
  writeScopeDefaults(database, scope, sha256);
}

function writeScopeDefaults(database: DatabaseSync, scope: ScopeContext, sha256: Sha256): void {
  const defaults = createLifecycleStateDefaultDocuments(scope, sha256) as Readonly<Record<string, unknown>>;
  writeGeneration(database, scope, 0, scope.kind === "user"
    ? { hostConfig: defaults.config, installedUser: defaults.installed, trust: defaults.trust }
    : { projectLocal: defaults.project }, sha256);
}

/**
 * Clean cut-over for a stale pointers index. The pointer document names every
 * blob in its generation, so no single document can be reinitialized on its
 * own; the whole scope returns to its fresh generation-0 defaults instead.
 */
function reinitializeScope(database: DatabaseSync, scope: ScopeContext, sha256: Sha256): void {
  database.prepare("DELETE FROM state_blobs").run();
  database.prepare("DELETE FROM generation_pointers").run();
  database.prepare("DELETE FROM current_pointer").run();
  writeScopeDefaults(database, scope, sha256);
}

function decodeBlob(
  database: DatabaseSync,
  pointer: StatePointersDocument["documents"][number],
  scope: ScopeContext,
  sha256: Sha256,
): { value: unknown; corruptions: readonly ReturnType<typeof safeCorruption>[] } {
  const row = database.prepare(`
    SELECT blob_ref, kind, generation, digest, document FROM state_blobs WHERE blob_ref = ?
  `).get(pointer.blob) as BlobRow | undefined;
  if (row === undefined || row.blob_ref !== pointer.blob || row.kind !== pointer.kind ||
      row.generation !== pointer.generation || row.digest !== pointer.digest) {
    throw new StateCodecError(safeCorruption(scope));
  }
  let raw: unknown;
  try { raw = JSON.parse(row.document); } catch { throw new StateCodecError(safeCorruption(scope)); }
  const context = { scope, generation: pointer.generation, expectedDigest: pointer.digest, sha256 };
  switch (pointer.kind) {
    case "hostConfig": return decodeStateDocument("hostConfig", raw, context);
    case "installedUser": return decodeStateDocument("installedUser", raw, context);
    case "trust": return decodeStateDocument("trust", raw, context);
    case "projectLocal": return decodeStateDocument("projectLocal", raw, context);
  }
}

function readSnapshot(database: DatabaseSync, scope: ScopeContext, sha256: Sha256): StateLoadResult {
  const row = database.prepare("SELECT generation, pointer_json FROM current_pointer WHERE singleton = 1")
    .get() as PointerRow | undefined;
  try {
    if (row === undefined) throw new StateCodecError(safeCorruption(scope));
    const generation = GenerationSchema.parse(row.generation);
    const rawPointer = JSON.parse(row.pointer_json);
    let decodedPointer: ReturnType<typeof decodeStateDocument<"pointers">>;
    try {
      decodedPointer = decodeStateDocument("pointers", rawPointer, { scope, generation, sha256 });
    } catch (error) {
      if (!(error instanceof StateVersionCutoverError)) throw error;
      // A stale pointers version is a clean cut-over, not corruption:
      // reinitialize the scope at generation 0 and read the fresh snapshot.
      reinitializeScope(database, scope, sha256);
      return readSnapshot(database, scope, sha256);
    }
    const pointers = decodedPointer.value;
    if (pointers.generation !== row.generation) throw new StateCodecError(safeCorruption(scope));
    const values = new Map<PointerDocumentKind, unknown>();
    const corruptions = [...decodedPointer.corruptions];
    for (const pointer of pointers.documents) {
      const decoded = decodeBlob(database, pointer, scope, sha256);
      values.set(pointer.kind, decoded.value);
      corruptions.push(...decoded.corruptions);
    }
    const snapshot: GenerationSnapshot = scope.kind === "user"
      ? {
          scope,
          generation,
          pointers,
          config: values.get("hostConfig") as never,
          installed: values.get("installedUser") as never,
          trust: values.get("trust") as never,
          corruptions,
        }
      : {
          scope,
          generation,
          pointers,
          project: values.get("projectLocal") as never,
          corruptions,
        };
    return { ok: true, snapshot };
  } catch (error) {
    const corruption = error instanceof StateCodecError ? error.corruption : safeCorruption(scope);
    return { ok: false, scope, corruptions: [corruption] };
  }
}

type LifecycleStatePathPlan = Readonly<{
  stateRoot: string;
  stateDatabase(scope: ReturnType<typeof toScopeReference>): string;
}>;

function projectDigest(projectKey: string): string {
  const match = /^project-v1:sha256:([0-9a-f]{64})$/u.exec(projectKey);
  if (match?.[1] === undefined) throw new Error("project key is invalid");
  return match[1];
}

class SqliteLifecycleStateAdapter implements LifecycleStateStore {
  readonly #handles = new Map<string, OpenScopeDatabase>();
  #closed = false;

  constructor(
    private readonly paths: LifecycleStatePathPlan,
    private readonly sha256: Sha256,
  ) {}

  async open(scopeInput: ScopeContext, signal: AbortSignal): Promise<OpenScopeDatabase> {
    if (this.#closed) throw new LifecycleStateAdapterError("STATE_ADAPTER_FAILED", "lifecycle state adapter is closed");
    const scope = createScopeContext(ScopeContextSchema.parse(scopeInput), this.sha256);
    const path = this.paths.stateDatabase(toScopeReference(scope));
    const existing = this.#handles.get(path);
    if (existing !== undefined) {
      assertFileIdentity(existing);
      if (!sameJson(existing.scope, scope)) throw new LifecycleStateAdapterError("STATE_CORRUPT", "lifecycle state scope alias detected");
      return existing;
    }
    const bound = await openIdentityBoundSqliteDatabase({
      root: this.paths.stateRoot,
      path,
      signal,
      initialize: (database) => {
        initializeSchema(database);
        initializeScope(database, scope, this.sha256);
      },
      validate: (database) => {
        validateSchema(database);
        const stored = scopeFromProtocol(database, this.sha256);
        if (!sameJson(stored, scope)) throw new LifecycleStateAdapterError("STATE_CORRUPT", "lifecycle state scope evidence does not match");
      },
    });
    const handle: OpenScopeDatabase = {
      database: bound.database,
      handle: bound,
      path,
      scope,
      closed: false,
    };
    this.#handles.set(path, handle);
    return handle;
  }

  async read(scope: ScopeContext, signal: AbortSignal): Promise<StateLoadResult> {
    signal.throwIfAborted();
    const handle = await this.open(scope, signal);
    for (let attempt = 0; ; attempt += 1) {
      assertFileIdentity(handle);
      try {
        handle.database.exec("BEGIN");
        signal.throwIfAborted();
        const snapshot = readSnapshot(handle.database, handle.scope, this.sha256);
        signal.throwIfAborted();
        handle.database.exec("COMMIT");
        return snapshot;
      } catch (error) {
        rollback(handle.database);
        if (signal.aborted) throw signal.reason;
        if (!isBusy(error) || attempt >= MAX_BUSY_RETRIES) throw error;
        await waitForBusy(signal, attempt);
      }
    }
  }

  async commit(mutation: VerifiedStateMutation, signal: AbortSignal): Promise<StateCommitResult> {
    signal.throwIfAborted();
    if (!isVerifiedStateMutation(mutation)) throw new TypeError("lifecycle state commit requires a verified mutation");
    const handle = await this.open(mutation.scope, signal);
    for (let attempt = 0; ; attempt += 1) {
      assertFileIdentity(handle);
      try {
        begin(handle.database);
        signal.throwIfAborted();
        const before = readSnapshot(handle.database, handle.scope, this.sha256);
        if (!before.ok) throw new LifecycleStateAdapterError("STATE_CORRUPT", "lifecycle state is corrupt");
        if (before.snapshot.generation !== mutation.expectedGeneration) {
          handle.database.exec("COMMIT");
          return {
            kind: "stale-generation",
            expected: mutation.expectedGeneration,
            actual: before.snapshot.generation,
          };
        }
        const next = GenerationSchema.parse(mutation.expectedGeneration + 1);
        let documents: Readonly<Record<string, unknown>>;
        if (handle.scope.kind === "user" && "config" in before.snapshot && mutation.scope.kind === "user" && !("project" in mutation.replace)) {
          documents = {
            hostConfig: withGeneration(mutation.replace.config ?? before.snapshot.config, next),
            installedUser: withGeneration(mutation.replace.installed ?? before.snapshot.installed, next),
            trust: withGeneration(mutation.replace.trust ?? before.snapshot.trust, next),
          };
        } else if (handle.scope.kind === "project" && "project" in before.snapshot && mutation.scope.kind === "project" && "project" in mutation.replace) {
          documents = { projectLocal: withGeneration(mutation.replace.project, next) };
        } else {
          throw new TypeError("lifecycle state mutation scope does not match its database");
        }
        writeGeneration(handle.database, handle.scope, next, documents, this.sha256, before.snapshot.generation);
        // Read and validate the exact expected+1 generation while the writer
        // still owns the transaction. A later writer can advance immediately
        // after COMMIT without changing the snapshot acknowledged here.
        const acknowledged = readSnapshot(handle.database, handle.scope, this.sha256);
        if (!acknowledged.ok || acknowledged.snapshot.generation !== next || acknowledged.snapshot.pointers.previousGeneration !== mutation.expectedGeneration) {
          throw new LifecycleStateAdapterError("STATE_CORRUPT", "written lifecycle generation could not be acknowledged");
        }
        signal.throwIfAborted();
        handle.database.exec("COMMIT");
        return { kind: "committed", snapshot: acknowledged.snapshot };
      } catch (error) {
        rollback(handle.database);
        if (signal.aborted) throw signal.reason;
        if (!isBusy(error) || attempt >= MAX_BUSY_RETRIES) throw error;
        await waitForBusy(signal, attempt);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const handle of [...this.#handles.values()].reverse()) {
      if (handle.closed) continue;
      handle.closed = true;
      handle.handle.close();
    }
    this.#handles.clear();
  }

  async discover(signal: AbortSignal): Promise<Awaited<ReturnType<LifecycleStateInventoryPort["discover"]>>> {
    signal.throwIfAborted();
    const scopes: ScopeContext[] = [];
    let complete = true;
    const names = await readdir(this.paths.stateRoot).catch(() => [] as string[]);
    for (const name of names.sort((left, right) => {
      if (left === "user.sqlite") return -1;
      if (right === "user.sqlite") return 1;
      return left.localeCompare(right);
    })) {
      signal.throwIfAborted();
      if (name !== "user.sqlite" && !/^project-[0-9a-f]{64}\.sqlite$/u.test(name)) continue;
      const path = `${this.paths.stateRoot}/${name}`;
      let temporary: DatabaseSync | undefined;
      try {
        const known = this.#handles.get(path);
        const database = known?.database ?? (temporary = new DatabaseSync(path, { readOnly: true, allowExtension: false, defensive: true }));
        const scope = scopeFromProtocol(database, this.sha256);
        if (name === "user.sqlite" ? scope.kind !== "user" : scope.kind !== "project" || basename(name) !== `project-${projectDigest(scope.projectKey)}.sqlite`) {
          throw new Error("scope filename mismatch");
        }
        database.exec("BEGIN");
        let loaded: StateLoadResult;
        try {
          loaded = readSnapshot(database, scope, this.sha256);
          database.exec("COMMIT");
        } catch (error) {
          rollback(database);
          throw error;
        }
        if (!loaded.ok) throw new Error("scope is corrupt");
        scopes.push(scope);
      } catch {
        complete = false;
      } finally {
        temporary?.close();
      }
    }
    return Object.freeze({ scopes: Object.freeze(scopes), complete });
  }
}

export type NodeLifecycleStateAdapters = Readonly<{
  state: LifecycleStateStore;
  inventory: LifecycleStateInventoryPort;
  close(): Promise<void>;
}>;

export async function createNodeLifecycleStateAdapters(input: Readonly<{
  paths: LifecycleStatePathPlan;
  currentProject: Extract<ScopeContext, { kind: "project" }>;
  sha256: Sha256;
  verifyLocalFilesystem?: (root: string) => Promise<void>;
}>): Promise<NodeLifecycleStateAdapters> {
  if (input === null || typeof input !== "object" || typeof input.sha256 !== "function") {
    throw new TypeError("Node lifecycle state adapter options are required");
  }
  const stateRoot = await ensurePrivateLockRoot(input.paths.stateRoot);
  await (input.verifyLocalFilesystem ?? verifyLocalFilesystemCapability)(stateRoot);
  const project = createScopeContext(input.currentProject, input.sha256);
  if (project.kind !== "project") throw new TypeError("current project scope is required");
  const adapter = new SqliteLifecycleStateAdapter(input.paths, input.sha256);
  try {
    const signal = new AbortController().signal;
    // Opening/creating both current scope databases is an adapter check, not a
    // requirement that every persisted scope be healthy. A decoded corruption
    // is authoritative read evidence: keep the adapter available so startup can
    // degrade that scope, expose diagnosis, and preserve healthy siblings
    // without rewriting quarantined bytes.
    await adapter.read({ kind: "user" }, signal);
    await adapter.read(project, signal);
  } catch (error) {
    await adapter.close();
    throw error;
  }
  return Object.freeze({
    state: adapter,
    inventory: { discover: (signal) => adapter.discover(signal) },
    close: () => adapter.close(),
  });
}
