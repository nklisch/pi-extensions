import { describe, expect, it } from "vitest";
import { trustedInstallFlowFixture } from "../../fixtures/trusted-install/plugin-install-flow.js";
import {
  createPluginManagerState,
  pluginManagerAvailableActions,
  pluginManagerMenuActions,
  pluginManagerReducer,
  rowKeyIdentity,
  type PluginManagerRow,
} from "../../../src/pi/manager/plugin-manager-model.js";

const row = (key: string): PluginManagerRow => ({
  key: { subject: "installed", key, snapshotId: `snapshot-${key}`, detailId: `detail-${key}` },
  title: key,
  subtitle: "market · user",
  status: "ready",
  scope: "user",
  plugin: `${key}@market`,
  completion: { category: "plugin", value: `${key}@market`, safe: { text: key, escaped: false, truncated: false } },
  data: {},
});

describe("plugin manager reducer", () => {
  it("is request-number deterministic and rejects late pages", () => {
    let state = createPluginManagerState();
    state = pluginManagerReducer(state, { type: "page-loading", request: 2, append: false });
    state = pluginManagerReducer(state, { type: "page-loaded", request: 1, rows: [row("stale")], append: false });
    expect(state.page.loading).toBe(true);
    expect(state.page.rows).toEqual([]);
    state = pluginManagerReducer(state, { type: "page-loaded", request: 2, rows: [row("current")], next: "opaque", append: false });
    expect(state.page.rows.map((entry) => entry.title)).toEqual(["current"]);
    expect(state.page.next).toBe("opaque");
  });

  it("restores focus by semantic row identity and falls back to the nearest survivor", () => {
    let state = createPluginManagerState();
    state = pluginManagerReducer(state, { type: "page-loading", request: 1, append: false });
    state = pluginManagerReducer(state, { type: "page-loaded", request: 1, rows: [row("a"), row("b"), row("c")], append: false });
    state = pluginManagerReducer(state, { type: "select-row", row: row("b").key });
    state = pluginManagerReducer(state, { type: "page-loading", request: 2, append: false });
    state = pluginManagerReducer(state, { type: "page-loaded", request: 2, rows: [row("a"), row("b"), row("d")], append: false });
    expect(rowKeyIdentity(state.focus.row!)).toBe(rowKeyIdentity(row("b").key));
    state = pluginManagerReducer(state, { type: "page-loading", request: 3, append: false });
    state = pluginManagerReducer(state, { type: "page-loaded", request: 3, rows: [row("a"), row("d")], append: false });
    expect(state.focus.row?.key).toBe("d");
  });

  it("reconciles the detail pane on page reload: follows the same plugin, closes when it disappears", () => {
    const rowV1 = row("demo");
    const rowV2: PluginManagerRow = { ...row("demo"), key: { ...row("demo").key, snapshotId: "snapshot-2", detailId: "detail-2" } };
    let state = createPluginManagerState();
    state = pluginManagerReducer(state, { type: "page-loading", request: 1, append: false });
    state = pluginManagerReducer(state, { type: "page-loaded", request: 1, rows: [rowV1, row("other")], append: false });
    state = pluginManagerReducer(state, { type: "intent", intent: { type: "open-detail" } });
    expect(state.focus.pane).toBe("detail");
    // Same plugin, rotated authority: the pane stays open on the new identity.
    state = pluginManagerReducer(state, { type: "page-loading", request: 2, append: false });
    state = pluginManagerReducer(state, { type: "page-loaded", request: 2, rows: [rowV2, row("other")], append: false });
    expect(state.focus).toMatchObject({ pane: "detail" });
    expect(state.focus.row?.key).toBe("demo");
    expect(state.focus.row?.snapshotId).toBe("snapshot-2");
    // Plugin gone: the pane closes instead of showing stale detail over a
    // substituted selection.
    state = pluginManagerReducer(state, { type: "page-loading", request: 3, append: false });
    state = pluginManagerReducer(state, { type: "page-loaded", request: 3, rows: [row("other")], append: false });
    expect(state.focus).toMatchObject({ pane: "list" });
    expect(state.focus.row?.key).toBe("other");
  });

  it("bounds appended pages and resets authority on view/search changes", () => {
    let state = createPluginManagerState();
    for (let request = 1; request <= 7; request += 1) {
      state = pluginManagerReducer(state, { type: "page-loading", request, append: request > 1 });
      state = pluginManagerReducer(state, { type: "page-loaded", request, rows: [row(String(request))], append: request > 1, next: String(request + 1) });
    }
    expect(state.page.pages).toBe(5);
    expect(state.page.rows.map((entry) => entry.title)).toEqual(["3", "4", "5", "6", "7"]);
    expect(state.installedCount).toBe(5);
    state = pluginManagerReducer(state, { type: "intent", intent: { type: "set-view", view: "marketplaces" } });
    expect(state.view).toBe("marketplaces");
    expect(state.page.rows).toEqual([]);
    expect(state.focus).toMatchObject({ pane: "list" });
    expect(state.installedCount).toBe(5);
  });

  it("derives onboarding and lifecycle actions from current presentation evidence", () => {
    let state = createPluginManagerState();
    expect(pluginManagerAvailableActions(state)).toEqual(["marketplace-add"]);
    state = pluginManagerReducer(state, { type: "intent", intent: { type: "set-view", view: "marketplaces" } });
    expect(pluginManagerAvailableActions(state)).toEqual(["marketplace-add"]);

    state = createPluginManagerState();
    state = pluginManagerReducer(state, { type: "page-loading", request: 1, append: false });
    state = pluginManagerReducer(state, { type: "page-loaded", request: 1, rows: [row("demo")], append: false });
    expect(pluginManagerAvailableActions(state)).toEqual(["inspect"]);
    state = pluginManagerReducer(state, { type: "detail-loading", request: 1, row: row("demo").key });
    state = pluginManagerReducer(state, {
      type: "detail-loaded", request: 1, row: row("demo").key, open: true,
      envelope: { data: { kind: "found", detail: { ...trustedInstallFlowFixture.chooseInspect, lifecycle: { ...trustedInstallFlowFixture.chooseInspect.lifecycle, activationIntent: "enabled", update: "current" } } } } as never,
    });
    expect(pluginManagerAvailableActions(state)).toEqual(["inspect", "disable", "uninstall-delete"]);
    expect(pluginManagerMenuActions(state)).toEqual(["disable", "uninstall-delete"]);
  });

  it("leads with update when one is available and offers mark-read in the updates lens", () => {
    let state = createPluginManagerState();
    const updateRow: PluginManagerRow = { ...row("demo"), hasUpdate: true, unreadNoticeIds: Object.freeze(["update-notice-v1:sha256:" + "a".repeat(64)]) };
    state = pluginManagerReducer(state, { type: "page-loading", request: 1, append: false });
    state = pluginManagerReducer(state, { type: "page-loaded", request: 1, rows: [updateRow], append: false });
    state = pluginManagerReducer(state, { type: "detail-loading", request: 1, row: updateRow.key });
    state = pluginManagerReducer(state, {
      type: "detail-loaded", request: 1, row: updateRow.key, open: true,
      envelope: { data: { kind: "found", detail: { ...trustedInstallFlowFixture.chooseInspect, lifecycle: { ...trustedInstallFlowFixture.chooseInspect.lifecycle, activationIntent: "enabled", update: "manual-required" } } } } as never,
    });
    expect(pluginManagerMenuActions(state)).toEqual(["update", "disable", "uninstall-delete"]);
    state = pluginManagerReducer(state, { type: "intent", intent: { type: "cycle-filter", delta: -1 } });
    // The lens switch clears the open detail; mark-read must still be offered
    // because it only needs the notice ids carried by the row itself.
    expect(pluginManagerMenuActions(state)).toEqual(["update-all", "update-policy", "notice-acknowledge"]);
    state = pluginManagerReducer(state, { type: "intent", intent: { type: "open-detail" } });
    state = pluginManagerReducer(state, { type: "detail-loading", request: 2, row: updateRow.key });
    state = pluginManagerReducer(state, {
      type: "detail-loaded", request: 2, row: updateRow.key, open: true,
      envelope: { data: { kind: "found", detail: { ...trustedInstallFlowFixture.chooseInspect, lifecycle: { ...trustedInstallFlowFixture.chooseInspect.lifecycle, activationIntent: "enabled", update: "manual-required" } } } } as never,
    });
    expect(pluginManagerMenuActions(state)).toEqual(["update-all", "update-policy", "update", "disable", "notice-acknowledge", "uninstall-delete"]);
  });

  it("offers update-all and auto-update setup from the installed view's updates lens", () => {
    let state = createPluginManagerState();
    state = pluginManagerReducer(state, { type: "intent", intent: { type: "cycle-filter", delta: -1 } });
    expect(state.filter).toBe("updates");
    expect(pluginManagerAvailableActions(state)).toEqual(["update-all", "update-policy", "marketplace-add"]);
    expect(pluginManagerMenuActions(state)).toEqual(["update-all", "update-policy", "marketplace-add"]);
    state = pluginManagerReducer(state, { type: "intent", intent: { type: "cycle-filter", delta: 1 } });
    expect(state.filter).toBe("all");
    expect(pluginManagerAvailableActions(state)).toEqual(["marketplace-add"]);
  });

  it("tracks the global update policy as presentation state", () => {
    let state = createPluginManagerState();
    expect(state.updatesPolicy).toBeUndefined();
    state = pluginManagerReducer(state, { type: "updates-policy", application: "automatic", cadence: "balanced" });
    expect(state.updatesPolicy).toEqual({ application: "automatic", cadence: "balanced" });
  });

  it("keeps independent semantic scroll anchors for detail and operation", () => {
    let state = createPluginManagerState();
    for (const region of ["detail", "operation"] as const) {
      state = pluginManagerReducer(state, { type: "intent", intent: { type: "scroll", region, delta: 7 } });
    }
    expect(state.scroll).toEqual({ detail: 7, operation: 7 });
    state = pluginManagerReducer(state, { type: "intent", intent: { type: "scroll", region: "detail", delta: -99 } });
    expect(state.scroll.detail).toBe(0);
    expect(state.scroll.operation).toBe(7);
  });

  it("keeps status, operation frames, and resize as presentation state only", () => {
    let state = createPluginManagerState();
    state = pluginManagerReducer(state, { type: "update-counts", unread: 2, unresolved: 3 });
    state = pluginManagerReducer(state, { type: "operation-started", action: "update" });
    state = pluginManagerReducer(state, { type: "resized", columns: 54, rows: 18 });
    expect(state.updateCounts).toEqual({ unread: 2, unresolved: 3 });
    expect(state.operation).toMatchObject({ state: "running", action: "update" });
    state = pluginManagerReducer(state, { type: "operation-cancelling" });
    const cancelling = state;
    state = pluginManagerReducer(state, { type: "operation-cancelling" });
    expect(state).toBe(cancelling);
    state = pluginManagerReducer(state, { type: "operation-finished", envelope: {} as never });
    state = pluginManagerReducer(state, { type: "intent", intent: { type: "return-manager" } });
    expect(state.screen).toBe("manager");
    expect(state.operation.state).toBe("idle");
    expect(state.viewport).toEqual({ columns: 54, rows: 18 });
  });
});
