import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPluginLifecycleComposition, createPluginLifecycleService, type PluginLifecycleServiceDependencies } from "../../src/application/plugin-lifecycle-service.js";
import { deriveLifecycleTargetDigest } from "../../src/application/native-lifecycle-target.js";
import { projectSafeComponents } from "../../src/application/native-inspection-disclosure.js";
import { deriveTrustedInstallConsentDisclosureDigest } from "../../src/application/trusted-install-identifiers.js";
import { createPluginConfigurationDocument, digestConfigurationDescriptors } from "../../src/domain/configured-values.js";
import { digestCompatibilityReport } from "../../src/application/ports/runtime-projection.js";
import { prepareEnableCandidate } from "../../src/application/plugin-candidate-preparation.js";
import { createMaterializationBinding, createContentManifest } from "../../src/domain/content-manifest.js";
import { CompatibilityReportSchema } from "../../src/domain/compatibility.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { claim } from "../../src/domain/provenance.js";
import { createResolvedMarketplaceSource, createResolvedPluginSource } from "../../src/domain/source.js";
import {
  createInstalledUserStateDocument,
  createMarketplaceSnapshotRecord,
  createInstalledPluginRecord,
  createInstalledRevisionRecord,
} from "../../src/domain/state/installed-state.js";
import { HostConfigDocumentSchema, GenerationSchema, type Generation } from "../../src/domain/state/config-state.js";
import { StatePointersDocumentSchema } from "../../src/domain/state/pointers.js";
import { TrustStateDocumentSchema } from "../../src/domain/state/trust-state.js";
import { deriveStateBlobRef } from "../../src/domain/state/references.js";
import { grantTrust, createTrustCandidate } from "../../src/domain/trust-policy.js";
import { deriveMarketplaceSourceIdentity, derivePluginSourceIdentity } from "../../src/domain/update-policy.js";
import type { GenerationSnapshot } from "../../src/application/state-contract.js";
import type { LifecycleStateStore } from "../../src/application/ports/lifecycle-state-store.js";
import type { GenerationMutationCoordinator } from "../../src/application/generation-mutation-coordinator.js";
import type { RuntimeProjectionPort, ProjectionExpectation } from "../../src/application/ports/runtime-projection.js";
import { CurrentProjectRuntimeContextSchema } from "../../src/application/ports/project-trust.js";
import type { LifecycleReloadPort } from "../../src/application/ports/lifecycle-reload.js";
import type { LifecycleTransitionStore } from "../../src/application/ports/lifecycle-transition-store.js";
import { readClaudeMarketplace } from "../../src/formats/claude/marketplace-reader.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;
const currentProject = CurrentProjectRuntimeContextSchema.parse({
  identity: { kind: "path-only", canonicalRoot: "file:///workspace/", limitation: "identity-changes-with-canonical-root" },
  projectKey: `project-v1:sha256:${"1".repeat(64)}`,
  trust: { kind: "trusted" },
});
const projectRevision = "b".repeat(40);
const marketplaceSource = createResolvedMarketplaceSource({ declared: { kind: "github", repository: "example/community" }, revision: projectRevision }, sha256);
const entry = readClaudeMarketplace({ name: "community", plugins: [{ name: "fixture", source: "./plugin", strict: false }] }).marketplace.entries[0]!;
const pluginSourcePath = entry.source.value.kind === "marketplace-path" ? entry.source.value.path : "plugin";
const plugin = NormalizedPluginSchema.parse({
  identity: { key: "fixture@community", marketplaceName: "community", marketplaceEntryName: "fixture" },
  source: createResolvedPluginSource({ kind: "marketplace-path", marketplaceRevision: projectRevision, path: pluginSourcePath }, sha256),
  configuration: { options: [] },
  components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
  metadata: [],
});
const compatibility = CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
const otherPlugin = NormalizedPluginSchema.parse({
  ...plugin,
  identity: { ...plugin.identity, key: "other@community", marketplaceEntryName: "other" },
});
const otherCompatibility = CompatibilityReportSchema.parse({ ...compatibility, plugin: otherPlugin.identity });
const content = createContentManifest([], sha256);
const binding = createMaterializationBinding(plugin.source.hash, content.rootDigest, sha256);
const materialized = { root: "/virtual/plugin", source: plugin.source, content, binding };
const marketplace = createMarketplaceSnapshotRecord({ marketplace: "community", source: marketplaceSource, content }, sha256);
const revision = createInstalledRevisionRecord({ plugin, compatibility, content, scope: { kind: "user" } }, sha256);
const trustCandidate = createTrustCandidate({ scope: { kind: "user" }, marketplaceSource, plugin, compatibility, content, materializationBinding: binding }, sha256);
const trust = grantTrust(trustCandidate, sha256);

