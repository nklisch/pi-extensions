import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PluginHost } from "../types.js";

function tokens(input: string): string[] {
  const result: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/gu;
  for (const match of input.matchAll(pattern)) result.push((match[1] ?? match[2] ?? match[3] ?? "").replace(/\\([\\"'])/gu, "$1"));
  return result;
}

function pluginIdentity(value: string): { plugin: string; marketplace: string } {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) throw new Error("plugin must be written as <plugin>@<marketplace>");
  return { plugin: value.slice(0, at), marketplace: value.slice(at + 1) };
}

function say(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
  else console.log(message);
}

async function confirmMutation(ctx: ExtensionCommandContext, operation: string, message: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!ctx.hasUI) throw new Error(`${operation} requires confirmation; pass --yes in headless mode`);
  if (!await ctx.ui.confirm(`Confirm plugin ${operation}`, message)) throw new Error("cancelled");
}

function removeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function removeValueFlag(args: string[], flag: string): string | undefined {
  const inline = args.findIndex((value) => value.startsWith(`${flag}=`));
  if (inline >= 0) return args.splice(inline, 1)[0]!.slice(flag.length + 1);
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const [, value] = args.splice(index, 2);
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

async function listInstalled(host: PluginHost, ctx: ExtensionCommandContext): Promise<void> {
  const installed = await host.listInstalled();
  if (installed.length === 0) { say(ctx, "No installed plugins."); return; }
  for (const plugin of installed) say(ctx, `${plugin.name}@${plugin.marketplace} ${plugin.enabled ? "enabled" : "disabled"}`);
}

async function listMarketplaces(host: PluginHost, ctx: ExtensionCommandContext): Promise<void> {
  const marketplaces = await host.listMarketplaces();
  if (marketplaces.length === 0) { say(ctx, "No marketplaces."); return; }
  for (const marketplace of marketplaces) say(ctx, `${marketplace.name} (${marketplace.source.value})`);
}

async function chooseMarketplace(host: PluginHost, ctx: ExtensionCommandContext, title: string): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  const marketplaces = await host.listMarketplaces();
  return ctx.ui.select(title, marketplaces.map((item) => item.name));
}

async function choosePluginIdentity(host: PluginHost, ctx: ExtensionCommandContext, install: boolean): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  if (install) {
    const marketplace = await chooseMarketplace(host, ctx, "Install from marketplace");
    if (marketplace === undefined) return undefined;
    const catalog = await host.browseMarketplace(marketplace);
    const plugin = await ctx.ui.select("Install plugin", catalog.plugins.map((item) => item.name));
    return plugin === undefined ? undefined : `${plugin}@${marketplace}`;
  }
  const installed = await host.listInstalled();
  return ctx.ui.select("Choose plugin", installed.map((item) => `${item.name}@${item.marketplace}`));
}

async function browse(host: PluginHost, args: string[], ctx: ExtensionCommandContext): Promise<void> {
  let name = args.shift();
  if (name === undefined && ctx.hasUI) {
    const marketplaces = await host.listMarketplaces();
    name = await ctx.ui.select("Browse marketplace", marketplaces.map((item) => item.name));
  }
  if (name === undefined) throw new Error("usage: /plugins browse <marketplace>");
  const catalog = await host.browseMarketplace(name);
  for (const item of catalog.diagnostics ?? []) say(ctx, `${item.scope}: ${item.message}`, "warning");
  if (catalog.plugins.length === 0) { say(ctx, `${name}: no catalog plugins.`); return; }
  for (const plugin of catalog.plugins) say(ctx, `${plugin.name}@${name}${plugin.version === undefined ? "" : ` ${plugin.version}`}${plugin.description === undefined ? "" : ` — ${plugin.description}`}`);
}

async function dispatch(host: PluginHost, input: string, ctx: ExtensionCommandContext): Promise<void> {
  const args = tokens(input);
  const action = args.shift();
  if (action === undefined) {
    if (!ctx.hasUI) { say(ctx, "Usage: /plugins list|status|marketplace|browse|install|update|enable|disable|remove"); return; }
    const chosen = await ctx.ui.select("Plugins", ["list", "marketplace list", "marketplace add", "marketplace refresh", "browse", "install", "update", "enable", "disable", "remove"]);
    if (chosen !== undefined) await dispatch(host, chosen, ctx);
    return;
  }
  if (action === "list" || action === "status") { await listInstalled(host, ctx); return; }
  if (action === "browse") { await browse(host, args, ctx); return; }

  if (action === "marketplace") {
    const subcommand = args.shift();
    if (subcommand === "list") { await listMarketplaces(host, ctx); return; }
    if (subcommand === "add") {
      const ref = removeValueFlag(args, "--ref");
      const source = args.shift() ?? (ctx.hasUI ? await ctx.ui.input("Marketplace source", "owner/repository, Git URL, or local path") : undefined);
      if (source === undefined) throw new Error("usage: /plugins marketplace add <source>");
      const marketplace = await host.addMarketplace(source, ref === undefined ? {} : { ref });
      say(ctx, `Added marketplace ${marketplace.name}.`);
      return;
    }
    if (subcommand === "refresh") {
      const name = args.shift() ?? await chooseMarketplace(host, ctx, "Refresh marketplace");
      if (name === undefined) throw new Error("usage: /plugins marketplace refresh <marketplace>");
      const marketplace = await host.refreshMarketplace(name);
      say(ctx, `Refreshed marketplace ${marketplace.name}.`);
      return;
    }
    if (subcommand === "remove") {
      const name = args.shift() ?? await chooseMarketplace(host, ctx, "Remove marketplace");
      if (name === undefined) throw new Error("usage: /plugins marketplace remove <marketplace>");
      if (ctx.hasUI && !await ctx.ui.confirm("Remove marketplace", `Remove ${name}'s source checkout? Installed plugin bundles are left in place.`)) throw new Error("cancelled");
      await host.removeMarketplace(name);
      say(ctx, `Removed marketplace ${name}.`);
      return;
    }
    throw new Error("usage: /plugins marketplace add|list|refresh|remove");
  }

  if (action === "install" || action === "add" || action === "update" || action === "enable" || action === "disable" || action === "remove" || action === "uninstall") {
    const yes = removeFlag(args, "--yes");
    const deleteData = removeFlag(args, "--delete-data");
    const selected = args.shift() ?? await choosePluginIdentity(host, ctx, action === "install" || action === "add");
    if (selected === undefined) throw new Error(`usage: /plugins ${action} <plugin>@<marketplace>`);
    const identity = pluginIdentity(selected);
    if (action === "install" || action === "add") {
      await confirmMutation(ctx, "installation", "Plugin hooks and MCP servers are executable local code. Continue?", yes);
      await host.installPlugin(identity.marketplace, identity.plugin);
      say(ctx, `Installed ${identity.plugin}@${identity.marketplace}.`);
      await ctx.reload();
      return;
    }
    if (action === "update") {
      await confirmMutation(ctx, "update", "An update may replace executable plugin hooks and MCP servers. Continue?", yes);
      await host.updatePlugin(identity.marketplace, identity.plugin);
      say(ctx, `Updated ${identity.plugin}@${identity.marketplace}.`);
      await ctx.reload();
      return;
    }
    if (action === "enable") {
      await confirmMutation(ctx, "enablement", "Enabling activates the plugin's hooks and MCP servers. Continue?", yes);
      await host.enablePlugin(identity.marketplace, identity.plugin);
      say(ctx, `Enabled ${identity.plugin}@${identity.marketplace}.`);
      await ctx.reload();
      return;
    }
    if (action === "disable") {
      await host.disablePlugin(identity.marketplace, identity.plugin);
      say(ctx, `Disabled ${identity.plugin}@${identity.marketplace}.`);
      await ctx.reload();
      return;
    }
    await confirmMutation(ctx, "removal", `Remove ${identity.plugin}@${identity.marketplace}${deleteData ? " and its persistent data" : ""}?`, yes);
    await host.removePlugin(identity.marketplace, identity.plugin, deleteData);
    say(ctx, `Removed ${identity.plugin}@${identity.marketplace}${deleteData ? " and its data" : ""}.`);
    await ctx.reload();
    return;
  }
  throw new Error("unknown /plugins action");
}

export function registerPluginsCommand(pi: ExtensionAPI, host: PluginHost): void {
  pi.registerCommand("plugins", {
    description: "Manage filesystem-first Pi plugins",
    handler: async (args, ctx) => {
      try {
        await dispatch(host, args ?? "", ctx);
      } catch (error) {
        say(ctx, error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
