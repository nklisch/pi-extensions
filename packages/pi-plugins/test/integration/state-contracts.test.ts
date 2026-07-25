import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CompatibilityReportSchema,
  ContentDigestSchema,
  GenerationSchema,
  HostConfigDocumentSchema,
  InstalledUserStateDocumentSchema,
  MarketplaceNameSchema,
  ProjectIdentitySchema,
  PortableProjectDeclarationSchema,
  ProjectLocalStateDocumentSchema,
  StatePointersDocumentSchema,
  StateMutationInputSchema,
  StateCodecError,
  TrustStateDocumentSchema,
  createContentManifest,
  createMarketplaceConfigurationRecord,
  createMarketplaceSnapshotRecord,
  createMaterializationBinding,
  createInstalledUserStateDocument,
  createProjectLocalStateDocument,
  createStatePointersDocument,
  decodeStateDocument,
  deriveProjectKey,
  deriveStateBlobRef,
  encodeStateDocument,
  hashContent,
  parsePortableProjectDeclaration,
  isVerifiedStateMutation,
  parseStateMutation,
  type Generation,
  type LifecycleStateStore,
  type ProjectGenerationSnapshot,
  type ProjectIdentity,
  type ProjectScopeContext,
  type ScopeContext,
  type Sha256,
  type StateCommitResult,
  type StateLoadResult,
  type VerifiedStateMutation as VerifiedStateMutationType,
  type UserGenerationSnapshot,
} from "../../src/index.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import {
  createResolvedMarketplaceSource,
  createResolvedPluginSource,
  MarketplaceSourceSchema,
} from "../../src/domain/source.js";
import { claim, type Provenance } from "../../src/domain/provenance.js";

const root = process.cwd();
const sha256: Sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const digest = ContentDigestSchema.parse(`sha256:${"00".repeat(32)}`);
const text = (value: string) => new TextEncoder().encode(value);
const location: Provenance = {
  location: { host: "claude", documentKind: "manifest", path: ".claude-plugin/plugin.json", pointer: "" },
};

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(resolve(root, "test/fixtures/state", path), "utf8")) as unknown;
}

function pointer(scope: ScopeContext, generation: Generation, kind: "hostConfig" | "installedUser" | "trust" | "projectLocal") {
  return {
    kind,
    generation,
    blob: deriveStateBlobRef({ document: kind, scope: scope.kind, generation }, sha256),
    digest,
  };
}

function pointers(scope: ScopeContext, generation: Generation) {
  const scopeReference = scope.kind === "user"
    ? { kind: "user" as const }
    : { kind: "project" as const, projectKey: scope.projectKey };
  const documents = scope.kind === "user"
    ? [
      pointer(scope, generation, "hostConfig"),
      pointer(scope, generation, "installedUser"),
      pointer(scope, generation, "trust"),
    ]
    : [pointer(scope, generation, "projectLocal")];
  return createStatePointersDocument({
    schemaVersion: 1,
    scope: scopeReference,
    generation,
    documents,
  });
}

const pluginSource = createResolvedPluginSource({
  kind: "git",
  url: "https://example.com/demo.git",
  revision: "a".repeat(40),
}, sha256);
const plugin = NormalizedPluginSchema.parse({
  identity: {
    key: "demo@community",
    marketplaceName: "community",
    marketplaceEntryName: "demo",
  },
  version: claim("1.0.0", location),
  source: pluginSource,
  configuration: { options: [] },
  components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
  metadata: [],
});
const report = CompatibilityReportSchema.parse({
  plugin: plugin.identity,
  activatable: true,
  components: [],
  requirements: [],
  diagnostics: [],
});
const content = createContentManifest([{
  kind: "file",
  path: "README.md",
  mode: 0o644,
  size: 7,
  digest: hashContent(text("content"), sha256),
}], sha256);
const marketplaceSource = createResolvedMarketplaceSource({
  declared: { kind: "github", repository: "example/marketplace" },
  revision: "b".repeat(40),
}, sha256);
const marketplace = {
  marketplace: MarketplaceNameSchema.parse("community"),
  source: marketplaceSource,
  content,
};
const pluginRevision = { plugin, compatibility: report, content };

