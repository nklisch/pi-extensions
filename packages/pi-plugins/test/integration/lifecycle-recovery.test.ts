import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createNodeRecoveryAdapters } from "../../src/infrastructure/recovery/create-node-recovery-adapters.js";
import { createLifecycleTransitionReconciler } from "../../src/application/lifecycle-transition-reconciler.js";
import { createInactiveProjectionExpectation } from "../../src/application/ports/runtime-projection.js";
import { createLifecycleTransitionRecord } from "../../src/application/ports/lifecycle-transition-store.js";
import { deriveLifecyclePendingTransitionRef } from "../../src/application/plugin-lifecycle-contract.js";
import { createInstalledPluginRecord, createInstalledRevisionRecord, createMarketplaceSnapshotRecord } from "../../src/domain/state/installed-state.js";
import {
  createProjectLocalStateDocument,
} from "../../src/domain/state/project-state.js";
import { createScopeContext, deriveProjectKey, toScopeReference } from "../../src/domain/state/scope.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { createResolvedMarketplaceSource } from "../../src/domain/source.js";
import { createNativeInstalledHarness } from "../helpers/native-installed-inspection.js";
import { evaluateCompatibility } from "../../src/domain/compatibility-evaluator.js";
import { capabilities } from "../fixtures/compatibility/common.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

