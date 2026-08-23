import { describe, expect, it } from "vitest";
import { runScopedMutation } from "../../src/application/state-transaction.js";
import { parseStateMutation } from "../../src/application/state-contract.js";
import type { GenerationSnapshot } from "../../src/application/state-contract.js";
import type { LifecycleStateStore } from "../../src/application/ports/lifecycle-state-store.js";

const scope = { kind: "user" as const };
const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(32).fill(bytes.byteLength % 251);
const signal = new AbortController().signal;

function snapshot(generation: number): GenerationSnapshot {
  return { scope, generation, pointers: {} as never } as GenerationSnapshot;
}

function mutation(generation: number, multiDocument = false) {
  return parseStateMutation({
    scope,
    expectedGeneration: generation,
    replace: {
      config: { schemaVersion: 4, generation, records: [] },
      ...(multiDocument ? { trust: { schemaVersion: 1, generation, records: [] } } : {}),
    },
  }, sha256);
}

function storeFixture(options: Readonly<{ staleBeforeCommit?: number; busy?: boolean }> = {}): LifecycleStateStore & { commits: number; current: GenerationSnapshot } {
  let current = snapshot(0);
  let staleBeforeCommit = options.staleBeforeCommit ?? 0;
  let commits = 0;
  return {
    get current() { return current; },
    get commits() { return commits; },
    async read() { return { ok: true as const, snapshot: current }; },
    async commit(next) {
      commits += 1;
      if (options.busy) throw Object.assign(new Error("busy"), { errcode: 5 });
      if (staleBeforeCommit > 0) {
        staleBeforeCommit -= 1;
        current = snapshot(current.generation + 1);
        return { kind: "stale-generation" as const, expected: next.expectedGeneration, actual: current.generation };
      }
      current = snapshot(current.generation + 1);
      return { kind: "committed" as const, snapshot: current };
    },
  };
}

describe("runScopedMutation", () => {
  it("returns an exact stale conflict after four bounded re-plans", async () => {
    const store = storeFixture({ staleBeforeCommit: 4 });
    let plans = 0;
    const result = await runScopedMutation(store, scope, (current) => {
      plans += 1;
      return { kind: "commit", mutation: mutation(current.generation), value: plans };
    }, signal);
    expect(result).toMatchObject({ kind: "stale", expected: 3, actual: 4 });
    expect(plans).toBe(4);
    expect(store.commits).toBe(4);
  });

  it("re-plans after a stale CAS and commits the new snapshot", async () => {
    const store = storeFixture({ staleBeforeCommit: 2 });
    const result = await runScopedMutation(store, scope, (current) => ({
      kind: "commit",
      mutation: mutation(current.generation),
      value: current.generation,
    }), signal);
    expect(result).toMatchObject({ kind: "committed", value: 2, snapshot: { generation: 3 } });
    expect(store.commits).toBe(3);
  });

  it("passes a multi-document mutation through as one commit", async () => {
    const store = storeFixture();
    let passed: unknown;
    const result = await runScopedMutation(store, scope, (current) => {
      const next = mutation(current.generation, true);
      passed = next;
      return { kind: "commit", mutation: next, value: "both" };
    }, signal);
    expect(result).toMatchObject({ kind: "committed", value: "both" });
    expect(passed).toBeDefined();
    expect((passed as ReturnType<typeof mutation>).replace).toHaveProperty("trust");
    expect(store.commits).toBe(1);
  });

  it("maps busy exhaustion to a typed retryable result", async () => {
    const store = storeFixture({ busy: true });
    const result = await runScopedMutation(store, scope, (current) => ({
      kind: "commit",
      mutation: mutation(current.generation),
      value: undefined,
    }), signal);
    expect(result).toEqual({ kind: "retryable", code: "BUSY", attempts: 1, reason: "another session is mid-write, retry" });
  });

  it("runs authority recheck before the commit call", async () => {
    const store = storeFixture();
    const events: string[] = [];
    const result = await runScopedMutation(store, scope, (current) => {
      events.push("plan");
      return { kind: "commit", mutation: mutation(current.generation), value: undefined };
    }, signal, async () => {
      events.push("recheck");
    });
    expect(result.kind).toBe("committed");
    expect(events).toEqual(["plan", "recheck"]);
  });
});
