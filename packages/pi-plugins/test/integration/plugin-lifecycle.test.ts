import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { claim } from "../../src/domain/provenance.js";
import { CompatibilityReportSchema } from "../../src/domain/compatibility.js";
import { createContentManifest, createMaterializationBinding } from "../../src/domain/content-manifest.js";
import { NormalizedPluginSchema, type NormalizedPlugin } from "../../src/domain/plugin.js";
import { createResolvedPluginSource, createResolvedMarketplaceSource } from "../../src/domain/source.js";
import {
  createInstalledRevisionRecord,
  createInstalledUserStateDocument,
  createMarketplaceSnapshotRecord,
} from "../../src/domain/state/installed-state.js";
import { createProjectLocalStateDocument } from "../../src/domain/state/project-state.js";
import { HostConfigDocumentSchema, GenerationSchema, type Generation } from "../../src/domain/state/config-state.js";
import { StatePointersDocumentSchema } from "../../src/domain/state/pointers.js";
import { TrustStateDocumentSchema } from "../../src/domain/state/trust-state.js";
import { deriveStateBlobRef } from "../../src/domain/state/references.js";
import {
  CanonicalProjectRootSchema,
  ProjectIdentitySchema,
  createScopeContext,
  deriveProjectKey,
  toScopeReference,
  type ScopeContext,
} from "../../src/domain/state/scope.js";
import { createProjectRootAuthorityPort } from "../../src/composition/create-project-root-authority.js";
import { createPiReloadBroker } from "../../src/pi/pi-reload-broker.js";
import { readClaudeMarketplace } from "../../src/formats/claude/marketplace-reader.js";
import type { CompatibilityReport } from "../../src/domain/compatibility.js";
import type { ContentManifest } from "../../src/domain/content-manifest.js";
import {
  createPluginRuntimeProjection,
  createActiveProjectionExpectation,
  type ProjectionExpectation,
  type RuntimeProjectionPort,
} from "../../src/application/ports/runtime-projection.js";
import { createPluginLifecycleService, type PluginLifecycleServiceDependencies } from "../../src/application/plugin-lifecycle-service.js";
import { createProjectSyncService } from "../../src/application/project-sync-service.js";
import { encodeProjectIntentDeclaration } from "../../src/application/project-intent-codec.js";
import type { GenerationMutationCoordinator } from "../../src/application/generation-mutation-coordinator.js";
import type { LifecycleStateStore } from "../../src/application/ports/lifecycle-state-store.js";
import { CurrentProjectRuntimeContextSchema } from "../../src/application/ports/project-trust.js";
import type { LifecycleReloadPort } from "../../src/application/ports/lifecycle-reload.js";
import type { LifecycleTransitionStore } from "../../src/application/ports/lifecycle-transition-store.js";
import type { ContentStorePort } from "../../src/application/ports/content-store.js";
import type { InstalledPluginLoader } from "../../src/application/ports/installed-plugin-loader.js";
import type { ProjectRootAuthorityPort } from "../../src/application/ports/project-root-authority.js";
import type { GenerationSnapshot } from "../../src/application/state-contract.js";
import { createTrustCandidate, grantTrust } from "../../src/domain/trust-policy.js";
import { createMarketplaceConfigurationRecord } from "../../src/domain/update-policy.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const provenance = { location: { host: "claude" as const, documentKind: "manifest" as const, path: "plugin.json", pointer: "/components" } };
const id = (kind: string, token: string) => `component-v1:${kind}:${token.repeat(64).slice(0, 64)}`;

