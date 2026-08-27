import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { DEFAULT_REFRESH_TIMEOUT_MS } from "../host.js";
import type {
  CatalogPlugin,
  InstalledPluginInfo,
  MarketplaceCatalog,
  MarketplaceInfo,
  MarketplaceRefreshResult,
  PluginBatchAction,
  PluginBatchItemResult,
  PluginHost,
  PluginIdentity,
  RuntimeSnapshot,
} from "../types.js";
import {
  filterPluginRows,
  pluginIdentity,
  pluginManagerKeyAction,
  pluginManagerMarketplaceRows,
  projectInstalledPluginDetail,
  prunePluginSelection,
  restorePluginCursor,
  type PluginManagerKeyAction,
  type PluginManagerRow,
  type PluginManagerTab,
  type PluginManagerView,
} from "./plugin-manager-model.js";

export interface PluginManagerResult {
  readonly reloadNeeded: boolean;
}

export interface PluginManagerOptions {
  readonly host: PluginHost;
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly done: (result: PluginManagerResult) => void;
  readonly confirm: (title: string, message: string) => Promise<boolean>;
  readonly input: (title: string, placeholder?: string) => Promise<string | undefined>;
  readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
}

type IssueEntry = Readonly<{
  readonly id: string;
  readonly title: string;
  readonly message: string;
  readonly severity: "warning" | "error";
  readonly pluginId?: string;
}>;

type BatchState = Readonly<{
  readonly action: PluginBatchAction;
  readonly identities: readonly PluginIdentity[];
}>;

const TAB_ORDER: readonly PluginManagerTab[] = ["installed", "discover", "marketplaces", "issues"];
const BATCH_ACTIONS: readonly PluginBatchAction[] = ["install", "update", "enable", "disable", "remove"];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function catalogEntry(catalog: MarketplaceCatalog | undefined, name: string): CatalogPlugin | undefined {
  return catalog?.plugins.find((item) => item.name === name);
}

