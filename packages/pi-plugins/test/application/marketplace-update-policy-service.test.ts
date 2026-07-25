import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createMarketplaceConfigurationRecord,
  deriveMarketplaceSourceIdentity,
  derivePluginSourceIdentity,
  deriveUpdateCandidateKey,
  type MarketplaceUpdateRecord,
} from "../../src/domain/update-policy.js";
import { HostConfigDocumentSchema, GenerationSchema } from "../../src/domain/state/config-state.js";
import { InstalledUserStateDocumentSchema } from "../../src/domain/state/installed-state.js";
import { StatePointersDocumentSchema } from "../../src/domain/state/pointers.js";
import { TrustStateDocumentSchema } from "../../src/domain/state/trust-state.js";
import { deriveStateBlobRef } from "../../src/domain/state/references.js";
import type { GenerationSnapshot } from "../../src/application/state-contract.js";
import type { GenerationMutationCoordinator } from "../../src/application/generation-mutation-coordinator.js";
import type { LifecycleStateStore } from "../../src/application/ports/lifecycle-state-store.js";
import { createMarketplaceUpdatePolicyService } from "../../src/application/marketplace-update-policy-service.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const digest = (value: string) => `sha256:${value.repeat(64 / value.length)}` as `sha256:${string}`;
const source = { kind: "github" as const, repository: "example/community" };
const pluginSource = { kind: "git" as const, url: "https://example.com/demo.git", ref: "main" };

function snapshot(record: MarketplaceUpdateRecord): Extract<GenerationSnapshot, { scope: { kind: "user" } }> {
  const generation = GenerationSchema.parse(0);
  return {
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
    config: HostConfigDocumentSchema.parse({ schemaVersion: 4, generation, global: { application: "manual", cadence: "balanced" }, scope: {}, records: [record] }),
    installed: InstalledUserStateDocumentSchema.parse({ schemaVersion: 2, generation, marketplaces: [], plugins: [] }),
    trust: TrustStateDocumentSchema.parse({ schemaVersion: 1, generation, records: [] }),
    corruptions: [],
  };
}

function coordinatorFor(
  current: Extract<GenerationSnapshot, { scope: { kind: "user" } }>,
  capture: (mutation: unknown) => void,
): GenerationMutationCoordinator {
  return {
    async runPreparedMutation(request, prepare) {
      if (request.expectedGeneration !== current.generation) {
        return { kind: "stale-generation", expected: request.expectedGeneration, actual: current.generation };
      }
      const prepared = await prepare({ snapshot: current, assertOwned: async () => undefined });
      capture(prepared.mutation);
      return { kind: "committed", value: prepared.value, snapshot: current };
    },
  };
}

describe("marketplace update policy service", () => {
  it("changes policy without network or trust work and preserves durable update memory", async () => {
    const marketplaceSourceIdentity = deriveMarketplaceSourceIdentity(source, sha256);
    const pluginSourceIdentity = derivePluginSourceIdentity(pluginSource, sha256);
    const candidate = deriveUpdateCandidateKey({
      scope: { kind: "user" },
      plugin: "demo@community",
      marketplaceSourceIdentity,
      pluginSourceIdentity,
      immutableRevision: digest("b"),
    }, sha256);
    const record = createMarketplaceConfigurationRecord({
      marketplace: "community",
      source,
      refresh: {
        claim: { id: "refresh-claim-v1:uuid:123e4567-e89b-42d3-a456-426614174000", startedAt: 10, expiresAt: 20 },
        lastCompletedAt: 9,
        schedule: { anchorAt: 0, baseDelayMs: 200, jitterMs: 0, dueAt: 200, reason: "success" },
        consecutiveFailures: 3,
      },
      notices: [{
        id: `update-notice-v1:sha256:${"c".repeat(64)}`,
        scope: { kind: "user" },
        plugin: "demo@community",
        registrationId: `marketplace-registration-v1:sha256:${"c".repeat(64)}`,
        snapshot: `marketplace-snapshot-v1:sha256:${"c".repeat(64)}`,
        candidateId: `marketplace-candidate-v1:sha256:${"c".repeat(64)}`,
        candidate,
        available: {
          immutableRevision: digest("b"),
          marketplaceSourceIdentity,
          pluginSourceIdentity,
          sourceRevision: "b".repeat(40),
        },
        display: { installed: "1.0.0", available: "1.1.0" },
        disposition: "manual-required",
        publication: "pending",
        unread: true,
        discoveredAt: 9,
      }],
    });
    const current = snapshot(record);
    let mutation: unknown;
    let reads = 0;
    const state: LifecycleStateStore = { read: async () => { reads += 1; return { ok: true, snapshot: current }; }, commit: async () => { throw new Error("coordinator owns commits"); } };
    const mutations = coordinatorFor(current, (value) => { mutation = value; });
    const service = createMarketplaceUpdatePolicyService({ state, mutations, sha256 });

    const result = await service.setApplicationPreference({
      scope: { kind: "user" },
      marketplace: "community",
      sourceIdentity: marketplaceSourceIdentity,
      preference: "automatic",
    }, new AbortController().signal);

    expect(result).toEqual({ kind: "changed", preference: "automatic" });
    expect(reads).toBe(1);
    const replacement = (mutation as { replace: { config: { schemaVersion: number; records: readonly MarketplaceUpdateRecord[] } } }).replace.config;
    expect(replacement.schemaVersion).toBe(4);
    expect(replacement.records[0]!.refresh).toEqual(record.refresh);
    expect(replacement.records[0]!.notices).toEqual(record.notices);
  });

  it("rejects local automatic policy and source races before mutation", async () => {
    const local = createMarketplaceConfigurationRecord({ marketplace: "local", source: { kind: "local-git", path: "/workspace/marketplace" } });
    const current = snapshot(local);
    let mutations = 0;
    const state: LifecycleStateStore = { read: async () => ({ ok: true, snapshot: current }), commit: async () => { throw new Error("not used"); } };
    const coordinator: GenerationMutationCoordinator = {
      async runPreparedMutation() { mutations += 1; throw new Error("not expected"); },
    };
    const service = createMarketplaceUpdatePolicyService({ state, mutations: coordinator, sha256 });
    const localResult = await service.setApplicationPreference({
      scope: { kind: "user" }, marketplace: "local",
      sourceIdentity: deriveMarketplaceSourceIdentity(local.source, sha256), preference: "automatic",
    }, new AbortController().signal);
    expect(localResult).toEqual({ kind: "rejected", code: "LOCAL_AUTOMATIC_FORBIDDEN" });

    const remote = createMarketplaceConfigurationRecord({ marketplace: "remote", source });
    const sourceRace = await createMarketplaceUpdatePolicyService({
      state: { read: async () => ({ ok: true, snapshot: snapshot(remote) }), commit: async () => { throw new Error("not used"); } },
      mutations: coordinator,
      sha256,
    }).setApplicationPreference({
      scope: { kind: "user" }, marketplace: "remote",
      sourceIdentity: deriveMarketplaceSourceIdentity({ kind: "github", repository: "example/old" }, sha256), preference: "automatic",
    }, new AbortController().signal);
    expect(sourceRace).toEqual({ kind: "rejected", code: "SOURCE_CHANGED" });
    expect(mutations).toBe(0);
  });
});