const plugin = NormalizedPluginSchema.parse({
  identity: { key: "bundle@community", marketplaceName: "community", marketplaceEntryName: "bundle" },
  source: createResolvedPluginSource({ kind: "git", url: "https://example.invalid/bundle.git", revision: "c".repeat(40) }, sha256),
  configuration: { options: [] },
  components: {
    skills: [{ kind: "skill", id: id("skill", "1"), name: claim("bundle-skill", provenance), root: claim("skills/bundle", provenance), metadata: [] }],
    hooks: [{ kind: "hook", id: id("hook", "2"), event: claim("SessionStart", provenance), handler: claim({ kind: "shell", command: "echo ready" }, provenance), metadata: [] }],
    mcpServers: [{ kind: "mcp-server", id: id("mcp-server", "3"), nativeKey: claim("bundle", provenance), declaration: claim({ transport: "stdio", command: "bundle-mcp" }, provenance), metadata: [] }],
    foreign: [],
  },
  metadata: [],
});
const componentIds = [plugin.components.skills[0]!.id, plugin.components.hooks[0]!.id, plugin.components.mcpServers[0]!.id];
const compatibility = CompatibilityReportSchema.parse({
  plugin: plugin.identity,
  activatable: true,
  components: componentIds.map((componentId) => ({ componentId, verdict: { kind: "supported" }, requirementIds: [], diagnostics: [] })),
  requirements: [],
  diagnostics: [],
});
const content = createContentManifest([], sha256);

function revision(scope: { kind: "user" } | { kind: "project"; projectKey: string }) {
  return createInstalledRevisionRecord({ plugin, compatibility, content, scope }, sha256);
}

describe("whole-plugin lifecycle integration contracts", () => {
  it("projects one skill, hook, and MCP bundle through one complete runtime seam", () => {
    const projection = createPluginRuntimeProjection({ scope: { kind: "user" }, plugin, compatibility, revision: revision({ kind: "user" }), sha256 });
    expect(projection.components.skills).toHaveLength(1);
    expect(projection.components.hooks).toHaveLength(1);
    expect(projection.components.mcpServers).toHaveLength(1);
    expect(createActiveProjectionExpectation(projection, sha256).kind).toBe("active");
    expect(JSON.stringify(projection)).not.toContain("example.invalid");
    expect(JSON.stringify(projection)).not.toContain("file://");
  });

  it("keeps identical plugin keys isolated by scope-qualified immutable references", () => {
    const user = createPluginRuntimeProjection({ scope: { kind: "user" }, plugin, compatibility, revision: revision({ kind: "user" }), sha256 });
    const project = createPluginRuntimeProjection({ scope: { kind: "project", projectKey: `project-v1:sha256:${"a".repeat(64)}` }, plugin, compatibility, revision: revision({ kind: "project", projectKey: `project-v1:sha256:${"a".repeat(64)}` }), sha256 });
    expect(user.plugin).toBe(project.plugin);
    expect(user.digest).not.toBe(project.digest);
    expect(user.dataRef).not.toBe(project.dataRef);
  });
});

const lifecycleEntry = readClaudeMarketplace({
  name: "community",
  plugins: [{ name: "bundle", source: "./plugin", strict: false }],
}).marketplace.entries[0]!;
const lifecycleMarketplace = createResolvedMarketplaceSource({
  declared: { kind: "github", repository: "example/community" },
  revision: "a".repeat(40),
}, sha256);
const adoptedMarketplace = createResolvedMarketplaceSource({
  declared: { kind: "github", repository: "example/adopted" },
  revision: "b".repeat(40),
}, sha256);
const lifecyclePluginV2 = NormalizedPluginSchema.parse({
  ...plugin,
  source: createResolvedPluginSource({
    kind: "git",
    url: "https://example.invalid/bundle.git",
    revision: "d".repeat(40),
  }, sha256),
});
const lifecycleCompatibilityV2 = CompatibilityReportSchema.parse({
  ...compatibility,
  plugin: lifecyclePluginV2.identity,
});
const lifecycleProjectRoot = CanonicalProjectRootSchema.parse("file:///workspace/project/");
const lifecycleProjectIdentity = ProjectIdentitySchema.parse({
  kind: "path-only",
  canonicalRoot: lifecycleProjectRoot,
  limitation: "identity-changes-with-canonical-root",
});
const lifecycleProject = createScopeContext({
  kind: "project",
  identity: lifecycleProjectIdentity,
  projectKey: deriveProjectKey(lifecycleProjectIdentity, sha256),
}, sha256);
const currentProject = CurrentProjectRuntimeContextSchema.parse({
  identity: lifecycleProjectIdentity,
  projectKey: lifecycleProject.projectKey,
  trust: { kind: "trusted" },
});