const projectIdentity: ProjectIdentity = ProjectIdentitySchema.parse({
  kind: "repository",
  canonicalRoot: "file:///workspace/project/",
  repositoryFingerprint: `sha256:${"9".repeat(64)}`,
});
const projectKey = deriveProjectKey(projectIdentity, sha256);
const projectScope: ProjectScopeContext = {
  kind: "project",
  identity: projectIdentity,
  projectKey,
};
const userScope = { kind: "user" as const };
const generation0 = GenerationSchema.parse(0);
const generation4 = GenerationSchema.parse(4);

function makeUserSnapshot(generation: Generation): UserGenerationSnapshot {
  const config = HostConfigDocumentSchema.parse({
    schemaVersion: 4,
    generation,
    records: [createMarketplaceConfigurationRecord({
      marketplace: MarketplaceNameSchema.parse("community"),
      source: MarketplaceSourceSchema.parse({ kind: "github", repository: "example/marketplace" }),
    })],
  });
  const installed = createInstalledUserStateDocument({
    generation,
    marketplaces: [marketplace],
    plugins: [{
      plugin: plugin.identity.key,
      activation: "enabled",
      revisions: [pluginRevision],
    }],
  }, sha256);
  const trust = TrustStateDocumentSchema.parse({ schemaVersion: 1, generation, records: [] });
  return {
    scope: userScope,
    generation,
    pointers: pointers(userScope, generation),
    config,
    installed,
    trust,
    corruptions: [],
  };
}

function makeProjectSnapshot(generation: Generation): ProjectGenerationSnapshot {
  const project = createProjectLocalStateDocument({
    schemaVersion: 4,
    generation,
    projectKey,
    identity: projectIdentity,
    declarationDigest: content.rootDigest,
    marketplaces: [marketplace],
    plugins: [{
      plugin: plugin.identity.key,
      activation: "enabled",
      revisions: [pluginRevision],
    }],
  }, projectScope, sha256);
  return {
    scope: projectScope,
    generation,
    pointers: pointers(projectScope, generation),
    project,
    corruptions: [],
  };
}

/** A deliberately tiny fake that implements only the public state port. */
class FakeLifecycleStateStore implements LifecycleStateStore {
  private user: UserGenerationSnapshot;
  private project: ProjectGenerationSnapshot;

  constructor() {
    this.user = makeUserSnapshot(generation0);
    this.project = makeProjectSnapshot(generation0);
  }

  async read(scope: ScopeContext, signal: AbortSignal): Promise<StateLoadResult> {
    if (signal.aborted) throw signal.reason;
    if (scope.kind === "user") return { ok: true, snapshot: this.user };
    if (scope.projectKey !== this.project.scope.projectKey) {
      return {
        ok: false,
        scope,
        corruptions: [{
          document: "projectLocal",
          scope: { kind: "project", projectKey: scope.projectKey },
          code: "SCOPE_MISMATCH",
          summary: "state document scope is not selected",
        }],
      };
    }
    return { ok: true, snapshot: this.project };
  }

  async commit(mutation: VerifiedStateMutationType, signal: AbortSignal): Promise<StateCommitResult> {
    if (signal.aborted) throw signal.reason;
    if (!isVerifiedStateMutation(mutation)) {
      throw new TypeError("lifecycle state store requires a verified mutation");
    }
    const validated = mutation;
    if (validated.scope.kind === "user") {
      if (validated.expectedGeneration !== this.user.generation) {
        return { kind: "stale-generation", expected: validated.expectedGeneration, actual: this.user.generation };
      }
      const next = GenerationSchema.parse(validated.expectedGeneration + 1);
      const replacement = validated.replace;
      if ("project" in replacement) throw new Error("user mutation contains a project replacement");
      this.user = {
        ...this.user,
        generation: next,
        pointers: pointers(userScope, next),
        config: replacement.config === undefined ? { ...this.user.config, generation: next } : { ...replacement.config, generation: next },
        installed: replacement.installed === undefined ? { ...this.user.installed, generation: next } : { ...replacement.installed, generation: next },
        trust: replacement.trust === undefined ? { ...this.user.trust, generation: next } : { ...replacement.trust, generation: next },
      };
      return { kind: "committed", snapshot: this.user };
    }
    if (validated.expectedGeneration !== this.project.generation) {
      return { kind: "stale-generation", expected: validated.expectedGeneration, actual: this.project.generation };
    }
    const next = GenerationSchema.parse(validated.expectedGeneration + 1);
    if (!("project" in validated.replace)) throw new Error("project mutation is missing a project replacement");
    const project = createProjectLocalStateDocument({
      ...validated.replace.project,
      generation: next,
    }, this.project.scope, sha256);
    this.project = { ...this.project, generation: next, pointers: pointers(this.project.scope, next), project };
    return { kind: "committed", snapshot: this.project };
  }
}

