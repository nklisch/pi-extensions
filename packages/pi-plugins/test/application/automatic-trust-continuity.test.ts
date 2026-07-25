import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAutomaticTrustContinuity } from "../../src/application/automatic-trust-continuity.js";
import type { GenerationSnapshot } from "../../src/application/state-contract.js";
import { createContentManifest, createMaterializationBinding } from "../../src/domain/content-manifest.js";
import { CompatibilityReportSchema } from "../../src/domain/compatibility.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { createResolvedMarketplaceSource, createResolvedPluginSource } from "../../src/domain/source.js";
import { HostConfigDocumentSchema, GenerationSchema, type Generation } from "../../src/domain/state/config-state.js";
import {
  createInstalledPluginRecord,
  createInstalledRevisionRecord,
  createInstalledUserStateDocument,
  createMarketplaceSnapshotRecord,
} from "../../src/domain/state/installed-state.js";
import { createProjectLocalStateDocument } from "../../src/domain/state/project-state.js";
import { StatePointersDocumentSchema } from "../../src/domain/state/pointers.js";
import { TrustStateDocumentSchema } from "../../src/domain/state/trust-state.js";
import { deriveStateBlobRef } from "../../src/domain/state/references.js";
import { deriveProjectKey, type ScopeContext } from "../../src/domain/state/scope.js";
import { createTrustCandidate, grantTrust, revokeTrust } from "../../src/domain/trust-policy.js";
import { createMarketplaceConfigurationRecord, deriveMarketplaceSourceIdentity, derivePluginSourceIdentity } from "../../src/domain/update-policy.js";
import { readClaudeMarketplace } from "../../src/formats/claude/marketplace-reader.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;
const declaredSource = { kind: "github" as const, repository: "example/community" };
const oldRevision = "a".repeat(40);
const newRevision = "b".repeat(40);
const marketplaceSourceOld = createResolvedMarketplaceSource({ declared: declaredSource, revision: oldRevision }, sha256);
const marketplaceSourceNew = createResolvedMarketplaceSource({ declared: declaredSource, revision: newRevision }, sha256);
const entry = readClaudeMarketplace({ name: "community", plugins: [{ name: "fixture", source: "./plugin", strict: false }] }).marketplace.entries[0]!;
const pluginSourcePath = entry.source.value.kind === "marketplace-path" ? entry.source.value.path : "plugin";
const marketplaceIdentity = deriveMarketplaceSourceIdentity(declaredSource, sha256);
const pluginIdentity = derivePluginSourceIdentity(entry.source.value, sha256);

function pluginAt(revision: string, key = "fixture@community", entryName = "fixture") {
  return NormalizedPluginSchema.parse({
    identity: { key, marketplaceName: "community", marketplaceEntryName: entryName },
    source: createResolvedPluginSource({ kind: "marketplace-path", marketplaceRevision: revision, path: pluginSourcePath }, sha256),
    configuration: { options: [] },
    components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
    metadata: [],
  });
}

