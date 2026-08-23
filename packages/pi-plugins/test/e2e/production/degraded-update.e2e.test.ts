import { chmod, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSandbox, type CleanE2ESandbox } from "../harness/environment.js";
import { createProductionE2ESandbox } from "../harness/production-environment.js";
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
import { fileInventory } from "../harness/state-inspector.js";

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

async function corruptSelectedProductionRevision(): Promise<string> {
  const candidates = (await fileInventory(sandbox!.agentDir))
    .filter((entry) => entry.kind === "file" && entry.path.startsWith("plugin-host/stores/v1/plugins/") && entry.path.endsWith("/revision.txt"));
  for (const candidate of candidates) {
    const path = join(sandbox!.agentDir, candidate.path);
    if ((await readFile(path, "utf8")).trim() === "v2") {
      // Published revisions are immutable; removing one models a missing or
      // otherwise unavailable selected revision without mutating sealed bytes.
      const payloadRoot = join(path, "..", "..");
      await chmod(payloadRoot, 0o700);
      for (const entry of await fileInventory(payloadRoot)) {
        await chmod(join(payloadRoot, entry.path), entry.kind === "directory" ? 0o700 : 0o600);
      }
      await rm(payloadRoot, { recursive: true, force: true });
      return path;
    }
  }
  throw new Error(`could not locate the production v2 revision among ${JSON.stringify(candidates)}`);
}

describe("production degraded update repair", () => {
  it("shows a broken selected revision as degraded, runs fallback, repairs it, and rolls back explicitly", async () => {
    sandbox = await createProductionE2ESandbox("production-degraded-update");
    const model = await startProductionModelService(sandbox);
    const journey = await seedRemoteMarketplace(sandbox, { extraArgs: productionModelArgs });
    await installProductionBundle({ sandbox, rpc: journey.rpc, version: "v1" });
    await publishProductionBundleRevision(sandbox, journey.repository, "v2");
    expect((await journey.rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh")).envelope.status).toBe("ok");
    expect((await journey.rpc.plugin(`update ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.update")).envelope.data.kind).toBe("succeeded");
    await corruptSelectedProductionRevision();
    const degraded = await PiRpcProcess.start({ sandbox, extraArgs: productionModelArgs });
    const detail = await degraded.plugin(`--non-interactive show ${PRODUCTION_PLUGIN} --scope user`, "inspection.show");
    expect(detail.envelope).toMatchObject({ status: "ok", data: { kind: "found", detail: { lifecycle: { health: "fallback-active" } } } });
    expect(detail.envelope.data.detail.activation).toMatchObject({ state: "degraded", runningRevision: expect.any(String) });
    await observeProductionBundle(degraded, active("v1"), model);

    await degraded.shutdown();
    const repaired = await journey.rpc.plugin(`repair ${PRODUCTION_PLUGIN} --scope user`, "lifecycle.repair");
    expect(["ok", "no-change"]).toContain(repaired.envelope.status);
    expect(JSON.stringify(repaired.envelope)).not.toMatch(/RECOVERY_REQUIRED|PENDING_TRANSITION|recovery-required|pending-transition|staged/iu);
    await observeProductionBundle(journey.rpc, active("v2"), model);
    await journey.rpc.shutdown();

    await corruptSelectedProductionRevision();
    const degradedAgain = await PiRpcProcess.start({ sandbox, extraArgs: productionModelArgs });
    const rolledBack = await degradedAgain.plugin(`rollback ${PRODUCTION_PLUGIN} --scope user`, "lifecycle.rollback");
    expect(["ok", "no-change"]).toContain(rolledBack.envelope.status);
    await observeProductionBundle(degradedAgain, active("v1"), model);
    const after = await degradedAgain.plugin(`--non-interactive show ${PRODUCTION_PLUGIN} --scope user`, "inspection.show");
    expect(after.envelope.data.detail.lifecycle.health).toBe("none");
    expect(after.envelope.data.detail.summary.revision.installed.text).toBe("1.0.0");
    await degradedAgain.shutdown();
    await journey.rpc.shutdown();
  });
});