describe("state contract integration", () => {
  it("loads every current fixture through strict envelopes", () => {
    expect(HostConfigDocumentSchema.parse(fixture("v1/valid/host-config.json"))).toBeTruthy();
    expect(InstalledUserStateDocumentSchema.parse(fixture("v1/valid/installed-user.json"))).toBeTruthy();
    expect(TrustStateDocumentSchema.parse(fixture("v1/valid/trust.json"))).toBeTruthy();
    expect(ProjectLocalStateDocumentSchema.parse(fixture("v1/valid/project-local.json"))).toBeTruthy();
    expect(StatePointersDocumentSchema.parse(fixture("v1/valid/pointers-user.json"))).toBeTruthy();
    expect(StatePointersDocumentSchema.parse(fixture("v1/valid/pointers-project.json"))).toBeTruthy();
    expect(PortableProjectDeclarationSchema.parse(fixture("portable/valid.json"))).toBeTruthy();
  });

  it("quarantines mixed records while fatal roots expose no partial snapshot", () => {
    const decoded = decodeStateDocument("hostConfig", fixture("v1/corrupt/host-config-mixed.json"), {
      scope: userScope,
      generation: generation0,
      sha256,
    });
    expect(decoded.value.records.map((record) => record.marketplace)).toEqual(["alpha"]);
    expect(decoded.corruptions.map((entry) => entry.code)).toEqual([
      "RECORD_DUPLICATE",
      "RECORD_INVALID",
      "RECORD_DUPLICATE",
      "RECORD_INVALID",
    ]);

    const userState = makeUserSnapshot(generation0).installed;
    const userWithCorruptSibling = decodeStateDocument("installedUser", {
      ...userState,
      plugins: [
        userState.plugins[0],
        { ...userState.plugins[0], plugin: "other@community", activation: "corrupt" },
      ],
    }, { scope: userScope, generation: generation0, sha256 });
    expect(userWithCorruptSibling.value.plugins.map((entry) => entry.plugin)).toEqual([plugin.identity.key]);
    expect(userWithCorruptSibling.corruptions).toHaveLength(1);

    const projectState = makeProjectSnapshot(generation0).project;
    const projectWithCorruptSibling = decodeStateDocument("projectLocal", {
      ...projectState,
      plugins: [
        projectState.plugins[0],
        { ...projectState.plugins[0], plugin: "other@community", activation: "corrupt" },
      ],
    }, { scope: projectScope, generation: generation0, sha256 });
    expect(projectWithCorruptSibling.value.plugins.map((entry) => entry.plugin)).toEqual([plugin.identity.key]);
    expect(projectWithCorruptSibling.corruptions).toHaveLength(1);

    const otherSource = createResolvedMarketplaceSource({ declared: { kind: "github", repository: "example/shared" }, revision: "c".repeat(40) }, sha256);
    const thirdSource = createResolvedMarketplaceSource({ declared: { kind: "github", repository: "example/third" }, revision: "d".repeat(40) }, sha256);
    const otherSnapshot = createMarketplaceSnapshotRecord({ marketplace: "other", source: otherSource, content, binding: createMaterializationBinding(otherSource.hash, content.rootDigest, sha256) }, sha256);
    const thirdSnapshot = createMarketplaceSnapshotRecord({ marketplace: "third", source: thirdSource, content, binding: createMaterializationBinding(thirdSource.hash, content.rootDigest, sha256) }, sha256);
    const registration = (marketplaceName: string, repository: string) => ({
      marketplace: marketplaceName,
      source: { kind: "github" as const, repository },
      origin: { kind: "native" as const },
    });
    const projectWithRegistrationCorruption = decodeStateDocument("projectLocal", {
      ...projectState,
      schemaVersion: 4,
      marketplaces: [...projectState.marketplaces, otherSnapshot, thirdSnapshot],
      marketplaceUpdates: [
        registration("community", "example/marketplace"),
        registration("other", "example/shared"),
        registration("other", "example/other-duplicate"),
        registration("third", "example/shared"),
        { ...registration("broken", "example/broken"), source: { kind: "local-git", path: "/tmp/broken" } },
      ],
    }, { scope: projectScope, generation: generation0, sha256 });
    expect(projectWithRegistrationCorruption.value.marketplaceUpdates.map((entry) => entry.marketplace)).toEqual(["community"]);
    expect(projectWithRegistrationCorruption.value.plugins.map((entry) => entry.plugin)).toEqual([plugin.identity.key]);
    expect(projectWithRegistrationCorruption.corruptions.map((entry) => entry.code)).toEqual([
      "RECORD_DUPLICATE",
      "RECORD_DUPLICATE",
      "RECORD_DUPLICATE",
      "RECORD_INVALID",
    ]);

    expect(() => decodeStateDocument("pointers", fixture("v1/corrupt/pointers-fatal.json"), {
      scope: userScope,
      generation: generation4,
      sha256,
    })).toThrowError(StateCodecError);
    try {
      decodeStateDocument("pointers", fixture("v1/corrupt/pointers-fatal.json"), {
        scope: userScope,
        generation: generation4,
        sha256,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(StateCodecError);
      expect(JSON.stringify((error as StateCodecError).corruption)).not.toContain("/var/lib");
      expect(JSON.stringify(error)).not.toContain("nativeCause");
    }
  });

  it("cuts stale document versions over to empty defaults and rejects portable canaries without partial intent", () => {
    const cutover = decodeStateDocument("hostConfig", fixture("v1/corrupt/future-version.json"), {
      scope: userScope,
      generation: generation0,
      sha256,
    });
    expect(cutover.value).toEqual(HostConfigDocumentSchema.parse({ schemaVersion: 4, generation: 0, records: [] }));
    expect(cutover.corruptions).toEqual([]);
    expect(() => decodeStateDocument("pointers", fixture("v1/corrupt/scope-mismatch.json"), {
      scope: userScope,
      generation: generation0,
      sha256,
    })).toThrowError(StateCodecError);
    expect(() => decodeStateDocument("hostConfig", fixture("v1/corrupt/digest-mismatch.json"), {
      scope: userScope,
      generation: generation0,
      sha256,
      expectedDigest: ContentDigestSchema.parse(`sha256:${"ff".repeat(32)}`),
    })).toThrowError(StateCodecError);
    const canaries = JSON.stringify(fixture("portable/prohibited-canaries.json"));
    expect(() => parsePortableProjectDeclaration(fixture("portable/prohibited-canaries.json"))).toThrow();
    expect(() => parsePortableProjectDeclaration(fixture("portable/timestamps.json"))).toThrow();
    expect(canaries).toContain("CANARY_SECRET_VALUE");
    expect(JSON.stringify(PortableProjectDeclarationSchema.safeParse(fixture("portable/prohibited-canaries.json")))).not.toContain("CANARY_SECRET_VALUE");
  });

  it("encodes records and nested object keys deterministically", () => {
    const left = HostConfigDocumentSchema.parse({
      schemaVersion: 4,
      generation: generation0,
      records: [
        createMarketplaceConfigurationRecord({ marketplace: MarketplaceNameSchema.parse("team"), source: MarketplaceSourceSchema.parse({ kind: "github", repository: "example/plugins" }) }),
        createMarketplaceConfigurationRecord({ marketplace: MarketplaceNameSchema.parse("alpha"), source: MarketplaceSourceSchema.parse({ kind: "github", repository: "example/alpha" }), applicationOverride: "automatic" }),
      ],
    });
    const right = HostConfigDocumentSchema.parse({
      schemaVersion: 4,
      generation: generation0,
      records: [
        { ...createMarketplaceConfigurationRecord({ marketplace: MarketplaceNameSchema.parse("alpha"), source: MarketplaceSourceSchema.parse({ kind: "github", repository: "example/alpha" }), applicationOverride: "automatic" }) },
        { ...createMarketplaceConfigurationRecord({ marketplace: MarketplaceNameSchema.parse("team"), source: MarketplaceSourceSchema.parse({ kind: "github", repository: "example/plugins" }) }) },
      ],
    });
    const context = { scope: userScope, generation: generation0, sha256 };
    expect(JSON.stringify(encodeStateDocument("hostConfig", left, context))).toBe(
      JSON.stringify(encodeStateDocument("hostConfig", right, context)),
    );
    expect(JSON.stringify(encodeStateDocument("hostConfig", left, context))).toBe(
      JSON.stringify(encodeStateDocument("hostConfig", left, context)),
    );
  });

  it("round-trips complete user and independent project evidence through only the public store port", async () => {
    const store = new FakeLifecycleStateStore();
    const controller = new AbortController();
    const user = await store.read(userScope, controller.signal);
    const project = await store.read(projectScope, controller.signal);
    if (!user.ok || !project.ok) throw new Error("fake store did not return snapshots");
    if (!("installed" in user.snapshot) || !("project" in project.snapshot)) {
      throw new Error("fake store returned the wrong scope snapshot");
    }
    expect(user.snapshot.installed.plugins[0]?.revisions[0]?.evidence.plugin).toEqual(plugin.identity);
    expect(project.snapshot.project.plugins[0]?.revisions[0]?.evidence.compatibility.activatable).toBe(true);
    expect(user.snapshot.installed.plugins[0]!.revisions[0]!.dataRef)
      .not.toBe(project.snapshot.project.plugins[0]!.revisions[0]!.dataRef);

    const nextConfig = { ...user.snapshot.config, records: user.snapshot.config.records.map((record) => ({ ...record, applicationOverride: "automatic" as const })) };
    const committed = await store.commit(parseStateMutation({
      scope: userScope,
      expectedGeneration: user.snapshot.generation,
      replace: { config: nextConfig },
    }, sha256), controller.signal);
    expect(committed.kind).toBe("committed");
    if (committed.kind !== "committed" || !("installed" in committed.snapshot)) throw new Error("user commit failed");
    expect(committed.snapshot.generation).toBe(1);
    expect(committed.snapshot.installed.plugins).toHaveLength(1);
    expect((await store.commit(parseStateMutation({
      scope: userScope,
      expectedGeneration: 0,
      replace: { config: nextConfig },
    }, sha256), controller.signal)).kind).toBe("stale-generation");

    const projectMutation = parseStateMutation({
      scope: projectScope,
      expectedGeneration: project.snapshot.generation,
      replace: { project: project.snapshot.project },
    }, sha256);
    const projectCommit = await store.commit(projectMutation, controller.signal);
    expect(projectCommit.kind).toBe("committed");
    expect((await store.read(userScope, controller.signal)).ok).toBe(true);
  });

  it("rejects a structurally valid but unverified mutation at the store boundary", async () => {
    const store = new FakeLifecycleStateStore();
    const controller = new AbortController();
    const structural = StateMutationInputSchema.parse({
      scope: userScope,
      expectedGeneration: generation0,
      replace: { config: makeUserSnapshot(generation0).config },
    });
    expect(isVerifiedStateMutation(structural)).toBe(false);
    await expect(store.commit(
      structural as unknown as VerifiedStateMutationType,
      controller.signal,
    )).rejects.toThrow("verified mutation");
  });

  it("propagates cancellation from the port without converting it to state corruption", async () => {
    const store = new FakeLifecycleStateStore();
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    controller.abort(reason);
    await expect(store.read(userScope, controller.signal)).rejects.toBe(reason);
    await expect(store.commit(parseStateMutation({
      scope: userScope,
      expectedGeneration: generation0,
      replace: { config: makeUserSnapshot(generation0).config },
    }, sha256), controller.signal)).rejects.toBe(reason);
  });

  it("keeps state serialization free of operational canaries", async () => {
    const serialized = JSON.stringify(makeUserSnapshot(generation0));
    for (const canary of ["CANARY_SECRET_VALUE", "authorization", "x-api-key", "generatedProjection", "NODE_ENV", "/var/lib", "2026-07-12T00:00:00.000Z", "nativeCause"]) {
      expect(serialized.toLowerCase()).not.toContain(canary.toLowerCase());
    }
  });
});
