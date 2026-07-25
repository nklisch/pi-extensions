import { afterEach, describe, expect, it } from "vitest";
import { cleanupSandbox, type CleanE2ESandbox } from "../harness/environment.js";
import {
  createProductionE2ESandbox,
  prepareProductionSuiteArtifact,
} from "../harness/production-environment.js";
import { startProductionModelService } from "../harness/production-model-service.js";
import {
  installProductionBundle,
  productionModelArgs,
  PRODUCTION_PLUGIN,
} from "../harness/production-bundle.js";
import { seedRemoteMarketplace } from "../harness/journey.js";
import { PiRpcProcess } from "../harness/pi-rpc.js";
import { fileInventory } from "../harness/state-inspector.js";

let sandbox: CleanE2ESandbox | undefined;
afterEach(async (context) => {
  if (sandbox !== undefined) await cleanupSandbox(sandbox, context);
  sandbox = undefined;
});

describe("production packed full-bundle harness", () => {
  it("uses one registry-resolved candidate and observes an inert complete runtime bundle", async () => {
    const artifact = await prepareProductionSuiteArtifact();
    expect(artifact).toMatchObject({ candidateName: "@nklisch/pi-plugins" });
    expect(artifact.candidateIntegrity).toMatch(/^sha512-/u);
    expect(artifact.packageReceipts).toContainEqual(expect.objectContaining({
      name: "@nklisch/pi-mcp-adapter",
      version: "2.11.0-nklisch.3",
      integrity: "sha512-keVNCjw0ZldLr5p6TwB3UvM9dHc9SwhCHbSQQOvdR+nhMFRua2lHdAG3nMqmr9CK1torEd8e5PX3ZyptXXhmbQ==",
    }));
    expect(artifact.packageReceipts).not.toContainEqual(expect.objectContaining({ resolved: expect.stringMatching(/^file:/u) }));

    sandbox = await createProductionE2ESandbox("production-harness-smoke");
    const model = await startProductionModelService(sandbox);
    const journey = await seedRemoteMarketplace(sandbox, { extraArgs: productionModelArgs });
    expect(sandbox.installedList).toContain("@nklisch/pi-plugins");
    expect(sandbox.installedList).not.toContain("@nklisch/pi-subagents");
    const candidate = await journey.rpc.plugin(`--non-interactive show ${PRODUCTION_PLUGIN} --scope user`, "inspection.show");
    expect(candidate.envelope).toMatchObject({ status: "ok", data: { kind: "found" } });
    await installProductionBundle({ sandbox, rpc: journey.rpc, version: "v1" });
    await journey.rpc.shutdown();
    const fresh = await PiRpcProcess.start({ sandbox, extraArgs: productionModelArgs });
    const [commands, status] = await Promise.all([
      fresh.request({ type: "get_commands" }),
      fresh.plugin("--non-interactive status", "status"),
    ]);
    expect(commands.data.commands).toContainEqual(expect.objectContaining({ name: "skill:production-bundle", source: "skill" }));
    expect(status.envelope.data.capabilities).toMatchObject({ mcp: { status: "available" }, subagents: { status: "available" } });
    expect((await fileInventory(sandbox.agentDir)).some((entry) => entry.path.endsWith("production-mcp.jsonl"))).toBe(false);
    await fresh.shutdown();

    await model.stop();
    const offlineStarted = Date.now();
    const offline = await PiRpcProcess.start({ sandbox, extraArgs: productionModelArgs });
    expect(Date.now() - offlineStarted).toBeLessThan(15_000);
    expect((await offline.plugin("--non-interactive status", "status")).envelope.status).toBe("ok");
    expect((await offline.request({ type: "get_commands" })).data.commands).toContainEqual(expect.objectContaining({ name: "skill:production-bundle" }));
    await offline.shutdown();
  });
});
