import { describe, expect, it, vi } from "vitest";
import { createNativeInspectionService } from "../../src/application/native-inspection-service.js";
import { createNativeInstalledHarness, nativeInspectionSha256 } from "../helpers/native-installed-inspection.js";

async function inspectThroughService(options: Parameters<typeof createNativeInstalledHarness>[0]) {
  const harness = createNativeInstalledHarness(options);
  const service = createNativeInspectionService({
    evidence: { capture: async () => harness.snapshot, validate: async () => "current" },
    installed: harness.inspector,
    candidates: { inspect: vi.fn() },
    catalog: { search: vi.fn(async () => ({ candidates: [], observations: [] })), detail: vi.fn() } as never,
    adoption: { preview: vi.fn() },
    clock: { nowEpochMilliseconds: () => 1 } as never,
    sha256: nativeInspectionSha256,
  });
  const page = await service.list({ subjects: ["installed"], scope: options.projectUntrusted ? "project" : "user", query: "", limit: 50 }, new AbortController().signal);
  expect(page.items).toHaveLength(1);
  const result = await service.detail({ snapshotId: page.snapshotId, detailId: page.items[0]!.detailId }, new AbortController().signal);
  expect(result.kind).toBe("found");
  if (result.kind !== "found") throw new Error(`unexpected result: ${result.kind}`);
  return { page, detail: result.detail };
}

describe("native inspection runtime health acceptance", () => {
  it("keeps exact MCP registration active when real projection reports failed remote health", async () => {
    const { page, detail } = await inspectThroughService({ enabled: true, remote: "failed" });
    expect(page.condition).toBe("degraded");
    expect(detail.activation?.state).toBe("active");
    expect(detail.mcpHealth?.localRegistration).toBe("matching");
    expect(detail.mcpHealth?.servers[0]).toMatchObject({ authority: "current", state: "failed", transport: "stdio" });
    expect(detail.diagnostics.map((item) => item.code)).toEqual(["MCP_REMOTE_HEALTH_FAILED"]);
  });

  it("retains old health only as stale evidence across recovery and project distrust", async () => {
    const recovery = await inspectThroughService({ enabled: true, remote: "failed", pending: true });
    expect(recovery.detail.activation?.state).toBe("pending");
    expect(recovery.detail.mcpHealth?.servers[0]?.authority).toBe("stale");
    expect(recovery.detail.diagnostics.map((item) => item.code)).toEqual(["TRANSITION_PENDING"]);

    const untrusted = await inspectThroughService({ enabled: true, remote: "connected", projectUntrusted: true });
    expect(untrusted.detail.activation?.state).toBe("blocked");
    expect(untrusted.detail.mcpHealth?.servers[0]?.authority).toBe("stale");
    expect(untrusted.detail.diagnostics.map((item) => item.code)).toEqual(["PROJECT_UNTRUSTED"]);
  });

  it("treats exact disabled inactivity as ready through the composed service", async () => {
    const { page, detail } = await inspectThroughService({ skill: true, mcpUnavailable: true });
    expect(page.condition).toBe("ready");
    expect(detail.activation).toMatchObject({ intent: "disabled", state: "inactive" });
    expect(detail.summary.condition).toBe("ready");
  });
});
