import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSandbox, loadSuiteArtifact, type CleanE2ESandbox } from "../harness/environment.js";
import { createProductionE2ESandbox } from "../harness/production-environment.js";
import { startProductionModelService } from "../harness/production-model-service.js";
import {
  installProductionBundle,
  observeProductionBundle,
  productionModelArgs,
  PRODUCTION_PLUGIN,
  publishProductionBundleRevision,
  runProductionModelTurn,
} from "../harness/production-bundle.js";
import { seedRemoteMarketplace } from "../harness/journey.js";
import { PiRpcProcess } from "../harness/pi-rpc.js";
import { pauseNextGitBackend, waitForFile } from "../harness/faults.js";
import { assertAllSqliteIntegrity } from "../harness/state-inspector.js";
import { runChecked, waitForCondition } from "../harness/process.js";

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

function installedRevision(detail: any): "v1" | "v2" | undefined {
  const version = detail.envelope.data?.detail?.summary?.revision?.installed?.text;
  return version === "1.0.0" ? "v1" : version === "2.0.0" ? "v2" : undefined;
}

async function assertConverged(rpc: PiRpcProcess, model: Awaited<ReturnType<typeof startProductionModelService>>): Promise<"v1" | "v2"> {
  const detail = await rpc.plugin(`--non-interactive show ${PRODUCTION_PLUGIN} --scope user`, "inspection.show");
  expect(detail.envelope).toMatchObject({ status: "ok", data: { kind: "found" } });
  const revision = installedRevision(detail);
  expect(revision).toBeDefined();
  expect(["none", "degraded", "fallback-active"]).toContain(detail.envelope.data.detail.lifecycle.health);
  const diagnosis = await rpc.plugin(`--non-interactive diagnose ${PRODUCTION_PLUGIN} --scope user`, "inspection.diagnose");
  expect(JSON.stringify({ detail: detail.envelope, diagnosis: diagnosis.envelope })).not.toMatch(/RECOVERY_REQUIRED|PENDING_TRANSITION|recovery-required|pending-transition|staged/iu);
  await observeProductionBundle(rpc, active(revision!), model);
  return revision!;
}

async function commitFixture(repository: { working: string; bare: string }, message: string): Promise<void> {
  await runChecked(sandbox!.capabilities.git, ["add", "."], { cwd: repository.working, env: sandbox!.env });
  await runChecked(sandbox!.capabilities.git, ["commit", "--quiet", "-m", message], { cwd: repository.working, env: sandbox!.env });
  await runChecked(sandbox!.capabilities.git, ["push", "--quiet", "origin", "main"], { cwd: repository.working, env: sandbox!.env });
  await runChecked(sandbox!.capabilities.git, ["--git-dir", repository.bare, "update-server-info"], { env: sandbox!.env });
}

