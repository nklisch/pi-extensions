import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PluginCommandAdapter } from "./plugin-command.js";
import type { PiManagerReloadHandoff } from "./pi-manager-reload-handoff.js";
import type { PiUpdateNotificationPublisher } from "./pi-update-notification-publisher.js";
import type { PiControlChannel } from "./pi-control-channel.js";
import type { PluginManagerSession } from "./manager/plugin-manager-session.js";

export type PluginManagerLifecycle = Readonly<{
  register(): void;
  idle(): Promise<void>;
}>;

/** Bind presentation only after the packaged host's earlier lifecycle handler. */
export function createPluginManagerLifecycle(input: Readonly<{
  pi: ExtensionAPI;
  publisher: PiUpdateNotificationPublisher;
  manager: PluginManagerSession;
  command: PluginCommandAdapter;
  channel: PiControlChannel;
  handoff: PiManagerReloadHandoff;
}>): PluginManagerLifecycle {
  let registered = false;
  let pending: Promise<void> = Promise.resolve();

  const lifecycle: PluginManagerLifecycle = {
    register(): void {
      if (registered) return;
      registered = true;
      input.pi.on("session_start", (event, context) => {
        input.publisher.bind(context);
        input.publisher.restore(context);
        input.manager.bind(context);
        input.command.bindSession(context);
        if (event.reason !== "reload") return;
        const claim = input.handoff.claimSuccessor({ sessionId: context.sessionManager.getSessionId(), cwd: context.cwd });
        if (claim === undefined) return;
        pending = claim.result
          .then((report) => context.mode === "tui"
            ? input.manager.presentHandoff(context, claim.destination, report.envelope)
            : input.channel.publishReport(context, report))
          .catch(() => {
            if (context.hasUI) context.ui.notify("Plugin operation handoff was not available; open /plugin to inspect authoritative status.", "warning");
          });
      });
      input.pi.on("session_shutdown", async (event, context) => {
        await input.manager.close(event.reason);
        input.handoff.closeSession(context.sessionManager.getSessionId(), event.reason);
        input.command.unbindSession(event.reason);
        input.publisher.unbind(event.reason);
        await input.publisher.close();
      });
    },
    idle: () => pending,
  };
  return Object.freeze(lifecycle);
}
