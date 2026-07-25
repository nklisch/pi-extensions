import { setTimeout as nodeSetTimeout } from "node:timers/promises";
import {
  createMarketplaceRefreshService,
  type MarketplaceRefreshService,
  type MarketplaceRefreshServiceDependencies,
} from "../application/marketplace-refresh-service.js";
import {
  createMarketplaceUpdateScheduler,
  type MarketplaceUpdateScheduler,
} from "../application/marketplace-update-scheduler.js";
import type { UpdateDelayPort } from "../application/ports/update-delay.js";
import type { UpdateSchedulerLeasePort } from "../application/ports/update-scheduler-lease.js";
import type { UpdateSchedulerLeaseIdPort } from "../application/ports/update-scheduler-lease-id.js";
import { createUpdateSchedulerStatusProjection, type MutableUpdateSchedulerStatusProjection } from "../application/update-scheduler-status.js";
import {
  createMarketplaceUpdatePolicyService,
  type MarketplaceUpdatePolicyService,
} from "../application/marketplace-update-policy-service.js";

const nodeDelay: UpdateDelayPort = Object.freeze({
  async wait(milliseconds: number, signal: AbortSignal) {
    await nodeSetTimeout(milliseconds, undefined, { signal });
  },
});

export type NodeMarketplaceUpdateServicesOptions = Readonly<{
  refresh: MarketplaceRefreshServiceDependencies;
  delay?: UpdateDelayPort;
  schedulerLeases?: UpdateSchedulerLeasePort;
  leaseIds?: UpdateSchedulerLeaseIdPort;
}>;

export type NodeMarketplaceUpdateServices = Readonly<{
  refresh: MarketplaceRefreshService;
  policy: MarketplaceUpdatePolicyService;
  scheduler: MarketplaceUpdateScheduler;
  schedulerStatus: MutableUpdateSchedulerStatusProjection;
  schedulerLeases?: UpdateSchedulerLeasePort;
}>;

/**
 * Wire the complete portable marketplace update surface to Node's abortable
 * timer. Construction performs no I/O and starts no work.
 */
export function createNodeMarketplaceUpdateServices(
  options: NodeMarketplaceUpdateServicesOptions,
): NodeMarketplaceUpdateServices {
  if (options === null || typeof options !== "object" || options.refresh === undefined) {
    throw new TypeError("marketplace refresh composition requires refresh dependencies");
  }
  const refresh = createMarketplaceRefreshService(options.refresh);
  const policy = createMarketplaceUpdatePolicyService({
    state: options.refresh.state,
    mutations: options.refresh.mutations,
    sha256: options.refresh.sha256,
  });
  const schedulerStatus = createUpdateSchedulerStatusProjection();
  const scheduler = createMarketplaceUpdateScheduler({
    refresh,
    clock: options.refresh.clock,
    delay: options.delay ?? nodeDelay,
    status: schedulerStatus,
    ...(options.schedulerLeases === undefined ? {} : { leases: options.schedulerLeases }),
    ...(options.leaseIds === undefined ? {} : { leaseIds: options.leaseIds }),
  });
  return Object.freeze({
    refresh,
    policy,
    scheduler,
    schedulerStatus,
    ...(options.schedulerLeases === undefined ? {} : { schedulerLeases: options.schedulerLeases }),
  });
}