describe("production failure, convergence, and package drift", () => {
  it("rejects an incompatible update and an interrupted acquisition without disturbing complete V1", async () => {
    sandbox = await createProductionE2ESandbox("production-failure-update");
    const model = await startProductionModelService(sandbox);
    const journey = await seedRemoteMarketplace(sandbox, { extraArgs: productionModelArgs });
    await installProductionBundle({ sandbox, rpc: journey.rpc, version: "v1" });

    await publishProductionBundleRevision(sandbox, journey.repository, "v2");
    const manifestPath = join(journey.repository.working, "plugins", "production-bundle", ".claude-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.mcpServers.insecure = { type: "http", url: "http://example.invalid/mcp" };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await commitFixture(journey.repository, "incompatible production update");
    await journey.rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh");
    const rejected = await journey.rpc.plugin(`update ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.update");
    expect(rejected.envelope.status).not.toBe("ok");
    await observeProductionBundle(journey.rpc, active("v1"), model);

    await writeFile(join(journey.repository.working, "interrupted-refresh.txt"), "candidate acquisition boundary\n");
    await commitFixture(journey.repository, "interrupted acquisition candidate");
    await pauseNextGitBackend(journey.git.controlFile);
    const pending = journey.rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh", 60_000);
    await waitForFile(journey.git.phaseFile, "backend-paused", 15_000);
    journey.rpc.process.signal("SIGKILL");
    await journey.rpc.process.waitForExit(10_000);
    journey.git.resume();
    await pending.catch(() => undefined);

    const recovered = await PiRpcProcess.start({ sandbox, extraArgs: productionModelArgs });
    await assertConverged(recovered, model);
    await recovered.shutdown();
    await assertAllSqliteIntegrity(sandbox.agentDir);
  });

  it("converges a process killed during update without a durable operation block", async () => {
    sandbox = await createProductionE2ESandbox("production-update-kill");
    const model = await startProductionModelService(sandbox);
    const journey = await seedRemoteMarketplace(sandbox, { extraArgs: productionModelArgs });
    await installProductionBundle({ sandbox, rpc: journey.rpc, version: "v1" });
    await publishProductionBundleRevision(sandbox, journey.repository, "v2");
    expect((await journey.rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh")).envelope.status).toBe("ok");

    const update = journey.rpc.plugin(`update ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.update", 60_000);
    await waitForCondition("update transaction boundary", async () => {
      const entries = await journey.rpc.getEntries().catch(() => undefined);
      return entries?.data?.entries?.some((entry: any) => entry?.type === "custom" && entry.customType === "plugin-host:control-frame-v1" && entry.data?.type === "progress" && entry.data.phase === "lifecycle-transaction" && entry.data.state === "started") ? true : undefined;
    }, 15_000);
    journey.rpc.process.signal("SIGSTOP");
    journey.rpc.process.signal("SIGKILL");
    await journey.rpc.process.waitForExit(10_000);
    await update.catch(() => undefined);

    const recovered = await PiRpcProcess.start({ sandbox, extraArgs: productionModelArgs });
    await assertConverged(recovered, model);
    const retry = await recovered.plugin(`disable ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.disable");
    expect(["ok", "no-change", "conflict", "stale", "rejected"]).toContain(retry.envelope.status);
    expect(JSON.stringify(retry.envelope)).not.toMatch(/RECOVERY_REQUIRED|PENDING_TRANSITION|recovery-required|pending-transition|staged/iu);
    await recovered.shutdown();
    await assertAllSqliteIntegrity(sandbox.agentDir);
  });

  it("isolates a real failing MCP server, propagates cancellation, and keeps the exact good source usable", async () => {
    sandbox = await createProductionE2ESandbox("production-mcp-failure-cancel");
    const model = await startProductionModelService(sandbox);
    const journey = await seedRemoteMarketplace(sandbox, { extraArgs: productionModelArgs });
    await installProductionBundle({ sandbox, rpc: journey.rpc, version: "v1" });
    await journey.rpc.shutdown();
    const rpc = await PiRpcProcess.start({ sandbox, extraArgs: productionModelArgs });
    await model.selectScenario("mcp");
    const failed = await runProductionModelTurn(rpc, "PRODUCTION_MCP_FAILURE");
    expect(failed).toContain("PARENT_MCP_FAILURE_OBSERVED");
    expect(failed).toMatch(/MCP_LAUNCH_FAILED|MCP_CONNECTION_FAILED|ADAPTER_FAILED|error/iu);
    expect(failed).not.toContain("missing-server.mjs");
    expect(await runProductionModelTurn(rpc, "PRODUCTION_MCP_JOURNEY_AFTER_FAILURE")).toContain("PARENT_MCP_OBSERVED");
    await rpc.shutdown();
  });

  it("fails package drift closed before execution, then restores exact qualification", async () => {
    sandbox = await createProductionE2ESandbox("production-package-drift");
    const model = await startProductionModelService(sandbox);
    const journey = await seedRemoteMarketplace(sandbox, { extraArgs: productionModelArgs });
    expect((await journey.rpc.plugin("install core-local@native-e2e-market --scope user", "install.run")).envelope.data.kind).toBe("succeeded");
    await installProductionBundle({ sandbox, rpc: journey.rpc, version: "v1" });
    await journey.rpc.shutdown();

    const artifact = await loadSuiteArtifact();
    const packagePaths = {
      mcp: join(sandbox.consumer, "node_modules", "@nklisch", "pi-mcp-adapter"),
      subagents: join(sandbox.packageRoot, "node_modules", "@nklisch", "pi-subagents"),
    };
    const exactPaths = {
      mcp: join(artifact.consumerTemplate, "node_modules", "@nklisch", "pi-mcp-adapter"),
      subagents: join(artifact.packageRoot, "node_modules", "@nklisch", "pi-subagents"),
    };
    const restore = async (kind: keyof typeof packagePaths): Promise<void> => {
      await rm(packagePaths[kind], { recursive: true, force: true });
      await cp(exactPaths[kind], packagePaths[kind], { recursive: true, force: true, preserveTimestamps: true });
    };
    const versionDrift = async (kind: keyof typeof packagePaths): Promise<void> => {
      const path = join(packagePaths[kind], "package.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      manifest.version = "99.0.0-drift";
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    };
    const assertDrift = async (mcp: "available" | "unavailable", subagents: "available" | "unavailable"): Promise<void> => {
      const rpc = await PiRpcProcess.start({ sandbox: sandbox!, extraArgs: productionModelArgs });
      const [status, commands] = await Promise.all([rpc.plugin("--non-interactive status", "status"), rpc.request({ type: "get_commands" })]);
      expect(status.envelope.data.capabilities).toMatchObject({ mcp: { status: mcp }, subagents: { status: subagents } });
      expect(commands.data.commands).toContainEqual(expect.objectContaining({ name: "skill:core-local" }));
      expect(commands.data.commands).not.toContainEqual(expect.objectContaining({ name: "skill:production-bundle" }));
      await rpc.shutdown();
    };

    await versionDrift("mcp");
    await assertDrift("unavailable", "available");
    await restore("mcp");
    await versionDrift("subagents");
    await assertDrift("available", "unavailable");
    await restore("subagents");
    const restored = await PiRpcProcess.start({ sandbox, extraArgs: productionModelArgs });
    await observeProductionBundle(restored, active("v1"), model);
    await restored.shutdown();
  });
});