function lifecyclePointers(scope: ScopeContext, generation: Generation) {
  const reference = toScopeReference(scope);
  const kinds = scope.kind === "user" ? ["hostConfig", "installedUser", "trust"] : ["projectLocal"];
  return StatePointersDocumentSchema.parse({
    schemaVersion: 1,
    scope: reference,
    generation,
    documents: kinds.map((kind) => ({
      kind,
      generation,
      blob: deriveStateBlobRef({ document: kind, scope: reference, generation }, sha256),
      digest: content.rootDigest,
    })),
  });
}

function lifecycleUserSnapshot(
  generation: number,
  plugins: ReadonlyArray<ReturnType<typeof createInstalledUserStateDocument>["plugins"][number]> = [],
  records: ReadonlyArray<ReturnType<typeof grantTrust>> = [],
): Extract<GenerationSnapshot, { scope: { kind: "user" } }> {
  const value = GenerationSchema.parse(generation);
  return {
    scope: { kind: "user" },
    generation: value,
    pointers: lifecyclePointers({ kind: "user" }, value),
    config: HostConfigDocumentSchema.parse({ schemaVersion: 4, generation: value, records: [] }),
    installed: createInstalledUserStateDocument({ generation: value, marketplaces: [createMarketplaceSnapshotRecord({ marketplace: "community", source: lifecycleMarketplace, content }, sha256)], plugins }, sha256),
    trust: TrustStateDocumentSchema.parse({ schemaVersion: 1, generation: value, records }),
    corruptions: [],
  };
}

function lifecycleProjectSnapshot(
  generation: number,
): Extract<GenerationSnapshot, { scope: { kind: "project" } }> {
  const value = GenerationSchema.parse(generation);
  const marketplace = createMarketplaceSnapshotRecord({ marketplace: "community", source: lifecycleMarketplace, content }, sha256);
  const adopted = createMarketplaceSnapshotRecord({ marketplace: "adopted", source: adoptedMarketplace, content }, sha256);
  return {
    scope: lifecycleProject,
    generation: value,
    pointers: lifecyclePointers(lifecycleProject, value),
    project: createProjectLocalStateDocument({
      schemaVersion: 4,
      generation: value,
      projectKey: lifecycleProject.projectKey,
      identity: lifecycleProject.identity,
      declarationDigest: content.rootDigest,
      scope: { application: "automatic" },
      marketplaces: [marketplace, adopted],
      plugins: [],
      marketplaceUpdates: [
        createMarketplaceConfigurationRecord({ marketplace: "community", source: lifecycleMarketplace.declared, applicationOverride: "automatic", origin: { kind: "native" } }),
        createMarketplaceConfigurationRecord({ marketplace: "adopted", source: adoptedMarketplace.declared, origin: { kind: "adoption", candidateId: `adoption-v1:sha256:${"c".repeat(64)}`, documents: [{ host: "claude", document: "claude-known-marketplaces", pointer: "/adopted" }] } }),
      ],
    }, lifecycleProject, sha256),
    corruptions: [],
  };
}

class LifecycleScopeState implements LifecycleStateStore {
  private readonly values = new Map<string, GenerationSnapshot>();

  constructor(user: GenerationSnapshot, project: GenerationSnapshot) {
    this.values.set("user", user);
    this.values.set(`project:${project.scope.kind === "project" ? project.scope.projectKey : ""}`, project);
  }

  get(scope: ScopeContext): GenerationSnapshot {
    const value = this.values.get(scope.kind === "user" ? "user" : `project:${scope.projectKey}`);
    if (value === undefined) throw new Error("missing lifecycle test scope");
    return value;
  }

  set(snapshot: GenerationSnapshot): void {
    this.values.set(snapshot.scope.kind === "user" ? "user" : `project:${snapshot.scope.projectKey}`, snapshot);
  }

