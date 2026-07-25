import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { E2E_SECRET_CANARY } from "../harness/constants.js";
import { cleanupSandbox, createCleanE2ESandbox, type CleanE2ESandbox } from "../harness/environment.js";
import { publishFixtureRevision } from "../harness/git-service.js";
import { seedRemoteMarketplace } from "../harness/journey.js";
import { PiRpcProcess } from "../harness/pi-rpc.js";
import { fileInventory, scanForbiddenValues } from "../harness/state-inspector.js";

let sandbox: CleanE2ESandbox | undefined;
afterEach(async (context) => {
  if (sandbox !== undefined) await cleanupSandbox(sandbox, context);
  sandbox = undefined;
});

async function installCore(rpc: PiRpcProcess): Promise<any> {
  const opened = await rpc.plugin(
    "--non-interactive install open core-local@native-e2e-market --scope user",
    "install.open",
  );
  expect(opened.envelope).toMatchObject({ status: "ok", data: { kind: "opened" } });
  const token = opened.envelope.data.session.token as string;
  const applied = await rpc.plugin(`install apply ${token}`, "install.apply");
  expect(applied.envelope).toMatchObject({
    status: "ok",
    data: { kind: "succeeded", plugin: "core-local@native-e2e-market", components: { skills: 1, hooks: 1, mcpServers: 0 } },
  });
  return applied.envelope.data;
}

describe("packed golden install and lifecycle journeys", () => {
  it("completes exact open/configure/consent/activation and runtime observation", async () => {
    sandbox = await createCleanE2ESandbox("golden-install-runtime");
    const journey = await seedRemoteMarketplace(sandbox);
    await installCore(journey.rpc);
    await journey.rpc.shutdown();

    const fresh = await PiRpcProcess.start({ sandbox });
    const commands = await fresh.request({ type: "get_commands" });
    expect(commands.data.commands).toContainEqual(expect.objectContaining({ name: "skill:core-local", source: "skill" }));
    const hookFiles = (await fileInventory(sandbox.agentDir)).filter((entry) => entry.path.endsWith("hook-events.log"));
    expect(hookFiles).toHaveLength(1);
    const marker = await readFile(`${sandbox.agentDir}/${hookFiles[0]!.path}`, "utf8");
    expect(marker).toContain("e2e-value|");
    expect(marker).toContain(sandbox.project);
    await fresh.shutdown();
  });

  it("disables, enables, updates to V2, and uninstalls with retained data", async () => {
    sandbox = await createCleanE2ESandbox("golden-lifecycle-xfail");
    const journey = await seedRemoteMarketplace(sandbox);
    await installCore(journey.rpc);

    const disabled = await journey.rpc.plugin("disable core-local@native-e2e-market --scope user --yes", "lifecycle.disable");
    expect(disabled.envelope.data.kind).toBe("succeeded");
    const afterDisable = await journey.rpc.request({ type: "get_commands" });
    expect(afterDisable.data.commands).not.toContainEqual(expect.objectContaining({ name: "skill:core-local" }));

    const enabled = await journey.rpc.plugin("enable core-local@native-e2e-market --scope user --yes", "lifecycle.enable");
    expect(enabled.envelope.data.kind).toBe("succeeded");
    await publishFixtureRevision(sandbox, journey.repository, "2.0.0", "v2");
    const refresh = await journey.rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh");
    expect(refresh.envelope.status).toBe("ok");
    const updated = await journey.rpc.plugin("update core-local@native-e2e-market --scope user --yes", "lifecycle.update");
    expect(updated.envelope.data).toMatchObject({ kind: "succeeded" });

    const removed = await journey.rpc.plugin("uninstall core-local@native-e2e-market --scope user --keep-data --yes", "lifecycle.uninstall");
    expect(removed.envelope.data).toMatchObject({ kind: "succeeded" });
    const installed = await journey.rpc.plugin("--non-interactive list --scope user", "inspection.list");
    expect(installed.envelope.data.items).toEqual([]);
    expect((await fileInventory(sandbox.agentDir)).some((entry) => entry.path.endsWith("hook-events.log"))).toBe(true);
    await journey.rpc.shutdown();
  });

  it("blocks secret/incompatible candidates and activates newly qualified MCP/subagent candidates", async () => {
    sandbox = await createCleanE2ESandbox("golden-runtime-capabilities");
    const journey = await seedRemoteMarketplace(sandbox);
    for (const plugin of ["secret-required", "incompatible"]) {
      const report = await journey.rpc.plugin(`install ${plugin}@native-e2e-market --scope user`, "install.run");
      expect(report.envelope.status).not.toBe("ok");
      expect(JSON.stringify(report.envelope)).toMatch(/UNAVAILABLE|INCOMPATIBLE|INPUT_REQUIRED/u);
    }
    for (const plugin of ["mcp-required", "subagent-required"]) {
      const report = await journey.rpc.plugin(`install ${plugin}@native-e2e-market --scope user`, "install.run");
      expect(report.envelope).toMatchObject({ status: "ok", data: { kind: "succeeded" } });
      const removed = await journey.rpc.plugin(`uninstall ${plugin}@native-e2e-market --scope user --delete-data --yes`, "lifecycle.uninstall");
      expect(removed.envelope.data).toMatchObject({ kind: "succeeded" });
    }
    const installed = await journey.rpc.plugin("--non-interactive list --scope user", "inspection.list");
    expect(installed.envelope.data.items).toEqual([]);
    expect(JSON.stringify(journey.rpc.events)).not.toContain(E2E_SECRET_CANARY);
    await scanForbiddenValues(sandbox.root);
    await journey.rpc.shutdown();
  });
});
