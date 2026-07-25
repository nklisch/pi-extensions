import { describe, expect, it } from "vitest";
import { disposeSequentially } from "../../src/composition/sequential-cleanup.js";

describe("sequential cleanup", () => {
  it("captures a direct synchronous throw and continues cleanup", async () => {
    const events: string[] = [];
    const failure = new Error("synchronous failure");

    const cleanup = disposeSequentially([
      () => {
        events.push("first");
        throw failure;
      },
      () => { events.push("second"); },
    ], "cleanup failed");

    const rejection = await cleanup.catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).message).toBe("cleanup failed");
    expect((rejection as AggregateError).errors[0]).toBe(failure);
    expect(events).toEqual(["first", "second"]);
  });

  it("captures an asynchronous rejection and continues cleanup", async () => {
    const events: string[] = [];
    const failure = new Error("asynchronous failure");

    const cleanup = disposeSequentially([
      () => {
        events.push("first");
        return Promise.reject(failure);
      },
      () => { events.push("second"); },
    ], "cleanup failed");

    const rejection = await cleanup.catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).message).toBe("cleanup failed");
    expect((rejection as AggregateError).errors[0]).toBe(failure);
    expect(events).toEqual(["first", "second"]);
  });

  it("attempts every disposer serially and preserves ordered failures", async () => {
    const events: string[] = [];
    const firstError = new Error("first failure");
    const secondError = new Error("second failure");
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const cleanup = disposeSequentially([
      async () => {
        events.push("first:start");
        await firstMayFinish;
        events.push("first:end");
        throw firstError;
      },
      async () => {
        events.push("second");
        throw secondError;
      },
      () => { events.push("third"); },
    ], "cleanup failed");

    expect(events).toEqual(["first:start"]);
    releaseFirst();

    let rejection: unknown;
    try {
      await cleanup;
    } catch (error) {
      rejection = error;
    }

    expect(events).toEqual(["first:start", "first:end", "second", "third"]);
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).message).toBe("cleanup failed");
    expect((rejection as AggregateError).errors).toHaveLength(2);
    expect((rejection as AggregateError).errors[0]).toBe(firstError);
    expect((rejection as AggregateError).errors[1]).toBe(secondError);
  });
});