  async read(scope: ScopeContext) {
    return { ok: true as const, snapshot: this.get(scope) };
  }

  async commit(): Promise<never> {
    throw new Error("the generation coordinator owns lifecycle test commits");
  }
}

function createLifecycleCoordinator(state: LifecycleScopeState): GenerationMutationCoordinator {
  return {
    async runPreparedMutation(request, callback) {
      const current = state.get(request.scope);
      if (request.expectedGeneration !== current.generation) {
        return { kind: "stale-generation", expected: request.expectedGeneration, actual: current.generation };
      }
      const prepared = await callback({ snapshot: current, assertOwned: async () => undefined });
      const generation = GenerationSchema.parse(current.generation + 1);
      let next: GenerationSnapshot;
      if (current.scope.kind === "user" && prepared.mutation.scope.kind === "user") {
        const replacement = prepared.mutation.replace;
        const installed = "installed" in replacement && replacement.installed !== undefined
          ? { ...replacement.installed, generation }
          : { ...current.installed, generation };
        const config = "config" in replacement && replacement.config !== undefined
          ? { ...replacement.config, generation }
          : { ...current.config, generation };
        const trust = "trust" in replacement && replacement.trust !== undefined
          ? { ...replacement.trust, generation }
          : { ...current.trust, generation };
        next = { ...current, generation, pointers: lifecyclePointers(current.scope, generation), config, installed, trust };
      } else if (current.scope.kind === "project" && prepared.mutation.scope.kind === "project") {
        next = {
          ...current,
          generation,
          pointers: lifecyclePointers(current.scope, generation),
          project: { ...prepared.mutation.replace.project, generation },
        };
      } else {
        throw new Error("lifecycle test mutation scope mismatch");
      }
      state.set(next);
      return { kind: "committed", value: prepared.value, snapshot: next };
    },
  };
}

function lifecycleTrust(
  scope: ScopeContext,
  candidatePlugin: NormalizedPlugin,
  candidateCompatibility: CompatibilityReport,
) {
  return grantTrust(createTrustCandidate({
    scope: toScopeReference(scope),
    marketplaceSource: lifecycleMarketplace,
    plugin: candidatePlugin,
    compatibility: candidateCompatibility,
    content,
    materializationBinding: createMaterializationBinding(candidatePlugin.source.hash, content.rootDigest, sha256),
  }, sha256), sha256);
}

