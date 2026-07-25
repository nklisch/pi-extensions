import { describe, expect, it } from "vitest";
import { createNativeLifecycleTargetService } from "../../src/application/native-lifecycle-target.js";
import { deriveInspectionDetailId, deriveInspectionEvidenceSnapshotId } from "../../src/application/native-inspection-identifiers.js";
import { createNativeInstalledHarness, nativeInspectionSha256 } from "../helpers/native-installed-inspection.js";

const signal = new AbortController().signal;

describe("native lifecycle target", () => {
  it("binds one exact installed inspection and rebases only unrelated generation changes", async () => {
    const harness = createNativeInstalledHarness({ enabled: true });
    let current = harness.snapshot;
    const service = createNativeLifecycleTargetService({
      evidence: { async capture() { return current; }, async validate() { return "current"; } },
      sha256: nativeInspectionSha256,
    });
    const request = {
      inspectionSnapshotId: deriveInspectionEvidenceSnapshotId(current.binding, nativeInspectionSha256),
      detailId: deriveInspectionDetailId(harness.subject, nativeInspectionSha256),
    };
    const resolved = await service.resolve(request, signal);
    expect(resolved.kind).toBe("ready");
    if (resolved.kind !== "ready") return;

    current = {
      ...current,
      binding: { ...current.binding, scopes: current.binding.scopes.map((entry: any) => ({ ...entry, generation: 1 })) },
      states: current.states.map((entry: any) => ({ ...entry, snapshot: { ...entry.snapshot, generation: 1 } })),
    };
    const rebased = await service.validate(resolved.target, signal);
    expect(rebased.kind).toBe("ready");
    if (rebased.kind === "ready") expect(rebased.target.expectation.generation).toBe(1);

    current = {
      ...current,
      states: current.states.map((entry: any) => ({
        ...entry,
        snapshot: {
          ...entry.snapshot,
          installed: { ...entry.snapshot.installed, plugins: entry.snapshot.installed.plugins.map((record: any) => ({ ...record, activation: "disabled" })) },
        },
      })),
    };
    expect(await service.validate(resolved.target, signal)).toMatchObject({ kind: "stale", reason: "target" });
  });

  it("blocks pending transition evidence before producing a target", async () => {
    const harness = createNativeInstalledHarness({ pending: true });
    const service = createNativeLifecycleTargetService({
      evidence: { async capture() { return harness.snapshot; }, async validate() { return "current"; } },
      sha256: nativeInspectionSha256,
    });
    expect(await service.resolve({
      inspectionSnapshotId: deriveInspectionEvidenceSnapshotId(harness.snapshot.binding, nativeInspectionSha256),
      detailId: deriveInspectionDetailId(harness.subject, nativeInspectionSha256),
    }, signal)).toMatchObject({ kind: "blocked", reason: "pending-transition" });
  });
});
