import { visibleWidth } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PluginManager, type PluginManagerResult } from "../src/pi/plugin-manager.js";
import type {
  InstalledPluginInfo,
  MarketplaceCatalog,
  MarketplaceInfo,
  PluginBatchItemResult,
  PluginHost,
  RuntimeSnapshot,
} from "../src/types.js";

const marketplace: MarketplaceInfo = {
  name: "market",
  source: { kind: "github", value: "owner/repository" },
  root: "/agent/plugin-host/marketplaces/market",
  checkout: "/agent/plugin-host/marketplaces/market/checkout",
};

function installed(name: string): InstalledPluginInfo {
  return {
    marketplace: "market",
    name,
    root: `/agent/plugin-host/plugins/market/${name}`,
    data: `/agent/plugin-host/data/market/${name}`,
    enabled: true,
    autoUpdate: name === "alpha",
    receipt: { version: "1.0.0" },
  };
}

function catalog(names: readonly string[]): MarketplaceCatalog {
  return {
    name: "market",
    sources: [".agents/plugins/marketplace.json"],
    plugins: names.map((name) => ({
      name,
      description: `${name} plugin`,
      version: "1.0.0",
      source: { kind: "local", path: `plugins/${name}` },
      raw: {},
    })),
    diagnostics: [],
  };
}

function runtime(infos: readonly InstalledPluginInfo[]): RuntimeSnapshot {
  return {
    plugins: infos.map((info) => ({
      info,
      skillPaths: [`${info.root}/skills`],
      skillNames: [`skills/${info.name}`],
      hooks: [{ event: "SessionStart", command: "context.py", timeoutMs: 1_000 }],
      mcp: { server: { command: "node" } },
      diagnostics: [],
    })),
    skillPaths: infos.map((info) => `${info.root}/skills`),
    diagnostics: [],
  };
}

function managerHost(infos: readonly InstalledPluginInfo[]): PluginHost {
  const currentCatalog = catalog(infos.map((info) => info.name));
  return {
    paths: { agentDir: "/agent", hostRoot: "/agent/plugin-host", marketplaces: "", plugins: "", data: "" },
    addMarketplace: vi.fn(),
    listMarketplaces: vi.fn(async () => [marketplace]),
    refreshMarketplace: vi.fn(),
    refreshMarketplaces: vi.fn(async () => []),
    removeMarketplace: vi.fn(),
    browseMarketplace: vi.fn(async () => currentCatalog),
    listInstalled: vi.fn(async () => infos),
    installPlugin: vi.fn(),
    updatePlugin: vi.fn(),
    enablePlugin: vi.fn(),
    disablePlugin: vi.fn(),
    removePlugin: vi.fn(),
    setAutoUpdate: vi.fn(),
    getCheckOnOpen: vi.fn(async () => false),
    setCheckOnOpen: vi.fn(),
    runPluginBatch: vi.fn(async (action, identities, options = {}) => {
      const results: PluginBatchItemResult[] = [];
      for (const identity of identities) {
        options.onBeforeItem?.(identity);
        const result: PluginBatchItemResult = { action, identity, ok: true, info: infos.find((info) => info.name === identity.plugin)! };
        results.push(result);
        options.onItem?.(result);
      }
      return { results, cancelled: false };
    }),
    updateMarkedPlugins: vi.fn(async () => ({ refreshes: [], results: [] })),
    scanRuntime: vi.fn(async () => runtime(infos)),
    buildMcpConfig: vi.fn(async () => ({ mcpServers: {} })),
  } as PluginHost;
}

function createManager(host: PluginHost, done = vi.fn<(result: PluginManagerResult) => void>()): PluginManager {
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const manager = new PluginManager({
    host,
    tui: { requestRender: vi.fn() } as never,
    theme,
    keybindings: { matches: () => false } as unknown as KeybindingsManager,
    done,
    // Options intentionally omit confirm/input: the manager owns its dialogs so
    // that no nested pi UI prompt can orphan this custom component (its
    // ui.custom promise would otherwise never settle and wedge the editor).
    notify: vi.fn(),
  });
  manager.focused = true;
  return manager;
}

async function waitForText(manager: PluginManager, text: string, width = 100): Promise<string> {
  await vi.waitFor(() => expect(manager.render(width).join("\n")).toContain(text));
  return manager.render(width).join("\n");
}

