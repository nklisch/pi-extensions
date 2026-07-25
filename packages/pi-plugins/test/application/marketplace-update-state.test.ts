import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createMarketplaceConfigurationRecord,
  deriveMarketplaceSourceIdentity,
  derivePluginSourceIdentity,
  deriveUpdateCandidateKey,
  type MarketplaceUpdateRecord,
} from "../../src/domain/update-policy.js";
import { ContentDigestSchema, createContentManifest, hashContent } from "../../src/domain/content-manifest.js";
import { MarketplaceSourceSchema, createResolvedMarketplaceSource } from "../../src/domain/source.js";
import { ProjectIdentitySchema, deriveProjectKey } from "../../src/domain/state/scope.js";
import { HostConfigDocumentSchema, GenerationSchema } from "../../src/domain/state/config-state.js";
import { ProjectLocalStateDocumentSchema } from "../../src/domain/state/project-state.js";
import { createMarketplaceSnapshotRecord, InstalledUserStateDocumentSchema } from "../../src/domain/state/installed-state.js";
import { StatePointersDocumentSchema } from "../../src/domain/state/pointers.js";
import { TrustStateDocumentSchema } from "../../src/domain/state/trust-state.js";
import { isVerifiedStateMutation, type UserGenerationSnapshot, type ProjectGenerationSnapshot } from "../../src/application/state-contract.js";
import { createMarketplaceUpdateRecordsMutation, marketplaceUpdateRecords } from "../../src/application/marketplace-update-state.js";
import { deriveStateBlobRef } from "../../src/domain/state/references.js";
import { deriveUpdateNoticeId } from "../../src/application/native-update-identifiers.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const digest = (value: string) => `sha256:${value.repeat(64 / value.length)}` as `sha256:${string}`;
const generation = GenerationSchema.parse(7);
const source = MarketplaceSourceSchema.parse({ kind: "github", repository: "example/community" });

function userPointers() {
  return StatePointersDocumentSchema.parse({
    schemaVersion: 1, scope: { kind: "user" }, generation,
    documents: ["hostConfig", "installedUser", "trust"].map((document) => ({
      kind: document, generation,
      blob: deriveStateBlobRef({ document, scope: "user", generation }, sha256), digest: digest("a"),
    })),
  });
}

function userSnapshot(config: unknown): UserGenerationSnapshot {
  return {
    scope: { kind: "user" }, generation, pointers: userPointers(),
    config: config as UserGenerationSnapshot["config"],
    installed: InstalledUserStateDocumentSchema.parse({ schemaVersion: 2, generation, marketplaces: [], plugins: [] }),
    trust: TrustStateDocumentSchema.parse({ schemaVersion: 1, generation, records: [] }), corruptions: [],
  };
}

function projectSnapshot(record: MarketplaceUpdateRecord): ProjectGenerationSnapshot {
  const identity = ProjectIdentitySchema.parse({ kind: "repository", canonicalRoot: "file:///workspace/project/", repositoryFingerprint: digest("c") });
  const projectKey = deriveProjectKey(identity, sha256);
  const resolvedSource = createResolvedMarketplaceSource({ declared: source, revision: "a".repeat(40) }, sha256);
  const content = createContentManifest([{ kind: "file", path: "README.md", mode: 0o644, size: 0, digest: hashContent(new Uint8Array(), sha256) }], sha256);
  const marketplace = createMarketplaceSnapshotRecord({ marketplace: "community", source: resolvedSource, content }, sha256);
  const project = ProjectLocalStateDocumentSchema.parse({
    schemaVersion: 4, generation, projectKey, identity, declarationDigest: content.rootDigest, scope: {},
    marketplaces: [marketplace], plugins: [], marketplaceUpdates: [record],
  });
  return {
    scope: { kind: "project", identity, projectKey }, generation,
    pointers: StatePointersDocumentSchema.parse({
      schemaVersion: 1, scope: { kind: "project", projectKey }, generation,
      documents: [{ kind: "projectLocal", generation, blob: deriveStateBlobRef({ document: "projectLocal", scope: "project", generation }, sha256), digest: digest("a") }],
    }),
    project, corruptions: [],
  };
}

