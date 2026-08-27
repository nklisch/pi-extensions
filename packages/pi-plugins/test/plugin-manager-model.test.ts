import { describe, expect, it } from "vitest";
import {
  filterPluginRows,
  movePluginCursor,
  pluginManagerKeyAction,
  pluginManagerMarketplaceRows,
  projectInstalledPluginDetail,
  prunePluginSelection,
  restorePluginCursor,
  type PluginManagerRow,
} from "../src/pi/plugin-manager-model.js";

const rows: PluginManagerRow[] = [
  { id: "alpha@one", name: "alpha", marketplace: "one", description: "First plugin", version: "1.0.0", installed: true, enabled: true },
  { id: "beta@two", name: "beta", marketplace: "two", description: "Second plugin", version: "2.0.0", installed: false },
];

describe("plugin manager view model", () => {
  it("filters by plugin identity and description without changing stable ids", () => {
    expect(filterPluginRows(rows, "SECOND").map((row) => row.id)).toEqual(["beta@two"]);
    expect(filterPluginRows(rows, "")).toBe(rows);
  });

  it("drops only selections that disappeared from current catalog truth", () => {
    const result = prunePluginSelection(new Set(["alpha@one", "gone@one"]), rows);
    expect([...result.selected]).toEqual(["alpha@one"]);
    expect(result.vanished).toEqual(["gone@one"]);
  });

  it("clamps navigation and preserves cursor identity across asynchronous rows", () => {
    expect(movePluginCursor(0, -1, rows.length)).toBe(0);
    expect(movePluginCursor(0, 1, rows.length)).toBe(1);
    expect(movePluginCursor(1, 1, rows.length)).toBe(1);
    expect(movePluginCursor(4, -1, 0)).toBe(0);

    const inserted = [{ id: "aardvark@zero", name: "aardvark", marketplace: "zero", installed: false }, ...rows];
    expect(restorePluginCursor(inserted, 1, "beta@two")).toBe(2);
    expect(restorePluginCursor(rows.slice(0, 1), 2, "beta@two")).toBe(0);
  });

  it("advertises the accepted keyboard contract and contextual actions", () => {
    const discover = { view: "list", tab: "discover", selectedCount: 2 } as const;
    const installed = { view: "list", tab: "installed", selectedCount: 2 } as const;
    expect(pluginManagerKeyAction("a", discover)).toBe("select-all");
    expect(pluginManagerKeyAction("i", discover)).toBe("install");
    expect(pluginManagerKeyAction("u", installed)).toBe("update");
    expect(pluginManagerKeyAction("r", installed)).toBe("check");
    expect(pluginManagerKeyAction(" ", discover)).toBe("select");
    expect(pluginManagerKeyAction("\u001b[A", discover)).toBe("up");
    expect(pluginManagerKeyAction("\r", discover)).toBe("details");
    expect(pluginManagerKeyAction("\u001b", discover)).toBe("close");
  });

  it("routes printable keys to search while search has focus", () => {
    const state = { view: "list", tab: "discover", selectedCount: 0, searchFocused: true } as const;
    expect(pluginManagerKeyAction("u", state)).toBe("search-input");
    expect(pluginManagerKeyAction("\u001b", state)).toBe("back");
  });

  it("projects check-on-open as its own navigable marketplace row", () => {
    const rows = pluginManagerMarketplaceRows([{
      name: "one",
      source: { kind: "github", value: "owner/repository" },
      root: "/agent/plugin-host/marketplaces/one",
      checkout: "/agent/plugin-host/marketplaces/one/checkout",
    }], true);
    expect(rows.map((row) => row.kind)).toEqual(["add", "check-now", "check-on-open", "marketplace"]);
    expect(rows[2]).toMatchObject({ kind: "check-on-open", enabled: true });
  });

  it("projects installed paths and runtime component names for details", () => {
    const info = {
      marketplace: "one",
      name: "alpha",
      root: "/agent/plugin-host/plugins/one/alpha",
      data: "/agent/plugin-host/data/one/alpha",
      enabled: true,
      autoUpdate: false,
    } as const;
    const detail = projectInstalledPluginDetail(info, {
      info,
      skillPaths: ["/agent/plugin-host/plugins/one/alpha/skills"],
      skillNames: ["skills/alpha"],
      hooks: [{ event: "PreToolUse", matcher: "Bash", command: "./check.sh", timeoutMs: 1_000 }],
      mcp: { server: { command: "node" } },
      diagnostics: [],
    });
    expect(detail).toEqual({
      installPath: info.root,
      dataPath: info.data,
      skills: ["skills/alpha"],
      hooks: ["PreToolUse (Bash)"],
      mcpServers: ["server"],
    });
  });
});
