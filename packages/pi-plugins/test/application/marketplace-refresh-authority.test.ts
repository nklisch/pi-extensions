import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createMarketplaceRefreshService } from "../../src/application/marketplace-refresh-service.js";
import { createContentManifest, createMaterializationBinding } from "../../src/domain/content-manifest.js";
import { createMarketplaceSnapshotRecord } from "../../src/domain/state/installed-state.js";
import { createProjectLocalStateDocument } from "../../src/domain/state/project-state.js";
import { StatePointersDocumentSchema } from "../../src/domain/state/pointers.js";
import { deriveStateBlobRef } from "../../src/domain/state/references.js";
import { deriveProjectKey } from "../../src/domain/state/scope.js";
import { GenerationSchema } from "../../src/domain/state/config-state.js";
import { createResolvedMarketplaceSource, type Sha256 } from "../../src/domain/source.js";
import { createMarketplaceConfigurationRecord, MarketplaceRegistrationRecordSchema } from "../../src/domain/update-policy.js";
import { readClaudeMarketplace } from "../../src/formats/claude/marketplace-reader.js";
import type { GenerationSnapshot } from "../../src/application/state-contract.js";

const sha256: Sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const digest = (value: string) => `sha256:${value.repeat(64)}` as `sha256:${string}`;

function pointers(scope: { projectKey: string }, generation: number) {
  return StatePointersDocumentSchema.parse({
    schemaVersion: 1,
    scope: { kind: "project", projectKey: scope.projectKey },
    generation,
    documents: [{
      kind: "projectLocal",
      generation,
      blob: deriveStateBlobRef({ document: "projectLocal", scope: "project", generation }, sha256),
      digest: digest("d"),
    }],
  });
}

describe("marketplace refresh project authority", () => {
  it("does not finalize a long refresh after project trust is revoked", async () => {
    const identity = { kind: "path-only" as const, canonicalRoot: "file:///project/", limitation: "identity-changes-with-canonical-root" as const };
    const scope = { kind: "project" as const, identity, projectKey: deriveProjectKey(identity, sha256) };
    const source = { kind: "github" as const, repository: "example/community" };
    const content = createContentManifest([], sha256);
    const resolved = createResolvedMarketplaceSource({ declared: source, revision: "a".repeat(40) }, sha256);
    const binding = createMaterializationBinding(resolved.hash, content.rootDigest, sha256);
    const selected = createMarketplaceSnapshotRecord({ marketplace: "community", source: resolved, content, binding }, sha256);
    const record = createMarketplaceConfigurationRecord({ marketplace: "community", source });
    const claim = { id: "refresh-claim-v1:uuid:123e4567-e89b-42d3-a456-426614174099", startedAt: 1_000, expiresAt: 901_000 };
    const claimedRecord = MarketplaceRegistrationRecordSchema.parse({ ...record, refresh: { ...record.refresh, claim } });

    const snapshot = (generation: number, registration: typeof record): Extract<GenerationSnapshot, { scope: { kind: "project" } }> => ({
      scope,
      generation: GenerationSchema.parse(generation),
      pointers: pointers(scope, generation),
      project: createProjectLocalStateDocument({
        schemaVersion: 4,
        generation,
        projectKey: scope.projectKey,
        identity,
        declarationDigest: content.rootDigest,
        scope: {},
        marketplaces: [selected],
        plugins: [],
        marketplaceUpdates: [registration],
      }, scope, sha256),
      corruptions: [],
    });
    const before = snapshot(0, record);
    const claimed = snapshot(1, claimedRecord);
    let reads = 0;
    let mutations = 0;
    let durableCommits = 0;
    let trustChecks = 0;
    const promote = vi.fn(async (plan: { identity: unknown; manifest: unknown }) => ({ kind: "promoted" as const, identity: plan.identity, root: "/store", manifest: plan.manifest }));
    const service = createMarketplaceRefreshService({
      inventory: { async discover() { return { scopes: [scope], complete: true }; } },
      state: {
        async read() {
          reads += 1;
          return { ok: true as const, snapshot: reads <= 2 ? before : claimed };
        },
        async commit() { throw new Error("coordinator owns commits"); },
      },
      mutations: {
        async runPreparedMutation(_request, prepare) {
          mutations += 1;
          if (mutations === 1) {
            durableCommits += 1;
            return { kind: "committed" as const, value: undefined, snapshot: claimed };
          }
          if (mutations === 2) {
            const prepared = await prepare({ snapshot: claimed, assertOwned: async () => undefined });
            await prepared.beforeCommit?.();
            durableCommits += 1;
            throw new Error("revoked refresh reached commit");
          }
          return { kind: "stale-generation" as const, expected: 1, actual: 1 };
        },
      },
      clock: { nowEpochMilliseconds: () => 1_000, monotonicMilliseconds: () => 1_000 },
      claimIds: { async create() { return claim.id as never; } },
      materializers: { marketplaces: { async materialize() { return { root: "/stage/content", source: resolved, content, binding }; } } },
      inspection: { async inspect() { return readClaudeMarketplace({ name: "community", plugins: [] }); } },
      content: {
        async allocateStaging() { return { slot: { root: "/stage" }, allocationId: "allocation" }; },
        async discardStaging() {},
        promote,
      } as never,
      currentProject: scope,
      projectTrust: {
        async assess() {
          trustChecks += 1;
          return trustChecks < 6 ? { kind: "trusted" as const } : { kind: "untrusted" as const };
        },
      },
      async revalidateCurrentProject() { return { identity, projectKey: scope.projectKey, trust: { kind: "trusted" as const } }; },
      sha256,
    });

    const result = await service.refresh({ trigger: "explicit", scope: "project" }, new AbortController().signal);
    expect(result.outcomes).toMatchObject([{ kind: "failed", code: "STATE_STALE" }]);
    expect(promote).toHaveBeenCalledTimes(1);
    expect(durableCommits).toBe(1);
  });
});
