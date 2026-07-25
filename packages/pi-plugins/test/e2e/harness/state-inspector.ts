import { cp, lstat, mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, relative } from "node:path";
import { E2E_CHECKOUT_ROOT, E2E_SECRET_CANARY } from "./constants.js";
import type { CleanE2ESandbox } from "./environment.js";
import type { PiRpcProcess } from "./pi-rpc.js";

export type FileInventoryEntry = Readonly<{ path: string; kind: "directory" | "file" | "symlink"; bytes?: number }>;

export async function fileInventory(root: string): Promise<readonly FileInventoryEntry[]> {
  const result: FileInventoryEntry[] = [];
  async function visit(path: string): Promise<void> {
    for (const name of (await readdir(path).catch(() => [])).sort()) {
      const child = join(path, name);
      const info = await lstat(child);
      const item = relative(root, child);
      if (info.isSymbolicLink()) result.push({ path: item, kind: "symlink" });
      else if (info.isDirectory()) { result.push({ path: item, kind: "directory" }); await visit(child); }
      else result.push({ path: item, kind: "file", bytes: info.size });
    }
  }
  await visit(root);
  return Object.freeze(result);
}

export async function sqliteFiles(root: string): Promise<readonly string[]> {
  return Object.freeze((await fileInventory(root)).filter((entry) => entry.kind === "file" && entry.path.endsWith(".sqlite")).map((entry) => join(root, entry.path)));
}

export function sqliteIntegrity(path: string): readonly string[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.freeze((database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>).map((row) => row.integrity_check));
  } finally { database.close(); }
}

export async function assertAllSqliteIntegrity(root: string): Promise<void> {
  for (const path of await sqliteFiles(root)) {
    const result = sqliteIntegrity(path);
    if (result.length !== 1 || result[0] !== "ok") throw new Error(`SQLite integrity failed for ${path}: ${JSON.stringify(result)}`);
  }
}

export async function mutateCurrentPointer(path: string, mutation: "digest" | "generation" | "document"): Promise<void> {
  const database = new DatabaseSync(path);
  try {
    const row = database.prepare("SELECT generation, pointer_json FROM current_pointer WHERE singleton = 1").get() as { generation: number; pointer_json: string } | undefined;
    if (row === undefined) throw new Error(`state database has no current pointer: ${path}`);
    if (mutation === "generation") database.prepare("UPDATE current_pointer SET generation = generation + 7 WHERE singleton = 1").run();
    else if (mutation === "document") database.prepare("UPDATE current_pointer SET pointer_json = ? WHERE singleton = 1").run("{malformed-json");
    else {
      const pointer = JSON.parse(row.pointer_json) as { documents?: Array<{ digest?: string }> };
      const document = pointer.documents?.[0];
      if (document === undefined || typeof document.digest !== "string") throw new Error("state pointer has no digest to mutate");
      document.digest = document.digest.endsWith("0") ? `${document.digest.slice(0, -1)}1` : `${document.digest.slice(0, -1)}0`;
      database.prepare("UPDATE current_pointer SET pointer_json = ? WHERE singleton = 1").run(JSON.stringify(pointer));
    }
  } finally { database.close(); }
}

export async function mutateStateBlob(path: string, mutation: "digest" | "kind" | "generation" | "document"): Promise<void> {
  const database = new DatabaseSync(path);
  try {
    const row = database.prepare("SELECT blob_ref, digest, kind, generation, document FROM state_blobs ORDER BY blob_ref LIMIT 1").get() as any;
    if (row === undefined) throw new Error(`state database has no blob: ${path}`);
    if (mutation === "digest") database.prepare("UPDATE state_blobs SET digest = ? WHERE blob_ref = ?").run(`sha256:${"0".repeat(64)}`, row.blob_ref);
    if (mutation === "kind") database.prepare("UPDATE state_blobs SET kind = 'futureState' WHERE blob_ref = ?").run(row.blob_ref);
    if (mutation === "generation") database.prepare("UPDATE state_blobs SET generation = generation + 1 WHERE blob_ref = ?").run(row.blob_ref);
    if (mutation === "document") database.prepare("UPDATE state_blobs SET document = '{malformed-json' WHERE blob_ref = ?").run(row.blob_ref);
  } finally { database.close(); }
}

export async function scanForbiddenValues(root: string, additional: readonly string[] = []): Promise<void> {
  const needles = [E2E_SECRET_CANARY, E2E_CHECKOUT_ROOT, ...additional].map((value) => Buffer.from(value));
  for (const entry of await fileInventory(root)) {
    if (entry.kind !== "file" || (entry.bytes ?? 0) > 4_000_000) continue;
    const bytes = await readFile(join(root, entry.path));
    for (const needle of needles) {
      if (bytes.includes(needle)) throw new Error(`forbidden value retained in ${entry.path}`);
    }
  }
}

export async function publicStateDigest(rpc: PiRpcProcess): Promise<string> {
  const [plugins, marketplaces, updates] = await Promise.all([
    rpc.plugin("--non-interactive list --scope all-current --limit 100", "inspection.list"),
    rpc.plugin("--non-interactive marketplace list --limit 100", "marketplace.list"),
    rpc.plugin("--non-interactive updates status --scope all-current", "updates.status"),
  ]);
  const volatile = new Set(["snapshotId", "detailId", "capturedAt", "checkedAt", "nextAt", "dueAt", "anchorAt", "updateDigest", "claim", "executionId"]);
  const stable = (value: any): any => Array.isArray(value)
    ? value.map(stable)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).filter(([key]) => !volatile.has(key)).map(([key, child]) => [key, stable(child)]))
      : value;
  const registrations = (marketplaces.envelope.data?.registrations ?? []).map((entry: any) => {
    const { refresh: _refresh, ...authority } = entry;
    return stable(authority);
  });
  // Snapshot ids, scheduler ownership, deadlines, and refresh observations are
  // live health, not mutation authority. Keep installed rows, registration
  // declarations, policy, and notice counts as the public digest.
  const publicState = {
    plugins: stable(plugins.envelope.data?.items ?? []),
    marketplaces: { registrations },
    updates: {
      policy: stable(updates.envelope.data?.policy),
      unreadCount: updates.envelope.data?.unreadCount,
      unresolvedCount: updates.envelope.data?.unresolvedCount,
    },
  };
  return createHash("sha256").update(JSON.stringify(publicState)).digest("hex");
}

export async function cloneOwnedTree(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
}

export async function assertNoConsumerCheckoutResolution(sandbox: CleanE2ESandbox): Promise<void> {
  for (const entry of await fileInventory(join(sandbox.consumer, "node_modules"))) {
    const path = join(sandbox.consumer, "node_modules", entry.path);
    if (entry.kind === "symlink") throw new Error(`consumer dependency symlink: ${entry.path}`);
    const canonical = await realpath(path);
    if (canonical === E2E_CHECKOUT_ROOT || canonical.startsWith(`${E2E_CHECKOUT_ROOT}/`)) throw new Error(`consumer dependency enters checkout: ${entry.path}`);
  }
}