function pointers(generation: Generation) {
  return StatePointersDocumentSchema.parse({
    schemaVersion: 1,
    scope: { kind: "user" },
    generation,
    documents: ["hostConfig", "installedUser", "trust"].map((kind) => ({
      kind,
      generation,
      blob: deriveStateBlobRef({ document: kind, scope: "user", generation }, sha256),
      digest: `sha256:${"0".repeat(64)}`,
    })),
  });
}

function snapshot(generation: number, installed: ReturnType<typeof createInstalledUserStateDocument>["plugins"] = [], records = [trust]): Extract<GenerationSnapshot, { scope: { kind: "user" } }> {
  const value = GenerationSchema.parse(generation);
  return {
    scope: { kind: "user" },
    generation: value,
    pointers: pointers(value),
    config: HostConfigDocumentSchema.parse({ schemaVersion: 4, generation: value, records: [] }),
    installed: createInstalledUserStateDocument({ generation: value, marketplaces: [marketplace], plugins: installed }, sha256),
    trust: TrustStateDocumentSchema.parse({ schemaVersion: 1, generation: value, records }),
    corruptions: [],
  };
}

class MemoryState implements LifecycleStateStore {
  constructor(public current: Extract<GenerationSnapshot, { scope: { kind: "user" } }>) {}
  async read() { return { ok: true as const, snapshot: this.current }; }
  async commit() { throw new Error("the coordinator owns commits in this fixture"); }
}

function nextSnapshot(current: Extract<GenerationSnapshot, { scope: { kind: "user" } }>, mutation: { replace: { installed?: ReturnType<typeof createInstalledUserStateDocument> } }) {
  const generation = GenerationSchema.parse(current.generation + 1);
  const installed = mutation.replace.installed === undefined
    ? { ...current.installed, generation }
    : { ...mutation.replace.installed, generation };
  return {
    ...current,
    generation,
    pointers: pointers(generation),
    config: { ...current.config, generation },
    installed,
    trust: { ...current.trust, generation },
  };
}

function fakeCoordinator(state: MemoryState, ambiguousFirstCommit = false): GenerationMutationCoordinator {
  let commits = 0;
  return {
    async runPreparedMutation(request, callback) {
      if (request.expectedGeneration !== state.current.generation) return { kind: "stale-generation", expected: request.expectedGeneration, actual: state.current.generation };
      const prepared = await callback({ snapshot: state.current, assertOwned: async () => undefined });
      state.current = nextSnapshot(state.current, prepared.mutation as unknown as { replace: { installed?: ReturnType<typeof createInstalledUserStateDocument> } });
      commits += 1;
      if (ambiguousFirstCommit && commits === 1) {
        return { kind: "commit-ambiguous", value: prepared.value, expected: request.expectedGeneration, actual: state.current.generation };
      }
      return { kind: "committed", value: prepared.value, snapshot: state.current };
    },
  };
}

type LifecycleTestOptions = Readonly<{
  rejectReload?: boolean;
  ambiguousFirstCommit?: boolean;
  onReload?: (count: number, state: MemoryState) => void;
  onPromote?: () => void;
}>;

