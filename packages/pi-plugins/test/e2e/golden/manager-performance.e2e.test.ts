import { afterEach, describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { cleanupSandbox, createCleanE2ESandbox, type CleanE2ESandbox } from "../harness/environment.js";
import { seedRemoteMarketplace } from "../harness/journey.js";
import { PiPtyProcess } from "../harness/pi-pty.js";
import { diagnosePtyCapability } from "../harness/faults.js";

let sandbox: CleanE2ESandbox | undefined;
afterEach(async (context) => {
  if (sandbox !== undefined) await cleanupSandbox(sandbox, context);
  sandbox = undefined;
});

const timings: Record<string, number> = {};

async function step(label: string, run: () => Promise<unknown>): Promise<void> {
  const start = performance.now();
  await run();
  timings[label] = Math.round(performance.now() - start);
}

describe("plugin manager step latency through the real PTY", () => {
  it("times open, detail, and every install step", async () => {
    sandbox = await createCleanE2ESandbox("manager-performance");
    const ptyCapability = await diagnosePtyCapability(sandbox);
    if (!ptyCapability.available) {
      expect(ptyCapability.reason).toContain("util-linux PTY capability missing");
      return;
    }
    const journey = await seedRemoteMarketplace(sandbox);
    await journey.rpc.shutdown();

    const pty = await PiPtyProcess.start({ sandbox, columns: 120, rows: 30 });
    try {
      await pty.waitFor("clear/exit", 0, 60_000);
      let mark = pty.mark();
      pty.send("/plugin\r");
      await step("open manager", () => pty.waitFor("Plugins", mark, 60_000));
      await step("manager rows ready", () => pty.waitFor("core-local", mark, 60_000));

      mark = pty.mark();
      pty.send("\r");
      await step("open detail", () => pty.waitFor("Runtime surface", mark, 60_000));

      mark = pty.mark();
      pty.send("\r");
      await pty.waitFor("Add plugin to", mark, 60_000);
      pty.send("\r");
      await step("install session open", () => pty.waitFor("Step 1/2 · Configure and add", mark, 60_000));

      pty.send("\r");
      await pty.waitFor("editing", mark, 60_000);
      pty.send("e2e-value\r");
      await pty.waitFor("set: e2e-value", mark, 60_000);
      mark = pty.mark();
      pty.send("\u001b[B\u001b[B\u001b[B\r");
      await step("install.apply (add)", () => pty.waitFor("Added core-local", mark, 120_000));
      expect(pty.semanticOutput().slice(mark)).toContain("session reloaded");
    } finally {
      await writeFile("/tmp/pi-manager-pty-perf.json", JSON.stringify(timings, null, 2), "utf8");
      await pty.shutdown();
    }
    // Perf gates: no interactive step may feel like "multiple seconds".
    expect(timings["open manager"]).toBeLessThan(5_000);
    expect(timings["manager rows ready"]).toBeLessThan(5_000);
    expect(timings["open detail"]).toBeLessThan(3_000);
    expect(timings["install session open"]).toBeLessThan(10_000);
  }, 300_000);
});
