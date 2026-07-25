import { afterEach, describe, expect, it } from "vitest";
import { cleanupSandbox, type CleanE2ESandbox } from "../harness/environment.js";
import { createProductionE2ESandbox } from "../harness/production-environment.js";
import { startProductionModelService } from "../harness/production-model-service.js";
import {
  installProductionBundle,
  observeProductionBundle,
  productionHookEvidence,
  productionModelArgs,
  PRODUCTION_PLUGIN,
  publishProductionBundleRevision,
  type ProductionBundleRevision,
  type ProductionHookEvidence,
} from "../harness/production-bundle.js";
import { seedRemoteMarketplace } from "../harness/journey.js";
import { PiRpcProcess } from "../harness/pi-rpc.js";
import { waitForCondition } from "../harness/process.js";

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

const inactive = (revision: "v1" | "v2") => ({
  revision,
  skill: "absent" as const,
  ordinaryHooks: "inactive" as const,
  subagent: "inactive" as const,
  mcp: "absent" as const,
  alias: "runtime-unavailable-omission" as const,
});

async function startWithExactSessionHook(
  before: readonly ProductionHookEvidence[],
  revision: ProductionBundleRevision | null,
): Promise<PiRpcProcess> {
  const rpc = await PiRpcProcess.start({ sandbox: sandbox!, extraArgs: productionModelArgs });
  // A completed packed status command is the deterministic startup barrier for
  // an inactive bundle; active hook execution is awaited through its durable log.
  expect((await rpc.plugin("--non-interactive status", "status")).envelope.status).toBe("ok");
  if (revision !== null) {
    await waitForCondition("fresh production SessionStart hook", async () => {
      const after = await productionHookEvidence(sandbox!);
      return after.length > before.length ? after : undefined;
    }, 15_000);
  }
  const delta = (await productionHookEvidence(sandbox!)).slice(before.length);
  expect(delta).toEqual(revision === null ? [] : [{ event: "SessionStart", revision }]);
  return rpc;
}

describe("golden production full-bundle lifecycle", () => {
  it("installs, observes, disables, enables, updates, and uninstalls one exact bundle", async () => {
    sandbox = await createProductionE2ESandbox("production-golden-bundle");
    const model = await startProductionModelService(sandbox);
    const journey = await seedRemoteMarketplace(sandbox, { extraArgs: productionModelArgs });
    await installProductionBundle({ sandbox, rpc: journey.rpc, version: "v1" });
    await journey.rpc.shutdown();

    let baseline = await productionHookEvidence(sandbox);
    let rpc = await startWithExactSessionHook(baseline, "v1");
    await observeProductionBundle(rpc, active("v1"), model);

    const disabled = await rpc.plugin(`disable ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.disable");
    expect(disabled.envelope.data).toMatchObject({ kind: "succeeded" });
    await rpc.shutdown();
    baseline = await productionHookEvidence(sandbox);
    rpc = await startWithExactSessionHook(baseline, null);
    await observeProductionBundle(rpc, inactive("v1"), model);

    const enabled = await rpc.plugin(`enable ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.enable");
    expect(enabled.envelope.data).toMatchObject({ kind: "succeeded" });
    await rpc.shutdown();
    baseline = await productionHookEvidence(sandbox);
    rpc = await startWithExactSessionHook(baseline, "v1");
    await observeProductionBundle(rpc, active("v1"), model);

    await publishProductionBundleRevision(sandbox, journey.repository, "v2");
    const refreshed = await rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh");
    expect(refreshed.envelope.status).toBe("ok");
    const updated = await rpc.plugin(`update ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.update");
    expect(updated.envelope.data).toMatchObject({ kind: "succeeded" });
    await rpc.shutdown();

    baseline = await productionHookEvidence(sandbox);
    rpc = await startWithExactSessionHook(baseline, "v2");
    await observeProductionBundle(rpc, active("v2"), model);

    const removed = await rpc.plugin(`uninstall ${PRODUCTION_PLUGIN} --scope user --delete-data --yes`, "lifecycle.uninstall");
    expect(removed.envelope.data).toMatchObject({ kind: "succeeded" });
    await rpc.shutdown();

    baseline = await productionHookEvidence(sandbox);
    rpc = await startWithExactSessionHook(baseline, null);
    await observeProductionBundle(rpc, inactive("v2"), model);
    const listed = await rpc.plugin("--non-interactive list --scope user", "inspection.list");
    expect(listed.envelope.data.items).not.toContainEqual(expect.objectContaining({ plugin: PRODUCTION_PLUGIN }));
    const marketplaces = await rpc.plugin("--non-interactive marketplace list", "marketplace.list");
    expect(marketplaces.envelope.data.registrations).toContainEqual(expect.objectContaining({ marketplace: "native-e2e-market" }));
    await rpc.shutdown();
  });
});
