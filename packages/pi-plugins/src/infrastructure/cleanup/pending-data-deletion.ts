import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../../domain/canonical-json.js";
import { EpochMillisecondsSchema, type EpochMilliseconds } from "../../application/ports/lifecycle-clock.js";
import { PendingDeleteMarkerSchema, PENDING_DELETE_GRACE_MS, type PendingDeleteMarker, type PendingDeleteMarkerStore, type PendingDeleteReplayResult, type PluginKey, type ScopeReference, type PluginDataRef } from "../../application/ports/pending-data-deletion.js";
import type { PersistentDataRemovalPort } from "../../application/ports/persistent-data-removal.js";

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

/**
 * Replay pending deletion work. A marker for an absent plugin is immediate;
 * a marker for an installed plugin is only residue after the 60-minute
 * kill-window age gate and is discarded only then.
 */
export async function replayPendingDeleteMarkers(input: Readonly<{
  markers: PendingDeleteMarkerStore;
  isInstalled(scope: ScopeReference, plugin: PluginKey, signal: AbortSignal): Promise<boolean>;
  data: PersistentDataRemovalPort;
  now?: EpochMilliseconds;
  signal: AbortSignal;
}>): Promise<readonly PendingDeleteReplayResult[]> {
  if (input === null || typeof input !== "object" || input.markers === undefined || typeof input.isInstalled !== "function" || input.data === undefined) {
    throw new TypeError("pending-delete replay dependencies are required");
  }
  const signal = input.signal;
  signal.throwIfAborted();
  const now = EpochMillisecondsSchema.parse(input.now ?? Date.now());
  const results: PendingDeleteReplayResult[] = [];
  for (const marker of await input.markers.list(signal)) {
    signal.throwIfAborted();
    const installed = await input.isInstalled(marker.scope, marker.plugin, signal);
    if (installed) {
      if (now - marker.requestedAt < PENDING_DELETE_GRACE_MS) {
        results.push({ marker, outcome: "retained" });
        continue;
      }
      await input.markers.remove(marker);
      results.push({ marker, outcome: "discarded-installed" });
      continue;
    }
    try {
      await input.data.remove({
        scope: marker.scope,
        plugin: marker.plugin,
        dataRef: marker.dataRef,
        confirmation: "delete-confirmed",
        capability: {},
      }, signal);
      await input.markers.remove(marker);
      results.push({ marker, outcome: "deleted" });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      results.push({ marker, outcome: "retained" });
    }
  }
  return Object.freeze(results);
}

export { PendingDeleteMarkerSchema, PENDING_DELETE_GRACE_MS } from "../../application/ports/pending-data-deletion.js";
export type { PendingDeleteMarker, PendingDeleteMarkerStore, PendingDeleteReplayResult, PluginDataRef, ScopeReference, PluginKey } from "../../application/ports/pending-data-deletion.js";
