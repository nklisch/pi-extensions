import { describe, expect, it, vi } from "vitest";
import { RunListeners } from "#src/lifecycle/run-listeners";

describe("RunListeners — attachObserver / release", () => {
  it("calls the unsub handle on release", () => {
    const listeners = new RunListeners();
    const unsub = vi.fn();
    listeners.attachObserver(unsub);
    listeners.release();
    expect(unsub).toHaveBeenCalledOnce();
  });

  it("clears the handle so a second release does not double-call", () => {
    const listeners = new RunListeners();
    const unsub = vi.fn();
    listeners.attachObserver(unsub);
    listeners.release();
    listeners.release();
    expect(unsub).toHaveBeenCalledOnce();
  });

  it("release is idempotent with no handles attached", () => {
    const listeners = new RunListeners();
    expect(() => {
      listeners.release();
      listeners.release();
    }).not.toThrow();
  });
});
