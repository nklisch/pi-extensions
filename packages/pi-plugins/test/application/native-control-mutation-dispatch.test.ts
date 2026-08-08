import { describe, expect, it, vi } from "vitest";
import { createNativeControlMutationDispatcher, foldMarketplaceRefreshStatus } from "../../src/application/native-control-mutation-dispatch.js";
import { createNativeControlParser } from "../../src/application/native-control-parser.js";
import { unavailableNativeControlInput } from "../../src/application/native-control-input.js";
import { SplitInspectorDetailFixtures, SplitInspectorPageFixture } from "../fixtures/native-inspection/split-inspector.js";

const parser = createNativeControlParser();
const signal = new AbortController().signal;
function parsed(argv: string[]) { const value = parser.parseArgv(argv); if (value.kind !== "parsed") throw new Error(JSON.stringify(value)); return value.command; }
const ready = { status: "ready", local: { recovery: "settled", runtime: "reconciled" }, update: { state: "standby", unresolvedCount: 0, unreadCount: 0, scopes: [] }, blocked: [], capabilities: { mcp: { status: "unavailable", explanation: "none" }, subagents: { status: "unavailable", explanation: "none" }, piReload: { status: "available", explanation: "yes" }, secrets: { status: "available", explanation: "yes" } } } as const;
const context = { executionId: "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000", input: unavailableNativeControlInput, readiness: ready, progress: { trusted: vi.fn(), lifecycle: vi.fn(), emit: vi.fn() } } as never;

function fixture() {
  const inspection = {
    list: vi.fn(async () => SplitInspectorPageFixture),
    detail: vi.fn(async (request: any) => {
      const detail = Object.values(SplitInspectorDetailFixtures).find((entry) => entry.summary.detailId === request.detailId);
      return detail === undefined ? { kind: "missing" } : { kind: "found", detail };
    }),
    diagnose: vi.fn(),
  };
  const dependencies = {
    marketplace: {
      registration: { add: vi.fn(async () => ({ kind: "rejected", code: "SOURCE_UNAVAILABLE" })), remove: vi.fn(), list: vi.fn() },
      refresh: { refresh: vi.fn(async () => ({ outcomes: [], notifications: [] })) },
      catalog: { search: vi.fn(), detail: vi.fn() },
      adoption: { preview: vi.fn(), import: vi.fn(async () => ({ outcomes: [], diagnostics: [] })) },
    },
    inspection,
    trustedInstallation: { open: vi.fn(async () => ({ kind: "rejected", code: "INCOMPATIBLE", diagnostics: [] })), status: vi.fn(), activate: vi.fn(), recover: vi.fn(), run: vi.fn(), cancel: vi.fn() },
    operations: { preview: vi.fn(async () => ({ kind: "current-state", operation: "disable", diagnostics: [] })), apply: vi.fn(), run: vi.fn(), status: vi.fn(), cancel: vi.fn() },
    updates: { previewPolicy: vi.fn(async () => ({ kind: "rejected", code: "INVALID_CHANGE" })), applyPolicy: vi.fn(), status: vi.fn(), notifications: vi.fn(), acknowledge: vi.fn(), runAutomatic: vi.fn() },
    status: { snapshot: () => ready },
    currentProject: { current: vi.fn(async () => ({ kind: "unavailable" })) },
  };
  return { dispatcher: createNativeControlMutationDispatcher(dependencies as never), dependencies };
}

