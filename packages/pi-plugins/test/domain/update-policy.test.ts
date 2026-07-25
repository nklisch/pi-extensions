import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AvailableRevisionSchema,
  MarketplaceUpdateRecordSchema,
  UpdateNoticeSchema,
  UpdateScheduleMemorySchema,
  UpdateSchedulerLeaseSchema,
  RefreshClaimIdSchema,
  UpdateCandidateKeySchema,
  compareInstalledRevision,
  createMarketplaceConfigurationRecord,
  deriveMarketplaceSourceIdentity,
  derivePluginSourceIdentity,
  deriveUpdateCandidateKey,
  replaceMarketplaceConfigurationSource,
  selectDeclaredVersion,
} from "../../src/domain/update-policy.js";
import { ContentDigestSchema } from "../../src/domain/content-manifest.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const revision = (value: string) => ContentDigestSchema.parse(`sha256:${value.repeat(64 / value.length)}`);

const marketplace = { kind: "github" as const, repository: "example/plugins" };
const plugin = { kind: "git" as const, url: "https://example.com/plugin.git", ref: "main" };

function available(immutableRevision: string) {
  return AvailableRevisionSchema.parse({
    immutableRevision: revision(immutableRevision),
    marketplaceSourceIdentity: deriveMarketplaceSourceIdentity(marketplace, sha256),
    pluginSourceIdentity: derivePluginSourceIdentity(plugin, sha256),
    declaredVersion: "1.0.0",
    sourceRevision: "a".repeat(40),
  });
}

