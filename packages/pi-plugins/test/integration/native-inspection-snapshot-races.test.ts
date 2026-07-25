import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createNativeInspectionService } from "../../src/application/native-inspection-service.js";
import { deriveInspectionDetailId, deriveInspectionEvidenceSnapshotId } from "../../src/application/native-inspection-identifiers.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
function snapshot(epoch: string) {
  return { binding: { capturedAt: 1, scopes: [{ scope: { kind: "user" }, generation: 0, status: "ready", corruptionCodes: [] }], currentProject: { projectKey: `project-v1:sha256:${"11".repeat(32)}`, trust: { kind: "trusted" }, epoch: `sha256:${"22".repeat(32)}` }, catalogs: [], capability: { status: "ready", digest: `sha256:${"33".repeat(32)}`, capturedBy: "fixture" }, runtimeEpoch: `sha256:${epoch.repeat(64).slice(0, 64)}`, recoveryDigest: `sha256:${"44".repeat(32)}`, updateDigest: `sha256:${"55".repeat(32)}` }, states: [], currentProject: { identity: { kind: "path-only", canonicalRoot: "file:///project/", limitation: "identity-changes-with-canonical-root" }, projectKey: `project-v1:sha256:${"11".repeat(32)}`, trust: { kind: "trusted" } }, runtime: [], recovery: { results: [], deferred: false, processed: 0 }, startup: { status: "ready", blocked: [], capabilities: { mcp: { status: "unavailable", explanation: "none" }, subagents: { status: "unavailable", explanation: "none" }, piReload: { status: "available", explanation: "ready" }, secrets: { status: "available", explanation: "ready" } } } } as never;
}

describe("native inspection snapshot race rejection", () => {
  it("never returns a page after return-boundary validation changes", async () => {
    const captured = snapshot("6");
    const service = createNativeInspectionService({
      evidence: { capture: async () => captured, validate: async () => "stale" },
      installed: { inspect: vi.fn() }, candidates: { inspect: vi.fn() },
      catalog: { search: async () => ({ candidates: [], observations: [] }), detail: vi.fn() } as never,
      adoption: { preview: vi.fn() }, clock: { nowEpochMilliseconds: () => 1 } as never, sha256,
    });
    await expect(service.list({ subjects: ["installed"], scope: "all-current", query: "", limit: 50 }, new AbortController().signal))
      .rejects.toEqual(expect.objectContaining({ code: "SNAPSHOT_STALE" }));
  });

  it("rejects detail IDs replayed against another authority epoch before routing", async () => {
    const first = snapshot("6");
    const second = snapshot("7");
    const installed = { inspect: vi.fn() };
    const service = createNativeInspectionService({
      evidence: { capture: async () => second, validate: async () => "current" },
      installed: installed as never, candidates: { inspect: vi.fn() } as never,
      catalog: { search: vi.fn(), detail: vi.fn() } as never, adoption: { preview: vi.fn() }, clock: { nowEpochMilliseconds: () => 1 } as never, sha256,
    });
    const subject = { version: 1 as const, subject: "installed" as const, scope: { kind: "user" as const }, plugin: "demo@market" as never, selectedRevision: `sha256:${"88".repeat(32)}` as never };
    const result = await service.detail({ snapshotId: deriveInspectionEvidenceSnapshotId(first.binding, sha256), detailId: deriveInspectionDetailId(subject, sha256) }, new AbortController().signal);
    expect(result).toEqual({ kind: "stale", action: "retry-read" });
    expect(installed.inspect).not.toHaveBeenCalled();
  });
});
