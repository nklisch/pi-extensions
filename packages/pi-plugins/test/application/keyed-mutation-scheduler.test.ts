import { describe, expect, it } from "vitest";
import {
  createKeyedMutationScheduler,
  canonicalSubjectKey,
  RecursiveMutationAcquisitionError,
} from "../../src/infrastructure/state/keyed-mutation-scheduler.js";
import type { MutationSubject } from "../../src/application/mutation-coordination.js";
import type { ScopeReference } from "../../src/domain/state/scope.js";

const user: ScopeReference = { kind: "user" };
const project: ScopeReference = { kind: "project", projectKey: `project-v1:sha256:${"a".repeat(64)}` as never };
const subject = (plugin: string, scope: ScopeReference = user): MutationSubject => ({
  scope,
  plugin: `${plugin}@marketplace` as never,
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("scope-qualified keyed mutation scheduler", () => {
  it("serializes one subject in FIFO order and permits unrelated subjects to overlap", async () => {
    const scheduler = createKeyedMutationScheduler();
    const firstRelease = deferred();
    const unrelatedStarted = deferred();
    const events: string[] = [];

    const first = scheduler.run([subject("one")], async () => {
      events.push("one-start");
      await firstRelease.promise;
      events.push("one-end");
    }, new AbortController().signal);
    const second = scheduler.run([subject("one")], async () => {
      events.push("one-second");
    }, new AbortController().signal);
    const other = scheduler.run([subject("two")], async () => {
      events.push("two-start");
      unrelatedStarted.resolve();
    }, new AbortController().signal);

    await flush();
    await unrelatedStarted.promise;
    expect(events).toEqual(["one-start", "two-start"]);
    firstRelease.resolve();
    await Promise.all([first, second, other]);
    expect(events).toEqual(["one-start", "two-start", "one-end", "one-second"]);
  });

  it("uses one canonical order for opposite multi-key requests", async () => {
    const scheduler = createKeyedMutationScheduler();
    const entered: string[] = [];
    const firstRelease = deferred();
    const first = scheduler.run([subject("b"), subject("a")], async () => {
      entered.push("first");
      await firstRelease.promise;
    }, new AbortController().signal);
    const second = scheduler.run([subject("a"), subject("b")], async () => {
      entered.push("second");
    }, new AbortController().signal);

    await flush();
    expect(entered).toEqual(["first"]);
    firstRelease.resolve();
    await Promise.all([first, second]);
    expect(entered).toEqual(["first", "second"]);
  });

  it("separates user and project installations", async () => {
    const scheduler = createKeyedMutationScheduler();
    const userRelease = deferred();
    const projectStarted = deferred();
    const first = scheduler.run([subject("same", user)], async () => userRelease.promise, new AbortController().signal);
    const second = scheduler.run([subject("same", project)], async () => projectStarted.resolve(), new AbortController().signal);
    await projectStarted.promise;
    userRelease.resolve();
    await Promise.all([first, second]);
  });

  it("removes a cancelled waiter without invoking it and preserves its exact reason", async () => {
    const scheduler = createKeyedMutationScheduler();
    const controller = new AbortController();
    const reason = new Error("caller deadline");
    const release = deferred();
    const first = scheduler.run([subject("one")], async () => release.promise, new AbortController().signal);
    const work = scheduler.run([subject("one")], async () => {
      throw new Error("cancelled work ran");
    }, controller.signal);

    controller.abort(reason);
    await expect(work).rejects.toBe(reason);
    release.resolve();
    await first;
  });

  it("releases all keys after callback failure", async () => {
    const scheduler = createKeyedMutationScheduler();
    const nextStarted = deferred();
    const failure = new Error("callback failed");
    await expect(scheduler.run([subject("a"), subject("b")], async () => {
      throw failure;
    }, new AbortController().signal)).rejects.toBe(failure);
    await scheduler.run([subject("a"), subject("b")], async () => nextStarted.resolve(), new AbortController().signal);
    await nextStarted.promise;
  });

  it("rejects cross-scope and duplicate requests before work", async () => {
    const scheduler = createKeyedMutationScheduler();
    expect(() => scheduler.run([subject("a", user), subject("b", project)], async () => {}, new AbortController().signal)).toThrow(/one scope/);
    expect(() => scheduler.run([subject("a"), subject("a")], async () => {}, new AbortController().signal)).toThrow(/duplicate/);
  });

  it("rejects overlapping closure recursion synchronously instead of deadlocking", async () => {
    const scheduler = createKeyedMutationScheduler();
    let recursiveError: unknown;
    await scheduler.run([subject("a")], async () => {
      expect(() => scheduler.run([subject("a")], async () => {}, new AbortController().signal)).toThrowError(RecursiveMutationAcquisitionError);
      try {
        scheduler.run([subject("a")], async () => {}, new AbortController().signal);
      } catch (error) {
        recursiveError = error;
      }
    }, new AbortController().signal);
    expect(recursiveError).toBeInstanceOf(RecursiveMutationAcquisitionError);
    expect((recursiveError as RecursiveMutationAcquisitionError).code).toBe("RECURSIVE_MUTATION_ACQUISITION");
  });

  it("proves disjoint closure recursion safe by completing the nested request", async () => {
    const scheduler = createKeyedMutationScheduler();
    const events: string[] = [];
    await scheduler.run([subject("a")], async () => {
      events.push("outer-start");
      await scheduler.run([subject("b")], async () => {
        events.push("inner");
      }, new AbortController().signal);
      events.push("outer-end");
    }, new AbortController().signal);
    expect(events).toEqual(["outer-start", "inner", "outer-end"]);
  });

  it("uses an injective canonical key for distinct scope/plugin fields", () => {
    expect(canonicalSubjectKey(subject("a"))).not.toBe(canonicalSubjectKey(subject("aa")));
    expect(canonicalSubjectKey(subject("same", user))).not.toBe(canonicalSubjectKey(subject("same", project)));
  });
});
