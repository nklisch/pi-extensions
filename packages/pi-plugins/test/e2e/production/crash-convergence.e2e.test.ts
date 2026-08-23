import { DatabaseSync } from "node:sqlite";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSandbox, type CleanE2ESandbox } from "../harness/environment.js";
import { createProductionE2ESandbox } from "../harness/production-environment.js";
import { installProductionBundle, PRODUCTION_PLUGIN, publishProductionBundleRevision } from "../harness/production-bundle.js";
import { seedRemoteMarketplace } from "../harness/journey.js";
import { PiRpcProcess } from "../harness/pi-rpc.js";
import { fileInventory } from "../harness/state-inspector.js";
import { waitForCondition } from "../harness/process.js";

let sandbox: CleanE2ESandbox | undefined;
afterEach(async (context) => {
  if (sandbox !== undefined) await cleanupSandbox(sandbox, context);
  sandbox = undefined;
});

async function waitForLifecycleBoundary(rpc: PiRpcProcess, phases: readonly string[] = ["lifecycle-transaction"]): Promise<void> {
  await waitForCondition("lifecycle transaction boundary", async () => {
    const entries = await rpc.getEntries().catch(() => undefined);
    return entries?.data?.entries?.some((entry: any) =>
      entry?.type === "custom"
      && entry.customType === "plugin-host:control-frame-v1"
      && entry.data?.type === "progress"
      && phases.includes(entry.data.phase)
      && entry.data.state === "started") ? true : undefined;
  }, 15_000);
}

async function waitForStaging(agentDir: string): Promise<void> {
  await waitForCondition("materialization staging boundary", async () => {
    const entries = await readdir(join(agentDir, "plugin-host", "staging", "v1")).catch(() => []);
    return entries.some((entry) => /^[0-9a-f]{32}$/u.test(entry)) ? true : undefined;
  }, 15_000);
}

function killRpc(rpc: PiRpcProcess): void {
  rpc.process.signal("SIGSTOP");
  rpc.process.signal("SIGKILL");
}

function installedPlugins(agentDir: string): readonly string[] {
  const path = join(agentDir, "plugin-host", "state", "v1", "user.sqlite");
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const pointer = database.prepare("SELECT pointer_json FROM current_pointer WHERE singleton = 1").get() as { pointer_json: string };
    const current = JSON.parse(pointer.pointer_json) as { documents: Array<{ kind: string; blob: string }> };
    const installed = current.documents.find((document) => document.kind === "installedUser");
    if (installed === undefined) return [];
    const row = database.prepare("SELECT document FROM state_blobs WHERE blob_ref = ?").get(installed.blob) as { document: string };
    return Object.freeze((JSON.parse(row.document).plugins ?? []).map((plugin: { plugin: string }) => plugin.plugin));
  } finally {
    database.close();
  }
}

async function pendingDeleteMarkers(agentDir: string): Promise<readonly string[]> {
  const root = join(agentDir, "plugin-host", "cleanup", "v1", "pending-deletes");
  return (await readdir(root).catch(() => [])).filter((name) => name.endsWith(".json"));
}

async function seedSlowData(agentDir: string): Promise<string> {
  const roots = (await fileInventory(agentDir)).filter((entry) =>
    entry.kind === "directory" && /^plugin-host\/data\/v1\/[0-9a-f]{64}$/u.test(entry.path));
  const root = roots[0] === undefined ? undefined : join(agentDir, roots[0].path);
  if (root === undefined) throw new Error("installed production bundle did not create a data root");
  // A directory with many small entries gives the kill boundary between the
  // committed uninstall and inline deletion enough time to be observable.
  await Promise.all(Array.from({ length: 12_000 }, (_, index) => writeFile(join(root, `crash-${index}.txt`), "marker\n")));
  return root;
}

