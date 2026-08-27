import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { DiscoveredPlugin, InstalledPluginInfo, MarketplaceInfo } from "../types.js";

export type PluginManagerTab = "installed" | "discover" | "marketplaces" | "issues";
export type PluginManagerView = "list" | "detail" | "confirm" | "batch";

export interface PluginManagerRow {
  readonly id: string;
  readonly name: string;
  readonly marketplace: string;
  readonly description?: string | undefined;
  readonly version?: string | undefined;
  readonly availableVersion?: string | undefined;
  readonly installed: boolean;
  readonly enabled?: boolean | undefined;
  readonly autoUpdate?: boolean | undefined;
  readonly issue?: string | undefined;
}

export type PluginManagerMarketplaceRow =
  | Readonly<{ kind: "add"; label: string }>
  | Readonly<{ kind: "check-now"; label: string }>
  | Readonly<{ kind: "check-on-open"; label: string; enabled: boolean }>
  | Readonly<{ kind: "marketplace"; marketplace: MarketplaceInfo }>;

export function pluginManagerMarketplaceRows(
  marketplaces: readonly MarketplaceInfo[],
  checkOnOpen: boolean,
): readonly PluginManagerMarketplaceRow[] {
  return Object.freeze([
    Object.freeze({ kind: "add", label: "+ Add marketplace" }),
    Object.freeze({ kind: "check-now", label: "Check for updates now" }),
    Object.freeze({ kind: "check-on-open", label: "Check for updates when manager opens", enabled: checkOnOpen }),
    ...marketplaces.map((marketplace) => Object.freeze({ kind: "marketplace", marketplace })),
  ]);
}

export interface PluginManagerInstalledDetail {
  readonly installPath: string;
  readonly dataPath: string;
  readonly skills: readonly string[];
  readonly hooks: readonly string[];
  readonly mcpServers: readonly string[];
}

export function projectInstalledPluginDetail(
  plugin: InstalledPluginInfo,
  runtimePlugin: DiscoveredPlugin | undefined,
): PluginManagerInstalledDetail {
  return Object.freeze({
    installPath: plugin.root,
    dataPath: plugin.data,
    skills: Object.freeze([...(runtimePlugin?.skillNames ?? [])]),
    hooks: Object.freeze((runtimePlugin?.hooks ?? []).map((hook) => hook.matcher === undefined ? hook.event : `${hook.event} (${hook.matcher})`)),
    mcpServers: Object.freeze(Object.keys(runtimePlugin?.mcp ?? {}).sort()),
  });
}

export function pluginIdentity(plugin: string, marketplace: string): string {
  return `${plugin}@${marketplace}`;
}

export function filterPluginRows(rows: readonly PluginManagerRow[], query: string): readonly PluginManagerRow[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized.length === 0) return rows;
  return rows.filter((row) => `${row.name} ${row.marketplace} ${row.description ?? ""}`.toLocaleLowerCase().includes(normalized));
}

export function prunePluginSelection(
  selected: ReadonlySet<string>,
  currentRows: readonly PluginManagerRow[],
): { readonly selected: ReadonlySet<string>; readonly vanished: readonly string[] } {
  const current = new Set(currentRows.map((row) => row.id));
  const next = new Set<string>();
  const vanished: string[] = [];
  for (const id of selected) {
    if (current.has(id)) next.add(id);
    else vanished.push(id);
  }
  return { selected: next, vanished };
}

export function movePluginCursor(cursor: number, delta: -1 | 1, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, cursor + delta));
}

export function restorePluginCursor(
  rows: readonly PluginManagerRow[],
  cursor: number,
  previousId: string | undefined,
): number {
  const stableIndex = previousId === undefined ? -1 : rows.findIndex((row) => row.id === previousId);
  return stableIndex >= 0 ? stableIndex : Math.min(cursor, Math.max(0, rows.length - 1));
}

export type PluginManagerKeyAction =
  | "up"
  | "down"
  | "left"
  | "right"
  | "select"
  | "select-all"
  | "details"
  | "check"
  | "install"
  | "update"
  | "enable"
  | "disable"
  | "remove"
  | "back"
  | "close"
  | "search"
  | "search-input";

export interface PluginManagerKeyState {
  readonly view: PluginManagerView;
  readonly tab: PluginManagerTab;
  readonly selectedCount: number;
  readonly searchFocused?: boolean;
}

/**
 * Keep the key map independent from rendering and filesystem work. The custom
 * component can then route one semantic action to either local state or one
 * explicit host operation, while tests pin the user-facing keyboard contract.
 */
export function pluginManagerKeyAction(data: string, state: PluginManagerKeyState): PluginManagerKeyAction | undefined {
  if (state.searchFocused) {
    if (matchesKey(data, Key.escape)) return "back";
    if (matchesKey(data, Key.enter)) return "back";
    return "search-input";
  }
  if (matchesKey(data, Key.up)) return "up";
  if (matchesKey(data, Key.down)) return "down";
  if (matchesKey(data, Key.left) || matchesKey(data, Key.ctrl("left"))) return "left";
  if (matchesKey(data, Key.right) || matchesKey(data, Key.ctrl("right"))) return "right";
  if (matchesKey(data, Key.space)) return "select";
  if (matchesKey(data, Key.enter)) return "details";
  if (matchesKey(data, Key.escape)) return state.view === "list" ? "close" : "back";
  if (state.view === "list" && (state.tab === "installed" || state.tab === "discover")) {
    if (data.toLocaleLowerCase() === "a") return "select-all";
    if (data.toLocaleLowerCase() === "r") return "check";
    if (state.selectedCount > 0 && state.tab === "discover" && data.toLocaleLowerCase() === "i") return "install";
    if (state.selectedCount > 0 && state.tab === "installed" && data.toLocaleLowerCase() === "u") return "update";
    if (state.selectedCount > 0 && state.tab === "installed" && data.toLocaleLowerCase() === "e") return "enable";
    if (state.selectedCount > 0 && state.tab === "installed" && data.toLocaleLowerCase() === "d") return "disable";
    if (state.selectedCount > 0 && state.tab === "installed" && data.toLocaleLowerCase() === "x") return "remove";
  }
  if (matchesKey(data, Key.ctrl("f"))) return "search";
  return undefined;
}