describe("node lifecycle recovery composition", () => {
  it("composes isolated per-scope journals and private retention/lease adapters", async () => {
    const root = await mkdtemp(join(process.cwd(), ".test-lifecycle-recovery-"));
    try {
      const adapters = await createNodeRecoveryAdapters({ hostRoot: root, verifyLocalFilesystem: async () => {} });
      expect(adapters.transitions({ kind: "user" })).toBe(adapters.transitions({ kind: "user" }));
      expect(adapters.transitions({ kind: "user" })).not.toBe(adapters.transitions({ kind: "project", projectKey: `project-v1:sha256:${"a".repeat(64)}` as never }));
      expect((await adapters.artifacts.scan(new AbortController().signal)).complete).toBe(true);
      expect((await adapters.leases.list(new AbortController().signal)).complete).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("recovers a project transition without changing lifecycle, intent, policy, or registration evidence", async () => {
    const root = await mkdtemp(join(process.cwd(), ".test-lifecycle-recovery-project-"));
    try {
      const identity = { kind: "path-only" as const, canonicalRoot: "file:///recovery-project/" as never, limitation: "identity-changes-with-canonical-root" as const };
      const scope = createScopeContext({ kind: "project", identity, projectKey: deriveProjectKey(identity, sha256) }, sha256);
      if (scope.kind !== "project") throw new Error("project scope fixture failed");
      const scopeRef = toScopeReference(scope);
      const harness = createNativeInstalledHarness({ enabled: false });
      const compatibility = evaluateCompatibility({ plugin: harness.plugin, capabilities: capabilities() });
      const pluginContent = createContentManifest([], sha256);
      const revision = createInstalledRevisionRecord({ plugin: harness.plugin, compatibility, content: pluginContent, scope: scopeRef }, sha256);
      const previous = createInstalledPluginRecord({ plugin: harness.plugin.identity.key, activation: "disabled", selectedRevision: revision.revision, revisions: [revision], scope: scopeRef }, sha256);
      const candidate = createInstalledPluginRecord({ plugin: harness.plugin.identity.key, activation: "enabled", selectedRevision: revision.revision, revisions: [revision], scope: scopeRef }, sha256);
      const reference = deriveLifecyclePendingTransitionRef({ operationId: "00000000-0000-4000-8000-000000000001", scope: scopeRef, plugin: previous.plugin, startingGeneration: 0 }, sha256);
      const pending = createInstalledPluginRecord({ ...candidate, pendingTransition: reference, scope: scopeRef }, sha256);
      const content = createContentManifest([], sha256);
      const nativeSource = createResolvedMarketplaceSource({ declared: { kind: "github", repository: "owner/compatibility" }, revision: "a".repeat(40) }, sha256);
      const adoptedSource = createResolvedMarketplaceSource({ declared: { kind: "github", repository: "owner/adopted" }, revision: "b".repeat(40) }, sha256);
      const marketplaces = [
        createMarketplaceSnapshotRecord({ marketplace: "compatibility", source: nativeSource, content }, sha256),
        createMarketplaceSnapshotRecord({ marketplace: "adopted", source: adoptedSource, content }, sha256),
      ];
      const declarationDigest = `sha256:${"d".repeat(64)}` as never;
      const project = createProjectLocalStateDocument({
        schemaVersion: 4,
        generation: 0,
        projectKey: scope.projectKey,
        identity: scope.identity,
        declarationDigest,
        scope: { application: "automatic" },
        marketplaces,
        plugins: [pending],
        marketplaceUpdates: [
          { marketplace: "compatibility", source: nativeSource.declared, origin: { kind: "native" }, applicationOverride: "automatic" },
          { marketplace: "adopted", source: adoptedSource.declared, origin: { kind: "adoption", candidateId: `adoption-v1:sha256:${"e".repeat(64)}`, documents: [{ host: "claude", document: "claude-known-marketplaces" }] } },
        ],
      }, scope, sha256);
      let snapshot: any = { scope, generation: 0, project, pointers: {}, corruptions: [] };
      const state = { async read() { return { ok: true as const, snapshot }; }, async commit() { throw new Error("coordinator owns commit"); } };
      const mutations = {
        async runPreparedMutation(request: any, callback: any) {
          if (request.expectedGeneration !== snapshot.generation) return { kind: "stale-generation" as const, expected: request.expectedGeneration, actual: snapshot.generation };
          const prepared = await callback({ snapshot, assertOwned: async () => undefined });
          const generation = snapshot.generation + 1;
          snapshot = { ...snapshot, generation, project: { ...prepared.mutation.replace.project, generation } };
          return { kind: "committed" as const, value: prepared.value, snapshot };
        },
      };
      const previousProjection = createInactiveProjectionExpectation({ scope: scopeRef, plugin: previous.plugin, sha256 });
      const record = createLifecycleTransitionRecord({
        operationId: "00000000-0000-4000-8000-000000000001",
        operation: "enable",
        origin: "manual",
        scope: scopeRef,
        plugin: previous.plugin,
        startingGeneration: 0,
        previous,
        candidate,
        final: candidate,
        previousProjection,
        candidateProjection: previousProjection,
        retainedData: "keep",
        reference,
        sha256,
      });
      const writer = await createNodeRecoveryAdapters({ hostRoot: root, verifyLocalFilesystem: async () => {} });
      expect(await writer.transitionStore.prepare(record, new AbortController().signal)).toBe("stored");
      await writer.transitionStore.markRecoveryRequired?.({ scope: scopeRef, reference, generation: 0, at: Date.now() }, new AbortController().signal);
      await writer.close();

      const adapters = await createNodeRecoveryAdapters({ hostRoot: root, verifyLocalFilesystem: async () => {} });
      const currentProject = { identity: scope.identity, projectKey: scope.projectKey, trust: { kind: "trusted" as const } };
      const reload = {
        async reload() { throw new Error("startup recovery must not call Pi reload"); },
        async observe() { throw new Error("candidate observation is intentionally unavailable"); },
        async reconcileLocal() { return { kind: "inactive" as const, scope: scopeRef, plugin: previous.plugin, projectionDigest: previousProjection.digest, currentProject }; },
      };
      const reconciler = createLifecycleTransitionReconciler({ state: state as any, mutations: mutations as any, reload: reload as any, transitions: adapters.transitionStore, sha256 });
      const recovery = adapters.createRecoveryService({ state: state as any, reconciler, reload: reload as any });
      expect(project.marketplaceUpdates[0]).toMatchObject({ origin: { kind: "native" }, applicationOverride: "automatic" });
      const retained = JSON.stringify({
        declarationDigest: project.declarationDigest,
        scope: project.scope,
        marketplaceUpdates: project.marketplaceUpdates,
      });
      const result = await recovery.recover({ requiredScopes: [scope] }, new AbortController().signal);
      expect(result.results).toContainEqual(expect.objectContaining({ kind: "rolled-back", plugin: previous.plugin }));
      expect(snapshot.project.schemaVersion).toBe(4);
      expect(snapshot.project.plugins[0]?.activation).toBe("disabled");
      expect(snapshot.project.plugins[0]).not.toHaveProperty("pendingTransition");
      expect(JSON.stringify({
        declarationDigest: snapshot.project.declarationDigest,
        scope: snapshot.project.scope,
        marketplaceUpdates: snapshot.project.marketplaceUpdates,
      })).toBe(retained);
      await adapters.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
