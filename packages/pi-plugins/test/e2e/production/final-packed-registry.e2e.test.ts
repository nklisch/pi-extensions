import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSandbox, type CleanE2ESandbox } from "../harness/environment.js";
import {
  createProductionE2ESandbox,
  installFromEmptyRegistrySnapshot,
  installProductionPackedProduct,
  prepareProductionSuiteArtifact,
} from "../harness/production-environment.js";
import { startProductionModelService } from "../harness/production-model-service.js";
import {
  installProductionBundle,
  observeProductionBundle,
  productionModelArgs,
  PRODUCTION_PLUGIN,
  publishProductionBundleRevision,
} from "../harness/production-bundle.js";
import { seedRemoteMarketplace } from "../harness/journey.js";
import { PiRpcProcess } from "../harness/pi-rpc.js";
import { assertAllSqliteIntegrity, scanForbiddenValues } from "../harness/state-inspector.js";

let sandbox: CleanE2ESandbox | undefined;
afterEach(async (context) => {
  if (sandbox !== undefined) await cleanupSandbox(sandbox, context);
  sandbox = undefined;
});

const active = (revision: "v1" | "v2") => ({
  revision,
  skill: "present" as const,
  ordinaryHooks: "active" as const,
  subagent: "injected-and-continued" as const,
  mcp: "registered" as const,
  alias: "runtime-unavailable-omission" as const,
});

const inactiveV2 = {
  revision: "v2" as const,
  skill: "absent" as const,
  ordinaryHooks: "inactive" as const,
  subagent: "inactive" as const,
  mcp: "absent" as const,
  alias: "runtime-unavailable-omission" as const,
};

describe("final from-empty packed registry acceptance", () => {
  it("replays the npm lock/SRI cache offline and carries one real plugin through its complete lifecycle", async () => {
    const artifact = await prepareProductionSuiteArtifact();
    sandbox = await createProductionE2ESandbox("production-final-registry");
    const destination = join(sandbox.root, "from-empty-registry");
    await expect(lstat(join(destination, "consumer", "node_modules"))).rejects.toThrow();
    const installed = await installFromEmptyRegistrySnapshot({
      candidateTarball: artifact.candidateTarball,
      publicLockfile: artifact.publicLockfile,
      npmCache: artifact.npmCache,
      destination,
      env: sandbox.env,
    });
    expect(installed.installedReceipts).toContainEqual(expect.objectContaining({
      name: "@nklisch/pi-mcp-adapter",
      version: "2.11.0-nklisch.3",
      integrity: "sha512-keVNCjw0ZldLr5p6TwB3UvM9dHc9SwhCHbSQQOvdR+nhMFRua2lHdAG3nMqmr9CK1torEd8e5PX3ZyptXXhmbQ==",
    }));
    expect(installed.installedReceipts).toContainEqual(expect.objectContaining({
      name: "@nklisch/pi-subagents",
      version: "18.0.4-nklisch.0",
      integrity: "sha512-33Q8JDffXUuiT1M3XjLXCI4If9p+3AOwsUp/b5f1+B7Y5JI8Z8SVU+Dncq0umAG2IjgVYKnT9FHToFHNoZGWoQ==",
    }));
    expect(installed.installedReceipts.every((receipt) => receipt.realpath.startsWith(destination))).toBe(true);

    const finalSandbox: CleanE2ESandbox = {
      ...sandbox,
      consumer: join(destination, "consumer"),
      packageRoot: installed.packageRoot,
      extensionPath: join(installed.packageRoot, "dist", "pi", "extension.js"),
      piCli: installed.piCli,
    };
    await installProductionPackedProduct(finalSandbox);
    expect(finalSandbox.installedList).toContain("@nklisch/pi-plugins");
    expect(finalSandbox.installedList).not.toContain("@nklisch/pi-subagents");

    let model = await startProductionModelService(finalSandbox);
    const journey = await seedRemoteMarketplace(finalSandbox, { extraArgs: productionModelArgs });
    await installProductionBundle({ sandbox: finalSandbox, rpc: journey.rpc, version: "v1" });
    await journey.rpc.shutdown();
    let rpc = await PiRpcProcess.start({ sandbox: finalSandbox, extraArgs: productionModelArgs });
    await observeProductionBundle(rpc, active("v1"), model);
    expect((await rpc.plugin(`disable ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.disable")).envelope.data.kind).toBe("succeeded");
    expect((await rpc.request({ type: "get_commands" })).data.commands).not.toContainEqual(expect.objectContaining({ name: "skill:production-bundle" }));
    expect((await rpc.plugin(`enable ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.enable")).envelope.data.kind).toBe("succeeded");

    await publishProductionBundleRevision(finalSandbox, journey.repository, "v2");
    await rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh");
    expect((await rpc.plugin(`update ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.update")).envelope.data.kind).toBe("succeeded");
    await rpc.shutdown();
    await journey.git.stop();
    await model.stop();
    finalSandbox.env.PI_OFFLINE = "1";

    const offlineStarted = Date.now();
    rpc = await PiRpcProcess.start({ sandbox: finalSandbox, extraArgs: productionModelArgs });
    expect(Date.now() - offlineStarted).toBeLessThan(15_000);
    expect((await rpc.plugin("--non-interactive status", "status")).envelope.status).toBe("ok");
    expect((await rpc.request({ type: "get_commands" })).data.commands).toContainEqual(expect.objectContaining({ name: "skill:production-bundle" }));
    model = await startProductionModelService(finalSandbox);
    await observeProductionBundle(rpc, active("v2"), model);

    expect((await rpc.plugin(`uninstall ${PRODUCTION_PLUGIN} --scope user --delete-data --yes`, "lifecycle.uninstall")).envelope.data.kind).toBe("succeeded");
    await rpc.shutdown();
    rpc = await PiRpcProcess.start({ sandbox: finalSandbox, extraArgs: productionModelArgs });
    await observeProductionBundle(rpc, inactiveV2, model);
    expect((await rpc.plugin("--non-interactive list --scope user", "inspection.list")).envelope.data.items).toEqual([]);
    await rpc.shutdown();

    await assertAllSqliteIntegrity(finalSandbox.agentDir);
    await scanForbiddenValues(finalSandbox.root);
    for (const foreign of [join(finalSandbox.home, ".claude"), join(finalSandbox.home, ".codex")]) {
      await expect(lstat(foreign)).rejects.toThrow();
    }
  });
});
