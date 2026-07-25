import { createHash } from "node:crypto";
import { createContentStoreLayout } from "../filesystem/content-store-layout.js";
import { createLocalRecoveryFilesystem } from "./local-recovery-filesystem.js";
import { createSqliteTransitionJournal } from "./sqlite-transition-journal.js";
import { createSqliteRevisionRetention } from "./sqlite-revision-retention.js";
import { createProcessRevisionLeaseStore } from "./process-revision-leases.js";
import { createRevisionArtifactStore } from "./revision-artifact-store.js";
import type { ScopeReference } from "../../domain/state/scope.js";
import type { LifecycleTransitionStore } from "../../application/ports/lifecycle-transition-store.js";
import type { RevisionRetentionStore } from "../../application/ports/revision-retention-store.js";
import type { RevisionLeaseStore } from "../../application/ports/revision-lease-store.js";
import type { RevisionArtifactStore } from "../../application/ports/revision-artifact-store.js";
import type { LifecycleRecoveryService, LifecycleRecoveryServiceDependencies } from "../../application/recovery-service.js";
import { createLifecycleRecoveryService } from "../../application/recovery-service.js";
import { createRevisionCollectionService, type RevisionCollectionDependencies } from "../../application/revision-collection-service.js";

const nodeSha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());

export type NodeRecoveryAdapterOptions = Readonly<{
  hostRoot: string;
  verifyLocalFilesystem?: (root: string) => Promise<void>;
}>;

export type NodeRecoveryAdapters = Readonly<{
  transitions(scope: ScopeReference): LifecycleTransitionStore;
  transitionStore: LifecycleTransitionStore;
  leases: RevisionLeaseStore;
  retention: RevisionRetentionStore;
  artifacts: RevisionArtifactStore;
  createRecoveryService(dependencies: Omit<LifecycleRecoveryServiceDependencies, "transitions">): LifecycleRecoveryService;
  createCollectionService(dependencies: Omit<RevisionCollectionDependencies, "transitions" | "leases" | "retention" | "artifacts" | "sha256">): ReturnType<typeof createRevisionCollectionService>;
  close(): Promise<void>;
}>;

/** Composition root: adapter details remain private while application policy stays injectable. */
export async function createNodeRecoveryAdapters(options: NodeRecoveryAdapterOptions): Promise<NodeRecoveryAdapters> {
  if (options === null || typeof options !== "object" || typeof options.hostRoot !== "string") throw new TypeError("Node recovery adapters require a host root");
  const filesystem = await createLocalRecoveryFilesystem(options);
  const layout = await createContentStoreLayout(options.hostRoot);
  const journals = new Map<string, LifecycleTransitionStore>();
  const transitions = (scope: ScopeReference): LifecycleTransitionStore => {
    const key = JSON.stringify(scope);
    const existing = journals.get(key);
    if (existing !== undefined) return existing;
    const created = createSqliteTransitionJournal({ filesystem });
    journals.set(key, created);
    return created;
  };
  const prepare: LifecycleTransitionStore["prepare"] = (request, signal) => {
    const record = "record" in request ? request.record : request;
    return transitions(record.scope).prepare(request, signal);
  };
  const settle: LifecycleTransitionStore["settle"] = (request, signal) => {
    if (request.scope === undefined) throw new TypeError("transition settlement requires explicit scope");
    return transitions(request.scope).settle(request, signal);
  };
  const read: NonNullable<LifecycleTransitionStore["read"]> = (request, signal) => transitions(request.scope).read!(request, signal);
  const list: NonNullable<LifecycleTransitionStore["list"]> = (scope, signal) => transitions(scope).list!(scope, signal);
  const markRecoveryRequired: NonNullable<LifecycleTransitionStore["markRecoveryRequired"]> = (request, signal) => transitions(request.scope).markRecoveryRequired!(request, signal);
  const markCollectionComplete: NonNullable<LifecycleTransitionStore["markCollectionComplete"]> = (request, signal) => transitions(request.scope).markCollectionComplete!(request, signal);
  const markCleanup: NonNullable<LifecycleTransitionStore["markCleanup"]> = (request, signal) => transitions(request.scope).markCleanup!(request, signal);
  const ownerStatus: NonNullable<LifecycleTransitionStore["ownerStatus"]> = (scope, reference, signal) => transitions(scope).ownerStatus!(scope, reference, signal);
  const pruneTerminal: NonNullable<LifecycleTransitionStore["pruneTerminal"]> = async (request, signal) => {
    let pruned = 0;
    for (const journal of journals.values()) pruned += await journal.pruneTerminal!(request, signal);
    return pruned;
  };
  const transitionStore: LifecycleTransitionStore = Object.freeze({ prepare, settle, read, list, markRecoveryRequired, markCleanup, markCollectionComplete, ownerStatus, pruneTerminal });
  const [leases, retention] = await Promise.all([
    createProcessRevisionLeaseStore(options),
    createSqliteRevisionRetention(options),
  ]);
  const artifacts = createRevisionArtifactStore(layout, nodeSha256);
  return Object.freeze({
    transitions,
    transitionStore,
    leases,
    retention,
    artifacts,
    createRecoveryService: (dependencies) => createLifecycleRecoveryService({ ...dependencies, transitions }),
    createCollectionService: (dependencies) => createRevisionCollectionService({ ...dependencies, transitions, leases, retention, artifacts, sha256: nodeSha256 }),
    async close(): Promise<void> {
      const errors: unknown[] = [];
      try { await leases.close(); } catch (error) { errors.push(error); }
      try { await retention.close(); } catch (error) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, "recovery adapter cleanup failed");
    },
  });
}