describe("update policy domain contracts", () => {
  it("uses plugin version before marketplace version and never orders semver", () => {
    expect(selectDeclaredVersion({ plugin: "2.0.0", marketplace: "1.0.0" })).toBe("2.0.0");
    expect(selectDeclaredVersion({ marketplace: "1.0.0" })).toBe("1.0.0");
    expect(selectDeclaredVersion({})).toBeUndefined();
  });

  it("distinguishes immutable revisions from presentation changes", () => {
    const sourceIdentity = deriveMarketplaceSourceIdentity(marketplace, sha256);
    const pluginIdentity = derivePluginSourceIdentity(plugin, sha256);
    const installed = {
      immutableRevision: revision("a"),
      marketplaceSourceIdentity: sourceIdentity,
      pluginSourceIdentity: pluginIdentity,
      declaredVersion: "1.0.0",
      sourceRevision: "a".repeat(40),
    } as const;
    expect(compareInstalledRevision({ installed, available: available("a") }).kind).toBe("current");
    const changed = compareInstalledRevision({ installed, available: available("b") });
    expect(changed.kind).toBe("revision-changed");
    if (changed.kind === "revision-changed") expect(changed.displayVersionChanged).toBe(false);
  });

  it("keeps marketplace and plugin source changes as approval boundaries", () => {
    const pluginIdentity = derivePluginSourceIdentity(plugin, sha256);
    const candidate = available("a");
    const marketplaceChanged = compareInstalledRevision({
      installed: {
        immutableRevision: candidate.immutableRevision,
        marketplaceSourceIdentity: deriveMarketplaceSourceIdentity({ kind: "github", repository: "other/plugins" }, sha256),
        pluginSourceIdentity: pluginIdentity,
        sourceRevision: candidate.sourceRevision,
      },
      available: candidate,
    });
    expect(marketplaceChanged).toMatchObject({ kind: "approval-required", reason: "MARKETPLACE_SOURCE_CHANGED" });
    expect(marketplaceChanged).not.toHaveProperty("candidate");

    const pluginChanged = compareInstalledRevision({
      installed: {
        immutableRevision: candidate.immutableRevision,
        marketplaceSourceIdentity: candidate.marketplaceSourceIdentity,
        pluginSourceIdentity: derivePluginSourceIdentity({ kind: "git", url: "https://example.com/other.git" }, sha256),
        sourceRevision: candidate.sourceRevision,
      },
      available: candidate,
    });
    expect(pluginChanged).toMatchObject({ kind: "approval-required", reason: "PLUGIN_SOURCE_CHANGED" });
    expect(pluginChanged).not.toHaveProperty("candidate");
  });

  it("creates deterministic candidate keys and validates claims", () => {
    const key = deriveUpdateCandidateKey({
      scope: { kind: "user" },
      plugin: "demo@community",
      marketplaceSourceIdentity: deriveMarketplaceSourceIdentity(marketplace, sha256),
      pluginSourceIdentity: derivePluginSourceIdentity(plugin, sha256),
      immutableRevision: revision("a"),
    }, sha256);
    expect(UpdateCandidateKeySchema.parse(key)).toBe(key);
    expect(deriveUpdateCandidateKey({
      scope: { kind: "user" }, plugin: "demo@community",
      marketplaceSourceIdentity: deriveMarketplaceSourceIdentity(marketplace, sha256),
      pluginSourceIdentity: derivePluginSourceIdentity(plugin, sha256), immutableRevision: revision("a"),
    }, sha256)).toBe(key);
    expect(deriveUpdateCandidateKey({
      scope: { kind: "user" }, plugin: "demo@community",
      marketplaceSourceIdentity: deriveMarketplaceSourceIdentity({ kind: "github", repository: "other/plugins" }, sha256),
      pluginSourceIdentity: derivePluginSourceIdentity(plugin, sha256), immutableRevision: revision("a"),
    }, sha256)).not.toBe(key);
    expect(() => RefreshClaimIdSchema.parse("refresh-claim-v1:uuid:not-a-uuid")).toThrow();
  });

  it("applies exact overrides and resets operational memory on source replacement", () => {
    const record = createMarketplaceConfigurationRecord({
      marketplace: "community",
      source: marketplace,
      applicationOverride: "automatic",
      refresh: {
        consecutiveFailures: 3,
        schedule: { anchorAt: 0, baseDelayMs: 99, jitterMs: 0, dueAt: 99, reason: "success" },
      },
    });
    expect(record.applicationOverride).toBe("automatic");
    expect(record.refresh.schedule?.dueAt).toBe(99);
    expect(MarketplaceUpdateRecordSchema.parse(record)).toEqual(record);
    const replaced = replaceMarketplaceConfigurationSource(record, { kind: "local-git", path: "/workspace/marketplace" });
    expect(replaced.applicationOverride).toBeUndefined();
    expect(replaced.refresh.consecutiveFailures).toBe(0);
    expect(replaced.notices).toEqual([]);
  });

  it("rejects inconsistent schedules, leases, and notice state", () => {
    expect(UpdateScheduleMemorySchema.safeParse({ anchorAt: 10, baseDelayMs: 20, jitterMs: 1, dueAt: 30, reason: "success" }).success).toBe(false);
    expect(UpdateSchedulerLeaseSchema.safeParse({ id: "update-scheduler-lease-v1:uuid:123e4567-e89b-42d3-a456-426614174000", startedAt: 10, renewedAt: 10, expiresAt: 10 }).success).toBe(false);
    expect(UpdateNoticeSchema.safeParse({
      id: `update-notice-v1:sha256:${"a".repeat(64)}`,
      scope: { kind: "user" },
      plugin: "demo@community",
      registrationId: `marketplace-registration-v1:sha256:${"a".repeat(64)}`,
      snapshot: `marketplace-snapshot-v1:sha256:${"a".repeat(64)}`,
      candidateId: `marketplace-candidate-v1:sha256:${"a".repeat(64)}`,
      candidate: `update-candidate-v1:sha256:${"a".repeat(64)}`,
      available: available("a"),
      display: { installed: "1", available: "2" },
      disposition: "manual-required",
      publication: "pending",
      unread: false,
      discoveredAt: 1,
    }).success).toBe(false);
  });
});
