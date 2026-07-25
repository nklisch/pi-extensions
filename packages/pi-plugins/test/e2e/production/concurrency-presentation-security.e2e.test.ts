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
import { PiPtyProcess } from "../harness/pi-pty.js";
import { diagnosePtyCapability } from "../harness/faults.js";
import { assertAllSqliteIntegrity, fileInventory, scanForbiddenValues } from "../harness/state-inspector.js";
import { runChecked } from "../harness/process.js";
import { E2E_SECRET_CANARY } from "../harness/constants.js";

let sandbox: CleanE2ESandbox | undefined;
afterEach(async (context) => {
  if (sandbox !== undefined) await cleanupSandbox(sandbox, context);
  sandbox = undefined;
});

const activeV2 = {
  revision: "v2" as const,
  skill: "present" as const,
  ordinaryHooks: "active" as const,
  subagent: "injected-and-continued" as const,
  mcp: "registered" as const,
  alias: "runtime-unavailable-omission" as const,
};

describe("production concurrency, presentation, and secret non-retention", () => {
  it("serializes two real Pi process mutations while an unrelated third mutation converges", async () => {
    sandbox = await createProductionE2ESandbox("production-multiprocess");
    const model = await startProductionModelService(sandbox);
    const journey = await seedRemoteMarketplace(sandbox, { extraArgs: productionModelArgs });
    expect((await journey.rpc.plugin("install core-local@native-e2e-market --scope user", "install.run")).envelope.data.kind).toBe("succeeded");
    await installProductionBundle({ sandbox, rpc: journey.rpc, version: "v1" });
    await publishProductionBundleRevision(sandbox, journey.repository, "v2");
    await journey.rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh");
    const peer = await PiRpcProcess.start({ sandbox, extraArgs: productionModelArgs });
    const siblingOwner = await PiRpcProcess.start({ sandbox, extraArgs: productionModelArgs });

    const [first, second, sibling] = await Promise.all([
      journey.rpc.plugin(`update ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.update"),
      peer.plugin(`update ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.update"),
      siblingOwner.plugin("disable core-local@native-e2e-market --scope user --yes", "lifecycle.disable"),
    ]);
    const updateOutcomes = [first, second].map((report) => ({
      status: report.envelope.status,
      kind: report.envelope.data?.kind,
      reason: report.envelope.data?.reason,
    })).sort((left, right) => left.status.localeCompare(right.status));
    expect(updateOutcomes.filter((outcome) => outcome.status === "ok" && outcome.kind === "succeeded")).toHaveLength(1);
    const contender = updateOutcomes.find((outcome) => outcome.status !== "ok");
    expect([
      { status: "conflict", kind: "conflict", reason: "target-changed" },
      { status: "stale", kind: "stale", reason: "configuration" },
    ]).toContainEqual(contender);
    expect(sibling.envelope).toMatchObject({
      status: "recovery-required",
      data: {
        kind: "recovery-required",
        operation: "disable",
        code: "PENDING_TRANSITION",
        action: "run-recovery",
        committed: expect.any(Number),
      },
    });
    await Promise.all([journey.rpc.shutdown(), peer.shutdown(), siblingOwner.shutdown()]);

    const freshA = await PiRpcProcess.start({ sandbox, extraArgs: productionModelArgs });
    const freshB = await PiRpcProcess.start({ sandbox, extraArgs: productionModelArgs });
    const [showA, showB] = await Promise.all([
      freshA.plugin(`--non-interactive show ${PRODUCTION_PLUGIN} --scope user`, "inspection.show"),
      freshB.plugin(`--non-interactive show ${PRODUCTION_PLUGIN} --scope user`, "inspection.show"),
    ]);
    const [coreA, coreB] = await Promise.all([
      freshA.plugin("--non-interactive show core-local@native-e2e-market --scope user", "inspection.show"),
      freshB.plugin("--non-interactive show core-local@native-e2e-market --scope user", "inspection.show"),
    ]);
    const [commandsA, commandsB] = await Promise.all([
      freshA.request({ type: "get_commands" }),
      freshB.request({ type: "get_commands" }),
    ]);
    expect(showA.envelope.data.detail.summary.revision).toEqual(showB.envelope.data.detail.summary.revision);
    expect(JSON.stringify(showA.envelope.data.detail.summary.revision)).toContain("2.0.0");
    expect(coreA.envelope.data.detail.summary).toEqual(coreB.envelope.data.detail.summary);
    expect(coreA.envelope.data.detail.lifecycle).toMatchObject({ installed: true, activationIntent: "disabled", transition: "none" });
    expect(coreA.envelope.data.detail.activation).toMatchObject({ intent: "disabled", state: "inactive" });
    for (const commands of [commandsA, commandsB]) {
      expect(commands.data.commands).not.toContainEqual(expect.objectContaining({ name: "skill:core-local" }));
    }
    await observeProductionBundle(freshA, activeV2, model);
    await Promise.all([freshA.shutdown(), freshB.shutdown()]);
    await assertAllSqliteIntegrity(sandbox.agentDir);
  });

  it("restarts V2 offline without Git, model, or eager MCP launch, then serves an explicit call", async () => {
    sandbox = await createProductionE2ESandbox("production-offline-restart");
    let model = await startProductionModelService(sandbox);
    const journey = await seedRemoteMarketplace(sandbox, { extraArgs: productionModelArgs });
    await installProductionBundle({ sandbox, rpc: journey.rpc, version: "v1" });
    await publishProductionBundleRevision(sandbox, journey.repository, "v2");
    await journey.rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh");
    expect((await journey.rpc.plugin(`update ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.update")).envelope.data.kind).toBe("succeeded");
    await journey.rpc.shutdown();
    await journey.git.stop();
    await model.stop();
    sandbox.env.PI_OFFLINE = "1";

    const startedAt = Date.now();
    const offline = await PiRpcProcess.start({ sandbox, extraArgs: productionModelArgs });
    const [status, commands] = await Promise.all([
      offline.plugin("--non-interactive status", "status"),
      offline.request({ type: "get_commands" }),
    ]);
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(status.envelope.status).toBe("ok");
    expect(commands.data.commands).toContainEqual(expect.objectContaining({ name: "skill:production-bundle" }));
    expect((await fileInventory(sandbox.agentDir)).some((entry) => entry.path.endsWith("production-mcp.jsonl"))).toBe(false);

    model = await startProductionModelService(sandbox);
    await observeProductionBundle(offline, activeV2, model);
    await offline.shutdown();
  });

  it("renders the same signed authority in RPC, JSON/print, wide, and narrow Pi surfaces", async () => {
    sandbox = await createProductionE2ESandbox("production-presentation");
    await startProductionModelService(sandbox);
    const journey = await seedRemoteMarketplace(sandbox, { extraArgs: productionModelArgs });
    await installProductionBundle({ sandbox, rpc: journey.rpc, version: "v1" });
    const status = await journey.rpc.plugin("--non-interactive status", "status");
    const shown = await journey.rpc.plugin(`--non-interactive show ${PRODUCTION_PLUGIN} --scope user`, "inspection.show");
    expect(status.envelope.data.capabilities.mcp.explanation).toContain("RUNTIME_ALIAS_UNAVAILABLE");
    expect(shown.envelope.data.detail.compatibility.components.counts).toEqual({ skills: 1, hooks: 3, mcpServers: 2, foreign: 0 });
    await journey.rpc.shutdown();

    const printed = await runChecked(sandbox.capabilities.node, [
      sandbox.piCli, "--offline", "--approve", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--mode", "text", "--print", "--no-session", "/plugin status",
    ], { cwd: sandbox.project, env: sandbox.env, timeoutMs: 30_000 });
    expect(`${printed.stdout}${printed.stderr}`).toContain("Host ready · recovery settled · runtime reconciled");
    const json = await runChecked(sandbox.capabilities.node, [
      sandbox.piCli, "--offline", "--approve", "--no-prompt-templates", "--no-themes", "--no-context-files",
      "--mode", "json", "--no-session", "/plugin status",
    ], { cwd: sandbox.project, env: sandbox.env, timeoutMs: 30_000 });
    for (const line of json.stdout.split("\n").filter(Boolean)) JSON.parse(line);
    expect(json.stdout).toContain("RUNTIME_ALIAS_UNAVAILABLE");

    const ptyCapability = await diagnosePtyCapability(sandbox);
    if (!ptyCapability.available) return;
    for (const [columns, rows] of [[120, 30], [58, 24]] as const) {
      const pty = await PiPtyProcess.start({ sandbox, columns, rows, extraArgs: productionModelArgs });
      await pty.waitFor("clear/exit", 0, 60_000);
      const mark = pty.mark();
      pty.send("/plugin\r");
      const output = await pty.waitFor("Plugins", mark, 60_000);
      pty.send("\r");
      await pty.waitFor("production-bundle", mark, 60_000);
      const semantic = pty.semanticOutput().slice(mark);
      expect(`${output}${semantic}`).toContain("[all]");
      expect(semantic).toContain("a add");
      expect(semantic).toContain("m marketplaces");
      pty.send("\u001b\u0004");
      await pty.shutdown();
    }
  });

  it("rejects sensitive activation through the real masked Pi input boundary and retains no plaintext", async () => {
    sandbox = await createProductionE2ESandbox("production-secret-nonretention");
    const journey = await seedRemoteMarketplace(sandbox);
    await journey.rpc.shutdown();
    const ptyCapability = await diagnosePtyCapability(sandbox);
    if (!ptyCapability.available) return;
    const pty = await PiPtyProcess.start({ sandbox, columns: 120, rows: 30 });
    let mark = pty.mark();
    pty.send("/plugin install secret-required@native-e2e-market --scope user\r");
    await pty.waitFor("Secret token", mark, 120_000);
    pty.send(`${E2E_SECRET_CANARY}\r`);
    await pty.waitFor("Confirm exact plugin action", mark, 120_000);
    pty.send(" ");
    for (let page = 0; page < 12; page += 1) pty.send("\u001b[6~");
    pty.send("\r");
    await pty.waitFor(/input-required|unavailable|failed/iu, mark, 150_000);
    expect(pty.rawOutput()).not.toContain(E2E_SECRET_CANARY);
    expect(pty.semanticOutput()).not.toContain(E2E_SECRET_CANARY);
    pty.send("\u0004");
    await pty.shutdown();

    const rpc = await PiRpcProcess.start({ sandbox });
    expect((await rpc.plugin("--non-interactive list --scope user", "inspection.list")).envelope.data.items).toEqual([]);
    expect(JSON.stringify(rpc.events)).not.toContain(E2E_SECRET_CANARY);
    await scanForbiddenValues(sandbox.root);
    await rpc.shutdown();
  });
});
