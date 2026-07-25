import { lstat, readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ContentStoreLayout, RootCapability } from "../filesystem/content-store-layout.js";
import { assertLayoutRoot } from "../filesystem/content-store-layout.js";
import { inspectPublishedRevision } from "../filesystem/immutable-content-store.js";
import { inspectPublishedProjection } from "../filesystem/runtime-root-store.js";
import { removePreparedTree, type PreparedTreeIdentity } from "../filesystem/prepared-tree-cleanup.js";
import { ContentStoreIdentitySchema, MarketplaceStoreKeySchema, PluginStoreKeySchema } from "../../domain/content-store.js";
import { ProjectionRootRefSchema } from "../../domain/state/references.js";
import type { RevisionArtifactCandidate, RevisionArtifactCollection, RevisionArtifactStore } from "../../application/ports/revision-artifact-store.js";

type RecordValue = Readonly<{
  candidate: RevisionArtifactCandidate;
  publication: string;
  publicationIdentity: PreparedTreeIdentity;
  payload: string;
  payloadIdentity: PreparedTreeIdentity;
  parent: RootCapability;
}>;

export function createRevisionArtifactStore(layout: ContentStoreLayout, sha256: (bytes: Uint8Array) => Uint8Array): RevisionArtifactStore {
  const owned = new WeakMap<object, RecordValue>();

  async function scanStore(root: string, parent: RootCapability, kind: "marketplace" | "plugin"): Promise<{ artifacts: RevisionArtifactCandidate[]; complete: boolean }> {
    await assertLayoutRoot(layout, kind === "plugin" ? "pluginStoreRoot" : "marketplaceStoreRoot", "scanRevisionArtifacts");
    const artifacts: RevisionArtifactCandidate[] = [];
    const names = (await readdir(root)).sort();
    const referencedPayloads = new Set<string>();
    let complete = true;
    for (const name of names) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      const publication = join(root, name);
      try {
        const publicationStat = await lstat(publication);
        if ((!publicationStat.isDirectory() && !publicationStat.isFile()) || publicationStat.isSymbolicLink()) { complete = false; continue; }
        const inspected = await inspectPublishedRevision(publication, sha256);
        const payloadStat = await lstat(inspected.root);
        if (!payloadStat.isDirectory() || payloadStat.isSymbolicLink()) { complete = false; continue; }
        const identity = ContentStoreIdentitySchema.parse(inspected.identity);
        if (identity.kind !== kind) { complete = false; continue; }
        const reference = kind === "plugin"
          ? identity.kind === "plugin" ? { kind: "plugin" as const, key: PluginStoreKeySchema.parse(identity.key) } : undefined
          : identity.kind === "marketplace" ? { kind: "marketplace" as const, key: MarketplaceStoreKeySchema.parse(identity.key) } : undefined;
        if (reference === undefined) { complete = false; continue; }
        if (inspected.root !== publication) referencedPayloads.add(basename(inspected.root));
        const capability = Object.freeze({});
        const candidate = Object.freeze({ kind, key: name, reference, capability });
        owned.set(capability, {
          candidate,
          publication,
          publicationIdentity: { dev: publicationStat.dev, ino: publicationStat.ino },
          payload: inspected.root,
          payloadIdentity: { dev: payloadStat.dev, ino: payloadStat.ino },
          parent,
        });
        artifacts.push(candidate);
      } catch { complete = false; }
    }
    for (const name of names) {
      if (name.startsWith(".payload-") && referencedPayloads.has(name)) continue;
      if (/^[0-9a-f]{64}$/.test(name)) continue;
      // Hidden, unreferenced payloads can be crash residue or an in-flight
      // publication. They are never exposed as revisions and conservatively
      // make this collection scan incomplete until recovery proves ownership.
      complete = false;
    }
    return { artifacts, complete };
  }

  async function scanProjections(): Promise<{ artifacts: RevisionArtifactCandidate[]; complete: boolean }> {
    await assertLayoutRoot(layout, "generatedRoot", "scanRevisionArtifacts");
    const artifacts: RevisionArtifactCandidate[] = [];
    const names = (await readdir(layout.generatedRoot)).sort();
    const referencedPayloads = new Set<string>();
    let complete = true;
    for (const name of names) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      const path = join(layout.generatedRoot, name);
      try {
        const publicationStat = await lstat(path);
        if ((!publicationStat.isDirectory() && !publicationStat.isFile()) || publicationStat.isSymbolicLink()) { complete = false; continue; }
        const inspected = await inspectPublishedProjection(path, sha256);
        const payloadStat = await lstat(inspected.root);
        if (!payloadStat.isDirectory() || payloadStat.isSymbolicLink()) { complete = false; continue; }
        const reference = { kind: "projection" as const, reference: ProjectionRootRefSchema.parse(inspected.metadata.projectionRef) };
        if (inspected.root !== path) referencedPayloads.add(basename(inspected.root));
        const capability = Object.freeze({});
        const candidate = Object.freeze({ kind: "projection" as const, key: name, reference, capability });
        owned.set(capability, {
          candidate,
          publication: path,
          publicationIdentity: { dev: publicationStat.dev, ino: publicationStat.ino },
          payload: inspected.root,
          payloadIdentity: { dev: payloadStat.dev, ino: payloadStat.ino },
          parent: layout.rootCapabilities.generatedRoot,
        });
        artifacts.push(candidate);
      } catch { complete = false; }
    }
    for (const name of names) {
      if (name === ".staging" || /^[0-9a-f]{64}$/.test(name) || name.startsWith(".payload-") && referencedPayloads.has(name)) continue;
      complete = false;
    }
    return { artifacts, complete };
  }

  async function scan(signal: AbortSignal): Promise<RevisionArtifactCollection> {
    if (signal.aborted) throw signal.reason;
    const marketplace = await scanStore(layout.marketplaceStoreRoot, layout.rootCapabilities.marketplaceStoreRoot, "marketplace");
    const plugin = await scanStore(layout.pluginStoreRoot, layout.rootCapabilities.pluginStoreRoot, "plugin");
    const projections = await scanProjections();
    return {
      complete: marketplace.complete && plugin.complete && projections.complete,
      artifacts: [...marketplace.artifacts, ...plugin.artifacts, ...projections.artifacts]
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key)),
    };
  }

  async function remove(candidate: RevisionArtifactCandidate, signal: AbortSignal): Promise<"removed" | "already-absent"> {
    if (signal.aborted) throw signal.reason;
    const record = owned.get(candidate.capability);
    if (record === undefined || record.candidate !== candidate) throw new Error("revision artifact capability is not owned");
    const current = await lstat(record.publication).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (current === undefined) return "already-absent";
    if (current.isSymbolicLink() || current.dev !== record.publicationIdentity.dev || current.ino !== record.publicationIdentity.ino) {
      throw new Error("revision artifact identity changed");
    }
    await assertLayoutRoot(layout, record.candidate.kind === "plugin" ? "pluginStoreRoot" : record.candidate.kind === "marketplace" ? "marketplaceStoreRoot" : "generatedRoot", "removeRevisionArtifact");
    if (record.candidate.kind === "projection") {
      const inspected = await inspectPublishedProjection(record.publication, sha256);
      if (inspected.root !== record.payload) throw new Error("revision artifact identity changed");
      const payloadStat = await lstat(record.payload);
      if (!payloadStat.isDirectory() || payloadStat.isSymbolicLink() || payloadStat.dev !== record.payloadIdentity.dev || payloadStat.ino !== record.payloadIdentity.ino) {
        throw new Error("revision artifact payload identity changed");
      }
      if (record.publication !== record.payload) await unlink(record.publication);
      return removePreparedTree(record.payload, record.payloadIdentity, record.parent);
    }
    const inspected = await inspectPublishedRevision(record.publication, sha256);
    if (record.candidate.reference.kind === "projection" || inspected.identity.key !== record.candidate.reference.key || inspected.root !== record.payload) {
      throw new Error("revision artifact identity changed");
    }
    const payloadStat = await lstat(record.payload);
    if (!payloadStat.isDirectory() || payloadStat.isSymbolicLink() || payloadStat.dev !== record.payloadIdentity.dev || payloadStat.ino !== record.payloadIdentity.ino) {
      throw new Error("revision artifact payload identity changed");
    }
    if (record.publication !== record.payload) await unlink(record.publication);
    return removePreparedTree(record.payload, record.payloadIdentity, record.parent);
  }

  return Object.freeze({ scan, remove });
}