function dependencies(state: MemoryState, options: LifecycleTestOptions = {}): PluginLifecycleServiceDependencies {
  const expectations: ProjectionExpectation[] = [];
  let reloadCount = 0;
  const projections: RuntimeProjectionPort = {
    async prepare(value) { expectations.push(value); return value; },
  };
  const reload: LifecycleReloadPort = {
    async reload() {
      reloadCount += 1;
      options.onReload?.(reloadCount, state);
      if (options.rejectReload && reloadCount === 1) return { kind: "failed", code: "adapter-error" };
      return { kind: "accepted" };
    },
    async observe() {
      const current = state.current.installed.plugins.find((record) => record.plugin === plugin.identity.key);
      const expectation = current?.activation === "enabled"
        ? [...expectations].reverse().find((value) => value.kind === "active")
        : [...expectations].reverse().find((value) => value.kind === "inactive");
      if (expectation?.kind === "active") return { kind: "active", scope: expectation.projection.scope, plugin: expectation.projection.plugin, revision: expectation.projection.revision, projectionDigest: expectation.projection.digest, currentProject };
      return { kind: "inactive", scope: expectation?.kind === "inactive" ? expectation.scope : { kind: "user" }, plugin: plugin.identity.key, projectionDigest: expectation?.kind === "inactive" ? expectation.digest : `sha256:${"0".repeat(64)}`, currentProject };
    },
  };
  const transitions: LifecycleTransitionStore = {
    async prepare() { return "stored"; },
    async settle() { return undefined; },
  };
  const contentPort = {
    async allocateStaging() { return { slot: { root: "/virtual/stage" }, allocationId: "stage" }; },
    async discardStaging() { return undefined; },
    async promote(plan: any) {
      options.onPromote?.();
      return { kind: "promoted" as const, identity: plan.identity, root: "/virtual/store", manifest: plan.manifest };
    },
  };
  const base = {
    state,
    mutations: fakeCoordinator(state, options.ambiguousFirstCommit),
    content: contentPort,
    materializer: { async materialize() { return materialized; } },
    inspector: { async inspect() { return { ok: true as const, value: plugin, diagnostics: [] }; } },
    compatibility: { async assess() { return compatibility; } },
    installed: { async load() { return { plugin, compatibility, marketplaceSource, content, binding }; } },
    projections,
    reload,
    transitions,
    operationIds: { async create() { return "00000000-0000-4000-8000-000000000001"; } },
    projectTrust: { async assess() { return { kind: "trusted" as const }; } },
    projectRoots: { async acquire() { throw new Error("user scope must not acquire a project root"); }, verify() { throw new Error("user scope must not verify a project root"); } },
    configurations: { async read() { return { kind: "missing" as const }; }, async replace() { return { kind: "stored" as const }; }, async remove() { return "missing" as const; } },
    secrets: { async put() { return { kind: "collision" as const }; }, async get() { return { kind: "missing" as const }; }, async remove() { return "missing" as const; }, async removeOwned() { return "missing" as const; } },
    paths: { async normalizeAndInspect() { return { kind: "missing" as const }; } },
    sha256,
  } satisfies PluginLifecycleServiceDependencies;
  return base;
}

const installRequest = {
  scope: { kind: "user" as const },
  plugin: plugin.identity.key,
  entry,
  marketplaceSource,
  sourceContext: { kind: "marketplace" as const, root: "/virtual/marketplace", source: marketplaceSource, contentRootDigest: content.rootDigest, content, binding: createMaterializationBinding(marketplaceSource.hash, content.rootDigest, sha256) },
  configurationPathContext: { scope: { kind: "user" as const } },
};

const otherRecord = createInstalledPluginRecord({
  plugin: otherPlugin.identity.key,
  activation: "enabled",
  revisions: [{ plugin: otherPlugin, compatibility: otherCompatibility, content }],
}, sha256);

function advanceOtherPlugin(state: MemoryState): void {
  const current = state.current;
  const plugins = current.installed.plugins.map((record) => record.plugin === otherPlugin.identity.key
    ? createInstalledPluginRecord({ ...record, activation: "disabled" }, sha256)
    : record);
  state.current = nextSnapshot(current, {
    replace: {
      installed: createInstalledUserStateDocument({ ...current.installed, plugins }, sha256),
    },
  });
}

