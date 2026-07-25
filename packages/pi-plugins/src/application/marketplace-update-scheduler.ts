import type { ScopeReference } from "../domain/state/scope.js";
import type { UpdateSchedulerLeaseId } from "../domain/update-policy.js";
import type { LifecycleClock } from "./ports/lifecycle-clock.js";
import type { UpdateDelayPort } from "./ports/update-delay.js";
import type { UpdateSchedulerLeasePort } from "./ports/update-scheduler-lease.js";
import type { UpdateSchedulerLeaseIdPort } from "./ports/update-scheduler-lease-id.js";
import type { MarketplaceRefreshService } from "./marketplace-refresh-service.js";
import { createUpdateSchedulerStatusProjection, type MutableUpdateSchedulerStatusProjection, type UpdateSchedulerStatus } from "./update-scheduler-status.js";
export type { UpdateSchedulerStatus } from "./update-scheduler-status.js";

const DEFAULT_INVENTORY_POLL_MS = 30_000;
const DEFAULT_LEASE_MS = 2 * 60_000;

export type MarketplaceUpdateSchedulerDependencies = Readonly<{
  refresh: MarketplaceRefreshService;
  clock: LifecycleClock;
  delay: UpdateDelayPort;
  leases?: UpdateSchedulerLeasePort;
  leaseIds?: UpdateSchedulerLeaseIdPort;
  status?: MutableUpdateSchedulerStatusProjection;
  inventoryPollMs?: number;
  leaseMs?: number;
}>;

/** Runs ledger/application/publication maintenance and returns its next deadline. */
export type MarketplaceUpdateSchedulerCycle = (signal: AbortSignal) => Promise<number | undefined | void>;

export interface MarketplaceUpdateScheduler {
  /** Run until the caller aborts. Construction never starts this loop. */
  run(signal: AbortSignal, cycle?: MarketplaceUpdateSchedulerCycle): Promise<void>;
  status(signal: AbortSignal): Promise<UpdateSchedulerStatus>;
  /** Wake the sole owner after local policy/state/lifecycle work changes eligibility. */
  wake(): void;
}

