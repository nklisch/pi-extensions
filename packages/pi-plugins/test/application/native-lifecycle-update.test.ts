import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createNativeLifecycleTargetService } from "../../src/application/native-lifecycle-target.js";
import { createNativeLifecycleUpdateService } from "../../src/application/native-lifecycle-update.js";
import { deriveInspectionDetailId, deriveInspectionEvidenceSnapshotId } from "../../src/application/native-inspection-identifiers.js";
import { deriveMarketplaceSourceIdentity, derivePluginSourceIdentity } from "../../src/domain/update-policy.js";
import { createNativeInstalledHarness, nativeInspectionSha256 } from "../helpers/native-installed-inspection.js";

const signal = new AbortController().signal;
const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const digest = (value: string) => `sha256:${value.repeat(64)}` as never;

describe("native lifecycle update preparation", () => {
  it("binds one exact candidate acquisition to the installed source and target", async () => {
    const harness = createNativeInstalledHarness({ enabled: true });
    const marketplaceSource = { kind: "github" as const, repository: "owner/market" };
    const pluginSource = { kind: "marketplace-path" as const, path: "./plugin" };
    const marketplaceSourceIdentity = deriveMarketplaceSourceIdentity(marketplaceSource, sha256);
    const pluginSourceIdentity = derivePluginSourceIdentity(pluginSource, sha256);
    const record = {
      ...harness.record,
      revisions: harness.record.revisions.map((revision: any) => ({
        ...revision,
        evidence: { ...revision.evidence, source: { ...revision.evidence.source, marketplaceSourceIdentity, pluginSourceIdentity } },
      })),
    };
    const snapshot = {
      ...harness.snapshot,
      states: harness.snapshot.states.map((entry: any) => ({ ...entry, snapshot: { ...entry.snapshot, installed: { ...entry.snapshot.installed, plugins: [record] } } })),
    };
    const snapshotId = deriveInspectionEvidenceSnapshotId(snapshot.binding, nativeInspectionSha256);
    const targetRequest = { inspectionSnapshotId: snapshotId, detailId: deriveInspectionDetailId(harness.subject, nativeInspectionSha256) };
    const candidateSubject = {
      version: 1 as const,
      subject: "marketplace-candidate" as const,
      scope: harness.subject.scope,
      plugin: harness.subject.plugin,
      registrationId: `marketplace-registration-v1:sha256:${"1".repeat(64)}` as never,
      candidateId: `marketplace-candidate-v1:sha256:${"2".repeat(64)}` as never,
      catalogSnapshot: `marketplace-snapshot-v1:sha256:${"3".repeat(64)}` as never,
    };
    const release = vi.fn(async () => undefined);
    const candidate = {
      lease: { release },
      resolved: { scope: { kind: "user" }, marketplace: { source: { declared: marketplaceSource } }, entry: { source: { value: pluginSource } } },
      binding: {
        scope: { kind: "user" }, registrationId: candidateSubject.registrationId, candidateId: candidateSubject.candidateId,
        catalogSnapshot: candidateSubject.catalogSnapshot, plugin: harness.subject.plugin, sourceIdentity: digest("4"),
        immutableRevision: digest("5"), contentDigest: digest("6"), compatibilityFingerprint: digest("7"),
        configurationDescriptorDigest: digest("8"), consentDisclosureDigest: digest("f"), trustSubject: `trust-subject-v1:sha256:${"9".repeat(64)}`,
        executableSurfaceDigest: digest("a"), capabilityDigest: snapshot.binding.capability.digest,
      },
    } as any;
    const candidates = { acquire: vi.fn(async () => ({ kind: "ready" as const, candidate })), validate: vi.fn(async () => "current" as const) };
    const targets = createNativeLifecycleTargetService({ evidence: { async capture() { return snapshot; }, async validate() { return "current"; } }, sha256: nativeInspectionSha256 });
    const service = createNativeLifecycleUpdateService({ targets, candidates, sha256 });
    const result = await service.acquire({
      target: targetRequest,
      candidate: { inspectionSnapshotId: snapshotId, detailId: deriveInspectionDetailId(candidateSubject, nativeInspectionSha256) },
    }, signal);
    expect(result.kind).toBe("ready");
    expect(candidates.acquire).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    if (result.kind === "ready") {
      expect(result.update.binding.candidatePluginSourceIdentity).toBe(pluginSourceIdentity);
      expect(result.update.binding.target.targetDigest).toBeDefined();
    }
  });
});
