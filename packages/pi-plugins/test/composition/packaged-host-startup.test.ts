import { describe, expect, it } from "vitest";
import { createPackagedHostStartup } from "../../src/composition/packaged-host-startup.js";

const capabilities = {
  mcp: { status: "unavailable" as const, explanation: "optional" },
  subagents: { status: "unavailable" as const, explanation: "optional" },
  piReload: { status: "available" as const, explanation: "available" },
  secrets: { status: "unavailable" as const, explanation: "optional" },
};

describe("explicit packaged host startup", () => {
  it("is construction inert and orders local reconciliation before convergence and background", async () => {
    const calls: string[] = [];
    const startup = createPackagedHostStartup({
      async open() { calls.push("open"); },
      async capabilities() { calls.push("capabilities"); return capabilities; },
      async converge() { calls.push("convergence"); return { blocked: [] }; },
      async reconcile() { calls.push("reconcile"); return { blocked: [] }; },
      publish() { calls.push("status"); },
      async startBackground() { calls.push("background"); },
      async closeResources() { calls.push("close"); },
    });
    expect(calls).toEqual([]);
    await expect(startup.start(new AbortController().signal)).resolves.toMatchObject({ status: "ready" });
    expect(calls).toEqual(["open", "capabilities", "reconcile", "convergence", "status", "background"]);
    await startup.close();
  });

  it("returns local readiness before detached background adapters settle", async () => {
    let backgroundStarted = false;
    const startup = createPackagedHostStartup({
      async open() {}, async capabilities() { return capabilities; },
      async converge() { return { blocked: [] }; }, async reconcile() { return { blocked: [] }; },
      publish() {},
      async startBackground() {
        backgroundStarted = true;
        await new Promise<void>(() => undefined);
      },
      async closeResources() {},
    });
    await expect(startup.start(new AbortController().signal)).resolves.toMatchObject({ status: "ready" });
    expect(backgroundStarted).toBe(true);
  });

  it("publishes plugin-local convergence failure as degraded rather than host blocked", async () => {
    let published = false;
    const startup = createPackagedHostStartup({
      async open() {}, async capabilities() { return capabilities; },
      async converge() { return { blocked: [{ plugin: "demo@community", code: "PLUGIN_DEGRADED", explanation: "repair the selected revision" }] }; },
      async reconcile() { return { blocked: [] }; },
      publish() { published = true; }, async startBackground() {}, async closeResources() {},
    });
    await expect(startup.start(new AbortController().signal)).resolves.toMatchObject({ status: "degraded" });
    expect(published).toBe(true);
  });
});
