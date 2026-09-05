import { describe, expect, it, vi } from "vitest";

import { DistillerController } from "../src/controller.js";

const result = { processed: 0, notesChanged: 0, digest: "current" as const, errors: [] };

describe("DistillerController", () => {
  it("revokes stale reporting and serializes replacement passes", async () => {
    const controller = new DistillerController();
    const reports = vi.fn();
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const first = controller.start(async (signal) => {
      markStarted();
      await new Promise<void>((resolve) => { release = resolve; });
      expect(signal.aborted).toBe(true);
      return { ...result, errors: ["late"] };
    }, reports);
    await started;
    const secondTask = vi.fn(async () => result);
    const second = controller.start(secondTask, reports);
    expect(secondTask).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(secondTask).toHaveBeenCalledTimes(1);
    expect(reports).not.toHaveBeenCalled();
    expect(controller.status().state).toBe("completed");
  });

  it("contains a throwing reporter", async () => {
    const controller = new DistillerController();
    await expect(controller.start(async () => ({ ...result, errors: ["failure"] }), () => {
      throw new Error("stale UI");
    })).resolves.toBeUndefined();
    expect(controller.status().state).toBe("completed");
  });
});
