import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createMarketplaceRegistrationService } from "../../src/application/marketplace-registration-service.js";
import { createContentManifest, createMaterializationBinding } from "../../src/domain/content-manifest.js";
import { createResolvedMarketplaceSource, type MarketplaceSource, type Sha256 } from "../../src/domain/source.js";
import { HostConfigDocumentSchema, GenerationSchema } from "../../src/domain/state/config-state.js";
import { InstalledUserStateDocumentSchema } from "../../src/domain/state/installed-state.js";
import { TrustStateDocumentSchema } from "../../src/domain/state/trust-state.js";
import { StatePointersDocumentSchema } from "../../src/domain/state/pointers.js";
import { deriveStateBlobRef } from "../../src/domain/state/references.js";
import { readClaudeMarketplace } from "../../src/formats/claude/marketplace-reader.js";
import type { GenerationSnapshot } from "../../src/application/state-contract.js";
import { createProjectLocalStateDocument } from "../../src/domain/state/project-state.js";
import { deriveProjectKey } from "../../src/domain/state/scope.js";

const sha256: Sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const digest = (value: string) => `sha256:${value.repeat(64)}` as `sha256:${string}`;

function environment(options: Readonly<{ abortAfterCommit?: AbortController; ambiguousAfterCommit?: boolean }> = {}) {
  const generation = GenerationSchema.parse(0);
  let current: Extract<GenerationSnapshot, { scope: { kind: "user" } }> = {
    scope: { kind: "user" },
    generation,
    pointers: StatePointersDocumentSchema.parse({
      schemaVersion: 1,
      scope: { kind: "user" },
      generation,
      documents: ["hostConfig", "installedUser", "trust"].map((document) => ({
        kind: document,
        generation,
        blob: deriveStateBlobRef({ document, scope: "user", generation }, sha256),
        digest: digest("a"),
      })),
    }),
    config: HostConfigDocumentSchema.parse({
      schemaVersion: 4,
      generation,
      global: { application: "manual", cadence: "balanced" },
      scope: {},
      records: [],
    }),
    installed: InstalledUserStateDocumentSchema.parse({ schemaVersion: 2, generation, marketplaces: [], plugins: [] }),
    trust: TrustStateDocumentSchema.parse({ schemaVersion: 1, generation, records: [] }),
    corruptions: [],
  };
  const content = createContentManifest([], sha256);
  const catalog = readClaudeMarketplace({ name: "community", plugins: [{ name: "demo", source: "./demo", strict: false }] });
  const promote = vi.fn(async (plan: { identity: unknown; manifest: unknown }) => ({ kind: "promoted" as const, identity: plan.identity, root: "/store", manifest: plan.manifest }));
  let allocation = 0;
  const materialize = vi.fn(async (source: MarketplaceSource) => {
    const resolved = createResolvedMarketplaceSource({ declared: source, revision: "a".repeat(40) }, sha256);
    return { root: "/stage/content", source: resolved, content, binding: createMaterializationBinding(resolved.hash, content.rootDigest, sha256) };
  });
  let queue = Promise.resolve();
  const mutations = {
    async runPreparedMutation(request: { expectedGeneration: number }, prepare: (context: { snapshot: typeof current; assertOwned(): Promise<void> }) => Promise<{ mutation: any; value: unknown; beforeCommit?: () => Promise<void> }>) {
      let release!: () => void;
      const prior = queue;
      queue = new Promise<void>((resolve) => { release = resolve; });
      await prior;
      try {
        if (request.expectedGeneration !== current.generation) return { kind: "stale-generation" as const, expected: request.expectedGeneration, actual: current.generation };
        const prepared = await prepare({ snapshot: current, assertOwned: async () => undefined });
        await prepared.beforeCommit?.();
        const next = GenerationSchema.parse(current.generation + 1);
        current = {
          ...current,
          generation: next,
          config: { ...(prepared.mutation.replace.config ?? current.config), generation: next },
          installed: { ...(prepared.mutation.replace.installed ?? current.installed), generation: next },
          pointers: { ...current.pointers, generation: next, previousGeneration: current.generation, documents: current.pointers.documents.map((pointer) => ({ ...pointer, generation: next })) },
        };
        options.abortAfterCommit?.abort(new Error("cancelled after durable commit"));
        return options.ambiguousAfterCommit
          ? { kind: "commit-ambiguous" as const, value: prepared.value, expected: request.expectedGeneration, actual: current.generation }
          : { kind: "committed" as const, value: prepared.value, snapshot: current };
      } finally {
        release();
      }
    },
  };
  const service = createMarketplaceRegistrationService({
    state: { read: async () => ({ ok: true, snapshot: current }), commit: async () => { throw new Error("unused"); } },
    mutations: mutations as never,
    materializer: { materialize } as never,
    inspection: { inspect: async () => catalog },
    content: {
      allocateStaging: async () => ({ slot: { root: "/stage" }, allocationId: `allocation-${++allocation}` }),
      discardStaging: async () => undefined,
      promote,
      resolveMarketplace: async (record) => ({ kind: "marketplace", root: "/store", identity: { kind: "marketplace", key: "marketplace-store-v1:" + "a".repeat(64) }, manifest: content, contentRef: record.contentRef }),
    } as never,
    clock: { nowEpochMilliseconds: () => 1_000, monotonicMilliseconds: () => 1_000 },
    localSources: { canonicalize: async (source) => source },
    sha256,
  });
  return { service, materialize, promote, state: () => current };
}

