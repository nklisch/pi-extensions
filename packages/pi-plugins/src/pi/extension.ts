import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMcpAdapter, type McpAdapterOptions } from "@nklisch/pi-mcp-adapter";
import { registerPluginHooks } from "../hooks.js";
import { createPluginHost } from "../host.js";
import { registerPluginsCommand } from "./commands.js";

/**
 * The extension is intentionally a load-time filesystem snapshot. Mutations
 * write the durable layout and ask Pi to reload; there is no resident manager,
 * scheduler, database, or convergence loop to reconcile afterward.
 */
export default async function filesystemPluginHostExtension(pi: ExtensionAPI): Promise<void> {
  const host = createPluginHost(getAgentDir());
  const snapshot = await host.scanRuntime();
  pi.on("resources_discover", () => ({ skillPaths: [...snapshot.skillPaths] }));
  registerPluginHooks(pi, snapshot);
  registerPluginsCommand(pi, host);

  if (snapshot.diagnostics.length > 0) {
    pi.on("session_start", async (_event, ctx) => {
      if (!ctx.hasUI) return;
      for (const item of snapshot.diagnostics) ctx.ui.notify(`Plugin ${item.scope}: ${item.message}`, "warning");
    });
  }

  try {
    const config = await host.buildMcpConfig(snapshot);
    if (Object.keys(config.mcpServers).length > 0) {
      // This is deliberately the adapter's plain config entry point. The
      // plugin host owns discovery and substitution, but not MCP lifecycle.
      createMcpAdapter({ configOverlay: config as NonNullable<McpAdapterOptions["configOverlay"]> })(pi);
    }
  } catch (error) {
    pi.on("session_start", async (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(`Plugin MCP setup failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    });
  }
}