function changeTargetPlugin(state: MemoryState): void {
  const current = state.current;
  const plugins = current.installed.plugins.map((record) => record.plugin === plugin.identity.key
    ? createInstalledPluginRecord({ ...record, activation: record.activation === "enabled" ? "disabled" : "enabled" }, sha256)
    : record);
  state.current = nextSnapshot(current, {
    replace: {
      installed: createInstalledUserStateDocument({ ...current.installed, plugins }, sha256),
    },
  });
}

describe("plugin lifecycle service", () => {
  it("keeps idempotent missing and disabled operations deterministic", async () => {
    const missing = new MemoryState(snapshot(0, []));
    const service = createPluginLifecycleService(dependencies(missing));
    expect(await service.uninstall({ scope: { kind: "user" }, plugin: plugin.identity.key }, signal)).toMatchObject({ kind: "unchanged", operation: "uninstall" });
    expect(await service.disable({ scope: { kind: "user" }, plugin: plugin.identity.key }, signal)).toMatchObject({ kind: "rejected", code: "NOT_INSTALLED" });
  });

  it("enforces expected revision on initial install", async () => {
    const state = new MemoryState(snapshot(0, []));
    const service = createPluginLifecycleService(dependencies(state));
    const result = await service.install({ ...installRequest, expectedRevision: `sha256:${"9".repeat(64)}` }, signal);
    expect(result).toMatchObject({ kind: "rejected", operation: "install", code: "AVAILABLE_REVISION_CHANGED" });
    expect(state.current.installed.plugins).toHaveLength(0);
  });

  it("rejects a prepared install when the exact configuration revision changes before lifecycle resolution", async () => {
    const descriptorProvenance = entry.identity.provenance[0]!;
    const configuredPlugin = NormalizedPluginSchema.parse({
      ...plugin,
      configuration: {
        options: [{
          key: "NAME",
          label: claim("Name", descriptorProvenance),
          value: { kind: "string", default: "first" },
          required: true,
          sensitive: false,
          provenance: [descriptorProvenance],
        }],
      },
    });
    const configuredCompatibility = CompatibilityReportSchema.parse({ ...compatibility, plugin: configuredPlugin.identity });
    const configuredRevision = createInstalledRevisionRecord({
      plugin: configuredPlugin,
      compatibility: configuredCompatibility,
      content,
      scope: { kind: "user" },
      marketplaceSourceIdentity: deriveMarketplaceSourceIdentity(marketplaceSource.declared, sha256),
      pluginSourceIdentity: derivePluginSourceIdentity(entry.source.value, sha256),
    }, sha256);
    if (configuredRevision.configurationRef === undefined) throw new Error("configured revision requires a reference");
    const firstDocument = createPluginConfigurationDocument({
      schemaVersion: 1,
      configurationRef: configuredRevision.configurationRef,
      plugin: configuredPlugin.identity.key,
      scope: { kind: "user" },
      descriptorDigest: digestConfigurationDescriptors(configuredPlugin.configuration, sha256),
      values: [{ key: "NAME", value: { kind: "string", value: "first" } }],
      secrets: [],
    }, sha256);
    const secondDocument = createPluginConfigurationDocument({
      schemaVersion: 1,
      configurationRef: configuredRevision.configurationRef,
      plugin: configuredPlugin.identity.key,
      scope: { kind: "user" },
      descriptorDigest: digestConfigurationDescriptors(configuredPlugin.configuration, sha256),
      values: [{ key: "NAME", value: { kind: "string", value: "second" } }],
      secrets: [],
    }, sha256);
    const configuredTrustCandidate = createTrustCandidate({
      scope: { kind: "user" },
      marketplaceSource,
      plugin: configuredPlugin,
      compatibility: configuredCompatibility,
      content,
      materializationBinding: binding,
    }, sha256);
    const state = new MemoryState(snapshot(0, [], [grantTrust(configuredTrustCandidate, sha256)]));
    const base = dependencies(state);
    let reloads = 0;
    let promotions = 0;
    let transitions = 0;
    const composition = createPluginLifecycleComposition({
      ...base,
      inspector: { async inspect() { return { ok: true as const, value: configuredPlugin, diagnostics: [] }; } },
      compatibility: { async assess() { return configuredCompatibility; } },
      configurations: {
        async read() { return { kind: "found" as const, document: secondDocument }; },
        async replace() { return { kind: "stored" as const }; },
        async remove() { return "missing" as const; },
      },
      content: {
        ...base.content,
        async promote(plan) { promotions += 1; return base.content.promote(plan, signal); },
      },
      transitions: {
        async prepare() { transitions += 1; return "stored" as const; },
        async settle() { return undefined; },
      },
      reload: {
        async reload() { reloads += 1; return { kind: "accepted" as const }; },
        async observe() { throw new Error("observation must not run"); },
      },
    });
    const expected = {
      scope: { kind: "user" as const },
      registrationId: `marketplace-registration-v1:sha256:${"1".repeat(64)}` as never,
      candidateId: `marketplace-candidate-v1:sha256:${"2".repeat(64)}` as never,
      catalogSnapshot: `marketplace-snapshot-v1:sha256:${"3".repeat(64)}` as never,
      plugin: configuredPlugin.identity.key,
      sourceIdentity: configuredPlugin.source.hash,
      immutableRevision: configuredRevision.revision,
      contentDigest: content.rootDigest,
      compatibilityFingerprint: digestCompatibilityReport(configuredCompatibility, sha256),
      configurationDescriptorDigest: digestConfigurationDescriptors(configuredPlugin.configuration, sha256),
      consentDisclosureDigest: deriveTrustedInstallConsentDisclosureDigest(projectSafeComponents({ plugin: configuredPlugin, compatibility: configuredCompatibility }), sha256),
      configurationRef: configuredRevision.configurationRef,
      trustSubject: configuredTrustCandidate.subject,
      executableSurfaceDigest: configuredTrustCandidate.evidence.executableSurfaceDigest,
      capabilityDigest: `sha256:${"4".repeat(64)}` as never,
    };
    const claimedCandidate = { id: expected.candidateId, registrationId: expected.registrationId, snapshot: expected.catalogSnapshot, scope: { kind: "user" }, entry, marketplace: { source: marketplaceSource } } as never;
    const configuredMaterialized = { ...materialized, source: configuredPlugin.source };
    const lease = {
      candidate: claimedCandidate,
      materialized: configuredMaterialized,
      async claim() { return { candidate: claimedCandidate, materialized: configuredMaterialized, allocation: { slot: { root: "/virtual/stage" }, allocationId: "configured-stage" } }; },
      async release() {},
    } as never;

    const result = await composition.preparedInstall.installPrepared({
      scope: { kind: "user" },
      plugin: configuredPlugin.identity.key,
      entry,
      marketplaceSource,
      sourceContext: installRequest.sourceContext,
      lease,
      expected,
      expectedConfigurationRevision: firstDocument.revision,
      configurationPathContext: installRequest.configurationPathContext,
    }, signal);

    expect(result).toMatchObject({ kind: "rejected", code: "CONFIGURATION_STALE" });
    expect(state.current.installed.plugins).toHaveLength(0);
    expect(transitions).toBe(0);
    expect(promotions).toBe(0);
    expect(reloads).toBe(0);
  });

  it("consumes prepared candidate bytes without a second materializer call", async () => {
    const state = new MemoryState(snapshot(0, []));
    const base = dependencies(state);
    let materializations = 0;
    const composition = createPluginLifecycleComposition({ ...base, materializer: { async materialize() { materializations += 1; return materialized; } } });
    const expected = {
      scope: { kind: "user" as const },
      registrationId: `marketplace-registration-v1:sha256:${"1".repeat(64)}` as never,
      candidateId: `marketplace-candidate-v1:sha256:${"2".repeat(64)}` as never,
      catalogSnapshot: `marketplace-snapshot-v1:sha256:${"3".repeat(64)}` as never,
      plugin: plugin.identity.key,
      sourceIdentity: plugin.source.hash,
      immutableRevision: revision.revision,
      contentDigest: content.rootDigest,
      compatibilityFingerprint: digestCompatibilityReport(compatibility, sha256),
      configurationDescriptorDigest: digestConfigurationDescriptors(plugin.configuration, sha256),
      consentDisclosureDigest: deriveTrustedInstallConsentDisclosureDigest(projectSafeComponents({ plugin, compatibility }), sha256),
      trustSubject: trustCandidate.subject,
      executableSurfaceDigest: trustCandidate.evidence.executableSurfaceDigest,
      capabilityDigest: `sha256:${"4".repeat(64)}` as never,
    };
    const claimedCandidate = { id: expected.candidateId, registrationId: expected.registrationId, snapshot: expected.catalogSnapshot, scope: { kind: "user" }, entry, marketplace: { source: marketplaceSource } } as never;
    let claimed = false;
    const lease = {
      candidate: claimedCandidate,
      materialized,
      async claim() {
        if (claimed) throw new Error("duplicate claim");
        claimed = true;
        return { candidate: claimedCandidate, materialized, allocation: { slot: { root: "/virtual/stage" }, allocationId: "stage" } } as never;
      },
      async release() {},
    } as never;
    const result = await composition.preparedInstall.installPrepared({
      scope: { kind: "user" }, plugin: plugin.identity.key, entry, marketplaceSource, sourceContext: installRequest.sourceContext,
      lease, expected, configurationPathContext: installRequest.configurationPathContext,
    }, signal);
    expect(result.kind).toBe("changed");
    expect(claimed).toBe(true);
    expect(materializations).toBe(0);
  });

  it("runs one whole-plugin path through install, disable, enable, and uninstall", async () => {
    const state = new MemoryState(snapshot(0, []));
    const service = createPluginLifecycleService(dependencies(state));
    const installed = await service.install(installRequest, signal);
    expect(installed.kind).toBe("changed");
    expect(state.current.installed.plugins[0]?.activation).toBe("enabled");
    const disabled = await service.disable({ scope: { kind: "user" }, plugin: plugin.identity.key }, signal);
    expect(disabled.kind).toBe("changed");
    expect(state.current.installed.plugins[0]?.activation).toBe("disabled");
    const enabledRequest = { scope: { kind: "user" as const }, plugin: plugin.identity.key, configurationPathContext: { scope: { kind: "user" as const } } };
    const directEnable = await prepareEnableCandidate(dependencies(state), { operation: "enable", scope: enabledRequest.scope, installed: state.current.installed.plugins[0]!, trustRecords: [trust], configurationPathContext: enabledRequest.configurationPathContext }, signal);
    expect(directEnable.kind).toBe("prepared");
    const enabled = await service.enable(enabledRequest, signal);
    expect(enabled.kind).toBe("changed");
    const updated = await service.update(installRequest, signal);
    expect(updated).toMatchObject({ kind: "unchanged", operation: "update" });
    const removed = await service.uninstall({ scope: { kind: "user" }, plugin: plugin.identity.key, retainedData: "delete-confirmed" }, signal);
    expect(removed.kind).toBe("changed");
    expect(removed).toMatchObject({ cleanup: { kind: "deferred", retainedData: "delete-confirmed" } });
    expect(state.current.installed.plugins).toHaveLength(0);
  });

  it("binds optional target expectations and rebases unrelated generations only for exact target bytes", async () => {
    const target = createInstalledPluginRecord({ plugin: plugin.identity.key, activation: "enabled", revisions: [{ plugin, compatibility, content }] }, sha256);
    const state = new MemoryState(snapshot(0, [target, otherRecord]));
    const expectation = {
      generation: state.current.generation,
      plugin: target.plugin,
      selectedRevision: target.selectedRevision,
      activation: target.activation,
      targetDigest: deriveLifecycleTargetDigest({ kind: "user" }, target, sha256),
      pendingTransition: "none" as const,
    };
    advanceOtherPlugin(state);
    const service = createPluginLifecycleService(dependencies(state));
    expect((await service.disable({ scope: { kind: "user" }, plugin: target.plugin, expectedTarget: expectation }, signal)).kind).toBe("changed");

    const changed = state.current.installed.plugins.find((record) => record.plugin === target.plugin)!;
    const stale = await service.enable({
      scope: { kind: "user" },
      plugin: target.plugin,
      configurationPathContext: { scope: { kind: "user" } },
      expectedTarget: { ...expectation, activation: "disabled", targetDigest: expectation.targetDigest },
    }, signal);
    expect(stale.kind).toBe("stale");
    expect(changed.activation).toBe("disabled");
  });

  it("reports verified rollback instead of accepting a rejected reload", async () => {
    const state = new MemoryState(snapshot(0, [createInstalledPluginRecord({ plugin: plugin.identity.key, activation: "enabled", revisions: [{ plugin, compatibility, content }] }, sha256)]));
    const service = createPluginLifecycleService(dependencies(state, { rejectReload: true }));
    const result = await service.disable({ scope: { kind: "user" }, plugin: plugin.identity.key }, signal);
    expect(result.kind).toBe("rolled-back");
    expect(state.current.installed.plugins[0]?.activation).toBe("enabled");
  });

  it("continues from exact pending authority after an ambiguous first commit", async () => {
    const state = new MemoryState(snapshot(0, []));
    const service = createPluginLifecycleService(dependencies(state, { ambiguousFirstCommit: true }));

    const result = await service.install(installRequest, signal);

    expect(result.kind).toBe("changed");
    expect(state.current.installed.plugins).toEqual([
      expect.objectContaining({ plugin: plugin.identity.key, activation: "enabled" }),
    ]);
    expect(state.current.installed.plugins[0]).not.toHaveProperty("pendingTransition");
  });

  it("rebases successful finalization over an unrelated plugin generation advance", async () => {
    const state = new MemoryState(snapshot(0, [otherRecord]));
    let reloads = 0;
    let promotions = 0;
    const service = createPluginLifecycleService(dependencies(state, {
      onReload(count, current) {
        reloads = count;
        if (count === 1) advanceOtherPlugin(current);
      },
      onPromote() { promotions += 1; },
    }));

    const result = await service.install(installRequest, signal);

    expect(result.kind).toBe("changed");
    expect(reloads).toBe(1);
    expect(promotions).toBe(1);
    const target = state.current.installed.plugins.find((record) => record.plugin === plugin.identity.key);
    expect(target?.activation).toBe("enabled");
    expect(target).not.toHaveProperty("pendingTransition");
    expect(state.current.installed.plugins.find((record) => record.plugin === otherPlugin.identity.key)?.activation).toBe("disabled");
  });

  it("rebases failed-reload restoration over an unrelated plugin generation advance", async () => {
    const previousRecord = createInstalledPluginRecord({ plugin: plugin.identity.key, activation: "enabled", revisions: [{ plugin, compatibility, content }] }, sha256);
    const state = new MemoryState(snapshot(0, [previousRecord, otherRecord]));
    let reloads = 0;
    let promotions = 0;
    const service = createPluginLifecycleService(dependencies(state, {
      rejectReload: true,
      onReload(count, current) {
        reloads = count;
        if (count === 1) advanceOtherPlugin(current);
      },
      onPromote() { promotions += 1; },
    }));

    const result = await service.disable({ scope: { kind: "user" }, plugin: plugin.identity.key }, signal);

    expect(result.kind).toBe("rolled-back");
    expect(reloads).toBe(2);
    expect(promotions).toBe(0);
    const target = state.current.installed.plugins.find((record) => record.plugin === plugin.identity.key);
    expect(target?.activation).toBe("enabled");
    expect(target).not.toHaveProperty("pendingTransition");
    expect(state.current.installed.plugins.find((record) => record.plugin === otherPlugin.identity.key)?.activation).toBe("disabled");
  });

  it("requires recovery when a target plugin changes during reload", async () => {
    const state = new MemoryState(snapshot(0, []));
    let reloads = 0;
    const service = createPluginLifecycleService(dependencies(state, {
      onReload(count, current) {
        reloads = count;
        if (count === 1) changeTargetPlugin(current);
      },
    }));

    const result = await service.install(installRequest, signal);
    const target = state.current.installed.plugins.find((record) => record.plugin === plugin.identity.key);

    expect(result.kind).toBe("recovery-required");
    expect(reloads).toBe(1);
    expect(target?.activation).toBe("disabled");
    expect(target?.pendingTransition).toBeDefined();
  });
});