describe("marketplace registration service", () => {
  it("publishes registration and selected snapshot atomically and is source-idempotent", async () => {
    const fixture = environment();
    const source = { kind: "github" as const, repository: "example/community" };
    const first = await fixture.service.add({ source, scope: "user", origin: { kind: "native" } }, new AbortController().signal);
    expect(first.kind).toBe("added");
    expect(fixture.state().config.records).toHaveLength(1);
    expect(fixture.state().installed.marketplaces).toHaveLength(1);
    expect(fixture.state().config.generation).toBe(fixture.state().installed.generation);

    const second = await fixture.service.add({ source, scope: "user", origin: { kind: "native" } }, new AbortController().signal);
    expect(second.kind).toBe("unchanged");
    expect(fixture.materialize).toHaveBeenCalledTimes(1);
    expect(fixture.promote).toHaveBeenCalledTimes(1);
  });

  it("reports a committed add after caller cancellation during post-commit projection", async () => {
    const controller = new AbortController();
    const fixture = environment({ abortAfterCommit: controller });
    const result = await fixture.service.add({
      source: { kind: "github", repository: "example/community" },
      scope: "user",
      origin: { kind: "native" },
    }, controller.signal);
    expect(result).toMatchObject({ kind: "added", registration: { marketplace: "community" } });
    expect(fixture.state().config.records).toHaveLength(1);
  });

  it("reconciles ambiguous commit evidence from exact durable source authority", async () => {
    const fixture = environment({ ambiguousAfterCommit: true });
    const result = await fixture.service.add({
      source: { kind: "github", repository: "example/community" },
      scope: "user",
      origin: { kind: "native" },
    }, new AbortController().signal);
    expect(result).toMatchObject({ kind: "unchanged", registration: { marketplace: "community" } });
    expect(fixture.state().config.records).toHaveLength(1);
    expect(fixture.state().installed.marketplaces).toHaveLength(1);
  });

  it("reports an authoritative root-name conflict without replacing the selected cache", async () => {
    const fixture = environment();
    await fixture.service.add({ source: { kind: "github", repository: "example/first" }, scope: "user", origin: { kind: "native" } }, new AbortController().signal);
    const before = fixture.state().installed.marketplaces[0];
    const conflict = await fixture.service.add({ source: { kind: "github", repository: "example/second" }, scope: "user", origin: { kind: "native" } }, new AbortController().signal);
    expect(conflict).toEqual({ kind: "rejected", code: "NAME_CONFLICT" });
    expect(fixture.state().installed.marketplaces).toEqual([before]);
  });

  it("removes registration and selected cache together and remains idempotent", async () => {
    const fixture = environment();
    const added = await fixture.service.add({ source: { kind: "github", repository: "example/community" }, scope: "user", origin: { kind: "native" } }, new AbortController().signal);
    if (added.kind !== "added") throw new Error("registration failed");
    expect(await fixture.service.remove({ scope: "user", registrationId: added.registration.id }, new AbortController().signal))
      .toEqual({ kind: "removed", registrationId: added.registration.id });
    expect(fixture.state().config.records).toEqual([]);
    expect(fixture.state().installed.marketplaces).toEqual([]);
    expect(await fixture.service.remove({ scope: "user", registrationId: added.registration.id }, new AbortController().signal))
      .toEqual({ kind: "unchanged", reason: "not-configured" });
  });

  it("does not commit a long project add after trust is revoked", async () => {
    const generation = GenerationSchema.parse(0);
    const identity = { kind: "path-only" as const, canonicalRoot: "file:///project/", limitation: "identity-changes-with-canonical-root" as const };
    const projectKey = deriveProjectKey(identity, sha256);
    const scope = { kind: "project" as const, identity, projectKey };
    const emptyContent = createContentManifest([], sha256);
    const project = createProjectLocalStateDocument({
      schemaVersion: 4,
      generation,
      projectKey,
      identity,
      declarationDigest: emptyContent.rootDigest,
      scope: {},
      marketplaces: [],
      plugins: [],
      marketplaceUpdates: [],
    }, scope, sha256);
    const snapshot = {
      scope,
      generation,
      pointers: StatePointersDocumentSchema.parse({
        schemaVersion: 1,
        scope: { kind: "project", projectKey },
        generation,
        documents: [{
          kind: "projectLocal",
          generation,
          blob: deriveStateBlobRef({ document: "projectLocal", scope: "project", generation }, sha256),
          digest: digest("c"),
        }],
      }),
      project,
      corruptions: [],
    } as Extract<GenerationSnapshot, { scope: { kind: "project" } }>;
    const source = { kind: "github" as const, repository: "example/community" };
    const resolved = createResolvedMarketplaceSource({ declared: source, revision: "a".repeat(40) }, sha256);
    const materialized = { root: "/stage/content", source: resolved, content: emptyContent, binding: createMaterializationBinding(resolved.hash, emptyContent.rootDigest, sha256) };
    const promote = vi.fn(async (plan: { identity: unknown; manifest: unknown }) => ({ kind: "promoted" as const, identity: plan.identity, root: "/store", manifest: plan.manifest }));
    let assessments = 0;
    const service = createMarketplaceRegistrationService({
      state: { read: async () => ({ ok: true, snapshot }), commit: async () => { throw new Error("must not commit"); } },
      mutations: {
        async runPreparedMutation(_request, prepare) {
          const prepared = await prepare({ snapshot, assertOwned: async () => undefined });
          await prepared.beforeCommit?.();
          throw new Error("commit should have been blocked");
        },
      },
      materializer: { materialize: async () => materialized },
      inspection: { inspect: async () => readClaudeMarketplace({ name: "community", plugins: [] }) },
      content: {
        allocateStaging: async () => ({ slot: { root: "/stage" }, allocationId: "allocation" }),
        discardStaging: async () => undefined,
        promote,
      } as never,
      clock: { nowEpochMilliseconds: () => 1_000, monotonicMilliseconds: () => 1_000 },
      currentProject: scope,
      projectTrust: { async assess() { assessments += 1; return assessments < 3 ? { kind: "trusted" } : { kind: "untrusted" }; } },
      localSources: { canonicalize: async (value) => value },
      sha256,
    });

    await expect(service.add({ source, scope: "project", origin: { kind: "native" } }, new AbortController().signal))
      .resolves.toEqual({ kind: "rejected", code: "PROJECT_UNTRUSTED" });
    expect(promote).toHaveBeenCalledTimes(1);
    expect(snapshot.project.marketplaceUpdates).toEqual([]);
  });
});
