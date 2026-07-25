import { describe, expect, it, vi } from "vitest";
import { CURSOR_MARKER, Key, matchesKey } from "@earendil-works/pi-tui";
import { PluginManagerComponent } from "../../../src/pi/manager/plugin-manager-component.js";
import { createPluginManagerState, pluginManagerReducer, type PluginManagerIntent, type PluginManagerState } from "../../../src/pi/manager/plugin-manager-model.js";
import { trustedInstallFlowFixture } from "../../fixtures/trusted-install/plugin-install-flow.js";

function harness() {
  let state = createPluginManagerState();
  const listeners = new Set<(state: PluginManagerState) => void>();
  const intents: PluginManagerIntent[] = [];
  const controller = {
    state: () => state,
    dispatch(intent: PluginManagerIntent) {
      intents.push(intent);
      state = pluginManagerReducer(state, { type: "intent", intent });
      for (const listener of listeners) listener(state);
    },
    refresh: vi.fn(), dynamicCompletions: () => [], idle: async () => undefined, close: vi.fn(),
    subscribe(listener: (next: PluginManagerState) => void) { listeners.add(listener); return () => listeners.delete(listener); },
  } as any;
  const tui = { terminal: { rows: 20 }, requestRender: vi.fn() } as any;
  const theme = { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text, bold: (text: string) => text } as any;
  const keybindings = {
    matches: (data: string, id: string) =>
      id === "tui.select.up" ? matchesKey(data, Key.up) :
      id === "tui.select.down" ? matchesKey(data, Key.down) :
      id === "tui.select.pageDown" ? matchesKey(data, Key.pageDown) :
      id === "tui.select.pageUp" ? matchesKey(data, Key.pageUp) :
      id === "tui.select.confirm" ? matchesKey(data, Key.enter) :
      id === "tui.select.cancel" || id === "app.interrupt" ? matchesKey(data, Key.escape) : false,
    getKeys: () => ["enter"],
  } as any;
  const done = vi.fn();
  const component = new PluginManagerComponent({ tui, theme, keybindings, controller, done });
  component.focused = true;
  return { component, controller, intents, tui, done, setState(next: PluginManagerState) { state = next; } };
}

