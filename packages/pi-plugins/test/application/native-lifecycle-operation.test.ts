import { describe, expect, it, vi } from "vitest";
import { createNativeLifecycleOperationExecutor } from "../../src/application/native-lifecycle-operation.js";
import { createNativeLifecycleTargetService } from "../../src/application/native-lifecycle-target.js";
import { deriveInspectionDetailId, deriveInspectionEvidenceSnapshotId } from "../../src/application/native-inspection-identifiers.js";
import { canonicalJson } from "../../src/domain/canonical-json.js";
import { hashContent } from "../../src/domain/content-manifest.js";
import { createNativeInstalledHarness, nativeInspectionSha256 } from "../helpers/native-installed-inspection.js";

const signal = new AbortController().signal;
const previewId = `native-operation-preview-v1:sha256:${"1".repeat(64)}` as never;

async function target(enabled = true) {
  const harness = createNativeInstalledHarness({ enabled });
  const targets = createNativeLifecycleTargetService({ evidence: { async capture() { return harness.snapshot; }, async validate() { return "current"; } }, sha256: nativeInspectionSha256 });
  const result = await targets.resolve({ inspectionSnapshotId: deriveInspectionEvidenceSnapshotId(harness.snapshot.binding, nativeInspectionSha256), detailId: deriveInspectionDetailId(harness.subject, nativeInspectionSha256) }, signal);
  if (result.kind !== "ready") throw new Error("target fixture is unavailable");
  return { harness, targets, target: result.target };
}

function dependencies(fixture: Awaited<ReturnType<typeof target>>, lifecycle: any) {
  return {
    targets: fixture.targets,
    updates: { async acquire() { throw new Error("not used"); }, async validate() { throw new Error("not used"); } },
    lifecycle: { application: lifecycle, prepared: { async installPrepared() { throw new Error("not used"); }, async updatePrepared() { throw new Error("not used"); } }, preparedInstall: { async installPrepared() { throw new Error("not used"); } } },
    configuration: { async save() { throw new Error("not used"); }, async remove() { throw new Error("not used"); } },
    configurationAuthority: { async readCurrent() { throw new Error("not used"); }, async readExact() { throw new Error("not used"); } },
    configurationInput() { throw new Error("not used"); },
    configurationPathContext(value: any) { return { scope: value.scope }; },
    trust: { async grant() { throw new Error("not used"); } },
    evidence: { async capture() { return fixture.harness.snapshot; }, async validate() { return "current" as const; } },
    projectRoots: { async acquire() { throw new Error("not used"); }, verify() { throw new Error("not used"); } },
    sha256: nativeInspectionSha256,
  } as any;
}

