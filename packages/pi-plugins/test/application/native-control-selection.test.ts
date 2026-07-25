import { describe, expect, it, vi } from "vitest";
import { createNativeControlSelectionService } from "../../src/application/native-control-selection.js";
import { NativeInspectionError } from "../../src/application/native-inspection-service.js";
import { SplitInspectorDetailFixtures, SplitInspectorPageFixture } from "../fixtures/native-inspection/split-inspector.js";

const signal = new AbortController().signal;

describe("native control exact selection", () => {
  it("resolves identity through one list snapshot and exact detail", async () => {
    const list = vi.fn(async () => SplitInspectorPageFixture);
    const detail = vi.fn(async (request: any) => request.detailId === SplitInspectorDetailFixtures.disabled.summary.detailId ? { kind: "found" as const, detail: SplitInspectorDetailFixtures.disabled } : { kind: "missing" as const });
    const selection = createNativeControlSelectionService({ inspection: { list, detail, diagnose: vi.fn() } as never, currentProject: { current: vi.fn() } as never });
    await expect(selection.installed({ kind: "identity", plugin: "disabled@market", scope: "user" }, signal)).resolves.toMatchObject({ kind: "selected", detail: { summary: { plugin: "disabled@market" } } });
    expect(list).toHaveBeenCalledOnce();
    expect(detail).toHaveBeenCalledWith({ snapshotId: SplitInspectorPageFixture.snapshotId, detailId: SplitInspectorDetailFixtures.disabled.summary.detailId }, signal);
  });

  it("recaptures identity selection once when concurrent authority invalidates the current page", async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new NativeInspectionError("SNAPSHOT_STALE"))
      .mockResolvedValueOnce(SplitInspectorPageFixture);
    const detail = vi.fn(async () => ({ kind: "found" as const, detail: SplitInspectorDetailFixtures.disabled }));
    const selection = createNativeControlSelectionService({ inspection: { list, detail, diagnose: vi.fn() } as never, currentProject: { current: vi.fn() } as never });

    await expect(selection.installed({ kind: "identity", plugin: "disabled@market", scope: "user" }, signal))
      .resolves.toMatchObject({ kind: "selected", detail: { summary: { plugin: "disabled@market" } } });
    expect(list).toHaveBeenCalledTimes(2);

    const exact = createNativeControlSelectionService({ inspection: { list: vi.fn(), detail: vi.fn(async () => ({ kind: "stale", action: "retry-read" })), diagnose: vi.fn() } as never, currentProject: { current: vi.fn() } as never });
    await expect(exact.installed({ kind: "exact", plugin: "disabled@market", scope: "user", snapshotId: SplitInspectorPageFixture.snapshotId, detailId: SplitInspectorDetailFixtures.disabled.summary.detailId }, signal))
      .resolves.toEqual({ kind: "stale" });
  });

  it("rejects stale, wrong-subject, duplicate, and absent evidence without fallback", async () => {
    const exact = createNativeControlSelectionService({ inspection: { list: vi.fn(), detail: vi.fn(async () => ({ kind: "stale", action: "retry-read" })), diagnose: vi.fn() } as never, currentProject: { current: vi.fn() } as never });
    await expect(exact.installed({ kind: "exact", plugin: "disabled@market", scope: "user", snapshotId: SplitInspectorPageFixture.snapshotId, detailId: SplitInspectorDetailFixtures.disabled.summary.detailId }, signal)).resolves.toEqual({ kind: "stale" });

    const duplicatePage = { ...SplitInspectorPageFixture, items: [SplitInspectorDetailFixtures.disabled.summary, SplitInspectorDetailFixtures.disabled.summary] };
    const duplicate = createNativeControlSelectionService({ inspection: { list: vi.fn(async () => duplicatePage), detail: vi.fn(), diagnose: vi.fn() } as never, currentProject: { current: vi.fn() } as never });
    await expect(duplicate.installed({ kind: "identity", plugin: "disabled@market", scope: "user" }, signal)).resolves.toEqual({ kind: "ambiguous" });
    await expect(duplicate.candidate({ kind: "identity", plugin: "disabled@market", scope: "user" }, signal)).resolves.toEqual({ kind: "not-found" });
  });
});
