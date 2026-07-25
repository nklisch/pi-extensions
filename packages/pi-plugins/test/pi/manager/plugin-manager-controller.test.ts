import { describe, expect, it, vi } from "vitest";
import { createNativeControlEnvelope } from "../../../src/application/native-control-contract.js";
import type { NativeControlExecutionReport } from "../../../src/application/ports/native-control-execution.js";
import { createPluginManagerController, mergePluginCatalogRows } from "../../../src/pi/manager/plugin-manager-controller.js";
import type { PluginManagerRow } from "../../../src/pi/manager/plugin-manager-model.js";
import { SplitInspectorDetailFixtures } from "../../fixtures/native-inspection/split-inspector.js";

const executionId = "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never;
const snapshotId = `inspection-snapshot-v1:sha256:${"a".repeat(64)}`;
const detailId = `inspection-detail-v1:YWJj.${"b".repeat(64)}`;
const safe = (text: string) => ({ text, escaped: false, truncated: false });

function installedPage(plugin = "demo@market", nextCursor?: string) {
  return {
    snapshotId,
    condition: "ready",
    items: [{
      detailId,
      subject: "installed",
      scope: { kind: "user" },
      plugin,
      name: safe(plugin.split("@")[0]!),
      marketplace: safe("market"),
      revision: { installed: safe("1.0.0"), resolution: "exact" },
      condition: "ready",
      freshness: { status: "current", basis: "state" },
      diagnosticCounts: { error: 0, warning: 0, info: 0 },
    }],
    observations: [{ scope: { kind: "user" }, status: "ready", generation: 1, corruptionCodes: [] }],
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

function updateStatus(unread = 0, unresolved = 0) {
  return {
    policy: { global: { application: "manual", cadence: "balanced" }, scopes: [], policies: [], inventoryComplete: true },
    scheduler: { state: "standby", scopes: [] },
    unreadCount: unread,
    unresolvedCount: unresolved,
  };
}

function report(command: "inspection.list" | "updates.status" | "browse" | "updates.notices.list" | "status", data: unknown, page?: { next?: string }): NativeControlExecutionReport {
  return {
    envelope: createNativeControlEnvelope({ executionId, command, status: "ok", data: data as never, ...(page === undefined ? {} : { page }) }),
    delivery: "complete",
    deliveredThrough: -1,
  };
}

const emptyBrowse = () => report("browse", { candidates: [], observations: [] });
const emptyNotices = () => report("updates.notices.list", { notices: [], unreadCount: 0, unresolvedCount: 0 });
const healthStatus = () => report("status", {
  status: "ready",
  local: { recovery: "settled", runtime: "reconciled" },
  update: { state: "standby", unresolvedCount: 0, unreadCount: 0, scopes: [] },
  blocked: [],
  capabilities: {
    mcp: { status: "available", explanation: "ready" },
    subagents: { status: "available", explanation: "ready" },
    piReload: { status: "available", explanation: "ready" },
    secrets: { status: "available", explanation: "ready" },
  },
});

function catalogResult(argv: readonly string[], plugin = "demo@market", next?: string): NativeControlExecutionReport {
  if (argv[0] === "browse") return emptyBrowse();
  if (argv[0] === "status") return healthStatus();
  if (argv[0] === "updates" && argv[1] === "status") return report("updates.status", updateStatus(2, 3));
  if (argv[0] === "updates") return emptyNotices();
  return report("inspection.list", installedPage(plugin, next), next === undefined ? undefined : { next });
}

function candidateBrowse() {
  const detail = SplitInspectorDetailFixtures.marketplace!;
  const candidateSnapshot = `marketplace-snapshot-v1:sha256:${"c".repeat(64)}`;
  return report("browse", {
    candidates: [{
      id: `marketplace-candidate-v1:sha256:${"d".repeat(64)}`,
      snapshot: candidateSnapshot,
      scope: { kind: "user" },
      registrationId: `marketplace-registration-v1:sha256:${"e".repeat(64)}`,
      plugin: "candidate@market", marketplace: "market", name: "candidate",
      available: { kind: "marketplace-snapshot", marketplaceRevision: "a".repeat(40), snapshot: candidateSnapshot },
      availability: "available", source: detail.source,
      sourceIdentity: `sha256:${"f".repeat(64)}`,
      trust: "untrusted-not-inspected",
    }], observations: [],
  });
}

describe("plugin manager controller", () => {
  it("deduplicates equivalent Claude/Codex candidates by immutable source identity", () => {
    const candidate = (key: string, sourceIdentity: string, scope: "user" | "project" = "user"): PluginManagerRow => ({
      key: { subject: "candidate", key }, title: "agent-coordination", subtitle: "skills", status: "available", scope,
      plugin: `agent-coordination@${key}`,
      sourceIdentity,
      completion: { category: "candidate", value: key, safe: safe("agent-coordination") },
      data: { sourceIdentity },
    });
    const rows = mergePluginCatalogRows([], [
      candidate("claude", `sha256:${"a".repeat(64)}`),
      candidate("codex", `sha256:${"a".repeat(64)}`, "project"),
      candidate("other", `sha256:${"b".repeat(64)}`),
    ], []);
    expect(rows.map((row) => row.key.key)).toEqual(["claude", "other"]);
    expect(rows[0]?.availableScopes).toEqual(["user", "project"]);
  });

  it("attaches unread notice ids to the matching installed row", () => {
    const installed: PluginManagerRow = Object.freeze({
      key: Object.freeze({ subject: "installed" as const, key: "user:demo@market", snapshotId: "s", detailId: "d" }),
      title: "demo", subtitle: "market · user", status: "installed", scope: "user" as const, plugin: "demo@market",
      completion: Object.freeze({ category: "plugin" as const, value: "demo@market", safe: safe("demo") }),
      data: Object.freeze({}),
    });
    const notice = (id: string, unread: boolean, plugin = "demo@market"): PluginManagerRow => Object.freeze({
      key: Object.freeze({ subject: "notice" as const, key: id }),
      title: plugin, subtitle: "1.0 → 1.1", status: "manual-required", scope: "user" as const, plugin,
      completion: Object.freeze({ category: "notice" as const, value: id, safe: safe(plugin) }),
      data: Object.freeze({ id, unread }),
    });
    const rows = mergePluginCatalogRows([installed], [], [notice("n-read", false), notice("n-unread", true), notice("n-other", true, "other@market")]);
    expect(rows[0]?.unreadNoticeIds).toEqual(["n-unread"]);
    expect(rows[0]?.hasUpdate).toBe(true);
  });

  it("loads installed authority and update counts only through canonical facade argv", async () => {
    const calls: readonly string[][] = [];
    const execute = vi.fn(async (argv: readonly string[]) => {
      (calls as string[][]).push([...argv]);
      return catalogResult(argv);
    });
    const controller = createPluginManagerController({ execute });
    await controller.refresh("all");
    expect(calls).toContainEqual(["list", "--scope", "all-current", "--query", "", "--limit", "50"]);
    expect(calls).toContainEqual(["updates", "status", "--scope", "all-current"]);
    expect(controller.state().page.rows[0]).toMatchObject({ plugin: "demo@market", scope: "user", title: "demo", status: "installed" });
    expect(controller.state().updateCounts).toEqual({ unread: 2, unresolved: 3 });
    expect(controller.state().updatesPolicy).toEqual({ application: "manual", cadence: "balanced" });
    expect(controller.state().health.status).toBe("ready");
  });

  it("surfaces a degraded host through the heading indicator rather than a view", async () => {
    const execute = vi.fn(async (argv: readonly string[]) => {
      if (argv[0] === "status") {
        return {
          envelope: createNativeControlEnvelope({
            executionId, command: "status", status: "ok", data: {
              status: "degraded",
              local: { recovery: "settled", runtime: "degraded" },
              update: { state: "standby", unresolvedCount: 1, unreadCount: 2, scopes: [] },
              blocked: [],
              capabilities: {
                mcp: { status: "available", explanation: "ready" },
                subagents: { status: "unavailable", explanation: "not composed" },
                piReload: { status: "available", explanation: "ready" },
                secrets: { status: "unavailable", explanation: "not configured" },
              },
            } as never,
          }),
          delivery: "complete" as const,
          deliveredThrough: -1,
        };
      }
      return catalogResult(argv);
    });
    const controller = createPluginManagerController({ execute });
    await controller.refresh("all");
    expect(execute).toHaveBeenCalledWith(["status"], expect.any(AbortSignal));
    expect(controller.state().health).toMatchObject({ status: "degraded" });
    expect(controller.state().page.rows.every((row) => row.key.subject !== "health" as never)).toBe(true);
  });

  it("uses latest-intent-wins for search and ignores a late aborted response", async () => {
    const pending: Array<{ argv: readonly string[]; resolve: (value: NativeControlExecutionReport) => void; signal: AbortSignal }> = [];
    const execute = vi.fn((argv: readonly string[], signal: AbortSignal) => {
      if (argv[0] === "browse") return Promise.resolve(emptyBrowse());
      if (argv[0] === "updates") return Promise.resolve(emptyNotices());
      return new Promise<NativeControlExecutionReport>((resolve) => pending.push({ argv, resolve, signal }));
    });
    const controller = createPluginManagerController({ execute });
    controller.dispatch({ type: "set-query", query: "old" });
    const old = controller.refresh("view");
    controller.dispatch({ type: "set-query", query: "new" });
    const current = controller.refresh("view");
    expect(pending[0]!.signal.aborted).toBe(true);
    pending[1]!.resolve(report("inspection.list", installedPage("new@market")));
    await current;
    pending[0]!.resolve(report("inspection.list", installedPage("old@market")));
    await old;
    expect(controller.state().page.rows.map((row) => row.plugin)).toEqual(["new@market"]);
  });

  it("exhausts independent catalog cursors and loads exact detail IDs", async () => {
    const cursor = `inspection-cursor-v1:YWJj.${"c".repeat(64)}`;
    const execute = vi.fn(async (argv: readonly string[]) => {
      if (argv[0] === "show") {
        return {
          envelope: createNativeControlEnvelope({ executionId, command: "inspection.show", status: "stale", data: { kind: "stale", action: "retry-read" } as never }),
          delivery: "complete" as const,
          deliveredThrough: -1,
        };
      }
      return catalogResult(argv, "demo@market", cursor);
    });
    const controller = createPluginManagerController({ execute });
    await controller.refresh("view");
    expect(execute).toHaveBeenCalledWith(expect.arrayContaining(["--cursor", cursor]), expect.any(AbortSignal));
    controller.dispatch({ type: "open-detail" });
    await controller.idle();
    expect(execute).toHaveBeenCalledWith([
      "show", "demo@market", "--scope", "user", "--snapshot-id", snapshotId, "--detail-id", detailId,
    ], expect.any(AbortSignal));
    expect(controller.state().detail.envelope?.status).toBe("stale");
  });

  it("caches exact detail across navigation and only refetches on explicit detail refresh", async () => {
    const execute = vi.fn(async (argv: readonly string[]) => {
      if (argv[0] === "show") return {
        envelope: createNativeControlEnvelope({ executionId, command: "inspection.show", status: "ok", data: { kind: "found", detail: SplitInspectorDetailFixtures.disabled } as never }),
        delivery: "complete" as const, deliveredThrough: -1,
      };
      return catalogResult(argv, "disabled@market");
    });
    const controller = createPluginManagerController({ execute });
    await controller.refresh("view");
    controller.dispatch({ type: "open-detail" });
    await controller.idle();
    controller.dispatch({ type: "detail-back" });
    controller.dispatch({ type: "open-detail" });
    await controller.idle();
    expect(execute.mock.calls.filter(([argv]) => argv[0] === "show")).toHaveLength(1);
    controller.dispatch({ type: "refresh", scope: "detail" });
    await controller.idle();
    expect(execute.mock.calls.filter(([argv]) => argv[0] === "show")).toHaveLength(2);
  });

  it("preserves a direct Add intent while loading missing exact detail", async () => {
    const candidate = SplitInspectorDetailFixtures.marketplace!;
    const execute = vi.fn(async (argv: readonly string[]) => {
      if (argv[0] === "browse") return candidateBrowse();
      if (argv[0] === "show") return {
        envelope: createNativeControlEnvelope({ executionId, command: "inspection.show", status: "ok", data: { kind: "found", detail: candidate } as never }),
        delivery: "complete" as const, deliveredThrough: -1,
      };
      if (argv[0] === "list") return report("inspection.list", { snapshotId, condition: "ready", items: [], observations: [] });
      return catalogResult(argv);
    });
    const actions = { run: vi.fn(async () => ({ kind: "cancelled" as const })), cancel: vi.fn() };
    const controller = createPluginManagerController({ execute, actions });
    await controller.refresh("view");
    controller.dispatch({ type: "action", action: "install" });
    await controller.idle();
    expect(execute.mock.calls.filter(([argv]) => argv[0] === "show")).toHaveLength(1);
    expect(actions.run).toHaveBeenCalledWith("install", expect.objectContaining({ detail: expect.objectContaining({ envelope: expect.any(Object) }) }));
  });

  it("opens visible detail failure when direct Add cannot load exact authority", async () => {
    const execute = vi.fn(async (argv: readonly string[]) => {
      if (argv[0] === "browse") return candidateBrowse();
      if (argv[0] === "show") throw new Error("offline");
      if (argv[0] === "list") return report("inspection.list", { snapshotId, condition: "ready", items: [], observations: [] });
      return catalogResult(argv);
    });
    const actions = { run: vi.fn(), cancel: vi.fn() };
    const controller = createPluginManagerController({ execute, actions });
    await controller.refresh("view");
    controller.dispatch({ type: "action", action: "install" });
    await controller.idle();
    expect(actions.run).not.toHaveBeenCalled();
    expect(controller.state()).toMatchObject({
      focus: { pane: "detail" },
      detail: { loading: false, errorCode: "CONTROL_DETAIL_READ_FAILED" },
    });
  });

  it("detaches an admitted action on reload while closing reads and repeated cancellation remains owner-bound", async () => {
    const execute = vi.fn(async (argv: readonly string[]) => catalogResult(argv));
    let resolveAction!: (value: any) => void;
    const actions = {
      run: vi.fn(() => new Promise((resolve) => { resolveAction = resolve; })),
      cancel: vi.fn(),
    };
    const controller = createPluginManagerController({ execute, actions });
    await controller.refresh("view");
    controller.dispatch({ type: "action", action: "enable" });
    await vi.waitFor(() => expect(actions.run).toHaveBeenCalledOnce());
    controller.dispatch({ type: "cancel-operation" });
    controller.dispatch({ type: "cancel-operation" });
    expect(actions.cancel).toHaveBeenCalledOnce();
    await controller.close("reload");
    expect(actions.cancel).toHaveBeenCalledOnce();
    resolveAction({ kind: "completed", presentation: "successor", envelope: createNativeControlEnvelope({ executionId, command: "lifecycle.enable", status: "ok" }) });
  });

  it("keeps safe dynamic completion only and clears all ephemeral state on close", async () => {
    const execute = vi.fn(async (argv: readonly string[]) => catalogResult(argv));
    const controller = createPluginManagerController({ execute });
    await controller.refresh("all");
    expect(controller.dynamicCompletions()).toEqual([{ category: "plugin", value: "demo@market", safe: safe("demo") }]);
    await controller.close("quit");
    expect(controller.state().page.rows).toEqual([]);
    expect(controller.dynamicCompletions()).toEqual([]);
    await expect(controller.refresh()).resolves.toBeUndefined();
  });
});
