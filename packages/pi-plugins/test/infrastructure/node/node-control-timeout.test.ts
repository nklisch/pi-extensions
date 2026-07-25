import { describe, expect, it, vi } from "vitest";
import { createNodeControlTimeoutPort } from "../../../src/infrastructure/node/node-control-timeout.js";

describe("node control timeout", () => {
  it("propagates parent abort and disposes idempotently", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const armed = createNodeControlTimeoutPort().arm(100, parent.signal);
    parent.abort(new Error("caller"));
    expect(armed.signal.aborted).toBe(true);
    armed.dispose(); armed.dispose();
    vi.useRealTimers();
  });

  it("aborts at the requested deadline", () => {
    vi.useFakeTimers();
    const armed = createNodeControlTimeoutPort().arm(100, new AbortController().signal);
    vi.advanceTimersByTime(100);
    expect(armed.signal.aborted).toBe(true);
    armed.dispose();
    vi.useRealTimers();
  });
});