describe("native control mutation dispatch", () => {
  it.each([
    [[{ kind: "not-configured" }, { kind: "not-configured" }], "not-found"],
    [[{ kind: "not-configured" }, { kind: "refreshed" }], "partial"],
    [[{ kind: "cancelled" }, { kind: "cancelled" }], "cancelled"],
    [[{ kind: "refreshed" }, { kind: "skipped-local" }], "ok"],
    [[{ kind: "failed" }], "partial"],
    [[{ kind: "coalesced" }], "partial"],
  ] as const)("folds refresh outcomes %j exhaustively", (outcomes, expected) => {
    expect(foldMarketplaceRefreshStatus({ outcomes, notifications: [] } as never)).toBe(expected);
  });

  it("assembles marketplace mutation requests and calls only the owner once", async () => {
    const { dispatcher, dependencies } = fixture();
    const result = await dispatcher.dispatch(parsed(["marketplace", "add", "owner/repo"]), context, signal);
    expect(result).toMatchObject({
      status: "rejected",
      data: { kind: "rejected", code: "SOURCE_UNAVAILABLE" },
      human: [{ text: expect.stringContaining("couldn't be fetched") }],
    });
    expect(dependencies.marketplace.registration.add).toHaveBeenCalledOnce();
    expect(dependencies.marketplace.registration.add).toHaveBeenCalledWith({ source: { kind: "github", repository: "owner/repo" }, scope: "user", origin: { kind: "native" } }, signal);
  });

  it("rejects blocked readiness before selection/input/mutation", async () => {
    const { dispatcher, dependencies } = fixture();
    const result = await dispatcher.dispatch(parsed(["marketplace", "add", "owner/repo"]), { ...context, readiness: { ...ready, status: "blocked" } } as never, signal);
    expect(result).toMatchObject({ status: "rejected", diagnostics: [{ code: "CONTROL_READINESS_BLOCKED" }] });
    expect(dependencies.marketplace.registration.add).not.toHaveBeenCalled();
    expect(dependencies.inspection.list).not.toHaveBeenCalled();
  });

  it("forwards lifecycle preview authority without applying current state", async () => {
    const { dispatcher, dependencies } = fixture();
    const result = await dispatcher.dispatch(parsed(["disable", "disabled@market", "--scope", "user", "--yes"]), context, signal);
    expect(result).toMatchObject({ status: "no-change", data: { kind: "current-state", operation: "disable" } });
    expect(dependencies.operations.preview).toHaveBeenCalledOnce();
    expect(dependencies.operations.apply).not.toHaveBeenCalled();
  });

  it("opens install only through candidate inspection and trusted installation", async () => {
    const { dispatcher, dependencies } = fixture();
    const result = await dispatcher.dispatch(parsed(["install", "open", "candidate@market", "--scope", "user"]), context, signal);
    expect(result).toMatchObject({ status: "rejected", data: { kind: "rejected", code: "INCOMPATIBLE" } });
    expect(dependencies.trustedInstallation.open).toHaveBeenCalledOnce();
    expect(dependencies.trustedInstallation.activate).not.toHaveBeenCalled();
  });

  it("reports deferred automatic maintenance as partial rather than successful", async () => {
    const { dispatcher, dependencies } = fixture();
    const noticeId = `update-notice-v1:sha256:${"a".repeat(64)}`;
    dependencies.updates.runAutomatic.mockResolvedValue({
      outcomes: [{ noticeId, plugin: "demo@community", display: { installed: "1.0.0", available: "1.1.0" }, kind: "pending", reason: "cancelled-before-commit" }],
    });
    const result = await dispatcher.dispatch(parsed(["updates", "automatic", "run", "--notice-id", noticeId]), context, signal);
    expect(result).toMatchObject({
      status: "partial",
      data: { outcomes: [{ noticeId, kind: "pending" }] },
    });
    expect(result.human.map((field) => field.text).join("\n")).toContain("demo@community");
    expect(result.human.map((field) => field.text).join("\n")).not.toContain("updates.automatic.run");
  });

  it("presents staged updates in plain language with plugin names and next steps", async () => {
    const { dispatcher, dependencies } = fixture();
    const stagedId = `update-notice-v1:sha256:${"b".repeat(64)}`;
    const blockedId = `update-notice-v1:sha256:${"c".repeat(64)}`;
    dependencies.updates.runAutomatic.mockResolvedValue({
      outcomes: [
        { noticeId: stagedId, plugin: "workbench@nklisch-skills", display: { installed: "1.0.0", available: "1.1.0" }, kind: "staged" },
        { noticeId: blockedId, plugin: "krometrail@nklisch-skills", display: { installed: "1.4.0", available: "1.6.2" }, kind: "blocked", reason: "approval-required" },
      ],
    });
    const result = await dispatcher.dispatch(parsed(["updates", "automatic", "run", "--explicit", "--limit", "100"]), context, signal);
    expect(result.status).toBe("partial");
    const text = result.human.map((field) => field.text).join("\n");
    expect(text).toContain("1 update installed — live on next start");
    expect(text).toContain("workbench@nklisch-skills 1.0.0 → 1.1.0 — updated; live on next start");
    expect(text).toContain("krometrail@nklisch-skills 1.4.0 → 1.6.2 — needs your approval");
    expect(dependencies.updates.runAutomatic).toHaveBeenCalledWith(expect.objectContaining({ explicit: true, limit: 100 }), signal);
  });
});