describe("plugin manager component", () => {
  it("opens from local data and renders installed component details responsively", async () => {
    const info = installed("alpha");
    const host = managerHost([info]);
    const manager = createManager(host);
    try {
      const list = await waitForText(manager, "alpha · market · 1.0.0");
      expect(list).toContain("Local data · updates not checked");
      expect(host.refreshMarketplaces).not.toHaveBeenCalled();

      manager.handleInput("\r");
      const detail = await waitForText(manager, "Skills     skills/alpha");
      expect(detail).toContain(info.root);
      expect(detail).toContain(info.data);
      expect(detail).toContain("Hooks      SessionStart");
      expect(detail).toContain("MCP servers server");
      expect(manager.render(58).every((line) => visibleWidth(line) <= 58)).toBe(true);
    } finally {
      manager.dispose();
    }
  });

  it("keeps Escape as back in details while a marketplace check is active", async () => {
    const host = managerHost([installed("alpha")]);
    let finishCheck!: (value: readonly never[]) => void;
    let checkSignal: AbortSignal | undefined;
    host.refreshMarketplaces = vi.fn(async (_names, options = {}) => {
      checkSignal = options.signal;
      return new Promise<readonly never[]>((resolve) => { finishCheck = resolve; });
    });
    const manager = createManager(host);
    try {
      await waitForText(manager, "alpha · market · 1.0.0");
      manager.handleInput("r");
      manager.handleInput("\r");
      await waitForText(manager, "Plugin details");

      manager.handleInput("\u001b");
      expect(manager.render(100).join("\n")).toContain("Installed plugins (1)");
      expect(checkSignal?.aborted).toBe(false);
      finishCheck([]);
    } finally {
      manager.dispose();
    }
  });

  it("runs a confirmed multi-selection batch and returns one reload flag on close", async () => {
    const infos = [installed("alpha"), installed("beta")];
    const host = managerHost(infos);
    const done = vi.fn<(result: PluginManagerResult) => void>();
    const manager = createManager(host, done);
    try {
      await waitForText(manager, "beta · market · 1.0.0");
      manager.handleInput(" ");
      manager.handleInput("\u001b[B");
      manager.handleInput(" ");
      manager.handleInput("d");
      expect(manager.render(100).join("\n")).toContain("Disable 2 plugins?");

      manager.handleInput("\r");
      await waitForText(manager, "Batch complete");
      expect(manager.render(58).join("\n")).toContain("reload needed");
      expect(host.runPluginBatch).toHaveBeenCalledWith(
        "disable",
        [{ plugin: "alpha", marketplace: "market" }, { plugin: "beta", marketplace: "market" }],
        expect.objectContaining({ refresh: false }),
      );

      manager.handleInput("\u001b");
      expect(done).toHaveBeenCalledTimes(1);
      expect(done).toHaveBeenCalledWith({ reloadNeeded: true });
    } finally {
      manager.dispose();
    }
  });

  it("adds a marketplace through the internal input dialog without host UI prompts", async () => {
    const host = managerHost([]);
    host.addMarketplace = vi.fn(async () => ({ ...marketplace, name: "jamsesh" }));
    host.listMarketplaces = vi.fn(async () => [{ ...marketplace, name: "jamsesh" }]);
    host.listInstalled = vi.fn(async () => []);
    const manager = createManager(host);
    try {
      await waitForText(manager, "No installed plugins match this search.");
      // Marketplaces tab → + Add marketplace.
      manager.handleInput("\u001b[C"); // right → discover
      manager.handleInput("\u001b[C"); // right → marketplaces
      manager.handleInput("\r");
      const dialog = await waitForText(manager, "Add marketplace");
      expect(dialog).toContain("owner/repository, Git URL, or local path");
      expect(manager.render(100).join("\n")).toContain("enter submit · esc cancel");

      manager.handleInput("nklisch/jamsesh");
      manager.handleInput("\r");
      await vi.waitFor(() => expect(host.addMarketplace).toHaveBeenCalledWith("nklisch/jamsesh"));
      await waitForText(manager, "jamsesh");
      expect(manager.render(100).join("\n")).toContain("local checkout ready");
    } finally {
      manager.dispose();
    }
  });

  it("cancels the marketplace input dialog on Escape and leaves state untouched", async () => {
    const host = managerHost([]);
    const manager = createManager(host);
    try {
      await waitForText(manager, "No installed plugins match this search.");
      manager.handleInput("\u001b[C");
      manager.handleInput("\u001b[C");
      manager.handleInput("\r");
      await waitForText(manager, "Add marketplace");
      manager.handleInput("nklisch/jamsesh");
      manager.handleInput("\u001b");
      const after = manager.render(100).join("\n");
      expect(after).not.toContain("enter submit · esc cancel");
      expect(after).toContain("Manage marketplaces");
      expect(host.addMarketplace).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it("confirms marketplace removal internally and Escape declines", async () => {
    const host = managerHost([]);
    host.listMarketplaces = vi.fn(async () => [{ ...marketplace, name: "nklisch-skills" }]);
    host.listInstalled = vi.fn(async () => []);
    host.browseMarketplace = vi.fn(async () => catalog([]));
    host.removeMarketplace = vi.fn(async () => undefined);
    const manager = createManager(host);
    try {
      await waitForText(manager, "No installed plugins match this search.");
      manager.handleInput("\u001b[C");
      manager.handleInput("\u001b[C");
      await waitForText(manager, "nklisch-skills");
      // Marketplaces rows: add, check, check-on-open, then the marketplace row.
      manager.handleInput("\u001b[B");
      manager.handleInput("\u001b[B");
      manager.handleInput("\u001b[B");
      manager.handleInput("x");
      await waitForText(manager, "Remove marketplace");
      // Default cursor is the destructive action; Esc declines.
      manager.handleInput("\u001b");
      expect(host.removeMarketplace).not.toHaveBeenCalled();

      manager.handleInput("x");
      await waitForText(manager, "Remove nklisch-skills's source checkout");
      manager.handleInput("y");
      await vi.waitFor(() => expect(host.removeMarketplace).toHaveBeenCalledWith("nklisch-skills"));
      expect(manager.render(100).join("\n")).not.toContain("esc cancel");
    } finally {
      manager.dispose();
    }
  });
});
