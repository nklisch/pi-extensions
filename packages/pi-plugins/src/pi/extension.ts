import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMcpAdapter, type McpAdapterOptions } from "@nklisch/pi-mcp-adapter";
import { registerPluginHooks } from "../hooks.js";
import { createPluginHost } from "../host.js";
import { registerPluginsCommand } from "./commands.js";

/**
 * Runtime discovery remains a load-time filesystem snapshot. The only startup
 * network work is the bounded, marker-authorized update pass; the manager and
 * explicit commands own every other refresh.
 */
export default async function filesystemPluginHostExtension(pi: ExtensionAPI): Promise<void> {
  const host = createPluginHost(getAgentDir());
  let startupUpdateError: string | undefined;
  let startupUpdateFailures: readonly string[] = [];
  try {
    const startup = await host.updateMarkedPlugins();
    startupUpdateFailures = startup.results
      .filter((result) => !result.ok)
      .map((result) => `${result.identity.plugin}@${result.identity.marketplace}: ${result.error ?? "update failed"}`);
  } catch (error) {
    // Network and catalog failures must never prevent Pi from discovering the
    // installed copies that are already safe to run.
    startupUpdateError = error instanceof Error ? error.message : String(error);
  }
  const snapshot = await host.scanRuntime();
  pi.on("resources_discover", () => ({ skillPaths: [...snapshot.skillPaths] }));
  registerPluginHooks(pi, snapshot);
  registerPluginsCommand(pi, host);

  if (snapshot.diagnostics.length > 0 || startupUpdateError !== undefined || startupUpdateFailures.length > 0) {
    pi.on("session_start", async (_event, ctx) => {
      if (!ctx.hasUI) return;
      for (const item of snapshot.diagnostics) ctx.ui.notify(`Plugin ${item.scope}: ${item.message}`, "warning");
      if (startupUpdateError !== undefined) ctx.ui.notify(`Marked plugin update check failed: ${startupUpdateError}`, "warning");
      for (const failure of startupUpdateFailures) ctx.ui.notify(`Marked plugin update failed: ${failure}`, "warning");
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