describe("production crash convergence", () => {
  it("kills mid-install and starts again without a lifecycle wedge", async () => {
    sandbox = await createProductionE2ESandbox("production-crash-install");
    const journey = await seedRemoteMarketplace(sandbox);
    const opened = await journey.rpc.plugin("--non-interactive install open core-local@native-e2e-market --scope user", "install.open");
    const installing = journey.rpc.plugin(`install apply ${opened.envelope.data.session.token}`, "install.apply", 60_000);
    await waitForStaging(sandbox.agentDir);
    killRpc(journey.rpc);
    await journey.rpc.process.waitForExit(10_000);
    await installing.catch(() => undefined);

    const recovered = await PiRpcProcess.start({ sandbox });
    const status = await recovered.plugin("--non-interactive status", "status");
    expect(status.envelope.status).toBe("ok");
    expect(JSON.stringify(status.envelope)).not.toMatch(/RECOVERY_REQUIRED|PENDING_TRANSITION|recovery-required|pending-transition|staged/iu);
    const retry = await recovered.plugin("install core-local@native-e2e-market --scope user", "install.run");
    expect(["ok", "no-change", "conflict", "stale", "rejected"]).toContain(retry.envelope.status);
    await recovered.shutdown();
  });

  it("kills mid-update and converges to a usable selected revision on the next start", async () => {
    sandbox = await createProductionE2ESandbox("production-crash-update");
    const journey = await seedRemoteMarketplace(sandbox);
    await installProductionBundle({ sandbox, rpc: journey.rpc, version: "v1" });
    await publishProductionBundleRevision(sandbox, journey.repository, "v2");
    expect((await journey.rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh")).envelope.status).toBe("ok");

    const updating = journey.rpc.plugin(`update ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.update", 60_000);
    await waitForLifecycleBoundary(journey.rpc);
    killRpc(journey.rpc);
    await journey.rpc.process.waitForExit(10_000);
    await updating.catch(() => undefined);

    const recovered = await PiRpcProcess.start({ sandbox });
    const detail = await recovered.plugin(`--non-interactive show ${PRODUCTION_PLUGIN} --scope user`, "inspection.show");
    expect(detail.envelope).toMatchObject({ status: "ok", data: { kind: "found" } });
    expect(["none", "degraded", "fallback-active"]).toContain(detail.envelope.data.detail.lifecycle.health);
    const disable = await recovered.plugin(`disable ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.disable");
    expect(["ok", "no-change", "conflict", "stale", "rejected"]).toContain(disable.envelope.status);
    await recovered.shutdown();
  });

  it("kills after uninstall commit and replays the confirmed deletion marker", async () => {
    sandbox = await createProductionE2ESandbox("production-crash-uninstall");
    const journey = await seedRemoteMarketplace(sandbox);
    await installProductionBundle({ sandbox, rpc: journey.rpc, version: "v1" });
    const dataRoot = await seedSlowData(sandbox.agentDir);

    const uninstalling = journey.rpc.plugin(`remove ${PRODUCTION_PLUGIN} --scope user --delete-data --yes`, "lifecycle.uninstall", 60_000);
    await waitForCondition("committed uninstall with pending deletion marker", async () => {
      const markers = await pendingDeleteMarkers(sandbox!.agentDir);
      const absent = !installedPlugins(sandbox!.agentDir).includes(PRODUCTION_PLUGIN);
      if (markers.length > 0 && absent) {
        journey.rpc.process.signal("SIGSTOP");
        return true;
      }
      return undefined;
    }, 30_000);
    journey.rpc.process.signal("SIGKILL");
    await journey.rpc.process.waitForExit(10_000);
    await uninstalling.catch(() => undefined);

    const recovered = await PiRpcProcess.start({ sandbox });
    const listed = await recovered.plugin("--non-interactive list --scope user", "inspection.list");
    expect(listed.envelope.data.items).not.toContainEqual(expect.objectContaining({ plugin: PRODUCTION_PLUGIN }));
    expect(await pendingDeleteMarkers(sandbox.agentDir)).toEqual([]);
    expect(await fileInventory(dataRoot)).toEqual([]);
    await recovered.shutdown();
  });
});