function richRecord(): MarketplaceUpdateRecord {
  const marketplaceSourceIdentity = deriveMarketplaceSourceIdentity(source, sha256);
  const pluginSourceIdentity = derivePluginSourceIdentity({ kind: "git", url: "https://example.com/demo.git" }, sha256);
  const candidate = deriveUpdateCandidateKey({ scope: { kind: "user" }, plugin: "demo@community", marketplaceSourceIdentity, pluginSourceIdentity, immutableRevision: ContentDigestSchema.parse(digest("b")) }, sha256);
  return createMarketplaceConfigurationRecord({
    marketplace: "community", source, applicationOverride: "automatic",
    refresh: {
      claim: { id: "refresh-claim-v1:uuid:123e4567-e89b-42d3-a456-426614174000", startedAt: 10, expiresAt: 20 },
      lastCompletedAt: 9,
      schedule: { anchorAt: 100, baseDelayMs: 100, jitterMs: 0, dueAt: 200, reason: "success" },
      consecutiveFailures: 3,
    },
    notices: [{
      id: deriveUpdateNoticeId({ scope: { kind: "user" }, plugin: "demo@community", candidate }, sha256),
      scope: { kind: "user" }, plugin: "demo@community",
      registrationId: `marketplace-registration-v1:sha256:${"a".repeat(64)}`,
      snapshot: `marketplace-snapshot-v1:sha256:${"b".repeat(64)}`,
      candidateId: `marketplace-candidate-v1:sha256:${"c".repeat(64)}`,
      candidate,
      available: { immutableRevision: ContentDigestSchema.parse(digest("b")), marketplaceSourceIdentity, pluginSourceIdentity, sourceRevision: "b".repeat(40) },
      display: { installed: "1.0.0", available: "1.1.0" },
      disposition: "automatic-pending", publication: "pending", unread: true, discoveredAt: 9,
      automatic: { state: "pending", reason: "awaiting-host-context" },
    }],
  });
}

describe("marketplace update state projection", () => {
  it("reads current records with defaults and strict parsing", () => {
    const minimal = createMarketplaceConfigurationRecord({ marketplace: "community", source });
    const records = marketplaceUpdateRecords(userSnapshot(HostConfigDocumentSchema.parse({ schemaVersion: 4, generation, records: [minimal] })));
    expect(records[0]).toMatchObject({ marketplace: "community", refresh: { consecutiveFailures: 0 }, notices: [] });
    const rich = richRecord();
    expect(marketplaceUpdateRecords(userSnapshot({ schemaVersion: 4, generation, global: { application: "manual", cadence: "balanced" }, scope: {}, records: [rich] }))).toEqual([rich]);
  });

  it("projects a v4 user envelope to a verified frozen v4 mutation", () => {
    const rich = richRecord();
    const snapshot = userSnapshot(HostConfigDocumentSchema.parse({ schemaVersion: 4, generation, global: { application: "manual", cadence: "balanced" }, scope: {}, records: [rich] }));
    const mutation = createMarketplaceUpdateRecordsMutation(snapshot, marketplaceUpdateRecords(snapshot), sha256);
    expect(isVerifiedStateMutation(mutation)).toBe(true);
    if (!("config" in mutation.replace)) throw new Error("expected config replacement");
    expect(mutation.replace.config.schemaVersion).toBe(4);
    expect(mutation.replace.config.records[0]!.refresh).toEqual(rich.refresh);
    expect(mutation.replace.config.records[0]!.notices).toEqual(rich.notices);
    expect(Object.isFrozen(mutation.replace.config.records)).toBe(true);
  });

  it("projects project records without changing adjacent authority", () => {
    const rich = richRecord();
    const snapshot = projectSnapshot(rich);
    const mutation = createMarketplaceUpdateRecordsMutation(snapshot, [rich], sha256);
    expect(isVerifiedStateMutation(mutation)).toBe(true);
    if (!("project" in mutation.replace)) throw new Error("expected project replacement");
    expect(mutation.replace.project).toMatchObject({ schemaVersion: 4, projectKey: snapshot.project.projectKey, identity: snapshot.project.identity });
    expect(mutation.replace.project.marketplaces).toEqual(snapshot.project.marketplaces);
    expect(mutation.replace.project.marketplaceUpdates).toEqual([rich]);
  });
});