function receiptVersion(plugin: InstalledPluginInfo | undefined): string | undefined {
  const value = plugin?.receipt?.version;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function identityOf(plugin: InstalledPluginInfo): string {
  return pluginIdentity(plugin.name, plugin.marketplace);
}

function actionLabel(action: PluginBatchAction): string {
  return action[0]!.toLocaleUpperCase() + action.slice(1);
}

function actionVerb(action: PluginBatchAction): string {
  if (action === "remove") return "Remove";
  return actionLabel(action);
}

export class PluginManager implements Component, Focusable {
  private readonly host: PluginHost;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: (result: PluginManagerResult) => void;
  private readonly confirm: PluginManagerOptions["confirm"];
  private readonly input: PluginManagerOptions["input"];
  private readonly notify: PluginManagerOptions["notify"];
  private readonly searchInput = new Input();
  private _focused = false;

  private tab: PluginManagerTab = "installed";
  private view: PluginManagerView = "list";
  private query = "";
  private searchFocused = false;
  private cursor = 0;
  private detailActionCursor = 0;
  private detailId: string | undefined;
  private selected = new Set<string>();
  private installed: readonly InstalledPluginInfo[] = [];
  private marketplaces: readonly MarketplaceInfo[] = [];
  private catalogs = new Map<string, MarketplaceCatalog>();
  private localEpoch = 0;
  private runtime: RuntimeSnapshot | undefined;
  private issues: readonly IssueEntry[] = [];
  private issuesLoading = false;
  private marketplaceCursor = 0;
  private checkOnOpen = false;
  private checkOnOpenLoaded = false;
  private checkOnOpenSaving = false;
  private checking = false;
  private updatesChecked = false;
  private checkedMarketplaces = 0;
  private checkingMarketplaces = new Set<string>();
  private checkController: AbortController | undefined;
  private checkPromise: Promise<readonly MarketplaceRefreshResult[]> | undefined;
  private checkRun = 0;
  private openCheckPending = true;
  private reloadNeeded = false;
  private toast: string | undefined;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private batch: BatchState | undefined;
  private batchResults: PluginBatchItemResult[] = [];
  private batchRunning = false;
  private batchCancelledAfterCurrent = false;
  private batchController: AbortController | undefined;
  private batchItemActive = false;
  private destroyed = false;
  private completed = false;

  constructor(options: PluginManagerOptions) {
    this.host = options.host;
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.done = options.done;
    this.confirm = options.confirm;
    this.input = options.input;
    this.notify = options.notify;
    this.searchInput.onSubmit = () => this.leaveSearch();

    // Opening is local-first: the first render does not wait for either a
    // catalog read or a network request. Both tasks update this view in place.
    void this.loadLocal().catch((error: unknown) => this.showToast(`Could not load plugin data: ${errorMessage(error)}`, "warning"));
    void this.loadCheckOnOpen();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value && this.searchFocused;
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    const lines: string[] = [];
    lines.push(this.renderTabs(renderWidth));
    lines.push(this.theme.fg("border", "─".repeat(renderWidth)));

    if (this.view === "detail") lines.push(...this.renderDetail(renderWidth));
    else if (this.view === "confirm") lines.push(...this.renderConfirmation(renderWidth));
    else if (this.view === "batch") lines.push(...this.renderBatch(renderWidth));
    else if (this.tab === "installed") lines.push(...this.renderInstalled(renderWidth));
    else if (this.tab === "discover") lines.push(...this.renderDiscover(renderWidth));
    else if (this.tab === "marketplaces") lines.push(...this.renderMarketplaces(renderWidth));
    else lines.push(...this.renderIssues(renderWidth));

    lines.push("");
    lines.push(this.renderFooter(renderWidth));
    if (this.toast !== undefined) lines.push(this.theme.fg("accent", truncateToWidth(` ${this.toast}`, renderWidth, "")));
    return lines.map((line) => truncateToWidth(line, renderWidth, ""));
  }

  handleInput(data: string): void {
    if (this.destroyed) return;
    if (this.searchFocused) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
        this.leaveSearch();
        return;
      }
      this.searchInput.handleInput(data);
      this.query = this.searchInput.getValue();
      this.cursor = 0;
      this.requestRender();
      return;
    }

    if (this.view === "batch") {
      this.handleBatchInput(data);
      return;
    }
    if (this.view === "list" && this.checking && matchesKey(data, Key.escape)) {
      this.cancelMarketplaceCheck();
      return;
    }
    if (this.view === "confirm") {
      this.handleConfirmationInput(data);
      return;
    }
    if (this.view === "detail") {
      this.handleDetailInput(data);
      return;
    }

    if (this.tab === "marketplaces") {
      if (data.toLocaleLowerCase() === "x" && this.marketplaceCursor >= 3) {
        const marketplace = this.marketplaces[this.marketplaceCursor - 3];
        if (marketplace !== undefined) void this.removeMarketplace(marketplace.name).catch((error: unknown) => this.showToast(`Could not remove marketplace: ${errorMessage(error)}`, "error"));
        return;
      }
      if (matchesKey(data, Key.space) && this.marketplaceCursor === 2) {
        void this.toggleCheckOnOpen();
        return;
      }
      if (data.toLocaleLowerCase() === "r") {
        this.startMarketplaceCheck();
        return;
      }
    }
    if (this.tab === "issues" && data.toLocaleLowerCase() === "r") {
      void this.loadIssues();
      this.startMarketplaceCheck();
      return;
    }
    const action = this.managerKeyAction(data);
    if (action === undefined) return;
    this.handleListAction(action);
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  dispose(): void {
    this.destroyed = true;
    this.checkRun++;
    this.checkController?.abort("manager closed");
    this.batchController?.abort("manager closed");
    if (this.toastTimer !== undefined) clearTimeout(this.toastTimer);
  }

  private renderTabs(width: number): string {
    const labels: Record<PluginManagerTab, string> = {
      installed: `Installed (${this.installed.length})`,
      discover: `Discover (${this.discoverRows().length})`,
      marketplaces: "Marketplaces",
      issues: `Issues${this.issues.length === 0 ? "" : ` (${this.issues.length})`}`,
    };
    const rendered = TAB_ORDER.map((tab) => {
      const text = ` ${labels[tab]} `;
      return tab === this.tab ? this.theme.bg("selectedBg", this.theme.fg("text", text)) : this.theme.fg("muted", text);
    }).join(" ");
    const status = this.statusText(width);
    if (width < 80) return truncateToWidth(rendered, width, "");
    const gap = Math.max(1, width - visibleWidth(rendered) - visibleWidth(status));
    return truncateToWidth(rendered + " ".repeat(gap) + status, width, "");
  }

  private statusText(width: number): string {
    if (width < 80) return "";
    if (this.checking) return this.theme.fg("accent", `◌ Checking ${this.checkedMarketplaces}/${this.checkingMarketplaces.size} marketplaces · manager remains available`);
    if (this.reloadNeeded) return this.theme.fg("warning", "● Reload needed");
    if (this.updatesChecked) return this.theme.fg("muted", "Local data · updates checked just now");
    return this.theme.fg("muted", "Local data · updates not checked");
  }

  private renderInstalled(width: number): string[] {
    const rows = this.filteredRows(this.installedRows());
    const lines = [this.heading(`Installed plugins (${rows.length})`), this.renderSearch(width, "Search installed plugins…")];
    if (rows.length === 0) lines.push(this.theme.fg("muted", "  No installed plugins match this search."));
    else lines.push(...this.renderRows(rows, width));
    lines.push(...this.renderBatchBar(width, "installed"));
    return lines;
  }

  private renderDiscover(width: number): string[] {
    const rows = this.filteredRows(this.discoverRows());
    const lines = [this.heading(`Discover plugins (${rows.length})`), this.renderSearch(width, "Search all marketplaces…")];
    if (rows.length === 0) lines.push(this.theme.fg("muted", "  No discoverable plugins match this search."));
    else lines.push(...this.renderRows(rows, width));
    lines.push(...this.renderBatchBar(width, "discover"));
    return lines;
  }

  private renderMarketplaces(width: number): string[] {
    const lines = [this.heading("Manage marketplaces")];
    const rows = pluginManagerMarketplaceRows(this.marketplaces, this.checkOnOpen);
    for (const [index, row] of rows.entries()) {
      if (row.kind === "marketplace") {
        const marketplace = row.marketplace;
        const status = this.marketplaceStatus(marketplace.name);
        const installedCount = this.installed.filter((plugin) => plugin.marketplace === marketplace.name).length;
        const availableCount = this.catalogs.get(marketplace.name)?.plugins.length;
        lines.push(this.renderCursorLine(this.marketplaceCursor === index, this.theme.fg("accent", `○ ${marketplace.name}`)));
        lines.push(this.indent(`${marketplace.source.value} · ${availableCount ?? "?"} available · ${installedCount} installed · ${status}`, width));
        lines.push(this.indent(this.theme.fg("dim", "Enter refresh · x remove"), width));
        continue;
      }
      const label = row.kind === "check-on-open"
        ? `${row.enabled ? this.theme.fg("success", "●") : this.theme.fg("muted", "○")} ${row.label}${this.checkOnOpenSaving ? this.theme.fg("muted", " · saving…") : ""}`
        : this.theme.fg("accent", row.label);
      lines.push(this.renderCursorLine(this.marketplaceCursor === index, label));
    }
    if (this.marketplaces.length === 0) lines.push(this.theme.fg("muted", "  No marketplaces. Add one to discover plugins."));
    lines.push(this.indent(this.theme.fg("muted", "The manager opens from local data, then refreshes sources without blocking navigation."), width));
    return lines;
  }

  private renderIssues(width: number): string[] {
    const lines = [this.heading(`Issues${this.issues.length === 0 ? "" : ` (${this.issues.length})`}`)];
    if (this.issuesLoading) lines.push(this.theme.fg("accent", "  ◌ Scanning current runtime…"));
    if (!this.issuesLoading && this.issues.length === 0) lines.push(this.theme.fg("success", "  No current plugin issues."));
    for (let index = 0; index < this.issues.length; index++) {
      const issue = this.issues[index]!;
      const selected = index === this.cursor;
      const color = issue.severity === "error" ? "error" : "warning";
      lines.push(this.renderCursorLine(selected, this.theme.fg(color, `${issue.severity === "error" ? "×" : "△"} ${issue.title}`)));
      lines.push(this.indent(this.theme.fg("muted", issue.message), width));
    }
    return lines;
  }

  private renderDetail(width: number): string[] {
    const row = this.currentDetailRow();
    if (row === undefined) return [this.theme.fg("warning", "Plugin is no longer present."), this.theme.fg("muted", "Press Esc to return.")];
    const installed = this.installed.find((item) => identityOf(item) === row.id);
    const runtimePlugin = this.runtime?.plugins.find((item) => identityOf(item.info) === row.id);
    const catalog = this.catalogs.get(row.marketplace);
    const entry = catalogEntry(catalog, row.name);
    const details = installed === undefined ? undefined : projectInstalledPluginDetail(installed, runtimePlugin);
    const lines = [
      this.theme.fg("accent", `${this.tab === "discover" ? "Discover" : "Installed"} / Plugin details`),
      this.heading(`${row.name} @ ${row.marketplace}`),
      this.fact("Version", row.availableVersion === undefined
        ? receiptVersion(installed) ?? row.version ?? "not declared"
        : `${receiptVersion(installed) ?? "unversioned"} → ${row.availableVersion}`),
      this.fact("Status", installed === undefined ? "not installed" : this.statusLabel(installed, entry)),
      this.fact("Source", entry?.source.kind === "local"
        ? entry.source.path
        : entry === undefined
          ? row.marketplace
          : `${entry.source.url}${entry.source.path === undefined ? "" : `#${entry.source.path}`}`),
      "",
      this.wrapLine(row.description ?? "No description declared.", width),
      "",
    ];
    if (installed !== undefined && details !== undefined) {
      lines.push(this.fact("Install path", details.installPath));
      lines.push(this.fact("Data path", details.dataPath));
      lines.push(this.theme.fg("accent", "Components"));
      if (this.runtime === undefined) {
        lines.push(this.indent(this.theme.fg("muted", "Loading runtime components…"), width));
      } else {
        lines.push(this.fact("Skills", details.skills.length === 0 ? "none" : details.skills.join(", ")));
        lines.push(this.fact("Hooks", details.hooks.length === 0 ? "none" : details.hooks.join(", ")));
        lines.push(this.fact("MCP servers", details.mcpServers.length === 0 ? "none" : details.mcpServers.join(", ")));
      }
      lines.push("");
      const marker = installed.autoUpdate ? this.theme.fg("success", "[on]") : this.theme.fg("muted", "[off]");
      lines.push(`${marker} ${this.theme.bold("Update automatically on Pi startup")}`);
      lines.push(this.indent(this.theme.fg("muted", "Enabling grants standing authorization to replace executable plugin content when its declared catalog version changes."), width));
      lines.push("");
    }
    lines.push(this.theme.fg("accent", "Actions"));
    const actions = this.detailActions(row, installed);
    for (let index = 0; index < actions.length; index++) {
      const action = actions[index]!;
      const text = action.label;
      lines.push(this.renderCursorLine(index === this.detailActionCursor, action.destructive ? this.theme.fg("error", text) : index === 0 ? this.theme.fg("accent", text) : this.theme.fg("text", text)));
    }
    return lines;
  }

  private renderConfirmation(width: number): string[] {
    const batch = this.batch;
    if (batch === undefined) return [this.theme.fg("warning", "Nothing selected."), this.theme.fg("muted", "Press Esc to return.")];
    const rows = batch.identities.map((identity) => this.rowById(identityToString(identity))).filter((row): row is PluginManagerRow => row !== undefined);
    const executable = batch.action === "install" || batch.action === "update" || batch.action === "enable";
    const destructive = batch.action === "remove";
    const lines = [
      this.theme.fg("accent", `${this.tabLabel()} / Confirm ${actionLabel(batch.action.toString() as PluginBatchAction).toLocaleLowerCase()}`),
      this.heading(`${actionVerb(batch.action)} ${rows.length} plugin${rows.length === 1 ? "" : "s"}?`),
      this.theme.fg("text", `This batch affects ${rows.length} selected plugin${rows.length === 1 ? "" : "s"}.`),
    ];
    for (const row of rows) lines.push(this.indent(`• ${row.name} @ ${row.marketplace} · ${row.version ?? "unversioned"}`, width));
    lines.push("");
    if (executable) {
      lines.push(this.theme.bg("toolPendingBg", this.theme.fg("warning", " Executable content")));
      lines.push(this.indent(this.theme.fg("muted", "Plugin hooks and MCP servers run local code. Review the source before continuing."), width));
    } else if (destructive) {
      lines.push(this.theme.bg("toolErrorBg", this.theme.fg("error", " Destructive change")));
      lines.push(this.indent(this.theme.fg("muted", "Successful removals remain removed; failed items are reported without rolling back other items."), width));
    } else {
      lines.push(this.theme.bg("toolPendingBg", this.theme.fg("warning", " Runtime mutation")));
      lines.push(this.indent(this.theme.fg("muted", "Each item runs sequentially and Pi reloads once when the manager closes."), width));
    }
    lines.push("");
    lines.push(this.renderCursorLine(this.detailActionCursor === 0, this.theme.fg("accent", `${actionVerb(batch.action)} ${rows.length} plugin${rows.length === 1 ? "" : "s"}`)));
    lines.push(this.renderCursorLine(this.detailActionCursor === 1, this.theme.fg("text", "Back to selection")));
    return lines;
  }

  private renderBatch(width: number): string[] {
    const batch = this.batch;
    if (batch === undefined) return [this.theme.fg("muted", "No batch in progress.")];
    const succeeded = this.batchResults.filter((result) => result.ok).length;
    const failed = this.batchResults.length - succeeded;
    const lines = [
      this.theme.fg("accent", `${this.tabLabel()} / ${actionVerb(batch.action)} selected`),
      this.heading(this.batchRunning ? `${actionVerb(batch.action)} ${batch.identities.length} plugins` : "Batch complete"),
      this.theme.fg("muted", `${this.batchRunning ? "Items run sequentially; the manager stays available." : "Settled items remain visible in filesystem truth."}`),
      "",
    ];
    for (let index = 0; index < batch.identities.length; index++) {
      const identity = batch.identities[index]!;
      const result = this.batchResults[index];
      const prefix = result === undefined ? this.theme.fg("dim", "○") : result.ok ? this.theme.fg("success", "✓") : this.theme.fg("error", "×");
      const note = result === undefined ? (this.batchRunning && index === this.batchResults.length ? "working…" : "waiting") : result.ok ? "complete" : result.error ?? "failed";
      lines.push(this.indent(`${prefix} ${identity.plugin} @ ${identity.marketplace}  ${this.theme.fg("muted", note)}`, width));
    }
    if (!this.batchRunning) {
      lines.push("");
      lines.push(this.theme.bg("toolPendingBg", this.theme.fg("text", ` ${succeeded} succeeded · ${failed} failed${this.batchCancelledAfterCurrent ? " · cancelled before next item" : ""}`)));
      if (succeeded > 0) lines.push(this.theme.fg("warning", "Reload will run once when this manager closes."));
      lines.push("");
      lines.push(this.renderCursorLine(this.detailActionCursor === 0, this.theme.fg("accent", "View installed plugins")));
      lines.push(this.renderCursorLine(this.detailActionCursor === 1, this.theme.fg("text", "Close manager")));
    } else {
      lines.push("");
      lines.push(this.theme.fg("error", this.batchCancelledAfterCurrent ? "Stop after current plugin" : "Esc stop after current plugin"));
    }
    return lines;
  }

  private renderRows(rows: readonly PluginManagerRow[], width: number): string[] {
    const lines: string[] = [];
    for (const [index, row] of rows.entries()) {
      const status = this.rowStatus(row);
      const selected = this.selected.has(row.id);
      const main = `${selected ? "◉" : "○"} ${row.name} · ${row.marketplace} · ${row.version ?? "unversioned"}`;
      const suffix = row.installed && this.tab === "discover" ? ` · ${this.theme.fg("success", "installed")}` : status;
      const title = this.theme.fg("accent", main);
      const cursor = index === this.cursor ? this.theme.fg("accent", "›") : " ";
      const content = `${cursor} ${title}${suffix.length > 0 ? `  ${suffix}` : ""}`;
      lines.push(this.theme.bg(index === this.cursor ? "selectedBg" : "toolPendingBg", truncateToWidth(content, width, "")));
      lines.push(this.indent(this.theme.fg("muted", row.description ?? "No description declared."), width));
    }
    return lines;
  }

  private renderBatchBar(width: number, mode: "installed" | "discover"): string[] {
    if (this.selected.size === 0) return [];
    const actions = mode === "discover" ? "i Install selected" : "u Update · e Enable · d Disable · x Remove";
    return [
      this.theme.fg("border", "─".repeat(Math.max(1, width))),
      `${this.theme.fg("accent", `${this.selected.size} selected`)}  ${this.theme.fg("text", actions)}  ${this.theme.fg("muted", "Esc clear")}`,
    ];
  }

  private renderFooter(width: number): string {
    let footer: string;
    if (this.view === "detail" || this.view === "confirm") footer = "↑↓ navigate · Enter run · Esc back";
    else if (this.view === "batch") footer = this.batchRunning ? "Esc stop after current · manager stays open" : "Enter view installed · Esc close";
    else if (this.checking) footer = "Esc cancel checks · navigation remains available";
    else footer = "Ctrl+←/→ tabs · Ctrl+F search · ↑↓ navigate · Space select · a all · Enter details · r check · Esc close";
    if (width < 80) {
      const compact = this.checking ? "◌ checking · Esc cancel" : this.reloadNeeded ? "● reload needed" : "";
      footer = compact.length > 0 ? compact : footer;
    }
    return this.theme.fg("dim", footer);
  }

  private heading(text: string): string {
    return this.theme.fg("accent", this.theme.bold(text));
  }

  private fact(label: string, value: string): string {
    return `${this.theme.fg("muted", label.padEnd(10))} ${value}`;
  }

  private indent(text: string, width: number): string {
    return truncateToWidth(`  ${text}`, width, "");
  }

  private renderCursorLine(cursor: boolean, text: string): string {
    return `${cursor ? this.theme.fg("accent", "›") : " "} ${text}`;
  }

  private renderSearch(width: number, placeholder: string): string {
    this.searchInput.focused = this._focused && this.searchFocused;
    const text = this.searchInput.getValue().length === 0 && !this.searchFocused
      ? this.theme.fg("muted", `⌕ ${placeholder}`)
      : `⌕ ${this.searchInput.render(Math.max(1, width - 4))[0] ?? ""}`;
    return truncateToWidth(this.theme.fg("border", "[") + text + this.theme.fg("border", "]"), width, "");
  }

  private wrapLine(text: string, width: number): string {
    return truncateToWidth(text, width, "");
  }

  private managerKeyAction(data: string): PluginManagerKeyAction | undefined {
    const state = { view: this.view, tab: this.tab, selectedCount: this.selected.size, searchFocused: this.searchFocused } as const;
    if (this.keybindings.matches(data, "tui.select.up")) return "up";
    if (this.keybindings.matches(data, "tui.select.down")) return "down";
    if (this.keybindings.matches(data, "tui.select.confirm")) return "details";
    if (this.keybindings.matches(data, "tui.select.cancel")) return this.view === "list" ? "close" : "back";
    return pluginManagerKeyAction(data, state);
  }

  private handleListAction(action: PluginManagerKeyAction): void {
    if (action === "up" || action === "down") {
      if (this.tab === "marketplaces") {
        const max = Math.max(0, pluginManagerMarketplaceRows(this.marketplaces, this.checkOnOpen).length - 1);
        this.marketplaceCursor = action === "up" ? Math.max(0, this.marketplaceCursor - 1) : Math.min(max, this.marketplaceCursor + 1);
      } else {
        const rows = this.filteredRows(this.currentRows());
        this.cursor = action === "up" ? Math.max(0, this.cursor - 1) : Math.min(Math.max(0, rows.length - 1), this.cursor + 1);
      }
      this.requestRender();
      return;
    }
    if (action === "left" || action === "right") {
      if (this.tab === "marketplaces" || this.tab === "issues" || this.isListTab()) {
        const current = TAB_ORDER.indexOf(this.tab);
        const next = (current + (action === "left" ? -1 : 1) + TAB_ORDER.length) % TAB_ORDER.length;
        this.setTab(TAB_ORDER[next]!);
      }
      return;
    }
    if (action === "select" && this.isListTab()) {
      const row = this.filteredRows(this.currentRows())[this.cursor];
      if (row !== undefined) {
        if (this.tab === "discover" && row.installed) {
          this.showToast(`${row.name} is already installed`, "warning");
          return;
        }
        if (this.selected.has(row.id)) this.selected.delete(row.id);
        else this.selected.add(row.id);
        this.requestRender();
      }
      return;
    }
    if (action === "select-all" && this.isListTab()) {
      for (const row of this.filteredRows(this.currentRows())) {
        if (this.tab !== "discover" || !row.installed) this.selected.add(row.id);
      }
      this.requestRender();
      return;
    }
    if (action === "details") {
      if (this.tab === "marketplaces") {
        this.handleMarketplaceEnter();
        return;
      }
      if (this.tab === "issues") {
        const issue = this.issues[this.cursor];
        if (issue?.pluginId !== undefined) this.openDetail(issue.pluginId);
        return;
      }
      const row = this.filteredRows(this.currentRows())[this.cursor];
      if (row !== undefined) this.openDetail(row.id);
      return;
    }
    if (action === "check") {
      if (this.tab === "issues") void this.loadIssues();
      this.startMarketplaceCheck();
      return;
    }
    if (action === "search") {
      this.searchFocused = true;
      this.searchInput.focused = this._focused;
      this.searchInput.setValue(this.query);
      this.requestRender();
      return;
    }
    if (BATCH_ACTIONS.includes(action as PluginBatchAction)) {
      this.startBatch(action as PluginBatchAction);
      return;
    }
    if (action === "close") {
      if (this.selected.size > 0) {
        this.selected.clear();
        this.requestRender();
      } else {
        this.close();
      }
    }
  }

  private handleConfirmationInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.view = "list";
      this.batch = undefined;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) this.detailActionCursor = Math.max(0, this.detailActionCursor - 1);
    if (matchesKey(data, Key.down)) this.detailActionCursor = Math.min(1, this.detailActionCursor + 1);
    if (matchesKey(data, Key.enter)) {
      if (this.detailActionCursor === 0) void this.confirmBatch().catch((error: unknown) => this.showToast(`Batch failed: ${errorMessage(error)}`, "error"));
      else {
        this.view = "list";
        this.batch = undefined;
      }
    }
    this.requestRender();
  }

  private handleBatchInput(data: string): void {
    if (this.batchRunning) {
      if (matchesKey(data, Key.escape)) {
        this.batchCancelledAfterCurrent = true;
        // Abort only an in-flight marketplace refresh. Once an item has
        // started, cancellation is observed at the next item boundary so Esc
        // never interrupts the first/current plugin mutation.
        if (!this.batchItemActive) {
          this.batchController?.abort("cancelled before next item");
          if (this.checking) this.cancelMarketplaceCheck();
        }
        this.requestRender();
      }
      return;
    }
    if (matchesKey(data, Key.up)) this.detailActionCursor = Math.max(0, this.detailActionCursor - 1);
    if (matchesKey(data, Key.down)) this.detailActionCursor = Math.min(1, this.detailActionCursor + 1);
    if (matchesKey(data, Key.enter)) {
      if (this.detailActionCursor === 0) {
        this.tab = "installed";
        this.view = "list";
        this.cursor = 0;
        this.selected.clear();
        void this.loadLocal().catch((error: unknown) => this.showToast(`Could not load plugin data: ${errorMessage(error)}`, "warning"));
      } else this.close();
    }
    if (matchesKey(data, Key.escape)) this.close();
    this.requestRender();
  }

  private handleDetailInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.view = "list";
      this.detailId = undefined;
      this.detailActionCursor = 0;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) this.detailActionCursor = Math.max(0, this.detailActionCursor - 1);
    if (matchesKey(data, Key.down)) {
      const actions = this.detailActions(this.currentDetailRow(), this.currentDetailInstalled());
      this.detailActionCursor = Math.min(Math.max(0, actions.length - 1), this.detailActionCursor + 1);
    }
    if (matchesKey(data, Key.enter)) void this.runDetailAction().catch((error: unknown) => this.showToast(`Action failed: ${errorMessage(error)}`, "error"));
    if (data.toLocaleLowerCase() === "r") this.startMarketplaceCheck();
    if (data.toLocaleLowerCase() === "i" && this.tab === "discover") this.startBatch("install", this.detailId === undefined ? [] : [identityFromString(this.detailId)]);
    if (data.toLocaleLowerCase() === "u" && this.tab === "installed") this.startBatch("update", this.detailId === undefined ? [] : [identityFromString(this.detailId)]);
    this.requestRender();
  }

  private async runDetailAction(): Promise<void> {
    const row = this.currentDetailRow();
    if (row === undefined) return;
    const installed = this.currentDetailInstalled();
    const actions = this.detailActions(row, installed);
    const action = actions[this.detailActionCursor]?.action;
    if (action === "back") {
      this.view = "list";
      this.detailId = undefined;
      this.requestRender();
      return;
    }
    if (action === "toggle-auto" && installed !== undefined) {
      if (!installed.autoUpdate) {
        const approved = await this.confirm(
          "Enable automatic plugin updates",
          "This grants standing authorization to replace executable hooks and MCP servers when Pi startup sees a declared catalog version change. Enable it?",
        );
        if (!approved) return;
      }
      try {
        const updated = await this.host.setAutoUpdate(installed.marketplace, installed.name, !installed.autoUpdate);
        this.installed = this.installed.map((item) => identityOf(item) === row.id ? updated : item);
        this.showToast(updated.autoUpdate ? "Automatic startup updates enabled" : "Automatic startup updates disabled");
      } catch (error) {
        this.showToast(`Could not change automatic updates: ${errorMessage(error)}`, "error");
      }
      this.requestRender();
      return;
    }
    if (action === "install" || action === "update" || action === "enable" || action === "disable" || action === "remove") {
      this.startBatch(action, [identityFromString(row.id)]);
    }
  }

  private detailActions(row: PluginManagerRow | undefined, installed: InstalledPluginInfo | undefined): readonly { readonly action: PluginBatchAction | "toggle-auto" | "back"; readonly label: string; readonly destructive?: boolean }[] {
    if (row === undefined) return [{ action: "back", label: "Back to plugin list" }];
    if (installed === undefined) return [
      { action: "install", label: "Install plugin" },
      { action: "back", label: "Back to plugin list" },
    ];
    return [
      { action: installed.enabled ? "disable" : "enable", label: installed.enabled ? "Disable plugin" : "Enable plugin" },
      { action: "update", label: "Update now" },
      { action: "toggle-auto", label: installed.autoUpdate ? "Turn off automatic updates" : "Turn on automatic updates" },
      { action: "remove", label: "Remove plugin", destructive: true },
      { action: "back", label: "Back to plugin list" },
    ];
  }

  private startBatch(action: PluginBatchAction, explicit?: readonly PluginIdentity[]): void {
    if (this.batchRunning) return;
    const current = this.currentRows();
    const requested = explicit === undefined
      ? [...prunePluginSelection(this.selected, current).selected].map(identityFromString)
      : explicit;
    const pruned = explicit === undefined ? prunePluginSelection(this.selected, current) : { selected: new Set<string>(), vanished: [] as string[] };
    this.selected = new Set(pruned.selected);
    if (pruned.vanished.length > 0) this.notify(`Dropped ${pruned.vanished.length} vanished selection${pruned.vanished.length === 1 ? "" : "s"}.`, "warning");
    const identities = action === "install"
      ? requested.filter((identity) => this.rowById(identityToString(identity))?.installed !== true)
      : requested;
    const alreadyInstalled = requested.length - identities.length;
    if (alreadyInstalled > 0) this.notify(`Skipped ${alreadyInstalled} already-installed plugin${alreadyInstalled === 1 ? "" : "s"}.`, "warning");
    if (identities.length === 0) {
      this.showToast("No current plugins are selected for this action", "warning");
      return;
    }
    if (explicit === undefined) this.selected = new Set(identities.map(identityToString));
    this.batch = Object.freeze({ action, identities: Object.freeze(identities.map((identity) => Object.freeze({ ...identity }))) });
    this.detailActionCursor = 0;
    this.view = "confirm";
    this.requestRender();
  }

  private async confirmBatch(): Promise<void> {
    if (this.batch === undefined) return;
    this.view = "batch";
    this.batchRunning = true;
    this.batchResults = [];
    this.batchCancelledAfterCurrent = false;
    this.batchController = new AbortController();
    this.batchItemActive = false;
    this.requestRender();
    const batch = this.batch;
    const controller = this.batchController;
    const run = async (): Promise<void> => {
      try {
        let refresh = batch.action === "install" || batch.action === "update";
        // If the same marketplace is already being checked, wait for that
        // result rather than starting a second network operation. A failed
        // check is retried by the batch so a transient check does not silently
        // turn into an install from stale catalog data.
        const batchMarketplaces = new Set(batch.identities.map((identity) => identity.marketplace));
        const overlapsActiveCheck = [...batchMarketplaces].some((marketplace) => this.checkingMarketplaces.has(marketplace));
        if (refresh && this.checkPromise !== undefined && overlapsActiveCheck) {
          const activeCheck = this.checkPromise;
          const checked = await activeCheck;
          const checkedByName = new Map(checked.map((result) => [result.marketplace, result]));
          refresh = !batch.identities.every((identity) => checkedByName.get(identity.marketplace)?.ok === true);
        }
        if (controller.signal.aborted) return;
        if (this.batchCancelledAfterCurrent) return;
        const options = {
          refresh,
          signal: controller.signal,
          onBeforeItem: (identity: PluginIdentity) => {
            if (this.destroyed || this.batch !== batch) return;
            this.batchItemActive = true;
            this.requestRender();
          },
          onItem: (result: PluginBatchItemResult) => {
            if (this.destroyed || this.batch !== batch) return;
            this.batchItemActive = false;
            this.batchResults.push(result);
            if (result.ok) this.reloadNeeded = true;
            if (this.batchCancelledAfterCurrent) controller.abort("cancelled before next item");
            this.requestRender();
          },
        };
        const outcome = await this.host.runPluginBatch(batch.action, batch.identities, options);
        if (outcome.results.some((result) => result.ok)) this.reloadNeeded = true;
        if (outcome.cancelled) this.batchCancelledAfterCurrent = true;
      } catch (error) {
        this.showToast(`Batch failed: ${errorMessage(error)}`, "error");
      } finally {
        if (this.destroyed || this.batch !== batch) return;
        this.batchRunning = false;
        this.batchController = undefined;
        void this.loadLocal().catch(() => undefined);
        this.requestRender();
      }
    };
    void run().catch((error: unknown) => {
      if (!this.destroyed) this.showToast(`Batch failed: ${errorMessage(error)}`, "error");
    });
  }

  private openDetail(id: string): void {
    this.detailId = id;
    this.detailActionCursor = 0;
    this.runtime = undefined;
    this.view = "detail";
    this.requestRender();
    void this.loadDetailRuntime(id);
  }

  private close(): void {
    if (this.completed) return;
    this.completed = true;
    this.done({ reloadNeeded: this.reloadNeeded });
  }

  private setTab(tab: PluginManagerTab): void {
    this.tab = tab;
    this.view = "list";
    this.detailId = undefined;
    this.cursor = 0;
    this.marketplaceCursor = 0;
    this.selected.clear();
    this.query = "";
    this.searchInput.setValue("");
    if (tab === "issues") void this.loadIssues();
    this.requestRender();
  }

  private async loadCheckOnOpen(): Promise<void> {
    try {
      const enabled = await this.host.getCheckOnOpen();
      if (this.destroyed) return;
      this.checkOnOpen = enabled;
    } catch (error) {
      if (!this.destroyed) this.showToast(`Could not load check-on-open preference: ${errorMessage(error)}`, "warning");
    } finally {
      if (this.destroyed) return;
      this.checkOnOpenLoaded = true;
      this.maybeStartOpenCheck();
      this.requestRender();
    }
  }

  private maybeStartOpenCheck(): void {
    if (!this.openCheckPending || !this.checkOnOpenLoaded) return;
    if (!this.checkOnOpen) {
      this.openCheckPending = false;
      return;
    }
    if (this.marketplaces.length === 0) return;
    this.openCheckPending = false;
    this.startMarketplaceCheck();
  }

  private async toggleCheckOnOpen(): Promise<void> {
    if (this.checkOnOpenSaving) return;
    const enabled = !this.checkOnOpen;
    this.checkOnOpenSaving = true;
    this.requestRender();
    try {
      await this.host.setCheckOnOpen(enabled);
      if (this.destroyed) return;
      this.checkOnOpen = enabled;
      this.showToast(enabled ? "Check-on-open enabled" : "Check-on-open disabled");
    } catch (error) {
      if (!this.destroyed) this.showToast(`Could not save check-on-open preference: ${errorMessage(error)}`, "error");
    } finally {
      if (!this.destroyed) {
        this.checkOnOpenSaving = false;
        this.requestRender();
      }
    }
  }

  private async loadDetailRuntime(id: string): Promise<void> {
    try {
      const runtime = await this.host.scanRuntime();
      if (this.destroyed || this.view !== "detail" || this.detailId !== id) return;
      this.runtime = runtime;
      this.requestRender();
    } catch (error) {
      if (!this.destroyed && this.view === "detail" && this.detailId === id) {
        this.showToast(`Could not inspect installed plugin runtime: ${errorMessage(error)}`, "warning");
      }
    }
  }

  private leaveSearch(): void {
    this.searchFocused = false;
    this.searchInput.focused = false;
    this.requestRender();
  }

  private isListTab(): boolean {
    return this.tab === "installed" || this.tab === "discover";
  }

  private currentRows(): readonly PluginManagerRow[] {
    if (this.tab === "installed") return this.installedRows();
    if (this.tab === "discover") return this.discoverRows();
    return [];
  }

  private currentCursorId(): string | undefined {
    if (!this.isListTab()) return undefined;
    return this.filteredRows(this.currentRows())[this.cursor]?.id;
  }

  private restoreCursor(id: string | undefined): void {
    if (!this.isListTab()) return;
    const rows = this.filteredRows(this.currentRows());
    this.cursor = restorePluginCursor(rows, this.cursor, id);
  }

  private filteredRows(rows: readonly PluginManagerRow[]): readonly PluginManagerRow[] {
    return filterPluginRows(rows, this.query);
  }

  private installedRows(): readonly PluginManagerRow[] {
    return this.installed.map((plugin) => {
      const entry = catalogEntry(this.catalogs.get(plugin.marketplace), plugin.name);
      const installedVersion = receiptVersion(plugin);
      const availableVersion = entry?.version !== undefined && entry.version !== installedVersion ? entry.version : undefined;
      return {
        id: identityOf(plugin),
        name: plugin.name,
        marketplace: plugin.marketplace,
        description: typeof entry?.description === "string" ? entry.description : undefined,
        version: installedVersion,
        availableVersion,
        installed: true,
        enabled: plugin.enabled,
        autoUpdate: plugin.autoUpdate,
        issue: entry === undefined && this.catalogs.has(plugin.marketplace) ? "not declared in current catalog" : undefined,
      } satisfies PluginManagerRow;
    });
  }

  private discoverRows(): readonly PluginManagerRow[] {
    const installedById = new Map(this.installed.map((plugin) => [identityOf(plugin), plugin]));
    const rows: PluginManagerRow[] = [];
    for (const marketplace of this.marketplaces) {
      const catalog = this.catalogs.get(marketplace.name);
      for (const entry of catalog?.plugins ?? []) {
        const id = pluginIdentity(entry.name, marketplace.name);
        const installed = installedById.get(id);
        rows.push({
          id,
          name: entry.name,
          marketplace: marketplace.name,
          description: entry.description,
          version: entry.version,
          availableVersion: installed !== undefined && entry.version !== receiptVersion(installed) ? entry.version : undefined,
          installed: installed !== undefined,
          enabled: installed?.enabled,
          autoUpdate: installed?.autoUpdate,
        });
      }
    }
    return rows.sort((left, right) => left.id.localeCompare(right.id));
  }

  private rowById(id: string): PluginManagerRow | undefined {
    return [...this.installedRows(), ...this.discoverRows()].find((row) => row.id === id);
  }

  private currentDetailRow(): PluginManagerRow | undefined {
    return this.detailId === undefined ? undefined : this.rowById(this.detailId);
  }

  private currentDetailInstalled(): InstalledPluginInfo | undefined {
    const row = this.currentDetailRow();
    return row === undefined ? undefined : this.installed.find((plugin) => identityOf(plugin) === row.id);
  }

  private statusLabel(installed: InstalledPluginInfo, entry: CatalogPlugin | undefined): string {
    if (!installed.enabled) return "disabled";
    if (entry?.version !== undefined && entry.version !== receiptVersion(installed)) return "update available";
    return "enabled";
  }

  private rowStatus(row: PluginManagerRow): string {
    if (row.issue !== undefined) return this.theme.fg("error", "× issue");
    if (row.availableVersion !== undefined) return this.theme.fg("warning", `↑ ${row.availableVersion} available`);
    if (row.installed && row.enabled === false) return this.theme.fg("muted", "○ disabled");
    if (row.installed) return this.theme.fg("success", "✓ enabled");
    return "";
  }

  private tabLabel(): string {
    return this.tab[0]!.toLocaleUpperCase() + this.tab.slice(1);
  }

  private marketplaceStatus(name: string): string {
    if (this.checkingMarketplaces.has(name)) return this.theme.fg("accent", "checking…");
    const catalog = this.catalogs.get(name);
    return catalog === undefined ? this.theme.fg("warning", "catalog unavailable") : this.theme.fg("muted", "local checkout ready");
  }

  private handleMarketplaceEnter(): void {
    const actions = 3;
    if (this.marketplaceCursor === 0) {
      void this.addMarketplace();
      return;
    }
    if (this.marketplaceCursor === 1) {
      this.startMarketplaceCheck();
      return;
    }
    if (this.marketplaceCursor === 2) {
      void this.toggleCheckOnOpen();
      return;
    }
    const marketplace = this.marketplaces[this.marketplaceCursor - actions];
    if (marketplace !== undefined) this.startMarketplaceCheck([marketplace.name]);
  }

  private async addMarketplace(): Promise<void> {
    try {
      const source = await this.input("Add marketplace", "owner/repository, Git URL, or local path");
      if (source === undefined || source.trim().length === 0) return;
      const added = await this.host.addMarketplace(source.trim());
      this.showToast(`Added marketplace ${added.name}`);
      await this.loadLocal();
    } catch (error) {
      this.showToast(`Could not add marketplace: ${errorMessage(error)}`, "error");
    }
  }

  private startMarketplaceCheck(names = this.marketplaces.map((marketplace) => marketplace.name)): void {
    if (this.checking || names.length === 0) return;
    this.checkRun++;
    const run = this.checkRun;
    const controller = new AbortController();
    this.checkController = controller;
    this.checking = true;
    this.checkedMarketplaces = 0;
    this.checkingMarketplaces = new Set(names);
    this.localEpoch++;
    this.requestRender();
    const onResult = (result: MarketplaceRefreshResult): void => {
      if (this.destroyed || run !== this.checkRun) return;
      this.checkedMarketplaces++;
      if (result.ok && result.catalog !== undefined) {
        const cursorId = this.currentCursorId();
        this.catalogs.set(result.marketplace, result.catalog);
        this.restoreCursor(cursorId);
      }
      this.requestRender();
    };
    const runCheck = async (): Promise<readonly MarketplaceRefreshResult[]> => {
      try {
        const results = await this.host.refreshMarketplaces(names, {
          signal: controller.signal,
          timeoutMs: DEFAULT_REFRESH_TIMEOUT_MS,
          concurrency: 2,
          onResult,
        });
        if (this.destroyed || run !== this.checkRun) return results;
        this.updatesChecked = true;
        const failures = results.filter((result) => !result.ok);
        if (failures.length > 0) this.showToast(`${failures.length} marketplace check${failures.length === 1 ? "" : "s"} failed`, "warning");
        return results;
      } catch (error) {
        if (!this.destroyed && run === this.checkRun) this.showToast(`Marketplace check failed: ${errorMessage(error)}`, "warning");
        return [];
      } finally {
        if (this.destroyed || run !== this.checkRun) return [];
        this.checking = false;
        this.checkingMarketplaces.clear();
        this.checkController = undefined;
        this.checkPromise = undefined;
        void this.loadLocal().catch(() => undefined);
        this.requestRender();
      }
    };
    this.checkPromise = runCheck();
    void this.checkPromise.catch((error: unknown) => {
      if (!this.destroyed) this.showToast(`Marketplace check failed: ${errorMessage(error)}`, "warning");
    });
  }

  private cancelMarketplaceCheck(): void {
    if (!this.checking) return;
    this.checkRun++;
    this.checkController?.abort("cancelled");
    this.checkController = undefined;
    this.checkPromise = undefined;
    this.checking = false;
    this.checkingMarketplaces.clear();
    this.showToast("Marketplace check cancelled");
    this.requestRender();
  }

  private async loadLocal(): Promise<void> {
    const epoch = this.localEpoch;
    const marketplaces = await this.host.listMarketplaces();
    if (this.destroyed) return;
    let cursorId = this.currentCursorId();
    this.marketplaces = marketplaces;
    const marketplaceNames = new Set(marketplaces.map((marketplace) => marketplace.name));
    for (const name of this.catalogs.keys()) {
      if (!marketplaceNames.has(name)) this.catalogs.delete(name);
    }
    this.restoreCursor(cursorId);
    this.requestRender();
    this.maybeStartOpenCheck();
    const installed = await this.host.listInstalled();
    if (this.destroyed) return;
    cursorId = this.currentCursorId();
    this.installed = installed;
    this.restoreCursor(cursorId);
    this.requestRender();
    await Promise.all(this.marketplaces.map(async (marketplace) => {
      try {
        const catalog = await this.host.browseMarketplace(marketplace.name);
        if (!this.destroyed && epoch === this.localEpoch) {
          const currentCursorId = this.currentCursorId();
          this.catalogs.set(marketplace.name, catalog);
          this.restoreCursor(currentCursorId);
        }
      } catch (error) {
        if (!this.destroyed && epoch === this.localEpoch) this.showToast(`${marketplace.name}: ${errorMessage(error)}`, "warning");
      }
      if (!this.destroyed) this.requestRender();
    }));
    if (!this.destroyed && this.tab === "issues") await this.loadIssues();
  }

  private async loadIssues(): Promise<void> {
    this.issuesLoading = true;
    this.requestRender();
    try {
      const runtime = await this.host.scanRuntime();
      if (this.destroyed) return;
      this.runtime = runtime;
      this.issues = this.projectIssues(runtime);
      this.cursor = Math.min(this.cursor, Math.max(0, this.issues.length - 1));
    } catch (error) {
      if (!this.destroyed) this.issues = [{ id: "scan", title: "Runtime scan failed", message: errorMessage(error), severity: "error" }];
    } finally {
      if (!this.destroyed) {
        this.issuesLoading = false;
        this.requestRender();
      }
    }
  }

  private projectIssues(runtime: RuntimeSnapshot): readonly IssueEntry[] {
    const issues: IssueEntry[] = [];
    for (const plugin of runtime.plugins) {
      for (const diagnostic of plugin.diagnostics) {
        issues.push({
          id: `${identityOf(plugin.info)}:${diagnostic.scope}`,
          title: identityOf(plugin.info),
          message: diagnostic.message,
          severity: "error",
          pluginId: identityOf(plugin.info),
        });
      }
    }
    for (const diagnostic of runtime.diagnostics) {
      issues.push({ id: `runtime:${diagnostic.scope}`, title: diagnostic.scope, message: diagnostic.message, severity: "error" });
    }
    for (const plugin of this.installed) {
      const entry = catalogEntry(this.catalogs.get(plugin.marketplace), plugin.name);
      if (entry === undefined && this.catalogs.has(plugin.marketplace)) {
        issues.push({ id: `${identityOf(plugin)}:catalog`, title: identityOf(plugin), message: "Installed bundle is not declared in the current marketplace catalog; the installed copy remains available.", severity: "error", pluginId: identityOf(plugin) });
      } else if (plugin.autoUpdate && entry?.version === undefined) {
        issues.push({ id: `${identityOf(plugin)}:version`, title: identityOf(plugin), message: "Automatic updates are marked, but this catalog does not declare a version. Use /plugins update-marked for an explicit force update.", severity: "warning", pluginId: identityOf(plugin) });
      }
    }
    for (const [marketplace, catalog] of this.catalogs) {
      for (const diagnostic of catalog.diagnostics ?? []) issues.push({ id: `${marketplace}:${diagnostic.scope}`, title: marketplace, message: diagnostic.message, severity: "warning" });
    }
    return issues;
  }

  private async removeMarketplace(name: string): Promise<void> {
    const approved = await this.confirm("Remove marketplace", `Remove ${name}'s source checkout? Installed plugin bundles are left in place.`);
    if (!approved) return;
    try {
      await this.host.removeMarketplace(name);
      this.showToast(`Removed marketplace ${name}`);
      await this.loadLocal();
    } catch (error) {
      this.showToast(`Could not remove marketplace: ${errorMessage(error)}`, "error");
    }
  }

  private showToast(message: string, type: "info" | "warning" | "error" = "info"): void {
    this.toast = message;
    try { this.notify(message, type); } catch { /* notification failure must not escape the component callback */ }
    if (this.toastTimer !== undefined) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      if (this.destroyed) return;
      this.toast = undefined;
      this.requestRender();
    }, 2_000);
    this.toastTimer.unref?.();
    this.requestRender();
  }

  private requestRender(): void {
    if (!this.destroyed) this.tui.requestRender();
  }
}

function identityFromString(value: string): PluginIdentity {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) throw new Error(`invalid plugin identity: ${value}`);
  return { plugin: value.slice(0, at), marketplace: value.slice(at + 1) };
}

function identityToString(identity: PluginIdentity): string {
  return pluginIdentity(identity.plugin, identity.marketplace);
}

export async function openPluginManager(host: PluginHost, ctx: ExtensionCommandContext): Promise<PluginManagerResult | undefined> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/plugins requires TUI mode for the plugin manager", "error");
    return undefined;
  }
  return ctx.ui.custom<PluginManagerResult>((tui, theme, keybindings, done) => new PluginManager({
    host,
    tui,
    theme,
    keybindings,
    done,
    confirm: (title, message) => ctx.ui.confirm(title, message),
    input: (title, placeholder) => ctx.ui.input(title, placeholder),
    notify: (message, type) => ctx.ui.notify(message, type),
  }));
}