describe("project-scoped lifecycle service wiring", () => {
  it("installs, disables, enables, updates, and uninstalls a complete project bundle without crossing user state", async () => {
    const userTrust = lifecycleTrust({ kind: "user" }, plugin, compatibility);
    const projectTrustV1 = lifecycleTrust(lifecycleProject, plugin, compatibility);
    const projectTrustV2 = lifecycleTrust(lifecycleProject, lifecyclePluginV2, lifecycleCompatibilityV2);
    const state = new LifecycleScopeState(
      lifecycleUserSnapshot(0, [], [userTrust]),
      lifecycleProjectSnapshot(0),
    );
    const rootPort = createProjectRootAuthorityPort({ resolve: async () => lifecycleProject }, sha256);
    let rootAcquireCalls = 0;
    let rootVerifyCalls = 0;
    let rootAuthorityAvailable = true;
    const projectRoots: ProjectRootAuthorityPort = {
      async acquire(signal) {
        rootAcquireCalls += 1;
        if (!rootAuthorityAvailable) throw new Error("project root authority unavailable");
        return rootPort.acquire(signal);
      },
      verify(capability, scope) {
        rootVerifyCalls += 1;
        return rootPort.verify(capability, scope);
      },
    };
    const trustCalls: string[] = [];
    const expectations: ProjectionExpectation[] = [];
    const reloads: string[] = [];
    const broker = createPiReloadBroker();
    const piBinding = { sessionId: "lifecycle-v3", cwd: "/workspace/project", mode: "interactive" as const, projectTrusted: true };
    let rejectNextReload = false;
    const projections: RuntimeProjectionPort = {
      async prepare(expectation) {
        expectations.push(expectation);
        return expectation;
      },
    };
    const reload: LifecycleReloadPort = {
      async reload(request, signal) {
        reloads.push(request.scope.kind === "user" ? "user" : request.scope.projectKey);
        if (rejectNextReload) { rejectNextReload = false; return { kind: "failed", code: "RELOAD_REJECTED" }; }
        const ticket = broker.open(piBinding, request.scope, request.transition);
        const successor = broker.claimSuccessor(piBinding);
        if (successor === undefined) throw new Error("real reload broker did not admit the exact successor");
        broker.publish(successor, []);
        await broker.wait(ticket, signal);
        return { kind: "accepted" };
      },
      async observe(request) {
        const current = state.get(request.scope.kind === "user" ? { kind: "user" } : lifecycleProject);
        const currentRecord = current.scope.kind === "user"
          ? current.installed.plugins.find((record) => record.plugin === request.plugin)
          : current.project.plugins.find((record) => record.plugin === request.plugin);
        const active = currentRecord?.activation === "enabled";
        const expected = [...expectations].reverse().find((value) =>
          value.kind === (active ? "active" : "inactive") &&
          JSON.stringify(value.kind === "active" ? value.projection.scope : value.scope) === JSON.stringify(request.scope) &&
          (value.kind === "active" ? value.projection.plugin : value.plugin) === request.plugin &&
          (value.kind === "inactive" || value.projection.revision === currentRecord?.selectedRevision),
        );
        if (expected === undefined) throw new Error("lifecycle test observation has no prepared expectation");
        return expected.kind === "active"
          ? { kind: "active", scope: expected.projection.scope, plugin: expected.projection.plugin, revision: expected.projection.revision, projectionDigest: expected.projection.digest, currentProject }
          : { kind: "inactive", scope: expected.scope, plugin: expected.plugin, projectionDigest: expected.digest, currentProject };
      },
    };
    let materializationCount = 0;
    const materializer = {
      async materialize() {
        const selected = materializationCount++ < 2 ? plugin : lifecyclePluginV2;
        return {
          root: "/virtual/plugin",
          source: selected.source,
          content,
          binding: createMaterializationBinding(selected.source.hash, content.rootDigest, sha256),
        };
      },
    };
    const contentPort = {
      async allocateStaging() { return { slot: { root: "/virtual/stage" }, allocationId: `stage-${materializationCount}` }; },
      async discardStaging() { return undefined; },
      async promote(plan: { identity: unknown; manifest: ContentManifest }) { return { kind: "promoted" as const, identity: plan.identity as never, root: "/virtual/store", manifest: plan.manifest }; },
    } as unknown as ContentStorePort;
    const loader: InstalledPluginLoader = {
      async load({ revision }) {
        const selected = revision.evidence.source.kind === "git" && revision.evidence.source.revision === "d".repeat(40)
          ? lifecyclePluginV2
          : plugin;
        return { plugin: selected, compatibility: selected === lifecyclePluginV2 ? lifecycleCompatibilityV2 : compatibility, marketplaceSource: lifecycleMarketplace, content, binding: revision.revision };
      },
    };
    let operationCounter = 0;
    const dependencies = {
      state,
      mutations: createLifecycleCoordinator(state),
      content: contentPort,
      materializer,
      inspector: { async inspect(input: { materialized: { source: { revision?: string } } }) { return { ok: true as const, value: input.materialized.source.revision === "d".repeat(40) ? lifecyclePluginV2 : plugin, diagnostics: [] }; } },
      compatibility: { async assess(input: { plugin: NormalizedPlugin }) { return input.plugin === lifecyclePluginV2 ? lifecycleCompatibilityV2 : compatibility; } },
      installed: loader,
      projections,
      reload,
      transitions: { async prepare() { return "stored" as const; }, async settle() { return undefined; } } satisfies LifecycleTransitionStore,
      operationIds: { async create() { operationCounter += 1; return `00000000-0000-4000-8000-${operationCounter.toString(16).padStart(12, "0")}`; } },
      projectTrust: { async assess(projectKey: string) { trustCalls.push(projectKey); return { kind: "trusted" as const }; } },
      projectRoots,
      configurations: { async read() { return { kind: "missing" as const }; }, async replace() { return { kind: "stored" as const }; }, async remove() { return "missing" as const; } },
      secrets: { async put() { return { kind: "collision" as const }; }, async get() { return { kind: "missing" as const }; }, async remove() { return "missing" as const; }, async removeOwned() { return "missing" as const; } },
      paths: { async normalizeAndInspect() { return { kind: "missing" as const }; } },
      sha256,
    } as unknown as PluginLifecycleServiceDependencies;
    const service = createPluginLifecycleService(dependencies);
    const initialProject = state.get(lifecycleProject);
    if (initialProject.scope.kind !== "project") throw new Error("project fixture scope changed");
    const retainedProjectAuthority = JSON.stringify({
      declarationDigest: initialProject.project.declarationDigest,
      scope: initialProject.project.scope,
      marketplaceUpdates: initialProject.project.marketplaceUpdates,
    });
    const assertProjectAuthorityRetained = () => {
      const current = state.get(lifecycleProject);
      if (current.scope.kind !== "project") throw new Error("project fixture scope changed");
      expect(current.project.schemaVersion).toBe(4);
      expect(JSON.stringify({
        declarationDigest: current.project.declarationDigest,
        scope: current.project.scope,
        marketplaceUpdates: current.project.marketplaceUpdates,
      })).toBe(retainedProjectAuthority);
    };
    const userRequest = {
      scope: { kind: "user" as const },
      plugin: plugin.identity.key,
      entry: lifecycleEntry,
      marketplaceSource: lifecycleMarketplace,
      sourceContext: { kind: "external" as const },
      trustRecords: [userTrust],
      configurationPathContext: { scope: { kind: "user" as const }, trustedBaseDirectory: "/virtual" },
    };
    expect((await service.install(userRequest, new AbortController().signal)).kind).toBe("changed");
    expect(rootAcquireCalls).toBe(0);
    expect(rootVerifyCalls).toBe(0);
    expect(trustCalls).toEqual([]);

    const projectRequest = {
      ...userRequest,
      scope: lifecycleProject,
      sourceContext: { kind: "external" as const },
      trustRecords: [projectTrustV1, projectTrustV2],
      configurationPathContext: { scope: lifecycleProject },
    };
    expect((await service.install(projectRequest, new AbortController().signal)).kind).toBe("changed");
    assertProjectAuthorityRetained();
    rejectNextReload = true;
    expect((await service.disable({ scope: lifecycleProject, plugin: plugin.identity.key }, new AbortController().signal)).kind).toBe("rolled-back");
    assertProjectAuthorityRetained();
    expect((await service.disable({ scope: lifecycleProject, plugin: plugin.identity.key }, new AbortController().signal)).kind).toBe("changed");
    assertProjectAuthorityRetained();
    expect((await service.enable({ ...projectRequest, configurationPathContext: { scope: lifecycleProject } }, new AbortController().signal)).kind).toBe("changed");
    assertProjectAuthorityRetained();
    expect((await service.update(projectRequest, new AbortController().signal)).kind).toBe("changed");
    assertProjectAuthorityRetained();

    const desired = {
      schemaVersion: 1 as const,
      marketplaces: [
        { marketplace: "community", source: lifecycleMarketplace.declared },
        { marketplace: "adopted", source: adoptedMarketplace.declared },
      ],
      plugins: [],
    };
    const encodedDesired = encodeProjectIntentDeclaration(desired, sha256);
    const fileObservation = Object.freeze({ publicId: `project-intent-observation-v1:sha256:${"f".repeat(64)}` }) as never;
    const sync = createProjectSyncService({
      state,
      mutations: dependencies.mutations,
      projectRoots,
      projectTrust: dependencies.projectTrust,
      files: {
        async read() { return { kind: "found" as const, observation: fileObservation, declaration: encodedDesired.declaration, digest: encodedDesired.digest }; },
        async replace() { throw new Error("apply-intent must not write the project file"); },
        async cleanup() {},
      },
      writeIds: { async create() { throw new Error("apply-intent must not request a write id"); } },
      lifecycle: service,
      registrations: { async remove() { throw new Error("retained registrations must not be removed"); } },
      configurationPathContext(root) { return { scope: lifecycleProject, trustedProjectRoot: root }; },
      async readiness(snapshot) {
        return {
          capabilityDigest: `sha256:${"1".repeat(64)}` as never,
          projectTrustFingerprint: `sha256:${"2".repeat(64)}` as never,
          plugins: snapshot.project.plugins.map((record) => ({
            plugin: record.plugin,
            trust: "ready" as const,
            trustFingerprint: `sha256:${"3".repeat(64)}` as never,
            configuration: "ready" as const,
            configurationRevision: null,
          })),
        };
      },
      sha256,
    });
    const syncPreviewId = `native-operation-preview-v1:sha256:${"4".repeat(64)}` as never;
    const firstSync = await sync.preview({ mode: "apply-intent", projectKey: lifecycleProject.projectKey, previewId: syncPreviewId }, new AbortController().signal);
    if (firstSync.kind !== "ready") throw new Error("integrated project sync preview failed");
    const partialSync = await sync.apply({ context: firstSync.context, resolutions: [] }, undefined, new AbortController().signal);
    expect(partialSync).toMatchObject({ kind: "needs-action", actions: [{ kind: "repreview-sync" }], effects: { state: "partially-changed" } });
    assertProjectAuthorityRetained();
    const finalSync = await sync.preview({ mode: "apply-intent", projectKey: lifecycleProject.projectKey, previewId: syncPreviewId }, new AbortController().signal);
    if (finalSync.kind !== "ready") throw new Error("integrated project sync convergence preview failed");
    expect(await sync.apply({ context: finalSync.context, resolutions: [] }, undefined, new AbortController().signal)).toMatchObject({ kind: "succeeded", syncDigest: encodedDesired.digest });
    const syncedProject = state.get(lifecycleProject);
    if (syncedProject.scope.kind !== "project") throw new Error("project sync scope changed");
    expect(syncedProject.project.marketplaceUpdates).toEqual(initialProject.project.marketplaceUpdates);
    expect(syncedProject.project.declarationDigest).toBe(encodedDesired.digest);

    rootAuthorityAvailable = false;
    expect(await service.install(projectRequest, new AbortController().signal)).toMatchObject({ kind: "rejected", operation: "install", code: "UNCONFIGURED" });

    const user = state.get({ kind: "user" });
    const project = state.get(lifecycleProject);
    expect(user.scope.kind).toBe("user");
    if (user.scope.kind === "user") expect(user.installed.plugins[0]?.activation).toBe("enabled");
    if (project.scope.kind === "project") expect(project.project.plugins).toHaveLength(0);
    expect(rootAcquireCalls).toBe(11);
    expect(rootVerifyCalls).toBe(10);
    expect(trustCalls).toHaveLength(10);
    expect(reloads).toHaveLength(8);
    expect(expectations.filter((value) => value.kind === "active").every((value) => value.projection.components.skills.length === 1 && value.projection.components.hooks.length === 1 && value.projection.components.mcpServers.length === 1)).toBe(true);
    const userProjection = expectations.find((value) => value.kind === "active" && value.projection.scope.kind === "user");
    const projectProjection = expectations.find((value) => value.kind === "active" && value.projection.scope.kind === "project");
    expect(userProjection?.kind).toBe("active");
    expect(projectProjection?.kind).toBe("active");
    if (userProjection?.kind === "active" && projectProjection?.kind === "active") {
      expect(userProjection.projection.dataRef).not.toBe(projectProjection.projection.dataRef);
      expect(userProjection.projection.digest).not.toBe(projectProjection.projection.digest);
    }
  });
});
