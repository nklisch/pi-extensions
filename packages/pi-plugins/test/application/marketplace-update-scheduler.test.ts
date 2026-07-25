import { describe, expect, it } from "vitest";
import { createMarketplaceUpdateScheduler } from "../../src/application/marketplace-update-scheduler.js";
import { createNodeMarketplaceRefreshServices } from "../../src/composition/create-marketplace-refresh-services.js";
import { createNodeMarketplaceUpdateServices } from "../../src/composition/create-marketplace-update-services.js";
import type { MarketplaceRefreshServiceDependencies } from "../../src/application/marketplace-refresh-service.js";
import type { MarketplaceRefreshService } from "../../src/application/marketplace-refresh-service.js";
import type { UpdateDelayPort } from "../../src/application/ports/update-delay.js";

function refreshStub(next: () => number | undefined, calls: { refresh: number; next: number }): MarketplaceRefreshService {
  return {
    async refresh() { calls.refresh += 1; return { outcomes: [], notifications: [] }; },
    async nextScheduledAt() { calls.next += 1; return next(); },
  };
}

describe("marketplace update scheduler", () => {
  it("does not start work until run and performs an immediate scheduled pass", async () => {
    const calls = { refresh: 0, next: 0 };
    let waits = 0;
    const controller = new AbortController();
    const delay: UpdateDelayPort = {
      async wait() {
        waits += 1;
        controller.abort();
        throw controller.signal.reason;
      },
    };
    const scheduler = createMarketplaceUpdateScheduler({
      refresh: refreshStub(() => 10_000, calls),
      clock: { nowEpochMilliseconds: () => 9_000 },
      delay,
      inventoryPollMs: 15_000,
    });

    expect(calls).toEqual({ refresh: 0, next: 0 });
    await expect(scheduler.run(controller.signal)).rejects.toBeDefined();
    expect(calls).toEqual({ refresh: 1, next: 1 });
    expect(waits).toBe(1);
  });

  it("caps waits at the inventory ceiling and never reports abort as success", async () => {
    const controller = new AbortController();
    const waits: number[] = [];
    const delay: UpdateDelayPort = {
      async wait(milliseconds) {
        waits.push(milliseconds);
        controller.abort();
        throw controller.signal.reason;
      },
    };
    const scheduler = createMarketplaceUpdateScheduler({
      refresh: refreshStub(() => Number.MAX_SAFE_INTEGER, { refresh: 0, next: 0 }),
      clock: { nowEpochMilliseconds: () => 0 },
      delay,
      inventoryPollMs: 900_000,
    });

    await expect(scheduler.run(controller.signal)).rejects.toBeDefined();
    expect(waits).toEqual([900_000]);
  });

  it("propagates cancellation from the refresh pass without scheduling another pass", async () => {
    const controller = new AbortController();
    let nextCalls = 0;
    const refresh: MarketplaceRefreshService = {
      async refresh(_request, signal) {
        controller.abort(new Error("cancelled during refresh"));
        signal.throwIfAborted();
        return { outcomes: [], notifications: [] };
      },
      async nextScheduledAt() { nextCalls += 1; return undefined; },
    };
    const scheduler = createMarketplaceUpdateScheduler({
      refresh,
      clock: { nowEpochMilliseconds: () => 0 },
      delay: { async wait() { throw new Error("delay must not run"); } },
    });

    await expect(scheduler.run(controller.signal)).rejects.toThrow("cancelled during refresh");
    expect(nextCalls).toBe(0);
  });

  it("continues after a non-abort refresh failure and still stops on a later abort", async () => {
    const controller = new AbortController();
    let refreshes = 0;
    let waits = 0;
    const refresh: MarketplaceRefreshService = {
      async refresh(_request, signal) {
        refreshes += 1;
        if (refreshes === 1) throw new Error("one marketplace failed");
        controller.abort(new Error("stop after retry"));
        signal.throwIfAborted();
        return { outcomes: [], notifications: [] };
      },
      async nextScheduledAt() { return undefined; },
    };
    const scheduler = createMarketplaceUpdateScheduler({
      refresh,
      clock: { nowEpochMilliseconds: () => 0 },
      delay: { async wait() { waits += 1; } },
      inventoryPollMs: 1,
    });

    await expect(scheduler.run(controller.signal)).rejects.toThrow("stop after retry");
    expect(refreshes).toBe(2);
    expect(waits).toBe(1);
  });

  it("runs maintenance while cadence is paused and sleeps to automatic retry deadline", async () => {
    const controller = new AbortController();
    const waits: number[] = [];
    let cycles = 0;
    const scheduler = createMarketplaceUpdateScheduler({
      refresh: refreshStub(() => undefined, { refresh: 0, next: 0 }),
      leases: {
        async inventory() { return { plans: [{ context: { kind: "user" }, scope: { kind: "user" }, registrationIds: [], enabled: false, clock: "current" as const }], complete: true }; },
        async acquire() { return "self" as const; }, async renew() { return true; }, async release() {}, async validate() { return true; },
      },
      leaseIds: { async create() { return `update-scheduler-lease-v1:uuid:123e4567-e89b-42d3-a456-426614174000` as never; } },
      clock: { nowEpochMilliseconds: () => 100 },
      delay: { async wait(milliseconds) { waits.push(milliseconds); controller.abort(new Error("done")); throw controller.signal.reason; } },
      inventoryPollMs: 1_000, leaseMs: 2_000,
    });
    await expect(scheduler.run(controller.signal, async () => { cycles += 1; return 250; })).rejects.toThrow("done");
    expect(cycles).toBe(1);
    expect(waits).toEqual([150]);
  });

  it("constructs both Node compositions without starting work", () => {
    let calls = 0;
    const dependencies = {
      inventory: { async discover() { calls += 1; return { scopes: [], complete: true }; } },
      state: { async read() { calls += 1; throw new Error("state must not be read"); } },
      mutations: { async runPreparedMutation() { calls += 1; throw new Error("mutation must not run"); } },
      clock: {
        nowEpochMilliseconds: () => { calls += 1; return 0; },
        monotonicMilliseconds: () => { calls += 1; return 0; },
      },
      claimIds: { async create() { calls += 1; throw new Error("claim must not be created"); } },
      materializers: { marketplaces: { async materialize() { calls += 1; throw new Error("materializer must not run"); } } },
      inspection: { async inspect() { calls += 1; throw new Error("inspection must not run"); } },
      content: {},
      sha256: () => { calls += 1; return new Uint8Array(32); },
    } as unknown as MarketplaceRefreshServiceDependencies;
    const delay: UpdateDelayPort = { async wait() { calls += 1; } };
    const options = { refresh: dependencies, delay };

    const refreshServices = createNodeMarketplaceRefreshServices(options);
    const updateServices = createNodeMarketplaceUpdateServices(options);
    for (const services of [refreshServices, updateServices]) {
      expect(Object.isFrozen(services)).toBe(true);
      expect(Object.keys(services)).toEqual(["refresh", "policy", "scheduler", "schedulerStatus"]);
      expect(services.refresh).toBeDefined();
      expect(services.policy).toBeDefined();
      expect(services.scheduler).toBeDefined();
    }
    expect(calls).toBe(0);
  });

  it("honors an already-aborted signal without refreshing", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const calls = { refresh: 0, next: 0 };
    const scheduler = createMarketplaceUpdateScheduler({
      refresh: refreshStub(() => undefined, calls),
      clock: { nowEpochMilliseconds: () => 0 },
      delay: { async wait() {} },
    });

    await expect(scheduler.run(controller.signal)).rejects.toThrow("cancelled");
    expect(calls).toEqual({ refresh: 0, next: 0 });
  });
});
