import { chmodSync, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  PluginConfigurationReadResultSchema,
  PluginConfigurationRemoveResultSchema,
  PluginConfigurationReplaceResultSchema,
  type PluginConfigurationStore,
} from "../../application/ports/plugin-configuration-store.js";
import { PluginConfigurationDocumentSchemaV1 } from "../../domain/configured-values.js";
import { ContentDigestSchema } from "../../domain/content-manifest.js";
import { PluginConfigurationRefSchema } from "../../domain/state/references.js";
import {
  ensurePrivateLockRoot,
  LOCAL_LOCK_DATABASE_MODE,
  verifyLocalFilesystemCapability,
} from "../state/local-lock-filesystem.js";

const PROTOCOL = "pi-plugin-host-configuration";
const VERSION = 1;

export class PluginConfigurationAdapterError extends Error {
  readonly code = "CONFIGURATION_ADAPTER_FAILED" as const;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PluginConfigurationAdapterError";
  }

  toJSON(): Readonly<{ code: string; message: string }> {
    return Object.freeze({ code: this.code, message: this.message });
  }
}

function initialize(database: DatabaseSync): void {
  // The journal pragma itself can contend with another process performing the
  // same first-open initialization, so install the wait policy before it.
  database.exec(`
    PRAGMA busy_timeout = 30000;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS protocol (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      protocol TEXT NOT NULL,
      version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS configurations (
      configuration_ref TEXT PRIMARY KEY,
      revision TEXT NOT NULL,
      document TEXT NOT NULL
    ) STRICT;
  `);
  database.prepare("INSERT OR IGNORE INTO protocol(singleton, protocol, version) VALUES (1, ?, ?)")
    .run(PROTOCOL, VERSION);
  const row = database.prepare("SELECT protocol, version FROM protocol WHERE singleton = 1")
    .get() as { protocol: string; version: number } | undefined;
  if (row?.protocol !== PROTOCOL || row.version !== VERSION) {
    throw new PluginConfigurationAdapterError("configuration database protocol is invalid");
  }
}

export async function createSqlitePluginConfigurationStore(input: Readonly<{
  root: string;
  verifyLocalFilesystem?: (root: string) => Promise<void>;
}>): Promise<PluginConfigurationStore & AsyncDisposable> {
  if (input === null || typeof input !== "object") throw new TypeError("configuration store options are required");
  const root = await ensurePrivateLockRoot(input.root);
  await (input.verifyLocalFilesystem ?? verifyLocalFilesystemCapability)(root);
  const path = join(root, "configuration.sqlite");
  const database = new DatabaseSync(path, { allowExtension: false, defensive: true });
  let closed = false;
  try {
    chmodSync(path, LOCAL_LOCK_DATABASE_MODE);
    initialize(database);
  } catch (error) {
    database.close();
    throw error;
  }
  const stats = lstatSync(path);
  const identity = { dev: stats.dev, ino: stats.ino };

  function verify(): void {
    if (closed) throw new PluginConfigurationAdapterError("configuration store is closed");
    const current = lstatSync(path);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new PluginConfigurationAdapterError("configuration database identity changed");
    }
  }

  function transaction<T>(use: () => T): T {
    verify();
    database.exec("BEGIN IMMEDIATE");
    try {
      const value = use();
      database.exec("COMMIT");
      return value;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch { /* preserve operation failure */ }
      throw error;
    }
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    database.close();
  }

  const store: PluginConfigurationStore & AsyncDisposable = {
    async read(refInput, signal) {
      signal.throwIfAborted();
      verify();
      const ref = PluginConfigurationRefSchema.parse(refInput);
      const row = database.prepare("SELECT document FROM configurations WHERE configuration_ref = ?")
        .get(ref) as { document: string } | undefined;
      if (row === undefined) return PluginConfigurationReadResultSchema.parse({ kind: "missing" });
      try {
        return PluginConfigurationReadResultSchema.parse({
          kind: "found",
          document: PluginConfigurationDocumentSchemaV1.parse(JSON.parse(row.document)),
        });
      } catch (cause) {
        throw new PluginConfigurationAdapterError("configuration document is corrupt", cause);
      }
    },

    async replace(request, signal) {
      signal.throwIfAborted();
      const document = PluginConfigurationDocumentSchemaV1.parse(request.document);
      const expected = request.expectedRevision === null ? null : ContentDigestSchema.parse(request.expectedRevision);
      return transaction(() => {
        signal.throwIfAborted();
        const current = database.prepare("SELECT revision FROM configurations WHERE configuration_ref = ?")
          .get(document.configurationRef) as { revision: string } | undefined;
        const actual = current === undefined ? null : ContentDigestSchema.parse(current.revision);
        if (actual !== expected) {
          return PluginConfigurationReplaceResultSchema.parse({ kind: "stale", actualRevision: actual });
        }
        const result = current === undefined
          ? database.prepare("INSERT INTO configurations(configuration_ref, revision, document) VALUES (?, ?, ?)")
              .run(document.configurationRef, document.revision, JSON.stringify(document))
          : database.prepare("UPDATE configurations SET revision = ?, document = ? WHERE configuration_ref = ? AND revision = ?")
              .run(document.revision, JSON.stringify(document), document.configurationRef, expected);
        if (result.changes !== 1) {
          const raced = database.prepare("SELECT revision FROM configurations WHERE configuration_ref = ?")
            .get(document.configurationRef) as { revision: string } | undefined;
          return PluginConfigurationReplaceResultSchema.parse({
            kind: "stale",
            actualRevision: raced === undefined ? null : ContentDigestSchema.parse(raced.revision),
          });
        }
        return PluginConfigurationReplaceResultSchema.parse({ kind: "stored" });
      });
    },

    async remove(request, signal) {
      signal.throwIfAborted();
      if (request.confirmedSecretDeletion !== true) throw new TypeError("configuration removal requires confirmed secret deletion");
      const ref = PluginConfigurationRefSchema.parse(request.ref);
      const expected = ContentDigestSchema.parse(request.expectedRevision);
      return transaction(() => {
        signal.throwIfAborted();
        const current = database.prepare("SELECT revision FROM configurations WHERE configuration_ref = ?")
          .get(ref) as { revision: string } | undefined;
        if (current === undefined) return PluginConfigurationRemoveResultSchema.parse("missing");
        if (current.revision !== expected) return PluginConfigurationRemoveResultSchema.parse("stale");
        const result = database.prepare("DELETE FROM configurations WHERE configuration_ref = ? AND revision = ?")
          .run(ref, expected);
        return PluginConfigurationRemoveResultSchema.parse(result.changes === 1 ? "removed" : "stale");
      });
    },

    [Symbol.asyncDispose]: close,
  };
  return Object.freeze(store);
}