function positiveMilliseconds(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

function minimumDeadline(...values: readonly (number | undefined)[]): number | undefined {
  return values.filter((value): value is number => value !== undefined).sort((left, right) => left - right)[0];
}

export function createMarketplaceUpdateScheduler(dependencies: MarketplaceUpdateSchedulerDependencies): MarketplaceUpdateScheduler {
  if (dependencies === null || typeof dependencies !== "object") throw new TypeError("scheduler dependencies are required");
  if (dependencies.refresh === undefined || dependencies.clock === undefined || dependencies.delay === undefined) throw new TypeError("scheduler requires refresh, clock, and delay dependencies");
  if ((dependencies.leases === undefined) !== (dependencies.leaseIds === undefined)) throw new TypeError("scheduler lease state and identifier authority must be configured together");
  const inventoryPollMs = positiveMilliseconds(dependencies.inventoryPollMs ?? DEFAULT_INVENTORY_POLL_MS, "inventoryPollMs");
  const leaseMs = positiveMilliseconds(dependencies.leaseMs ?? DEFAULT_LEASE_MS, "leaseMs");
  if (dependencies.leases !== undefined && leaseMs <= inventoryPollMs) throw new TypeError("scheduler lease must exceed its renewal poll");
  const projection = dependencies.status ?? createUpdateSchedulerStatusProjection();
  let running = false;
  let wakeGeneration = 0;
  const wakeWaiters = new Set<() => void>();

  function wake(): void {
    wakeGeneration += 1;
    for (const resolve of [...wakeWaiters]) resolve();
  }

  async function wait(milliseconds: number, observedWake: number, signal: AbortSignal): Promise<void> {
    if (wakeGeneration !== observedWake) return;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    let resolveWake!: () => void;
    const woken = new Promise<"wake">((resolve) => {
      resolveWake = () => resolve("wake");
      wakeWaiters.add(resolveWake);
    });
    try {
      const delayed = dependencies.delay.wait(milliseconds, controller.signal).then(() => "delay" as const, (error) => {
        if (signal.aborted) throw signal.reason ?? error;
        if (!controller.signal.aborted) throw error;
        return "wake" as const;
      });
      const result = await Promise.race([delayed, woken]);
      if (result === "wake") controller.abort(new Error("update scheduler awakened"));
      signal.throwIfAborted();
    } finally {
      wakeWaiters.delete(resolveWake);
      signal.removeEventListener("abort", onAbort);
      controller.abort(new Error("update scheduler wait completed"));
    }
  }

  async function runLegacy(signal: AbortSignal, cycle?: MarketplaceUpdateSchedulerCycle): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const observedWake = wakeGeneration;
      let degraded = false;
      try {
        await dependencies.refresh.refresh({ trigger: "scheduled", scope: "all-current" }, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        degraded = true;
      }
      let maintenanceAt: number | undefined;
      try {
        maintenanceAt = await cycle?.(signal) ?? undefined;
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        degraded = true;
      }
      const scheduledAt = await dependencies.refresh.nextScheduledAt(signal).catch(() => undefined);
      const now = dependencies.clock.nowEpochMilliseconds();
      const deadline = minimumDeadline(scheduledAt, maintenanceAt);
      projection.publish({ state: degraded ? "degraded" : "running", scopes: [] });
      const untilDue = deadline === undefined ? inventoryPollMs : Math.max(1, deadline - now);
      await wait(Math.min(inventoryPollMs, untilDue), observedWake, signal);
    }
  }

  const scheduler: MarketplaceUpdateScheduler = Object.freeze({
    async run(signal: AbortSignal, cycle?: MarketplaceUpdateSchedulerCycle): Promise<void> {
      if (signal === null || typeof signal !== "object") throw new TypeError("scheduler signal is required");
      if (running) throw new Error("marketplace update scheduler is already running");
      running = true;
      if (dependencies.leases === undefined || dependencies.leaseIds === undefined) {
        try { await runLegacy(signal, cycle); }
        finally {
          running = false;
          projection.publish({ state: "stopped", scopes: projection.snapshot().scopes.map((entry) => ({ ...entry, ownership: "none" })) });
        }
        return;
      }
      const owner = await dependencies.leaseIds.create(signal);
      const renewalLeadMs = Math.min(inventoryPollMs, Math.floor(leaseMs / 2));
      const owned = new Map<string, { context: import("../domain/state/scope.js").ScopeContext; scope: ScopeReference; renewAt: number }>();
      try {
        for (;;) {
          signal.throwIfAborted();
          const observedWake = wakeGeneration;
          const now = dependencies.clock.nowEpochMilliseconds();
          let inventory;
          try {
            inventory = await dependencies.leases.inventory(signal);
          } catch (error) {
            if (signal.aborted) throw signal.reason ?? error;
            projection.publish({ state: "degraded", scopes: projection.snapshot().scopes });
            await wait(inventoryPollMs, observedWake, signal);
            continue;
          }
          const scopeStatuses: Array<{ scope: ScopeReference; ownership: "self" | "other" | "none"; nextAt?: number }> = [];
          let clockRegressed = false;
          let anyEnabled = false;
          let anyOwned = false;
          let earliestRefresh: number | undefined;
          let degraded = !inventory.complete;
          for (const plan of inventory.plans) {
            const key = JSON.stringify(plan.scope);
            if (!plan.enabled) {
              if (owned.has(key)) {
                const previous = owned.get(key)!;
                await dependencies.leases.release(previous.context, owner, new AbortController().signal).catch(() => undefined);
                owned.delete(key);
              }
              scopeStatuses.push({ scope: plan.scope, ownership: "none", ...(plan.dueAt === undefined ? {} : { nextAt: plan.dueAt }) });
              continue;
            }
            anyEnabled = true;
            const previous = owned.get(key);
            // A wake is a prompt to re-evaluate work, not a reason to rewrite
            // an otherwise healthy lease. Avoiding eager renewal prevents
            // foreground identity reads from being invalidated by operational
            // scheduler churn while still renewing with a bounded safety lead.
            const ownership = previous !== undefined && now < previous.renewAt
              ? "self" as const
              : previous !== undefined
                ? await dependencies.leases.renew(plan.context, owner, now, leaseMs, signal).then((value) => value ? "self" as const : "other" as const)
                : await dependencies.leases.acquire(plan.context, owner, now, leaseMs, signal);
            if (ownership === "self") {
              owned.set(key, {
                context: plan.context,
                scope: plan.scope,
                renewAt: previous !== undefined && now < previous.renewAt
                  ? previous.renewAt
                  : now + leaseMs - renewalLeadMs,
              });
              anyOwned = true;
              if (plan.clock === "regressed") clockRegressed = true;
              else if ((plan.dueAt ?? 0) <= now && plan.registrationIds.length > 0) {
                try {
                  if (dependencies.refresh.refreshScheduled !== undefined) {
                    await dependencies.refresh.refreshScheduled({ scope: plan.context, registrationIds: plan.registrationIds, leaseId: owner }, signal);
                  } else {
                    await dependencies.refresh.refresh({ trigger: "scheduled", scope: plan.scope.kind, registrationIds: plan.registrationIds }, signal);
                  }
                } catch (error) {
                  if (signal.aborted) throw signal.reason ?? error;
                  degraded = true;
                }
              }
              if (plan.dueAt !== undefined && plan.dueAt > now) earliestRefresh = minimumDeadline(earliestRefresh, plan.dueAt);
            } else {
              owned.delete(key);
              if (ownership === "unavailable") degraded = true;
            }
            scopeStatuses.push({
              scope: plan.scope,
              ownership: ownership === "unavailable" ? "none" : ownership,
              ...(plan.dueAt === undefined ? {} : { nextAt: plan.dueAt }),
            });
          }
          // Maintenance runs on every wake, including paused cadence. A refresh
          // merely supplies new durable notices before this ordered cycle.
          let maintenanceAt: number | undefined;
          try {
            maintenanceAt = await cycle?.(signal) ?? undefined;
          } catch (error) {
            if (signal.aborted) throw signal.reason ?? error;
            degraded = true;
          }
          projection.publish({
            state: degraded ? "degraded" : !anyEnabled ? "disabled" : clockRegressed ? "clock-regressed" : anyOwned ? "running" : "standby",
            scopes: scopeStatuses,
          });
          const deadline = minimumDeadline(earliestRefresh, maintenanceAt);
          const dueWait = deadline === undefined ? inventoryPollMs : Math.max(1, deadline - dependencies.clock.nowEpochMilliseconds());
          await wait(Math.min(inventoryPollMs, dueWait), observedWake, signal);
        }
      } finally {
        const cleanupSignal = new AbortController().signal;
        await Promise.all([...owned.values()].map((entry) => dependencies.leases!.release(entry.context, owner as UpdateSchedulerLeaseId, cleanupSignal).catch(() => undefined)));
        running = false;
        projection.publish({ state: "stopped", scopes: projection.snapshot().scopes.map((entry) => ({ ...entry, ownership: "none" })) });
      }
    },
    status: projection.status.bind(projection),
    wake,
  });
  return scheduler;
}

export { DEFAULT_INVENTORY_POLL_MS, DEFAULT_LEASE_MS };
