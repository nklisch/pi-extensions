import { afterEach, describe, expect, it, vi } from "vitest";
import { clearFailure, getFailureAgeSeconds, getFailureMessage, recordFailure } from "../init.ts";
import { logger } from "../logger.ts";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";

describe("MCP failure state", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("bounds messages and removes diagnostics after the backoff TTL", () => {
    vi.useFakeTimers();
    const state = {
      owner: { isActive: () => true },
      failureTracker: new Map<string, number>(),
      failureMessages: new Map<string, string>(),
    } as any;

    recordFailure(state, "demo", "x".repeat(100_000));

    expect(state.failureMessages.get("demo")).toHaveLength(8 * 1024);
    expect(getFailureAgeSeconds(state, "demo")).toBe(0);
    expect(getFailureMessage(state, "demo")).toHaveLength(8 * 1024);

    vi.advanceTimersByTime(60_000);

    expect(state.failureTracker.has("demo")).toBe(false);
    expect(state.failureMessages.has("demo")).toBe(false);
    expect(getFailureAgeSeconds(state, "demo")).toBeNull();
  });

  it("clears a prior expiry timer when a failure recovers", () => {
    vi.useFakeTimers();
    const state = {
      owner: { isActive: () => true },
      failureTracker: new Map<string, number>(),
      failureMessages: new Map<string, string>(),
    } as any;

    recordFailure(state, "demo", "failed");
    clearFailure(state, "demo");
    vi.advanceTimersByTime(60_000);

    expect(state.failureTracker.size).toBe(0);
    expect(state.failureMessages.size).toBe(0);
  });

  it("does not publish failure expiry after the runtime owner stops", async () => {
    vi.useFakeTimers();
    const owner = createMcpRuntimeOwner();
    const state = {
      owner,
      failureTracker: new Map<string, number>(),
      failureMessages: new Map<string, string>(),
      statusEvents: { emit: vi.fn() },
    } as any;

    recordFailure(state, "demo", "failed");
    await owner.stop("session shutdown");
    vi.advanceTimersByTime(60_000);

    expect(state.statusEvents.emit).not.toHaveBeenCalled();
  });

  it("contains a throwing observer inside the detached expiry timer", () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const state = {
      owner: {
        isActive: () => {
          throw new Error("observer exploded");
        },
      },
      failureTracker: new Map<string, number>(),
      failureMessages: new Map<string, string>(),
    } as any;

    recordFailure(state, "demo", "failed");

    // A throw escaping the timer callback would fail this assertion outright.
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("failure expiry"));
    // The throw happened before expiry deletion, so the failure entry survives.
    expect(state.failureTracker.has("demo")).toBe(true);
  });
});
