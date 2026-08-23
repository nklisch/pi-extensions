import { describe, expect, test } from "bun:test";
import { createGenerationGuardedFinderLifecycle, type FinderLike } from "./finder-lifecycle";

type FakeFinder = FinderLike & { destroyCalls: number };

function fakeFinder(): FakeFinder {
  const finder: FakeFinder = {
    isDestroyed: false,
    destroyCalls: 0,
    destroy() {
      finder.destroyCalls++;
      finder.isDestroyed = true;
    },
  };
  return finder;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("generation-guarded finder lifecycle", () => {
  test("does not install a finder that completes after revocation", async () => {
    const firstReady = deferred<FakeFinder>();
    const first = fakeFinder();
    const replacement = fakeFinder();
    const lifecycle = createGenerationGuardedFinderLifecycle(async (cwd) => {
      if (cwd === "/first") return firstReady.promise;
      return replacement;
    });

    const firstPromise = lifecycle.ensure("/first");
    lifecycle.revoke();
    const replacementPromise = lifecycle.ensure("/replacement");
    expect(await replacementPromise).toBe(replacement);

    firstReady.resolve(first);
    await expect(firstPromise).rejects.toThrow("initialization was revoked");
    expect(first.destroyCalls).toBe(1);
    expect(await lifecycle.ensure("/replacement")).toBe(replacement);
  });

  test("contains a throwing stale-finder cleanup and keeps the replacement", async () => {
    const firstReady = deferred<FakeFinder>();
    const first = fakeFinder();
    first.destroy = () => {
      first.destroyCalls++;
      throw new Error("destroy failed");
    };
    const replacement = fakeFinder();
    const lifecycle = createGenerationGuardedFinderLifecycle(async (cwd) =>
      cwd === "/first" ? firstReady.promise : replacement);

    const firstPromise = lifecycle.ensure("/first");
    lifecycle.revoke();
    expect(await lifecycle.ensure("/replacement")).toBe(replacement);

    firstReady.resolve(first);
    await expect(firstPromise).rejects.toThrow("initialization was revoked");
    expect(first.destroyCalls).toBe(1);
    expect(await lifecycle.ensure("/replacement")).toBe(replacement);
  });

  test("clears a rejected initialization so the same workspace can retry", async () => {
    const replacement = fakeFinder();
    let calls = 0;
    const lifecycle = createGenerationGuardedFinderLifecycle(async () => {
      calls++;
      if (calls === 1) throw new Error("scan failed");
      return replacement;
    });

    await expect(lifecycle.ensure("/workspace")).rejects.toThrow("scan failed");
    expect(await lifecycle.ensure("/workspace")).toBe(replacement);
    expect(calls).toBe(2);
  });

  test("shares one initialization and keeps a replacement after an old completion", async () => {
    const ready = deferred<FakeFinder>();
    const old = fakeFinder();
    const current = fakeFinder();
    let calls = 0;
    const lifecycle = createGenerationGuardedFinderLifecycle(async () => {
      calls++;
      return calls === 1 ? ready.promise : current;
    });

    const first = lifecycle.ensure("/workspace");
    expect(lifecycle.ensure("/workspace")).toBe(first);

    lifecycle.revoke();
    const replacement = lifecycle.ensure("/workspace");
    expect(await replacement).toBe(current);

    ready.resolve(old);
    await expect(first).rejects.toThrow("initialization was revoked");
    expect(old.destroyCalls).toBe(1);
    expect(await lifecycle.ensure("/workspace")).toBe(current);
  });
});
