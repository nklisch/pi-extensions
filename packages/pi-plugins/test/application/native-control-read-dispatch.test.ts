import { describe, expect, it, vi } from "vitest";
import { createNativeControlParser } from "../../src/application/native-control-parser.js";
import { createNativeControlReadDispatcher } from "../../src/application/native-control-read-dispatch.js";
import { createNativeControlSelectionService } from "../../src/application/native-control-selection.js";
import { SplitInspectorDetailFixtures, SplitInspectorPageFixture } from "../fixtures/native-inspection/split-inspector.js";

const signal = new AbortController().signal;
const parser = createNativeControlParser();

function command(argv: string[]) {
  const parsed = parser.parseArgv(argv);
  if (parsed.kind !== "parsed") throw new Error("command fixture did not parse");
  return parsed.command;
}

function fixture() {
  const inspection = {
    list: vi.fn(async () => SplitInspectorPageFixture),
    detail: vi.fn(async (request: any) => {
      const detail = Object.values(SplitInspectorDetailFixtures).find((entry) => entry.summary.detailId === request.detailId);
      return detail === undefined ? { kind: "missing" } : { kind: "found", detail };
    }),
    diagnose: vi.fn(async () => ({ snapshotId: SplitInspectorPageFixture.snapshotId, condition: "ready", observations: [], diagnostics: [] })),
  };
  const currentProject = { current: vi.fn(async () => ({ kind: "unavailable" })) };
  const selection = createNativeControlSelectionService({ inspection: inspection as never, currentProject: currentProject as never });
  const dependencies = {
    marketplace: {
      registration: { list: vi.fn(async () => ({ registrations: [] })) },
      catalog: { search: vi.fn(async () => ({ candidates: [], observations: [] })) },
      adoption: { preview: vi.fn(async () => ({ candidates: [], documents: [], diagnostics: [] })) },
    },
    inspection,
    trustedInstallation: { status: vi.fn(async () => ({ kind: "missing" })), cancel: vi.fn(async () => ({ kind: "missing" })) },
    operations: { status: vi.fn(async () => ({ kind: "missing" })), cancel: vi.fn(async () => ({ kind: "missing" })) },
    updates: { previewPolicy: vi.fn(), status: vi.fn(async () => ({ policy: { global: { application: "manual", cadence: "balanced" }, scopes: [], policies: [], inventoryComplete: true }, scheduler: { state: "standby", scopes: [] }, unreadCount: 0, unresolvedCount: 0 })), notifications: vi.fn(async () => ({ notices: [], unreadCount: 0, unresolvedCount: 0 })) },
    status: { snapshot: vi.fn(() => ({ status: "ready", local: { recovery: "settled", runtime: "reconciled" }, update: { state: "standby", unreadCount: 0, unresolvedCount: 0, scopes: [] }, blocked: [], capabilities: { mcp: { status: "unavailable", explanation: "not configured" }, subagents: { status: "unavailable", explanation: "not configured" }, piReload: { status: "available", explanation: "available" }, secrets: { status: "available", explanation: "available" } } })) },
    selection,
  };
  return { dispatcher: createNativeControlReadDispatcher(dependencies as never), dependencies };
}

describe("native control read dispatch", () => {
  it("dispatches local reads exactly once and preserves owner pagination", async () => {
    const { dispatcher, dependencies } = fixture();
    const result = await dispatcher.dispatch(command(["list", "--scope", "user"]), signal);
    expect(result).toMatchObject({ status: "ok", data: { items: expect.any(Array) } });
    expect(dependencies.inspection.list).toHaveBeenCalledOnce();
  });

  it("resolves show through exact selection with no lifecycle effect", async () => {
    const { dispatcher, dependencies } = fixture();
    const result = await dispatcher.dispatch(command(["show", "disabled@market", "--scope", "user"]), signal);
    expect(result).toMatchObject({ status: "ok", data: { kind: "found", detail: { summary: { plugin: "disabled@market" } } } });
    expect(dependencies.inspection.detail).toHaveBeenCalledOnce();
  });

  it("uses the same show command for exact marketplace candidates", async () => {
    const { dispatcher } = fixture();
    const result = await dispatcher.dispatch(command(["show", "candidate@market", "--scope", "user"]), signal);
    expect(result).toMatchObject({ status: "ok", data: { kind: "found", detail: { summary: { subject: "marketplace-candidate", plugin: "candidate@market" } } } });
  });

  it("routes operation tokens only to their owning service", async () => {
    const { dispatcher, dependencies } = fixture();
    const token = `trusted-install-session-v1:123e4567-e89b-42d3-a456-426614174000.${"a".repeat(64)}`;
    await expect(dispatcher.dispatch(command(["operation", "status", token]), signal)).resolves.toMatchObject({ status: "not-found" });
    expect(dependencies.trustedInstallation.status).toHaveBeenCalledOnce();
    expect(dependencies.operations.status).not.toHaveBeenCalled();
  });

  it("preserves scheduler ownership in update and host status projections", async () => {
    const { dispatcher, dependencies } = fixture();
    dependencies.updates.status.mockResolvedValue({
      policy: { global: { application: "manual", cadence: "balanced" }, scopes: [{ scope: { kind: "user" }, ownership: "self", clock: "current", nextAt: 500 }], policies: [], inventoryComplete: true },
      scheduler: { state: "running", scopes: [{ scope: { kind: "user" }, ownership: "self", nextAt: 500 }] },
      unreadCount: 1,
      unresolvedCount: 2,
    });
    dependencies.status.snapshot.mockReturnValue({
      status: "ready",
      local: { recovery: "settled", runtime: "reconciled" },
      update: { state: "running", unreadCount: 1, unresolvedCount: 2, scopes: [{ scope: { kind: "user" }, ownership: "self", nextAt: 500 }] },
      blocked: [],
      capabilities: { mcp: { status: "unavailable", explanation: "not configured" }, subagents: { status: "unavailable", explanation: "not configured" }, piReload: { status: "available", explanation: "available" }, secrets: { status: "available", explanation: "available" } },
    });

    await expect(dispatcher.dispatch(command(["updates", "status"]), signal)).resolves.toMatchObject({
      status: "ok",
      data: { scheduler: { state: "running", scopes: [{ ownership: "self", nextAt: 500 }] } },
    });
    await expect(dispatcher.dispatch(command(["status"]), signal)).resolves.toMatchObject({
      status: "ok",
      data: { update: { state: "running", scopes: [{ ownership: "self", nextAt: 500 }] } },
    });
  });
});
