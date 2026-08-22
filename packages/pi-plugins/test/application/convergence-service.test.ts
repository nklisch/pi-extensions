import { describe, expect, it } from "vitest";
import { createConvergenceService } from "../../src/application/convergence-service.js";
import type { LifecycleStateStore } from "../../src/application/ports/lifecycle-state-store.js";
import type { PendingDeleteMarker, PendingDeleteMarkerStore } from "../../src/application/ports/pending-data-deletion.js";
import type { GenerationSnapshot } from "../../src/application/state-contract.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(32).fill(bytes.byteLength);
const scope = { kind: "user" as const };
function state(installed: readonly Readonly<{ plugin: string }>[] = []): LifecycleStateStore {
  const snapshot = {
    scope,
    generation: 0,
    installed: { plugins: installed.map((record) => ({ plugin: record.plugin, selectedRevision: "sha256:" + "0".repeat(64), revisions: [] })) },
    project: undefined,
  } as unknown as GenerationSnapshot;
  return { async read() { return { ok: true as const, snapshot }; }, async commit() { return { kind: "committed" as const, snapshot }; } };
}
function markers(values: readonly PendingDeleteMarker[]): PendingDeleteMarkerStore & { removed: PendingDeleteMarker[] } {
  const removed: PendingDeleteMarker[] = [];
  return { root: "/markers", removed, path: () => "/marker", async create() {}, async remove(value) { removed.push(value); }, async list() { return values; } };
}
const marker = (plugin: string, requestedAt: number): PendingDeleteMarker => ({ scope, plugin: plugin as never, dataRef: "plugin-data-v1:sha256:" + "a".repeat(64) as never, requestedAt });

describe("convergence service", () => {
  it("replays absent-plugin deletion and age-gates installed residue", async () => {
    const store = markers([
      marker("absent@catalog", Date.now()),
      marker("demo@catalog", Date.now()),
      marker("demo@catalog", Date.now() - 61 * 60_000),
    ]);
    const removed: string[] = [];
    const service = createConvergenceService({
      state: state([{ plugin: "demo@catalog" }]),
      pendingDeletes: store,
      dataRemoval: { async remove() { removed.push("deleted"); return "removed"; } },
      sha256,
    });
    const report = await service.sweep({ scopes: [scope] });
    expect(removed).toEqual(["deleted"]);
    expect(store.removed.map((value) => value.plugin)).toEqual(["absent@catalog", "demo@catalog"]);
    expect(report.processed).toBe(4);
    expect(report.results).toContainEqual(expect.objectContaining({ plugin: "demo@catalog", kind: "deferred" }));
  });

  it("bounds marker replay and reports remaining work for a later pass", async () => {
    const store = markers([marker("one@catalog", Date.now()), marker("two@catalog", Date.now())]);
    const removed: string[] = [];
    const service = createConvergenceService({
      state: state(),
      pendingDeletes: store,
      dataRemoval: { async remove(input) { removed.push(input.plugin); return "removed"; } },
      sha256,
      policy: { maxItems: 1 },
    });

    const report = await service.sweep({ scopes: [scope] });

    expect(removed).toEqual(["one@catalog"]);
    expect(store.removed).toHaveLength(1);
    expect(report.processed).toBe(1);
    expect(report.deferred).toBe(true);
    expect(report.results).toContainEqual(expect.objectContaining({ code: "BUDGET_EXHAUSTED" }));
  });

  it("does not create a state commit when there is nothing to prune", async () => {
    let commits = 0;
    const base = state();
    const wrapped: LifecycleStateStore = { ...base, async commit(...args) { commits += 1; return base.commit(...args); } };
    const service = createConvergenceService({ state: wrapped, pendingDeletes: markers([]), sha256 });
    await service.sweep({ scopes: [scope] });
    expect(commits).toBe(0);
  });
});
