import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../../domain/canonical-json.js";
import { PendingDeleteMarkerSchema, type PendingDeleteMarker, type PendingDeleteMarkerStore, type PluginKey, type ScopeReference, type PluginDataRef } from "../../application/ports/pending-data-deletion.js";

function assertSignal(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function markerIdentity(marker: PendingDeleteMarker): Readonly<{ scope: ScopeReference; plugin: PluginKey }> {
  return { scope: marker.scope, plugin: marker.plugin };
}

/** The filename is opaque; marker contents remain the source of truth. */
export function pendingDeleteMarkerFilename(markerInput: PendingDeleteMarker): string {
  const marker = PendingDeleteMarkerSchema.parse(markerInput);
  const digest = createHash("sha256")
    .update(canonicalJson(markerIdentity(marker)), "utf8")
    .digest("hex");
  return `${digest}.json`;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

// A writer can legitimately keep a temp file around for a short interval. A
// crash can strand it forever, so the marker pass removes only older temps.
const PENDING_DELETE_TEMP_GRACE_MS = 5 * 60_000;

async function ensureRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const handle = await open(temporary, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function createPendingDeleteMarkerStore(options: Readonly<{ root: string }>): PendingDeleteMarkerStore {
  if (options === null || typeof options !== "object" || typeof options.root !== "string" || options.root.length === 0) {
    throw new TypeError("pending-delete marker root is required");
  }
  const root = options.root;

  async function create(markerInput: PendingDeleteMarker): Promise<void> {
    const marker = PendingDeleteMarkerSchema.parse(markerInput);
    await ensureRoot(root);
    await atomicWrite(join(root, pendingDeleteMarkerFilename(marker)), `${canonicalJson(marker)}\n`);
  }

  async function remove(markerInput: PendingDeleteMarker): Promise<void> {
    const marker = PendingDeleteMarkerSchema.parse(markerInput);
    try { await unlink(join(root, pendingDeleteMarkerFilename(marker))); }
    catch (error) { if (!isMissing(error)) throw error; }
  }

  async function list(signal?: AbortSignal): Promise<readonly PendingDeleteMarker[]> {
    assertSignal(signal);
    let names: string[];
    try { names = await readdir(root); }
    catch (error) { if (isMissing(error)) return Object.freeze([]); throw error; }
    const now = Date.now();
    for (const name of names) {
      assertSignal(signal);
      if (!name.endsWith(".tmp")) continue;
      try {
        const info = await stat(join(root, name));
        if (now - info.mtimeMs >= PENDING_DELETE_TEMP_GRACE_MS) await unlink(join(root, name));
      } catch {
        // An active writer or an already-removed temp is left alone; the next
        // marker pass can reassess it without hiding a real marker failure.
      }
    }
    const markers: PendingDeleteMarker[] = [];
    for (const name of names.sort()) {
      assertSignal(signal);
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = PendingDeleteMarkerSchema.parse(JSON.parse(await readFile(join(root, name), "utf8")));
        markers.push(parsed);
      } catch {
        // A malformed queue entry is retained for diagnosis; replay never
        // turns a work-queue byte into authority or silently deletes it.
      }
    }
    return Object.freeze(markers);
  }

  return Object.freeze({ root, path: (marker: PendingDeleteMarker) => join(root, pendingDeleteMarkerFilename(marker)), create, remove, list });
}

export { PendingDeleteMarkerSchema, PENDING_DELETE_GRACE_MS } from "../../application/ports/pending-data-deletion.js";
export type { PendingDeleteMarker, PendingDeleteMarkerStore, PluginDataRef, ScopeReference, PluginKey } from "../../application/ports/pending-data-deletion.js";
