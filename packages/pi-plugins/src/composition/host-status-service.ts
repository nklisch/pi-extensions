import { HostStatusSnapshotSchema, type HostStartupResult, type HostStatusSnapshot } from "../application/host-observation-contract.js";
import type { UpdateSchedulerStatus } from "../application/marketplace-update-scheduler.js";
import { createUpdateSchedulerStatusProjection, type UpdateSchedulerStatusProjection } from "../application/update-scheduler-status.js";

export interface HostStatusService {
  snapshot(): HostStatusSnapshot;
}

export interface MutableHostStatus extends HostStatusService {
  update(input: Readonly<{
    /** Compatibility for isolated callers; packaged composition shares projection. */
    scheduler?: UpdateSchedulerStatus["state"];
    unresolvedCount?: number;
    unreadCount?: number;
  }>): void;
}

export function createHostStatusService(input: Readonly<{
  startup: HostStartupResult;
  convergence?: "settled" | "degraded" | "blocked";
  runtime?: "reconciled" | "degraded" | "blocked";
  schedulerStatus?: UpdateSchedulerStatusProjection;
}>): MutableHostStatus {
  const localScheduler = createUpdateSchedulerStatusProjection();
  const scheduler = input.schedulerStatus ?? localScheduler;
  let counts: Readonly<{ unresolvedCount: number; unreadCount: number }> = Object.freeze({ unresolvedCount: 0, unreadCount: 0 });
  const convergence = input.convergence ?? (input.startup.status === "blocked" ? "blocked" : input.startup.status === "degraded" ? "degraded" : "settled");
  const runtime = input.runtime ?? (input.startup.status === "blocked" ? "blocked" : input.startup.status === "degraded" ? "degraded" : "reconciled");

  function snapshot(): HostStatusSnapshot {
    const schedulerSnapshot = scheduler.snapshot();
    const localBlocked = convergence === "blocked" || runtime === "blocked";
    const localDegraded = convergence === "degraded" || runtime === "degraded";
    const updateDegraded = schedulerSnapshot.state === "degraded" || schedulerSnapshot.state === "clock-regressed";
    return HostStatusSnapshotSchema.parse({
      status: localBlocked ? "blocked" : localDegraded || updateDegraded || input.startup.blocked.length > 0 ? "degraded" : "ready",
      local: { convergence, runtime },
      update: { state: schedulerSnapshot.state, ...counts, scopes: schedulerSnapshot.scopes },
      blocked: input.startup.blocked,
      capabilities: input.startup.capabilities,
    });
  }

  return Object.freeze({
    snapshot,
    update(next: Parameters<MutableHostStatus["update"]>[0]) {
      if (next.scheduler !== undefined && input.schedulerStatus === undefined) {
        localScheduler.publish({ state: next.scheduler, scopes: localScheduler.snapshot().scopes });
      }
      counts = Object.freeze({
        unresolvedCount: next.unresolvedCount ?? counts.unresolvedCount,
        unreadCount: next.unreadCount ?? counts.unreadCount,
      });
    },
  });
}
