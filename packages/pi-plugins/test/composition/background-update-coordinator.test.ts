import { describe, expect, it } from "vitest";
import { createBackgroundUpdateCoordinator } from "../../src/composition/background-update-coordinator.js";
import { createHostStatusService } from "../../src/composition/host-status-service.js";
import { createUpdateSchedulerStatusProjection } from "../../src/application/update-scheduler-status.js";

const startup = {
  status: "ready" as const, blocked: [],
  capabilities: {
    mcp: { status: "unavailable" as const, explanation: "optional" }, subagents: { status: "unavailable" as const, explanation: "optional" },
    piReload: { status: "available" as const, explanation: "available" }, secrets: { status: "unavailable" as const, explanation: "optional" },
  },
};

function statusFixture() {
  const schedulerStatus = createUpdateSchedulerStatusProjection();
  return { schedulerStatus, status: createHostStatusService({ startup, schedulerStatus }) };
}

describe("background update coordinator", () => {
  it("starts the sole maintenance owner even while refresh cadence is disabled", async () => {
    let runs = 0;
    const controllerSettled: Promise<void>[] = [];
    const { schedulerStatus, status } = statusFixture();
    const coordinator = createBackgroundUpdateCoordinator({
      scheduler: {
        async run(signal) {
          runs += 1;
          schedulerStatus.publish({ state: "disabled", scopes: [] });
          controllerSettled.push(new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })));
          await controllerSettled[0];
          schedulerStatus.publish({ state: "stopped", scopes: [] });
        },
        status: schedulerStatus.status.bind(schedulerStatus),
        wake() {},
      },
      schedulerStatus,
      status,
    });
    await coordinator.start();
    expect(runs).toBe(1);
    expect(status.snapshot().update.state).toBe("disabled");
    await coordinator.close();
  });

  it("wakes the already-running owner after local authority changes", async () => {
    let wakes = 0;
    const { schedulerStatus, status } = statusFixture();
    const coordinator = createBackgroundUpdateCoordinator({
      scheduler: {
        async run(signal) { await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })); },
        status: schedulerStatus.status.bind(schedulerStatus),
        wake() { wakes += 1; },
      },
      schedulerStatus,
      status,
    });
    await coordinator.start();
    coordinator.wake();
    coordinator.wake();
    expect(wakes).toBe(2);
    await coordinator.close();
  });

  it("orders reconciliation, automatic evaluation, then publication on each scheduler wake", async () => {
    const calls: string[] = [];
    const { schedulerStatus, status } = statusFixture();
    const coordinator = createBackgroundUpdateCoordinator({
      scheduler: {
        async run(signal, cycle) {
          schedulerStatus.publish({ state: "running", scopes: [] });
          await cycle?.(signal);
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          schedulerStatus.publish({ state: "stopped", scopes: [] });
        },
        status: schedulerStatus.status.bind(schedulerStatus),
        wake() {},
      },
      schedulerStatus,
      notifications: {
        async reconcile() { calls.push("reconcile"); return { resolved: [], pruned: 0, unreadCount: 2, unresolvedCount: 3 }; },
        async dispatch() { calls.push("dispatch"); return { published: [], pending: 0, failed: 0 }; },
        async list() { return { notices: [], unreadCount: 2, unresolvedCount: 3 }; },
      } as never,
      automatic: {
        async run() { calls.push("automatic"); return { outcomes: [] }; },
        async nextRetryAt() { return 5_000; },
      } as never,
      status,
    });
    await coordinator.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await coordinator.close();
    expect(calls).toEqual(["reconcile", "automatic", "dispatch"]);
    expect(status.snapshot().update).toMatchObject({ unreadCount: 2, unresolvedCount: 3 });
  });

  it("captures detached publisher failures in mutable host status", async () => {
    const { schedulerStatus, status } = statusFixture();
    const coordinator = createBackgroundUpdateCoordinator({
      scheduler: {
        async run(signal, cycle) { await cycle?.(signal); },
        status: schedulerStatus.status.bind(schedulerStatus), wake() {},
      },
      schedulerStatus,
      notifications: {
        async reconcile() { return { resolved: [], pruned: 0, unreadCount: 0, unresolvedCount: 1 }; },
        async dispatch() { throw new Error("publisher unavailable"); },
        async list() { return { notices: [], unreadCount: 0, unresolvedCount: 1 }; },
      } as never,
      status,
    });
    await coordinator.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(status.snapshot()).toMatchObject({ status: "degraded", update: { state: "degraded" } });
    await coordinator.close();
  });

  it("returns startup immediately when a publisher hangs and drains on close after abort", async () => {
    const { schedulerStatus, status } = statusFixture();
    let maintenanceStarted = false;
    const coordinator = createBackgroundUpdateCoordinator({
      scheduler: {
        async run(signal, cycle) {
          schedulerStatus.publish({ state: "running", scopes: [] });
          await cycle?.(signal);
        },
        status: schedulerStatus.status.bind(schedulerStatus),
        wake() {},
      },
      schedulerStatus,
      notifications: {
        async reconcile() { maintenanceStarted = true; return { resolved: [], pruned: 0, unreadCount: 0, unresolvedCount: 1 }; },
        async dispatch(_request: unknown, signal: AbortSignal) { await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); throw new Error("unreachable"); },
        async list() { return { notices: [], unreadCount: 0, unresolvedCount: 1 }; },
      } as never,
      status,
    });
    await expect(coordinator.start()).resolves.toBeUndefined();
    expect(maintenanceStarted).toBe(true);
    await coordinator.close();
  });
});
