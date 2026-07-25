import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPackagedPluginHost } from "../../src/composition/create-packaged-plugin-host.js";
import { extensionContext, fakePi } from "../helpers/packaged-marketplace.js";

describe("packaged native inspection in a clean environment", () => {
  it("lists and diagnoses offline without optional runtime packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-native-inspection-clean-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(project)]);
    const context = extensionContext(project, true, "native-inspection-clean");
    const host = createPackagedPluginHost({ pi: fakePi().api as never, agentDir });
    try {
      const started = await host.start({ type: "session_start", reason: "startup" } as never, context as never);
      expect(Object.keys(started.application)).toEqual(["control"]);
      expect(started.application).not.toHaveProperty("inspection");
      const signal = new AbortController().signal;
      const pageEnvelope = await host.runWithPiOperationContext(context as never, signal, (application) =>
        application.control.runArgv(["list", "--scope", "all-current"], { mode: "direct", output: "json" }, signal));
      const page = pageEnvelope.envelope.data as any;
      expect(page.items).toEqual([]);
      expect(page.condition).toBe("ready");
      expect(page.observations.every((observation: any) => observation.status === "ready")).toBe(true);
      const reportEnvelope = await host.runWithPiOperationContext(context as never, signal, (application) =>
        application.control.runArgv(["diagnose"], { mode: "direct", output: "json" }, signal));
      const report = reportEnvelope.envelope.data as any;
      expect(report.condition).toBe("ready");
      expect(report.diagnostics).toEqual([]);
    } finally {
      await host.dispose("quit");
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