const pluginOld = pluginAt(oldRevision);
const pluginNew = pluginAt(newRevision);
const compatibility = CompatibilityReportSchema.parse({ plugin: pluginNew.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
const compatibilityOld = CompatibilityReportSchema.parse({ ...compatibility, plugin: pluginOld.identity });
const content = createContentManifest([], sha256);
const bindingOld = createMaterializationBinding(pluginOld.source.hash, content.rootDigest, sha256);
const bindingNew = createMaterializationBinding(pluginNew.source.hash, content.rootDigest, sha256);
const marketplace = createMarketplaceSnapshotRecord({ marketplace: "community", source: marketplaceSourceNew, content }, sha256);

function revisionAt(plugin: ReturnType<typeof pluginAt>, compat: typeof compatibility, scope: { kind: "user" } | { kind: "project"; projectKey: string }) {
  return createInstalledRevisionRecord({
    plugin,
    compatibility: compat,
    content,
    scope,
    marketplaceSourceIdentity: marketplaceIdentity,
    pluginSourceIdentity: pluginIdentity,
  }, sha256);
}

const scope = { kind: "user" as const };
const revisionOld = revisionAt(pluginOld, compatibilityOld, scope);
const revisionNew = revisionAt(pluginNew, compatibility, scope);
const candidateOld = createTrustCandidate({ scope, marketplaceSource: marketplaceSourceOld, plugin: pluginOld, compatibility: compatibilityOld, content, materializationBinding: bindingOld }, sha256);
const candidateNew = createTrustCandidate({ scope, marketplaceSource: marketplaceSourceNew, plugin: pluginNew, compatibility, content, materializationBinding: bindingNew }, sha256);
const baseline = grantTrust(candidateOld, sha256);

// The launch path compares candidate evidence against the installed record;
// continuity lineage anchoring depends on the same identity.
it("installed revision digest matches the candidate immutable revision evidence", () => {
  expect(revisionOld.revision).toBe(candidateOld.evidence.immutableRevision);
  expect(revisionNew.revision).toBe(candidateNew.evidence.immutableRevision);
  expect(revisionOld.evidence.trust.executableSurfaceDigest).toBe(candidateOld.evidence.executableSurfaceDigest);
});

const installedRecord = createInstalledPluginRecord({
  plugin: "fixture@community",
  activation: "enabled",
  selectedRevision: revisionNew.revision,
  revisions: [revisionOld, revisionNew],
  scope,
}, sha256);

function pointers(generation: Generation, projectKey?: string) {
  const scopeRef = projectKey === undefined ? { kind: "user" as const } : { kind: "project" as const, projectKey };
  const kinds = projectKey === undefined ? ["hostConfig", "installedUser", "trust"] : ["projectLocal"];
  return StatePointersDocumentSchema.parse({
    schemaVersion: 1,
    scope: scopeRef,
    generation,
    documents: kinds.map((kind) => ({
      kind,
      generation,
      blob: deriveStateBlobRef({ document: kind, scope: projectKey === undefined ? "user" : "project", generation }, sha256),
      digest: `sha256:${"0".repeat(64)}`,
    })),
  });
}

function userSnapshot(options: {
  generation?: number;
  records?: readonly unknown[];
  application?: "manual" | "automatic";
  policyRecord?: unknown;
  plugins?: readonly unknown[];
} = {}): Extract<GenerationSnapshot, { scope: { kind: "user" } }> {
  const generation = GenerationSchema.parse(options.generation ?? 0);
  return {
    scope,
    generation,
    pointers: pointers(generation),
    config: HostConfigDocumentSchema.parse({
      schemaVersion: 4,
      generation,
      global: { application: options.application ?? "manual", cadence: "balanced" },
      records: options.policyRecord === undefined ? [] : [options.policyRecord],
    }),
    installed: createInstalledUserStateDocument({ generation, marketplaces: [marketplace], plugins: options.plugins ?? [installedRecord] }, sha256),
    trust: TrustStateDocumentSchema.parse({ schemaVersion: 1, generation, records: options.records ?? [baseline] }),
    corruptions: [],
  };
}

const automaticPolicy = createMarketplaceConfigurationRecord({ marketplace: "community", source: declaredSource, applicationOverride: "automatic" });

function setup(snapshot: Extract<GenerationSnapshot, { scope: { kind: "user" } }>, project?: Readonly<{ snapshot: GenerationSnapshot; trusted: boolean }>) {
  let replacement: { trust?: { records: readonly unknown[] } } | undefined;
  const requests: unknown[] = [];
  const runPreparedMutation = vi.fn(async (request: unknown, prepare: (context: unknown) => Promise<{ mutation: { replace: never }; value: unknown; beforeCommit?: () => Promise<void> }>) => {
    requests.push(request);
    // The first setup argument is always the user snapshot, and trust
    // authority is always user state.
    const prepared = await prepare({ snapshot, assertOwned: async () => undefined });
    // Mirror the real coordinator: beforeCommit gates every commit.
    await prepared.beforeCommit?.();
    replacement = prepared.mutation.replace;
    return { kind: "committed" as const, value: prepared.value, snapshot };
  });
  const service = createAutomaticTrustContinuity({
    state: {
      async read(readScope: ScopeContext) {
        if (readScope.kind === "project") return { ok: true as const, snapshot: project!.snapshot };
        return { ok: true as const, snapshot };
      },
    } as never,
    mutations: { runPreparedMutation } as never,
    installed: {
      async load() {
        return { plugin: pluginNew, compatibility, marketplaceSource: marketplaceSourceNew, content, binding: bindingNew };
      },
    } as never,
    ...(project === undefined ? {} : { projectTrust: { async assess() { return { kind: project.trusted ? "trusted" as const : "untrusted" as const }; } } }),
    sha256,
  });
  return { service, runPreparedMutation, requests, replacement: () => replacement };
}

function projectFixture(root = "file:///project/") {
  const identity = { kind: "path-only" as const, canonicalRoot: root, limitation: "identity-changes-with-canonical-root" as const };
  const projectScope: Extract<ScopeContext, { kind: "project" }> = { kind: "project", identity, projectKey: deriveProjectKey(identity, sha256) };
  const projectRef = { kind: "project" as const, projectKey: projectScope.projectKey };
  const revisionOldP = revisionAt(pluginOld, compatibilityOld, projectRef);
  const revisionNewP = revisionAt(pluginNew, compatibility, projectRef);
  const record = createInstalledPluginRecord({
    plugin: "fixture@community",
    activation: "enabled",
    selectedRevision: revisionNewP.revision,
    revisions: [revisionOldP, revisionNewP],
    scope: projectRef,
  }, sha256);
  const baselineGrant = grantTrust(createTrustCandidate({
    scope: projectRef,
    marketplaceSource: marketplaceSourceOld,
    plugin: pluginOld,
    compatibility: compatibilityOld,
    content,
    materializationBinding: bindingOld,
  }, sha256), sha256);
  const snapshot = (recordOverride = record): GenerationSnapshot => {
    const generation = GenerationSchema.parse(0);
    return {
      scope: projectScope,
      generation,
      pointers: pointers(generation, projectScope.projectKey),
      project: createProjectLocalStateDocument({
        schemaVersion: 4,
        generation,
        projectKey: projectScope.projectKey,
        identity,
        declarationDigest: content.rootDigest,
        scope: {},
        marketplaces: [marketplace],
        plugins: [recordOverride],
        marketplaceUpdates: [automaticPolicy],
      }, projectScope, sha256),
      corruptions: [],
    };
  };
  return { projectScope, projectRef, record, revisionOldP, revisionNewP, baselineGrant, snapshot };
}

describe("automatic trust continuity", () => {
  it("chains the exact grant for the selected revision under automatic policy with a granted baseline", async () => {
    const { service, replacement } = setup(userSnapshot({ policyRecord: automaticPolicy }));
    await expect(service.ensure(scope, signal)).resolves.toEqual({ kind: "ensured", granted: [candidateNew.subject] });
    expect(replacement()?.trust?.records).toHaveLength(2);
    expect(replacement()?.trust?.records).toContainEqual(expect.objectContaining({ subject: candidateNew.subject, status: "granted" }));
    expect(replacement()?.trust?.records).toContainEqual(expect.objectContaining({ subject: candidateOld.subject, status: "granted" }));
  });

  it("does nothing when the selected revision is already granted exactly", async () => {
    const { service, runPreparedMutation } = setup(userSnapshot({ policyRecord: automaticPolicy, records: [baseline, grantTrust(candidateNew, sha256)] }));
    await expect(service.ensure(scope, signal)).resolves.toEqual({ kind: "ensured", granted: [] });
    expect(runPreparedMutation).not.toHaveBeenCalled();
  });

  it("never overrides an exact revocation of the selected revision", async () => {
    const { service, runPreparedMutation } = setup(userSnapshot({ policyRecord: automaticPolicy, records: [baseline, revokeTrust(candidateNew, sha256)] }));
    await expect(service.ensure(scope, signal)).resolves.toEqual({ kind: "ensured", granted: [] });
    expect(runPreparedMutation).not.toHaveBeenCalled();
  });

  it("requires a granted lineage baseline before chaining", async () => {
    const { service, runPreparedMutation } = setup(userSnapshot({ policyRecord: automaticPolicy, records: [] }));
    await expect(service.ensure(scope, signal)).resolves.toEqual({ kind: "ensured", granted: [] });
    expect(runPreparedMutation).not.toHaveBeenCalled();
  });

  it("skips plugins whose effective policy is manual", async () => {
    const { service, runPreparedMutation } = setup(userSnapshot({ policyRecord: createMarketplaceConfigurationRecord({ marketplace: "community", source: declaredSource }) }));
    await expect(service.ensure(scope, signal)).resolves.toEqual({ kind: "ensured", granted: [] });
    expect(runPreparedMutation).not.toHaveBeenCalled();
  });

  it("skips revisions whose source identity no longer matches the registered marketplace", async () => {
    const foreignRevision = createInstalledRevisionRecord({
      plugin: pluginNew,
      compatibility,
      content,
      scope,
      marketplaceSourceIdentity: deriveMarketplaceSourceIdentity({ kind: "github", repository: "example/elsewhere" }, sha256),
      pluginSourceIdentity: pluginIdentity,
    }, sha256);
    const record = createInstalledPluginRecord({
      plugin: "fixture@community",
      activation: "enabled",
      selectedRevision: foreignRevision.revision,
      revisions: [revisionOld, foreignRevision],
      scope,
    }, sha256);
    const { service, runPreparedMutation } = setup(userSnapshot({ policyRecord: automaticPolicy, plugins: [record] }));
    await expect(service.ensure(scope, signal)).resolves.toEqual({ kind: "ensured", granted: [] });
    expect(runPreparedMutation).not.toHaveBeenCalled();
  });

  it("chains grants for project-scope plugins into user trust state when the project is trusted", async () => {
    const identity = { kind: "path-only" as const, canonicalRoot: "file:///project/", limitation: "identity-changes-with-canonical-root" as const };
    const projectScope: Extract<ScopeContext, { kind: "project" }> = { kind: "project", identity, projectKey: deriveProjectKey(identity, sha256) };
    const projectRef = { kind: "project" as const, projectKey: projectScope.projectKey };
    const projectRevisionOld = revisionAt(pluginOld, compatibilityOld, projectRef);
    const projectRevisionNew = revisionAt(pluginNew, compatibility, projectRef);
    const projectRecord = createInstalledPluginRecord({
      plugin: "fixture@community",
      activation: "enabled",
      selectedRevision: projectRevisionNew.revision,
      revisions: [projectRevisionOld, projectRevisionNew],
      scope: projectRef,
    }, sha256);
    const projectBaseline = grantTrust(createTrustCandidate({
      scope: projectRef,
      marketplaceSource: marketplaceSourceOld,
      plugin: pluginOld,
      compatibility: compatibilityOld,
      content,
      materializationBinding: bindingOld,
    }, sha256), sha256);
    const generation = GenerationSchema.parse(0);
    const projectSnapshot: GenerationSnapshot = {
      scope: projectScope,
      generation,
      pointers: pointers(generation, projectScope.projectKey),
      project: createProjectLocalStateDocument({
        schemaVersion: 4,
        generation,
        projectKey: projectScope.projectKey,
        identity,
        declarationDigest: content.rootDigest,
        scope: {},
        marketplaces: [marketplace],
        plugins: [projectRecord],
        marketplaceUpdates: [automaticPolicy],
      }, projectScope, sha256),
      corruptions: [],
    };
    const user = userSnapshot({ application: "automatic", records: [projectBaseline], plugins: [] });
    const { service, replacement, requests } = setup(user, { snapshot: projectSnapshot, trusted: true });
    const result = await service.ensure(projectScope, signal);
    expect(result.kind).toBe("ensured");
    expect((result as { granted: readonly string[] }).granted).toHaveLength(1);
    expect(replacement()?.trust?.records).toHaveLength(2);
    // Trust authority is user state even for project-scope plugins.
    expect(requests[0]).toMatchObject({ scope: { kind: "user" } });
  });

  it("isolates an unloadable plugin and still grants the others in one mutation", async () => {
    // A distinct plugin path keeps the other plugin's revision digests
    // distinct from the fixture plugin's (source path participates in the
    // materialization binding).
    const otherPluginAt = (revision: string) => NormalizedPluginSchema.parse({
      identity: { key: "other@community", marketplaceName: "community", marketplaceEntryName: "other" },
      source: createResolvedPluginSource({ kind: "marketplace-path", marketplaceRevision: revision, path: "other" }, sha256),
      configuration: { options: [] },
      components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
      metadata: [],
    });
    const otherOld = otherPluginAt(oldRevision);
    const otherNew = otherPluginAt(newRevision);
    const otherCompatOld = CompatibilityReportSchema.parse({ ...compatibility, plugin: otherOld.identity });
    const otherCompat = CompatibilityReportSchema.parse({ ...compatibility, plugin: otherNew.identity });
    const otherRevisionOld = revisionAt(otherOld, otherCompatOld, scope);
    const otherRevisionNew = revisionAt(otherNew, otherCompat, scope);
    const otherBindingOld = createMaterializationBinding(otherOld.source.hash, content.rootDigest, sha256);
    const otherBaseline = grantTrust(createTrustCandidate({
      scope,
      marketplaceSource: marketplaceSourceOld,
      plugin: otherOld,
      compatibility: otherCompatOld,
      content,
      materializationBinding: otherBindingOld,
    }, sha256), sha256);
    const broken = createInstalledPluginRecord({
      plugin: "fixture@community",
      activation: "enabled",
      selectedRevision: revisionNew.revision,
      revisions: [revisionOld, revisionNew],
      scope,
    }, sha256);
    const healthy = createInstalledPluginRecord({
      plugin: "other@community",
      activation: "enabled",
      selectedRevision: otherRevisionNew.revision,
      revisions: [otherRevisionOld, otherRevisionNew],
      scope,
    }, sha256);
    let replacement: { trust?: { records: readonly unknown[] } } | undefined;
    const runPreparedMutation = vi.fn(async (_request: unknown, prepare: (context: unknown) => Promise<{ mutation: { replace: never }; value: unknown }>) => {
      const prepared = await prepare({ snapshot: userSnapshot({ policyRecord: automaticPolicy, records: [baseline, otherBaseline], plugins: [broken, healthy] }), assertOwned: async () => undefined });
      replacement = prepared.mutation.replace;
      return { kind: "committed" as const, value: prepared.value };
    });
    const service = createAutomaticTrustContinuity({
      state: { async read() { return { ok: true as const, snapshot: userSnapshot({ policyRecord: automaticPolicy, records: [baseline, otherBaseline], plugins: [broken, healthy] }) }; } } as never,
      mutations: { runPreparedMutation } as never,
      installed: {
        async load(request: { revision: { revision: string } }) {
          // The fixture plugin's retained content is unavailable; the other
          // plugin loads cleanly.
          if (request.revision.revision === revisionNew.revision) throw new Error("retained content unavailable");
          if (request.revision.revision !== otherRevisionNew.revision) throw new Error("unexpected revision load");
          return { plugin: otherNew, compatibility: otherCompat, marketplaceSource: marketplaceSourceNew, content, binding: createMaterializationBinding(otherNew.source.hash, content.rootDigest, sha256) };
        },
      } as never,
      sha256,
    });
    const result = await service.ensure(scope, signal);
    expect(result.kind).toBe("ensured");
    expect((result as { granted: readonly string[] }).granted).toHaveLength(1);
    expect(runPreparedMutation).toHaveBeenCalledTimes(1);
    expect(replacement?.trust?.records).toHaveLength(3);
  });

  it("retries once on a stale generation and then commits", async () => {
    const snapshot = userSnapshot({ policyRecord: automaticPolicy });
    let calls = 0;
    const service = createAutomaticTrustContinuity({
      state: { async read() { return { ok: true as const, snapshot }; } } as never,
      mutations: {
        async runPreparedMutation(_request: unknown, prepare: (context: unknown) => Promise<{ mutation: { replace: never }; value: unknown }>) {
          calls += 1;
          const prepared = await prepare({ snapshot, assertOwned: async () => undefined });
          if (calls === 1) return { kind: "stale-generation" as const, expected: 0, actual: 1 };
          return { kind: "committed" as const, value: prepared.value, snapshot };
        },
      } as never,
      installed: { async load() { return { plugin: pluginNew, compatibility, marketplaceSource: marketplaceSourceNew, content, binding: bindingNew }; } } as never,
      sha256,
    });
    await expect(service.ensure(scope, signal)).resolves.toEqual({ kind: "ensured", granted: [candidateNew.subject] });
    expect(calls).toBe(2);
  });

  it("skips a subject a concurrent session granted while the mutation was locked", async () => {
    const planning = userSnapshot({ policyRecord: automaticPolicy });
    const concurrent = userSnapshot({ policyRecord: automaticPolicy, records: [baseline, grantTrust(candidateNew, sha256)] });
    const service = createAutomaticTrustContinuity({
      state: { async read() { return { ok: true as const, snapshot: planning }; } } as never,
      mutations: {
        async runPreparedMutation(_request: unknown, prepare: (context: unknown) => Promise<{ mutation: { replace: never }; value: unknown }>) {
          const prepared = await prepare({ snapshot: concurrent, assertOwned: async () => undefined });
          return { kind: "committed" as const, value: prepared.value, snapshot: concurrent };
        },
      } as never,
      installed: { async load() { return { plugin: pluginNew, compatibility, marketplaceSource: marketplaceSourceNew, content, binding: bindingNew }; } } as never,
      sha256,
    });
    // The grant was planned against the stale read but re-adjudicated away
    // inside the locked snapshot.
    await expect(service.ensure(scope, signal)).resolves.toEqual({ kind: "ensured", granted: [] });
  });

  it("skips project-scope chaining while the project is untrusted", async () => {
    const identity = { kind: "path-only" as const, canonicalRoot: "file:///project/", limitation: "identity-changes-with-canonical-root" as const };
    const projectScope: Extract<ScopeContext, { kind: "project" }> = { kind: "project", identity, projectKey: deriveProjectKey(identity, sha256) };
    const projectRef = { kind: "project" as const, projectKey: projectScope.projectKey };
    const projectRecord = createInstalledPluginRecord({
      plugin: "fixture@community",
      activation: "enabled",
      selectedRevision: revisionAt(pluginNew, compatibility, projectRef).revision,
      revisions: [revisionAt(pluginOld, compatibilityOld, projectRef), revisionAt(pluginNew, compatibility, projectRef)],
      scope: projectRef,
    }, sha256);
    const projectBaseline = grantTrust(createTrustCandidate({
      scope: projectRef,
      marketplaceSource: marketplaceSourceOld,
      plugin: pluginOld,
      compatibility: compatibilityOld,
      content,
      materializationBinding: bindingOld,
    }, sha256), sha256);
    const generation = GenerationSchema.parse(0);
    const projectSnapshot: GenerationSnapshot = {
      scope: projectScope,
      generation,
      pointers: pointers(generation, projectScope.projectKey),
      project: createProjectLocalStateDocument({
        schemaVersion: 4,
        generation,
        projectKey: projectScope.projectKey,
        identity,
        declarationDigest: content.rootDigest,
        scope: {},
        marketplaces: [marketplace],
        plugins: [projectRecord],
        marketplaceUpdates: [automaticPolicy],
      }, projectScope, sha256),
      corruptions: [],
    };
    const user = userSnapshot({ application: "automatic", records: [projectBaseline], plugins: [] });
    const { service, runPreparedMutation } = setup(user, { snapshot: projectSnapshot, trusted: false });
    await expect(service.ensure(projectScope, signal)).resolves.toEqual({ kind: "ensured", granted: [] });
    expect(runPreparedMutation).not.toHaveBeenCalled();
  });

  it("aborts the grant when project trust flips between planning and commit", async () => {
    const fixture = projectFixture();
    const user = userSnapshot({ application: "automatic", records: [fixture.baselineGrant], plugins: [] });
    let assessments = 0;
    const service = createAutomaticTrustContinuity({
      state: {
        async read(readScope: ScopeContext) {
          if (readScope.kind === "project") return { ok: true as const, snapshot: fixture.snapshot() };
          return { ok: true as const, snapshot: user };
        },
      } as never,
      mutations: {
        async runPreparedMutation(_request: unknown, prepare: (context: unknown) => Promise<{ mutation: unknown; value: unknown; beforeCommit?: () => Promise<void> }>) {
          const prepared = await prepare({ snapshot: user, assertOwned: async () => undefined });
          await prepared.beforeCommit?.();
          return { kind: "committed" as const, value: prepared.value, snapshot: user };
        },
      } as never,
      installed: { async load() { return { plugin: pluginNew, compatibility, marketplaceSource: marketplaceSourceNew, content, binding: bindingNew }; } } as never,
      projectTrust: {
        // Trusted during planning, untrusted by the time the grant commits.
        async assess() { assessments += 1; return { kind: assessments === 1 ? "trusted" as const : "untrusted" as const }; },
      },
      sha256,
    });
    await expect(service.ensure(fixture.projectScope, signal)).resolves.toEqual({ kind: "ensured", granted: [] });
  });

  it("replans when the project's selected revision moves between planning and commit", async () => {
    const fixture = projectFixture();
    const user = userSnapshot({ application: "automatic", records: [fixture.baselineGrant], plugins: [] });
    // The concurrently visible project already selected the previously
    // granted revision, so the replanned grant set is empty.
    const moved = createInstalledPluginRecord({
      plugin: "fixture@community",
      activation: "enabled",
      selectedRevision: fixture.revisionOldP.revision,
      revisions: [fixture.revisionOldP, fixture.revisionNewP],
      scope: fixture.projectRef,
    }, sha256);
    let projectReads = 0;
    const service = createAutomaticTrustContinuity({
      state: {
        async read(readScope: ScopeContext) {
          if (readScope.kind === "project") {
            projectReads += 1;
            return { ok: true as const, snapshot: projectReads === 1 ? fixture.snapshot() : fixture.snapshot(moved) };
          }
          return { ok: true as const, snapshot: user };
        },
      } as never,
      mutations: {
        async runPreparedMutation(_request: unknown, prepare: (context: unknown) => Promise<{ mutation: unknown; value: unknown; beforeCommit?: () => Promise<void> }>) {
          const prepared = await prepare({ snapshot: user, assertOwned: async () => undefined });
          await prepared.beforeCommit?.();
          return { kind: "committed" as const, value: prepared.value, snapshot: user };
        },
      } as never,
      installed: { async load() { return { plugin: pluginNew, compatibility, marketplaceSource: marketplaceSourceNew, content, binding: bindingNew }; } } as never,
      projectTrust: { async assess() { return { kind: "trusted" as const }; } },
      sha256,
    });
    // No grant for the stale plan; the retried plan is already adjudicated.
    await expect(service.ensure(fixture.projectScope, signal)).resolves.toEqual({ kind: "ensured", granted: [] });
  });

  it("never chains across projects: a baseline granted for one project does not authorize another", async () => {
    const projectA = projectFixture("file:///project-a/");
    const projectB = projectFixture("file:///project-b/");
    const user = userSnapshot({ application: "automatic", records: [projectA.baselineGrant], plugins: [] });
    const { service, runPreparedMutation } = setup(user, { snapshot: projectB.snapshot(), trusted: true });
    await expect(service.ensure(projectB.projectScope, signal)).resolves.toEqual({ kind: "ensured", granted: [] });
    expect(runPreparedMutation).not.toHaveBeenCalled();
  });
});
