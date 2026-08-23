import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PluginCommandAdapter } from "./plugin-command.js";
import type { PiManagerReloadHandoff } from "./pi-manager-reload-handoff.js";
import type { PiUpdateNotificationPublisher } from "./pi-update-notification-publisher.js";
import type { PiControlChannel } from "./pi-control-channel.js";
import type { PluginManagerSession } from "./manager/plugin-manager-session.js";
import type { PiTrustReview } from "./pi-trust-review.js";

export type PluginManagerLifecycle = Readonly<{
  register(): void;
  idle(): Promise<void>;
}>;

function notifySafely(context: ExtensionContext, message: string): void {
  try {
    if (context.hasUI) context.ui.notify(message, "warning");
  } catch {
    // A stale presentation context cannot be allowed to reject a detached
    // lifecycle chain. Authoritative status remains available through doctor.
  }
}

async function cleanupSequentially(
  steps: readonly (() => void | Promise<void>)[],
  message: string,
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try { await step(); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, message);
}

/** Bind presentation only after the packaged host's earlier lifecycle handler. */
export function createPluginManagerLifecycle(input: Readonly<{
  pi: ExtensionAPI;
  publisher: PiUpdateNotificationPublisher;
  manager: PluginManagerSession;
  command: PluginCommandAdapter;
  channel: PiControlChannel;
  handoff: PiManagerReloadHandoff;
  trustReview: PiTrustReview;
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
        if (event.reason !== "reload") {
          // Trust re-review owns its own errors: a broken review must never
          // take down session start.
          pending = pending
            .then(() => input.trustReview.review(context))
            .catch(() => notifySafely(context, "Plugin trust review could not complete; /plugins doctor has details."));
          return;
        }
        const claim = input.handoff.claimSuccessor({ sessionId: context.sessionManager.getSessionId(), cwd: context.cwd });
        if (claim === undefined) return;
        pending = claim.result
          .then((report) => context.mode === "tui"
            ? input.manager.presentHandoff(context, claim.destination, report.envelope)
            : input.channel.publishReport(context, report))
          .catch(() => {
            notifySafely(context, "Plugin operation handoff was not available; open /plugins to inspect authoritative status.");
          });
      });
      input.pi.on("session_shutdown", async (event, context) => {
        // These resources are independent. Continue closing the remaining
        // session-bound surfaces after one stale UI or publisher cleanup fails;
        // the aggregate remains observable to Pi's host-owned event boundary.
        await cleanupSequentially([
          () => input.manager.close(event.reason),
          () => input.handoff.closeSession(context.sessionManager.getSessionId(), event.reason),
          () => input.command.unbindSession(event.reason),
          () => input.publisher.unbind(event.reason),
          () => input.publisher.close(),
        ], "plugin manager session cleanup failed");
      });
    },
    idle: () => pending,
  };
  return Object.freeze(lifecycle);
}
