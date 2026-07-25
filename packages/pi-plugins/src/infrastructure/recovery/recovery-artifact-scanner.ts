import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContentStoreLayout, RootCapability } from "../filesystem/content-store-layout.js";
import { assertLayoutRoot } from "../filesystem/content-store-layout.js";
import { removePreparedTree, type PreparedTreeIdentity } from "../filesystem/prepared-tree-cleanup.js";
import { classifyProcessIdentity } from "../process/process-identity.js";
import type { RecoveryArtifactCandidate, RecoveryArtifactScan, RecoveryArtifactsPort } from "../../application/ports/recovery-artifacts.js";

 type Sidecar = Readonly<{ protocol: "pi-plugin-host-staging-owner"; version: 1; pid: number; startToken: string; nonce: string; createdAt: number }>;
 type RecordValue = Readonly<{ candidate: RecoveryArtifactCandidate; root: string; identity: PreparedTreeIdentity; parent: RootCapability; sidecar: Sidecar }>;

function parseSidecar(input: unknown): Sidecar {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("owner sidecar is invalid");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 6 || value.protocol !== "pi-plugin-host-staging-owner" || value.version !== 1 || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.startToken !== "string" || !/^\d+$/.test(value.startToken) || typeof value.nonce !== "string" || !/^[0-9a-f]{32}$/.test(value.nonce) || typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw new Error("owner sidecar is invalid");
  return value as Sidecar;
}

export function createRecoveryArtifactScanner(layout: ContentStoreLayout): RecoveryArtifactsPort {
  const capabilities = new WeakMap<object, RecordValue>();

  async function scanRoot(root: string, parent: RootCapability, kind: "staging" | "projection-staging"): Promise<RecoveryArtifactCandidate[]> {
    await assertLayoutRoot(layout, kind === "staging" ? "stagingRoot" : "projectionStagingRoot", "scanRecoveryArtifacts");
    const result: RecoveryArtifactCandidate[] = [];
    let names: string[];
    try { names = await readdir(root); } catch { return result; }
    for (const name of names.sort()) {
      if (!/^[0-9a-f]{32}$/.test(name)) continue;
      const path = join(root, name);
      const sidecarPath = `${path}.owner`;
      try {
        const stat = await lstat(path);
        const sidecar = parseSidecar(JSON.parse(await readFile(sidecarPath, "utf8")));
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        const status = classifyProcessIdentity({ pid: sidecar.pid, startToken: sidecar.startToken });
        const capability = Object.freeze({});
        const candidate = Object.freeze({ kind, key: name, owner: status, createdAt: sidecar.createdAt, capability });
        capabilities.set(capability, { candidate, root: path, identity: { dev: stat.dev, ino: stat.ino }, parent, sidecar });
        result.push(candidate);
      } catch {
        // Missing or malformed ownership evidence is intentionally invisible to
        // deletion; the caller's complete scan still reports it as incomplete.
      }
    }
    return result;
  }

  async function scan(signal: AbortSignal): Promise<RecoveryArtifactScan> {
    if (signal.aborted) throw signal.reason;
    const candidates = [
      ...await scanRoot(layout.stagingRoot, layout.rootCapabilities.stagingRoot, "staging"),
      ...await scanRoot(layout.projectionStagingRoot, layout.rootCapabilities.projectionStagingRoot, "projection-staging"),
    ].sort((left, right) => left.kind.localeCompare(right.kind) || left.key.localeCompare(right.key));
    return { complete: true, candidates };
  }

  async function remove(candidate: RecoveryArtifactCandidate, signal: AbortSignal): Promise<"removed" | "already-absent"> {
    if (signal.aborted) throw signal.reason;
    const record = candidate !== null && typeof candidate === "object" ? capabilities.get(candidate.capability) : undefined;
    if (record === undefined || record.candidate !== candidate) throw new Error("recovery artifact capability is not owned by this scanner");
    if (candidate.owner !== "dead") throw new Error("recovery artifact owner is not proven dead");
    const current = await lstat(record.root).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
    if (current === undefined) return "already-absent";
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== record.identity.dev || current.ino !== record.identity.ino) throw new Error("recovery artifact identity changed");
    const sidecar = parseSidecar(JSON.parse(await readFile(`${record.root}.owner`, "utf8")));
    if (sidecar.pid !== record.sidecar.pid || sidecar.startToken !== record.sidecar.startToken || sidecar.nonce !== record.sidecar.nonce || classifyProcessIdentity({ pid: sidecar.pid, startToken: sidecar.startToken }) !== "dead") throw new Error("recovery artifact ownership changed");
    await assertLayoutRoot(layout, record.candidate.kind === "staging" ? "stagingRoot" : "projectionStagingRoot", "removeRecoveryArtifact");
    const result = await removePreparedTree(record.root, record.identity, record.parent);
    await import("node:fs/promises").then(({ unlink }) => unlink(`${record.root}.owner`).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }));
    return result;
  }
  return Object.freeze({ scan, remove });
}
