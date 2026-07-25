import type { AutomaticUpdateCoordinator } from "../application/automatic-update-coordinator.js";
import type { MarketplaceUpdateScheduler } from "../application/marketplace-update-scheduler.js";
import type { UpdateNotificationService } from "../application/update-notification-service.js";
import type { MutableUpdateSchedulerStatusProjection } from "../application/update-scheduler-status.js";
import type { MutableHostStatus } from "./host-status-service.js";

export interface BackgroundUpdateCoordinator {
  /** Starts the detached owner without awaiting adapters, publishers, or network. */
  start(): Promise<void>;
  wake(): void;
  close(): Promise<void>;
}

/** Owns the existing scheduler task; it creates no second timer or job authority. */
export function createBackgroundUpdateCoordinator(dependencies: Readonly<{
  scheduler: MarketplaceUpdateScheduler;
  schedulerStatus?: MutableUpdateSchedulerStatusProjection;
  notifications?: UpdateNotificationService;
  automatic?: AutomaticUpdateCoordinator;
  status: MutableHostStatus;
}>): BackgroundUpdateCoordinator {
  let controller: AbortController | undefined;
  let task: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  async function maintain(signal: AbortSignal): Promise<number | undefined> {
    let degraded = false;
    // Publication follows policy/lifecycle disposition. This order prevents an
    // initial manual-looking event when effective policy is automatic.
    if (dependencies.notifications !== undefined) {
      try {
        const reconciled = await dependencies.notifications.reconcile(signal);
        dependencies.status.update({ unreadCount: reconciled.unreadCount, unresolvedCount: reconciled.unresolvedCount });
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        degraded = true;
      }
    }
    if (dependencies.automatic !== undefined) {
      try { await dependencies.automatic.run({ limit: 20 }, signal); }
      catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        degraded = true;
      }
    }
    if (dependencies.notifications !== undefined) {
      try {
        await dependencies.notifications.dispatch({}, signal);
        const page = await dependencies.notifications.list({ scope: "all-current", limit: 1 }, signal);
        dependencies.status.update({ unreadCount: page.unreadCount, unresolvedCount: page.unresolvedCount });
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        degraded = true;
      }
    }
    if (degraded) throw new Error("background update maintenance degraded");
    return dependencies.automatic?.nextRetryAt === undefined ? undefined : dependencies.automatic.nextRetryAt(signal);
  }

  return Object.freeze({
    async start() {
      if (closePromise !== undefined || task !== undefined) return;
      controller = new AbortController();
      const ownedController = controller;
      // Deliberately do not await this task: local startup is complete before
      // any notification publisher, marketplace adapter, or timer participates.
      task = dependencies.scheduler.run(ownedController.signal, maintain).catch((error) => {
        if (!ownedController.signal.aborted) dependencies.schedulerStatus?.degrade();
        void error;
      });
    },
    wake() {
      if (closePromise === undefined) dependencies.scheduler.wake();
    },
    close() {
      closePromise ??= (async () => {
        controller?.abort(new Error("background update coordinator closed"));
        await task?.catch(() => undefined);
      })();
      return closePromise;
    },
  });
}
