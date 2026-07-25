import { access, chmod, cp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
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
const activeV1 = active("v1");

function pendingProductionTransition(): Record<string, any> | undefined {
  const journalPath = join(sandbox!.agentDir, "plugin-host", "recovery", "journal", "v1", "user.sqlite");
  const statePath = join(sandbox!.agentDir, "plugin-host", "state", "v1", "user.sqlite");
  let journal: DatabaseSync | undefined;
  let state: DatabaseSync | undefined;
  try {
    journal = new DatabaseSync(journalPath, { readOnly: true });
    const row = journal.prepare("SELECT record_json FROM lifecycle_transitions WHERE plugin = ? AND status = 'prepared' ORDER BY prepared_at DESC LIMIT 1").get(PRODUCTION_PLUGIN) as { record_json: string } | undefined;
    if (row === undefined) return undefined;
    const record = JSON.parse(row.record_json) as Record<string, any>;
    state = new DatabaseSync(statePath, { readOnly: true });
    const pointer = state.prepare("SELECT pointer_json FROM current_pointer WHERE singleton = 1").get() as { pointer_json: string } | undefined;
    if (pointer === undefined) return undefined;
    const documents = (JSON.parse(pointer.pointer_json) as { documents: Array<{ blob: string }> }).documents;
    const selected = documents.map((document) => state!.prepare("SELECT document FROM state_blobs WHERE blob_ref = ?").get(document.blob) as { document: string } | undefined);
    return selected.some((document) => document?.document.includes(String(record.reference))) ? record : undefined;
  } catch {
    return undefined;
  } finally {
    state?.close();
    journal?.close();
  }
}

async function assertRecoveredProductionBundle(rpc: PiRpcProcess, model: Awaited<ReturnType<typeof startProductionModelService>>): Promise<"v1" | "v2" | "recovery-required"> {
  const detail = await rpc.plugin(`--non-interactive show ${PRODUCTION_PLUGIN} --scope user`, "inspection.show");
  if (detail.envelope.status === "ok" && detail.envelope.data?.kind === "found" && detail.envelope.data.detail.lifecycle.transition === "none") {
    const version = detail.envelope.data.detail.summary.revision.installed.text;
    const revision = version === "1.0.0" ? "v1" : version === "2.0.0" ? "v2" : undefined;
    expect(revision).toBeDefined();
    await observeProductionBundle(rpc, active(revision!), model);
    return revision!;
  }
  const diagnosis = await rpc.plugin(`--non-interactive diagnose ${PRODUCTION_PLUGIN} --scope user`, "inspection.diagnose");
  expect(JSON.stringify({ detail: detail.envelope, diagnosis: diagnosis.envelope })).toMatch(/RECOVERY_REQUIRED|PENDING_TRANSITION/u);
  return "recovery-required";
}

async function commitFixture(repository: { working: string; bare: string }, message: string): Promise<void> {
  await runChecked(sandbox!.capabilities.git, ["add", "."], { cwd: repository.working, env: sandbox!.env });
  await runChecked(sandbox!.capabilities.git, ["commit", "--quiet", "-m", message], { cwd: repository.working, env: sandbox!.env });
  await runChecked(sandbox!.capabilities.git, ["push", "--quiet", "origin", "main"], { cwd: repository.working, env: sandbox!.env });
  await runChecked(sandbox!.capabilities.git, ["--git-dir", repository.bare, "update-server-info"], { env: sandbox!.env });
}

describe("production failure, recovery, and package drift", () => {
  it("rejects an incompatible update and an interrupted acquisition without disturbing complete V1", async () => {
    sandbox = await createProductionE2ESandbox("production-failure-update");
    const model = await startProductionModelService(sandbox);
    const journey = await seedRemoteMarketplace(sandbox, { extraArgs: productionModelArgs });
    await installProductionBundle({ sandbox, rpc: journey.rpc, version: "v1" });

    await publishProductionBundleRevision(sandbox, journey.repository, "v2");
    // Incompatibility must trip a rule that still blocks under gentle
    // degradation: plaintext non-loopback MCP transport is a security gate.
    const manifestPath = join(journey.repository.working, "plugins", "production-bundle", ".claude-plugin", "plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.mcpServers.insecure = { type: "http", url: "http://example.invalid/mcp" };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await commitFixture(journey.repository, "incompatible production update");
    await journey.rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh");
    const rejected = await journey.rpc.plugin(`update ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.update");
    expect(rejected.envelope.status).not.toBe("ok");
    await observeProductionBundle(journey.rpc, activeV1, model);

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
    await observeProductionBundle(recovered, activeV1, model);
    expect(JSON.stringify(await recovered.plugin(`--non-interactive diagnose ${PRODUCTION_PLUGIN} --scope user`, "inspection.diagnose"))).not.toMatch(/PARTIAL|mixed/iu);
    await recovered.shutdown();
    await assertAllSqliteIntegrity(sandbox.agentDir);
  });

  it("recovers an owner killed after a production-bundle state commit to one whole revision", async () => {
    sandbox = await createProductionE2ESandbox("production-transition-kill");
    const model = await startProductionModelService(sandbox);
    const journey = await seedRemoteMarketplace(sandbox, { extraArgs: productionModelArgs });
    await installProductionBundle({ sandbox, rpc: journey.rpc, version: "v1" });
    await publishProductionBundleRevision(sandbox, journey.repository, "v2");
    expect((await journey.rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh")).envelope.status).toBe("ok");

    const update = journey.rpc.plugin(`update ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.update", 60_000);
    await waitForCondition("durable pending production transition", pendingProductionTransition, 15_000);
    journey.rpc.process.signal("SIGSTOP");
    journey.rpc.process.signal("SIGKILL");
    await journey.rpc.process.waitForExit(10_000);
    await update.catch(() => undefined);

    const recovered = await PiRpcProcess.start({ sandbox, extraArgs: productionModelArgs });
    expect(["v1", "v2", "recovery-required"]).toContain(await assertRecoveredProductionBundle(recovered, model));
    await recovered.shutdown();
    await assertAllSqliteIntegrity(sandbox.agentDir);
  });

  it("rejects corrupted candidate projection evidence without exposing a mixed production bundle", async () => {
    sandbox = await createProductionE2ESandbox("production-candidate-projection-corrupt");
    const model = await startProductionModelService(sandbox);
    const journey = await seedRemoteMarketplace(sandbox, { extraArgs: productionModelArgs });
    await installProductionBundle({ sandbox, rpc: journey.rpc, version: "v1" });
    await publishProductionBundleRevision(sandbox, journey.repository, "v2");
    expect((await journey.rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh")).envelope.status).toBe("ok");

    const update = journey.rpc.plugin(`update ${PRODUCTION_PLUGIN} --scope user --yes`, "lifecycle.update", 60_000);
    const transition = await waitForCondition("candidate projection committed for transition", pendingProductionTransition, 15_000);
    journey.rpc.process.signal("SIGSTOP");
    try {
      const projectionRef = transition.candidateProjection?.projectionRef;
      if (typeof projectionRef !== "string" || !projectionRef.startsWith("runtime-projection-v1:sha256:")) throw new Error("prepared transition has no candidate projection reference");
      const markerPath = join(sandbox.agentDir, "plugin-host", "generated", "v1", projectionRef.slice("runtime-projection-v1:sha256:".length));
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as { payload?: string };
      if (typeof marker.payload !== "string" || !/^\.payload-[0-9a-f]{32}$/u.test(marker.payload)) throw new Error("candidate projection marker has no payload");
      const candidateProjection = join(sandbox.agentDir, "plugin-host", "generated", "v1", marker.payload, "projection.json");
      await chmod(candidateProjection, 0o600);
      await writeFile(candidateProjection, "{\"corrupt\":true}\n");
    } finally {
      journey.rpc.process.signal("SIGKILL");
      await journey.rpc.process.waitForExit(10_000);
    }
    await update.catch(() => undefined);

    const recovered = await PiRpcProcess.start({ sandbox, extraArgs: productionModelArgs });
    const outcome = await assertRecoveredProductionBundle(recovered, model);
    expect(["v1", "recovery-required"]).toContain(outcome);
    const diagnosis = await recovered.plugin(`--non-interactive diagnose ${PRODUCTION_PLUGIN} --scope user`, "inspection.diagnose");
    expect(JSON.stringify(diagnosis.envelope.data)).not.toMatch(/mixed/iu);
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
    expect(failed).toMatch(/MCP_LAUNCH_FAILED|MCP_CONNECTION_FAILED|error/iu);
    expect(failed).not.toContain("missing-server.mjs");
    expect(await runProductionModelTurn(rpc, "PRODUCTION_MCP_JOURNEY_AFTER_FAILURE")).toContain("PARENT_MCP_OBSERVED");

    const cursor = rpc.events.length;
    const cancellation = runProductionModelTurn(rpc, "PRODUCTION_MCP_CANCEL");
    await waitForCondition("delayed MCP call start", async () => rpc.events.slice(cursor).some((event) =>
      event?.type === "tool_execution_start" && event?.toolName === "mcp" && event?.args?.action === "call" && String(event?.args?.args).includes("delay")) ? true : undefined, 30_000);
    await rpc.abort();
    await cancellation.catch(() => "cancelled");
    expect(await runProductionModelTurn(rpc, "PRODUCTION_MCP_JOURNEY_AFTER_CANCEL")).toContain("PARENT_MCP_OBSERVED");
    await rpc.shutdown();
  });

  it("fails version, tree/API, subagent, and combined drift closed before execution, then restores exact qualification", async () => {
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
    const treeDrift = async (kind: keyof typeof packagePaths): Promise<void> => {
      const relative = kind === "mcp" ? join("dist", "programmatic.js") : join("src", "index.ts");
      const path = join(packagePaths[kind], relative);
      const sentinel = join(sandbox!.root, `${kind}-drift-sentinel`);
      const original = await readFile(path, "utf8");
      await writeFile(path, `import { writeFileSync as __driftWrite } from \"node:fs\"; __driftWrite(${JSON.stringify(sentinel)}, \"executed\");\n${original}`);
    };
    const assertDrift = async (mcp: "available" | "unavailable", subagents: "available" | "unavailable"): Promise<void> => {
      const rpc = await PiRpcProcess.start({ sandbox: sandbox!, extraArgs: productionModelArgs });
      const [status, commands] = await Promise.all([
        rpc.plugin("--non-interactive status", "status"),
        rpc.request({ type: "get_commands" }),
      ]);
      expect(status.envelope.data.capabilities).toMatchObject({ mcp: { status: mcp }, subagents: { status: subagents } });
      expect(commands.data.commands).toContainEqual(expect.objectContaining({ name: "skill:core-local" }));
      expect(commands.data.commands).not.toContainEqual(expect.objectContaining({ name: "skill:production-bundle" }));
      await rpc.shutdown();
    };

    await versionDrift("mcp");
    await assertDrift("unavailable", "available");
    await restore("mcp");
    await treeDrift("mcp");
    await assertDrift("unavailable", "available");
    await access(join(sandbox.root, "mcp-drift-sentinel")).then(() => { throw new Error("drifted MCP code executed"); }, () => undefined);
    await restore("mcp");

    await versionDrift("subagents");
    await assertDrift("available", "unavailable");
    await restore("subagents");
    await treeDrift("subagents");
    await versionDrift("mcp");
    await assertDrift("unavailable", "unavailable");
    await access(join(sandbox.root, "subagents-drift-sentinel")).then(() => { throw new Error("drifted subagent code executed"); }, () => undefined);
    await restore("mcp");
    await restore("subagents");

    const restored = await PiRpcProcess.start({ sandbox, extraArgs: productionModelArgs });
    await observeProductionBundle(restored, activeV1, model);
    await restored.shutdown();
  });
});