describe("plugin manager component", () => {
  it("supports direct catalog navigation, configured keys, refresh, and close", () => {
    const h = harness();
    h.component.handleInput("\r");
    h.component.handleInput("/");
    h.component.handleInput("abc");
    h.component.handleInput("\r");
    h.component.handleInput("r");
    h.component.handleInput("?");
    h.component.handleInput("\u001b");
    expect(h.intents).toEqual(expect.arrayContaining([
      { type: "open-detail" },
      { type: "focus-query" },
      { type: "set-query", query: "abc" },
      { type: "submit-search" },
      { type: "refresh", scope: "all" },
      { type: "toggle-help" },
      { type: "close" },
    ]));
    expect(h.tui.requestRender).toHaveBeenCalled();
  });

  it("moves catalog selection by a page and scrolls detail without another layer", () => {
    const h = harness();
    h.setState({ ...createPluginManagerState(), focus: { pane: "list" } });
    h.component.handleInput("\u001b[6~");
    h.setState({ ...createPluginManagerState(), focus: { pane: "detail" } });
    h.component.handleInput("\u001b[6~");
    expect(h.intents).toContainEqual({ type: "move-selection", delta: 18 });
    expect(h.intents).toContainEqual({ type: "scroll", region: "detail", delta: 18 });
  });

  it("returns from detail and then closes", () => {
    const h = harness();
    h.setState({ ...createPluginManagerState(), focus: { pane: "detail", action: "inspect" } });
    h.component.handleInput("\u001b");
    h.component.handleInput("\u001b");
    expect(h.intents).toEqual(expect.arrayContaining([{ type: "detail-back" }, { type: "close" }]));
    expect(h.done).toHaveBeenCalledWith({ kind: "closed" });
  });

  it("emits the IME cursor marker only while the query owns focus", () => {
    const h = harness();
    h.component.handleInput("/");
    expect(h.component.render(70).join("\n")).toContain(CURSOR_MARKER);
    h.component.handleInput("\u001b");
    expect(h.component.render(70).join("\n")).not.toContain(CURSOR_MARKER);
  });

  it("offers marketplace onboarding without a separate discovery surface", () => {
    const h = harness();
    h.component.handleInput("A");
    expect(h.intents).toContainEqual({ type: "action", action: "marketplace-add" });
    expect(h.done).not.toHaveBeenCalled();
  });

  it("uses horizontal catalog lenses and direct update shortcuts", () => {
    const h = harness();
    h.component.handleInput("\u001b[C");
    h.component.handleInput("\u001b[D");
    h.component.handleInput("\u0015");
    let updateState = pluginManagerReducer(createPluginManagerState(), { type: "page-loading", request: 1, append: false });
    const updateRow = {
      key: { subject: "installed" as const, key: "user:demo", snapshotId: "snapshot", detailId: "detail" },
      title: "demo", subtitle: "market · user", status: "update available", scope: "user" as const, plugin: "demo@market", hasUpdate: true,
      completion: { category: "plugin" as const, value: "demo@market", safe: { text: "demo", escaped: false, truncated: false } }, data: {},
    };
    updateState = pluginManagerReducer(updateState, { type: "page-loaded", request: 1, rows: [updateRow], append: false });
    h.setState(updateState);
    h.component.handleInput("u");
    expect(h.intents).toEqual(expect.arrayContaining([
      { type: "cycle-filter", delta: 1 },
      { type: "cycle-filter", delta: -1 },
      { type: "action", action: "update-all" },
      { type: "action", action: "update" },
    ]));
  });

  it("runs update-all and auto-update setup from the installed view's updates lens", () => {
    const h = harness();
    let state = pluginManagerReducer(createPluginManagerState(), { type: "intent", intent: { type: "cycle-filter", delta: -1 } });
    h.setState(state);
    h.component.handleInput("p");
    expect(h.intents).toContainEqual({ type: "action", action: "update-policy" });
    state = pluginManagerReducer(state, { type: "intent", intent: { type: "cycle-filter", delta: 1 } });
    h.setState(state);
    h.component.handleInput("p");
    expect(h.intents.filter((intent) => intent.type === "action" && intent.action === "update-policy")).toHaveLength(1);
  });

  it("toggles enable/disable with d and removes with x from exact detail evidence", () => {
    const h = harness();
    const row = {
      key: { subject: "installed" as const, key: "user:demo", snapshotId: "snapshot", detailId: "detail" },
      title: "demo", subtitle: "market · user", status: "installed", scope: "user" as const, plugin: "demo@market",
      completion: { category: "plugin" as const, value: "demo@market", safe: { text: "demo", escaped: false, truncated: false } }, data: {},
    };
    let state = pluginManagerReducer(createPluginManagerState(), { type: "page-loading", request: 1, append: false });
    state = pluginManagerReducer(state, { type: "page-loaded", request: 1, rows: [row], append: false });
    // Without exact detail evidence the shortcuts are inert.
    h.setState(state);
    h.component.handleInput("d");
    h.component.handleInput("x");
    expect(h.intents.filter((intent) => intent.type === "action")).toEqual([]);
    state = pluginManagerReducer(state, { type: "detail-loading", request: 1, row: row.key });
    state = pluginManagerReducer(state, {
      type: "detail-loaded", request: 1, row: row.key, open: false,
      envelope: { data: { kind: "found", detail: { ...trustedInstallFlowFixture.chooseInspect, lifecycle: { ...trustedInstallFlowFixture.chooseInspect.lifecycle, activationIntent: "enabled", update: "current" } } } } as never,
    });
    h.setState(state);
    h.component.handleInput("d");
    h.component.handleInput("x");
    expect(h.intents).toEqual(expect.arrayContaining([
      { type: "action", action: "disable" },
      { type: "action", action: "uninstall-delete" },
    ]));
    // The query pane owns printable keys; shortcuts never fire while searching.
    h.component.handleInput("/");
    h.component.handleInput("d");
    expect(h.intents.filter((intent) => intent.type === "action")).toHaveLength(2);
  });

  it("runs update with u from the open detail pane", () => {
    const h = harness();
    const row = {
      key: { subject: "installed" as const, key: "user:demo", snapshotId: "snapshot", detailId: "detail" },
      title: "demo", subtitle: "market · user", status: "update available", scope: "user" as const, plugin: "demo@market", hasUpdate: true,
      completion: { category: "plugin" as const, value: "demo@market", safe: { text: "demo", escaped: false, truncated: false } }, data: {},
    };
    let state = pluginManagerReducer(createPluginManagerState(), { type: "page-loading", request: 1, append: false });
    state = pluginManagerReducer(state, { type: "page-loaded", request: 1, rows: [row], append: false });
    state = pluginManagerReducer(state, { type: "intent", intent: { type: "open-detail" } });
    state = pluginManagerReducer(state, { type: "detail-loading", request: 1, row: row.key });
    h.setState(state);
    expect(state.focus.pane).toBe("detail");
    h.component.handleInput("u");
    expect(h.intents).toContainEqual({ type: "action", action: "update" });
  });

  it("keeps u inert in the detail pane while the same plugin's detail reloads after authority rotation", () => {
    const h = harness();
    const row = (snapshotId: string, detailId: string) => ({
      key: { subject: "installed" as const, key: "user:demo", snapshotId, detailId },
      title: "demo", subtitle: "market · user", status: "update available", scope: "user" as const, plugin: "demo@market", hasUpdate: true,
      completion: { category: "plugin" as const, value: "demo@market", safe: { text: "demo", escaped: false, truncated: false } }, data: {},
    });
    let state = pluginManagerReducer(createPluginManagerState(), { type: "page-loading", request: 1, append: false });
    state = pluginManagerReducer(state, { type: "page-loaded", request: 1, rows: [row("s1", "d1")], append: false });
    state = pluginManagerReducer(state, { type: "intent", intent: { type: "open-detail" } });
    state = pluginManagerReducer(state, { type: "detail-loading", request: 1, row: row("s1", "d1").key });
    // Authority rotates but the plugin stays: the pane follows the new key
    // while the displayed detail still belongs to the old one.
    state = pluginManagerReducer(state, { type: "page-loading", request: 2, append: false });
    state = pluginManagerReducer(state, { type: "page-loaded", request: 2, rows: [row("s2", "d2")], append: false });
    h.setState(state);
    expect(state.focus.pane).toBe("detail");
    h.component.handleInput("u");
    expect(h.intents.filter((intent) => intent.type === "action")).toEqual([]);
    // Once the reconciled detail lands, u works again.
    state = pluginManagerReducer(state, { type: "detail-loading", request: 2, row: row("s2", "d2").key });
    h.setState(state);
    h.component.handleInput("u");
    expect(h.intents).toContainEqual({ type: "action", action: "update" });
  });

  it("removes the selected marketplace with x from the marketplaces view", () => {
    const h = harness();
    const marketplace = {
      key: { subject: "marketplace" as const, key: "marketplace-registration-v1:sha256:" + "a".repeat(64) },
      title: "community", subtitle: "github", status: "ready",
      completion: { category: "marketplace" as const, value: "community", safe: { text: "community", escaped: false, truncated: false } }, data: {},
    };
    let state = pluginManagerReducer(createPluginManagerState(), { type: "intent", intent: { type: "set-view", view: "marketplaces" } });
    state = pluginManagerReducer(state, { type: "page-loading", request: 1, append: false });
    state = pluginManagerReducer(state, { type: "page-loaded", request: 1, rows: [marketplace], append: false });
    h.setState(state);
    h.component.handleInput("x");
    expect(h.intents).toContainEqual({ type: "action", action: "marketplace-remove" });
    // x never means uninstall on this view.
    expect(h.intents.filter((intent) => intent.type === "action" && intent.action === "uninstall-delete")).toEqual([]);
  });

  it("runs a mutating action without closing the manager surface", () => {
    const h = harness();
    h.setState({ ...createPluginManagerState(), focus: { pane: "detail", action: "install" } });
    h.component.handleInput("\r");
    expect(h.intents).toContainEqual({ type: "action", action: "install" });
    expect(h.done).not.toHaveBeenCalled();
  });

  it("mounts install review inside the existing Plugins component", async () => {
    const h = harness();
    const child = { render: vi.fn(() => ["Review trust", "Add plugin"]), handleInput: vi.fn(), dispose: vi.fn() };
    let done!: () => void;
    const pending = h.component.presentInline((_tui, _theme, _keys, finish) => {
      done = finish;
      return child;
    });
    expect(h.component.render(70).join("\n")).toContain("Plugins");
    expect(h.component.render(70).join("\n")).toContain("Review trust");
    h.component.handleInput("x");
    expect(child.handleInput).toHaveBeenCalledWith("x");
    done();
    await pending;
    expect(child.dispose).toHaveBeenCalledOnce();
    expect(h.component.render(70).join("\n")).toContain("Plugins");
  });

  it("returns from a finished inline operation to the catalog", () => {
    const h = harness();
    let finished = pluginManagerReducer(createPluginManagerState(), { type: "operation-started", action: "marketplace-add" });
    finished = pluginManagerReducer(finished, { type: "operation-finished", envelope: {} as never });
    h.setState(finished);
    h.component.handleInput("\u001b");
    expect(h.intents).toContainEqual({ type: "return-manager" });
    expect(h.done).not.toHaveBeenCalled();
  });

  it("makes repeated Escape a no-op while cancellation waits for owner truth", () => {
    const h = harness();
    let operation = pluginManagerReducer(createPluginManagerState(), { type: "operation-started", action: "enable" });
    h.setState(operation);
    h.component.handleInput("\u001b");
    operation = pluginManagerReducer(operation, { type: "operation-cancelling" });
    h.setState(operation);
    h.component.handleInput("\u001b");
    expect(h.intents.filter((intent) => intent.type === "cancel-operation")).toHaveLength(1);
    expect(h.done).not.toHaveBeenCalled();
  });

  it("handles resize/theme invalidation and idempotent disposal", () => {
    const h = harness();
    h.component.render(55);
    expect(h.intents).toContainEqual({ type: "resized", columns: 55, rows: 20 });
    h.component.invalidate();
    h.component.dispose();
    h.component.dispose();
    h.component.handleInput("r");
    expect(h.controller.close).not.toHaveBeenCalled();
  });
});
