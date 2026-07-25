import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPackagedPluginHost } from "../composition/create-packaged-plugin-host.js";
import { createProductionMcpRuntimeCandidate } from "../composition/create-mcp-runtime.js";
import { createPiControlChannel } from "./pi-control-channel.js";
import { createPluginCommandAdapter } from "./plugin-command.js";
import { createPluginManagerLifecycle } from "./plugin-manager-lifecycle.js";
import { createPiManagerReloadHandoff } from "./pi-manager-reload-handoff.js";
import { createPiUpdateNotificationPublisher } from "./pi-update-notification-publisher.js";
import { createPiControlInputPort } from "./manager/pi-control-input.js";
import { createPluginManagerSession } from "./manager/plugin-manager-session.js";

/** Construct-only Pi extension entry; host startup remains session_start-owned. */
export default async function packagedPluginHostExtension(pi: ExtensionAPI): Promise<void> {
  const publisher = createPiUpdateNotificationPublisher({ pi });
  // The isolated MCP candidate attaches before host startup, so its session
  // context is available when central qualification captures environment-aware
  // facts. It starts empty; authoritative full-bundle reconciliation remains
  // the only source publication path.
  const mcp = await createProductionMcpRuntimeCandidate();
  mcp?.extension(pi);
  // Host construction registers its lifecycle delegates before presentation.
  const host = createPackagedPluginHost({
    pi,
    ...(mcp === undefined ? {} : { runtime: { mcp: mcp.runtime } }),
    update: { publisher },
  });
  const handoff = createPiManagerReloadHandoff();
  const manager = createPluginManagerSession({ host, handoff });
  const channel = createPiControlChannel({ pi });
  const command = createPluginCommandAdapter({
    pi,
    sourceUrl: import.meta.url,
    host,
    manager,
    channel,
    handoff,
    createInput: (context, mode) => createPiControlInputPort({ context, mode, present: () => manager.inlinePresenter?.() }),
  });
  command.register();
  createPluginManagerLifecycle({ pi, publisher, manager, command, channel, handoff }).register();
}
