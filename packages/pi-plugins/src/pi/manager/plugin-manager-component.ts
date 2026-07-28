import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { PluginManagerController } from "./plugin-manager-controller.js";
import { projectTerminalText } from "./pi-terminal-text.js";
import { SPINNER_FRAMES, renderPluginManager } from "./plugin-manager-render.js";
import { pluginManagerAvailableActions, pluginManagerMenuActions, pluginManagerVisibleRows, rowKeyIdentity, type PluginManagerScrollRegion } from "./plugin-manager-model.js";

export type PluginManagerCloseResult = Readonly<{ kind: "closed" | "action"; action?: string }>;

function safePrintable(data: string): string | undefined {
  if (data.length === 0 || data.includes("\n") || data.includes("\r")) return undefined;
  const projected = projectTerminalText(data, 256);
  return projected.escaped ? undefined : projected.text;
}

export class PluginManagerComponent implements Component, Focusable {
  focused = false;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly controller: PluginManagerController;
  private done: ((result: PluginManagerCloseResult) => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private disposed = false;
  private cachedWidth: number | undefined;
  private cachedRows: number | undefined;
  private cachedLines: string[] | undefined;
  private inline: Readonly<{ component: Component; finish(value?: unknown): void }> | undefined;
  private spinIndex = 0;
  private spinTimer: ReturnType<typeof setInterval> | undefined;

  constructor(input: Readonly<{
    tui: TUI;
    theme: Theme;
    keybindings: KeybindingsManager;
    controller: PluginManagerController;
    done(result: PluginManagerCloseResult): void;
  }>) {
    this.tui = input.tui;
    this.theme = input.theme;
    this.keybindings = input.keybindings;
    this.controller = input.controller;
    this.done = input.done;
    this.unsubscribe = input.controller.subscribe((state) => {
      this.invalidate();
      this.tui.requestRender();
      if (state.closed) this.finish({ kind: "closed" });
    });
  }

  private finish(result: PluginManagerCloseResult): void {
    const done = this.done;
    if (done === undefined) return;
    this.done = undefined;
    done(result);
  }

  requestClose(): void {
    if (this.disposed) return;
    this.inline?.finish();
    this.controller.dispatch({ type: "close" });
    this.finish({ kind: "closed" });
  }

  /** Mount a child flow inside the existing manager surface instead of opening a second custom UI. */
  presentInline<T>(factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (value?: T) => void) => Component): Promise<T | undefined> {
    if (this.disposed || this.inline !== undefined) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value?: unknown): void => {
        if (settled) return;
        settled = true;
        const current = this.inline;
        this.inline = undefined;
        (current?.component as (Component & { dispose?(): void }) | undefined)?.dispose?.();
        this.invalidate();
        this.tui.requestRender();
        resolve(value as T | undefined);
      };
      const component = factory(this.tui, this.theme, this.keybindings, finish);
      this.inline = Object.freeze({ component, finish });
      this.invalidate();
      this.tui.requestRender();
    });
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const rows = Math.max(4, this.tui.terminal.rows);
    const state = this.controller.state();
    this.syncSpinner(state.operation.state === "running" || state.operation.state === "cancelling" || state.page.loading || state.detail.loading);
    if (state.viewport.columns !== width || state.viewport.rows !== rows) {
      this.controller.dispatch({ type: "resized", columns: width, rows });
    }
    if (this.cachedLines !== undefined && this.cachedWidth === width && this.cachedRows === rows) return this.cachedLines;
    this.cachedWidth = width;
    this.cachedRows = rows;
    if (this.inline !== undefined) {
      const selected = pluginManagerVisibleRows(state).find((row) => state.focus.row !== undefined && rowKeyIdentity(row.key) === rowKeyIdentity(state.focus.row)) ?? pluginManagerVisibleRows(state)[0];
      const context = [
        this.theme.fg("accent", this.theme.bold("Plugins")),
        truncateToWidth(`→ ${selected?.title ?? "Selected plugin"}  ${selected?.status ?? "working"}`, Math.max(1, width), ""),
      ];
      const available = Math.max(1, rows - context.length - 1);
      const child = this.inline.component.render(width).slice(0, available);
      this.cachedLines = [...context, ...child, this.theme.fg("dim", "esc back/cancel")].slice(0, rows);
    } else {
      this.cachedLines = [...renderPluginManager({ state: this.controller.state(), width, height: rows, theme: this.theme, keybindings: this.keybindings, focused: this.focused, spinnerFrame: SPINNER_FRAMES[this.spinIndex % SPINNER_FRAMES.length] })];
    }
    return this.cachedLines;
  }

  /** Spinner ticks only while something is actually in flight. */
  private syncSpinner(active: boolean): void {
    if (active && this.spinTimer === undefined) {
      this.spinTimer = setInterval(() => {
        this.spinIndex += 1;
        this.invalidate();
        this.tui.requestRender();
      }, 100);
      this.spinTimer.unref?.();
    } else if (!active && this.spinTimer !== undefined) {
      clearInterval(this.spinTimer);
      this.spinTimer = undefined;
    }
  }

  private escape(): void {
    const state = this.controller.state();
    if (state.operation.state === "running") {
      this.controller.dispatch({ type: "cancel-operation" });
      return;
    }
    if (state.operation.state === "cancelling") return;
    if (state.operation.state === "finished") {
      this.controller.dispatch({ type: "return-manager" });
      return;
    }
    if (state.screen !== "manager") {
      this.controller.dispatch({ type: "return-manager" });
      return;
    }
    if (state.focus.pane === "detail" || state.focus.pane === "query") {
      this.controller.dispatch({ type: "detail-back" });
      return;
    }
    this.requestClose();
  }

  private queryInput(data: string): boolean {
    const state = this.controller.state();
    if (state.focus.pane !== "query") return false;
    if (matchesKey(data, Key.enter) || this.keybindings.matches(data, "tui.select.confirm")) {
      this.controller.dispatch({ type: "submit-search" });
      return true;
    }
    if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
      const scalars = Array.from(state.query);
      scalars.pop();
      this.controller.dispatch({ type: "set-query", query: scalars.join("") });
      return true;
    }
    const printable = safePrintable(data);
    if (printable !== undefined) {
      this.controller.dispatch({ type: "set-query", query: `${state.query}${printable}`.slice(0, 256) });
      return true;
    }
    return false;
  }

  private scrollRegion(): PluginManagerScrollRegion {
    return this.controller.state().operation.state !== "idle" ? "operation" : "detail";
  }

  private activateAction(action: string): void {
    this.controller.dispatch({ type: "action", action });
  }

  private page(delta: number): void {
    const state = this.controller.state();
    const amount = Math.max(1, state.viewport.rows - 6) * delta;
    if (state.focus.pane === "list" || state.focus.pane === "query") {
      const rows = pluginManagerVisibleRows(state);
      const selected = state.focus.row === undefined ? 0 : rows.findIndex((row) => rowKeyIdentity(row.key) === rowKeyIdentity(state.focus.row!));
      if (delta > 0 && state.page.next !== undefined && selected >= rows.length - 1) {
        this.controller.dispatch({ type: "next-page" });
      } else this.controller.dispatch({ type: "move-selection", delta: amount });
      return;
    }
    this.controller.dispatch({ type: "scroll", region: this.scrollRegion(), delta: amount });
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.inline !== undefined) {
      this.inline.component.handleInput?.(data);
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel") || this.keybindings.matches(data, "app.interrupt")) {
      this.escape();
      this.invalidate();
      this.tui.requestRender();
      return;
    }
    if (this.queryInput(data)) return;
    const state = this.controller.state();
    const pane = state.focus.pane;
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.controller.dispatch(pane === "detail" && pluginManagerMenuActions(state).length > 0 ? { type: "move-action", delta: -1 } : pane === "detail" || state.operation.state !== "idle" ? { type: "scroll", region: this.scrollRegion(), delta: -1 } : { type: "move-selection", delta: -1 });
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.controller.dispatch(pane === "detail" && pluginManagerMenuActions(state).length > 0 ? { type: "move-action", delta: 1 } : pane === "detail" || state.operation.state !== "idle" ? { type: "scroll", region: this.scrollRegion(), delta: 1 } : { type: "move-selection", delta: 1 });
    } else if (pane === "list" && state.view === "installed" && matchesKey(data, Key.left)) {
      this.controller.dispatch({ type: "cycle-filter", delta: -1 });
    } else if (pane === "list" && state.view === "installed" && matchesKey(data, Key.right)) {
      this.controller.dispatch({ type: "cycle-filter", delta: 1 });
    } else if (this.keybindings.matches(data, "tui.select.pageUp")) this.page(-1);
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.page(1);
    else if (this.keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      if (state.operation.state === "finished") {
        // A finished result is a read-out: Enter dismisses it back to the
        // rows exactly like Escape.
        this.controller.dispatch({ type: "return-manager" });
      } else if (pane === "detail") {
        const action = state.focus.action ?? pluginManagerMenuActions(state)[0];
        if (action !== undefined) this.activateAction(action);
      } else this.controller.dispatch({ type: "open-detail" });
    } else if (data === "/" && pane === "list") this.controller.dispatch({ type: "focus-query" });
    else if (data.toLowerCase() === "m" && pane === "list") this.controller.dispatch({ type: "set-view", view: state.view === "marketplaces" ? "installed" : "marketplaces" });
    else if (matchesKey(data, Key.ctrl("u")) && pane === "list" && state.view === "installed") this.activateAction("update-all");
    else if (data.toLowerCase() === "p" && pane === "list" && state.view === "installed" && state.filter === "updates") this.activateAction("update-policy");
    else if (data.toLowerCase() === "u" && state.view === "installed") {
      // Works from the list and from the open detail pane — opening details
      // must not be a toll on the most common row action. In the detail pane
      // the displayed detail must still belong to the focused row, so a
      // refresh that is mid-reconciliation cannot update a substituted row.
      const rows = pluginManagerVisibleRows(state);
      const row = state.focus.row === undefined
        ? rows[0]
        : rows.find((candidate) => rowKeyIdentity(candidate.key) === rowKeyIdentity(state.focus.row!));
      const detailCurrent = pane !== "detail" ||
        row !== undefined && state.detail.row !== undefined && rowKeyIdentity(state.detail.row) === rowKeyIdentity(row.key);
      if (detailCurrent && row?.key.subject === "installed" && row.hasUpdate === true) this.activateAction("update");
    } else if (data.toLowerCase() === "a") {
      const actions = pluginManagerAvailableActions(state);
      if (actions.includes("install")) this.activateAction("install");
      else if (actions.includes("marketplace-add")) this.activateAction("marketplace-add");
    } else if (data.toLowerCase() === "d") {
      const actions = pluginManagerAvailableActions(state);
      if (actions.includes("disable")) this.activateAction("disable");
      else if (actions.includes("enable")) this.activateAction("enable");
    } else if (data.toLowerCase() === "x") {
      const actions = pluginManagerAvailableActions(state);
      if (state.view === "marketplaces") {
        if (actions.includes("marketplace-remove")) this.activateAction("marketplace-remove");
      } else if (actions.includes("uninstall-delete")) this.activateAction("uninstall-delete");
    } else if (data.toLowerCase() === "r") {
      // On the marketplaces view, refresh means the selected marketplace's
      // catalog — one keystroke instead of detail → actions → refresh. Like
      // u/x, it works from the list and the open detail pane alike.
      if (state.view === "marketplaces" && pluginManagerAvailableActions(state).includes("marketplace-refresh")) {
        this.activateAction("marketplace-refresh");
      } else this.controller.dispatch({ type: "refresh", scope: "all" });
    }
    else if (data === "?") this.controller.dispatch({ type: "toggle-help" });
    this.invalidate();
    this.tui.requestRender();
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.spinTimer !== undefined) {
      clearInterval(this.spinTimer);
      this.spinTimer = undefined;
    }
    this.inline?.finish();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.done = undefined;
    this.invalidate();
  }
}