describe("native lifecycle operation orchestration", () => {
  it("returns exact current state without invoking lifecycle", async () => {
    const fixture = await target(true);
    const enable = vi.fn();
    const executor = createNativeLifecycleOperationExecutor(dependencies(fixture, { enable }));
    const result = await executor.execute({ operation: "enable", previewId, target: fixture.target }, { kind: "confirm", previewId, expectedVersion: 0, operation: "enable" }, {}, signal);
    expect(result).toMatchObject({ kind: "current-state", reason: "already-enabled", effects: { state: "unchanged" } });
    expect(enable).not.toHaveBeenCalled();
  });

  it("projects verified disable success and isolates progress observer failures", async () => {
    const fixture = await target(true);
    const disabled = { ...fixture.target.record, activation: "disabled" as const };
    const nextSnapshot = {
      ...fixture.target.snapshot.states[0]!.snapshot,
      generation: 1,
      installed: { ...(fixture.target.snapshot.states[0]!.snapshot as any).installed, plugins: [disabled] },
    } as any;
    const disable = vi.fn(async () => ({ kind: "changed", operation: "disable", snapshot: nextSnapshot, observation: { kind: "inactive", scope: { kind: "user" }, plugin: disabled.plugin, projectionDigest: `sha256:${"2".repeat(64)}` } }));
    const executor = createNativeLifecycleOperationExecutor(dependencies(fixture, { disable }));
    const result = await executor.execute({ operation: "disable", previewId, target: fixture.target }, { kind: "confirm", previewId, expectedVersion: 0, operation: "disable" }, { onProgress: async () => { throw new Error("CANARY_NATIVE_CALLBACK"); } }, signal);
    expect(result).toMatchObject({ kind: "succeeded", effects: { state: "changed", generation: 1 }, after: { activation: "disabled" } });
    expect(JSON.stringify(result)).not.toContain("CANARY_NATIVE_CALLBACK");
    expect(result.kind === "succeeded" && result.progress.some((event) => event.code === "PROGRESS_DELIVERY_FAILED")).toBe(true);
  });

  it("carries the exact update configuration revision into prepared lifecycle", async () => {
    const fixture = await target(true);
    const configurationRevision = `sha256:${"7".repeat(64)}` as never;
    const configurationRef = `plugin-configuration-v1:sha256:${"8".repeat(64)}` as never;
    const consentId = `trusted-install-consent-v1:sha256:${"9".repeat(64)}` as never;
    const updatePrepared = vi.fn(async () => ({
      kind: "rejected" as const,
      operation: "update" as const,
      code: "CONFIGURATION_STALE" as const,
    }));
    const update = {
      target: fixture.target,
      candidate: {
        binding: { plugin: fixture.target.binding.plugin, configurationRef },
        consent: { consentId },
        fields: [],
        plugin: { configuration: { options: [] } },
        resolved: {
          scope: { kind: "user" },
          entry: { source: { value: { kind: "github", repository: "example/plugin" } } },
          marketplace: { source: {} },
        },
        lease: { async release() {} },
        trust: {},
        snapshotBinding: {},
        detail: { compatibility: { components: { counts: { skills: 0, hooks: 0, mcpServers: 0 } } } },
      },
      binding: {},
    } as any;
    const base = dependencies(fixture, {});
    let trustCalls = 0;
    const executor = createNativeLifecycleOperationExecutor({
      ...base,
      updates: { async acquire() { throw new Error("not used"); }, async validate() { return { kind: "ready" as const, update }; } },
      lifecycle: {
        ...base.lifecycle,
        prepared: { ...base.lifecycle.prepared, updatePrepared },
      },
      configurationAuthority: {
        async readCurrent() { return { kind: "current" as const, document: { revision: configurationRevision } }; },
        async readExact(request: any) {
          expect(request.expectedRevision).toBe(configurationRevision);
          return { kind: "current" as const, document: { revision: configurationRevision } };
        },
      },
      configurationInput() { return { pathContext: { scope: { kind: "user" } }, paths: {}, secretCustody: { status: "available" } }; },
      trust: { async grant() { trustCalls += 1; if (trustCalls > 1) throw new Error("trust adapter failed"); return { kind: "granted" as const }; } },
    } as any);
    const trustFingerprint = hashContent(new TextEncoder().encode(`native-lifecycle-trust-v1\0${canonicalJson(update.candidate.trust)}`), nativeInspectionSha256);
    const result = await executor.execute(
      { operation: "update", previewId, target: fixture.target, update },
      { kind: "confirm-update", previewId, expectedVersion: 0, input: { nonSensitive: [], sensitive: [], consent: { kind: "grant", consentId }, authority: { configurationRevision, trustFingerprint } } },
      {},
      signal,
    );
    expect(result).toMatchObject({ kind: "stale", reason: "configuration", retainedPreflight: { configuration: true, trust: true, configurationRevision, trustFingerprint } });
    expect(updatePrepared).toHaveBeenCalledWith(expect.objectContaining({ expectedConfigurationRevision: configurationRevision }), signal);
    const failedAfterConfiguration = await executor.execute(
      { operation: "update", previewId, target: fixture.target, update },
      { kind: "confirm-update", previewId, expectedVersion: 0, input: { nonSensitive: [], sensitive: [], consent: { kind: "grant", consentId }, authority: { configurationRevision, trustFingerprint } } },
      {},
      signal,
    );
    expect(failedAfterConfiguration).toMatchObject({ kind: "failed", code: "ADAPTER_FAILED", retainedPreflight: { configuration: true, trust: false, configurationRevision } });
    expect(JSON.stringify(failedAfterConfiguration)).not.toMatch(/locator|CANARY_SECRET/);
  });

  it("preserves rollback truth instead of reporting cancellation or success", async () => {
    const fixture = await target(true);
    const disable = vi.fn(async () => ({ kind: "rolled-back", operation: "disable", failure: { kind: "reload-rejected", code: "RELOAD_REJECTED" }, snapshot: fixture.target.snapshot.states[0]!.snapshot, observation: { kind: "active" } }));
    const executor = createNativeLifecycleOperationExecutor(dependencies(fixture, { disable }));
    const result = await executor.execute({ operation: "disable", previewId, target: fixture.target }, { kind: "confirm", previewId, expectedVersion: 0, operation: "disable" }, {}, signal);
    expect(result).toMatchObject({ kind: "rolled-back", failure: "reload-rejected", restored: { activation: "enabled" } });
  });
});
