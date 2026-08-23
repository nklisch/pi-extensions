import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupSandbox, createCleanE2ESandbox, type CleanE2ESandbox } from "../harness/environment.js";
import { seedRemoteMarketplace } from "../harness/journey.js";
import { PiRpcProcess } from "../harness/pi-rpc.js";
import { runChecked, waitForCondition } from "../harness/process.js";
import { pauseNextGitBackend, waitForFile } from "../harness/faults.js";
import { publicStateDigest } from "../harness/state-inspector.js";

let sandbox: CleanE2ESandbox | undefined;
afterEach(async (context) => {
  if (sandbox !== undefined) await cleanupSandbox(sandbox, context);
  sandbox = undefined;
});

describe("packed output, cancellation, and reload failure boundaries", () => {
  it("cancels a real slow Git refresh without replacing the selected catalog [idea-packed-refresh-cancellation-state-stale]", async () => {
    sandbox = await createCleanE2ESandbox("failure-cancel-refresh");
    const journey = await seedRemoteMarketplace(sandbox);
    const policy = await journey.rpc.plugin("updates policy set --kind cadence --target global --cadence paused", "updates.policy.set");
    expect(policy.envelope.status).toMatch(/ok|no-change/u);
    const baseline = journey.browse.envelope.data.candidates.map((entry: any) => [entry.plugin, entry.snapshot]);
    await pauseNextGitBackend(journey.git.controlFile);
    const pending = journey.rpc.plugin("--timeout-ms 500 marketplace refresh", "marketplace.refresh", 30_000);
    await waitForFile(journey.git.phaseFile, "backend-paused", 15_000);
    let cancelled;
    try { cancelled = await pending; } finally { journey.git.resume(); }
    expect(cancelled.envelope.status).toBe("cancelled");
    expect(JSON.stringify(cancelled.envelope.data)).toMatch(/CANCELLED|ABORTED|cancelled|aborted/u);
    const after = await journey.rpc.plugin("--non-interactive browse --scope user --limit 50", "browse");
    expect(after.envelope.data.candidates.map((entry: any) => [entry.plugin, entry.snapshot])).toEqual(baseline);
    await journey.rpc.shutdown();
  });

  it("keeps the selected catalog after malformed remote output", async () => {
    sandbox = await createCleanE2ESandbox("failure-malformed-refresh");
    const journey = await seedRemoteMarketplace(sandbox);
    const baseline = journey.browse.envelope.data.candidates.map((entry: any) => entry.id);
    await writeFile(join(journey.repository.working, ".claude-plugin", "marketplace.json"), "{malformed-json\n");
    await runChecked(sandbox.capabilities.git, ["add", "."], { cwd: journey.repository.working, env: sandbox.env });
    await runChecked(sandbox.capabilities.git, ["commit", "--quiet", "-m", "malformed catalog"], { cwd: journey.repository.working, env: sandbox.env });
    await runChecked(sandbox.capabilities.git, ["push", "--quiet", "origin", "main"], { cwd: journey.repository.working, env: sandbox.env });
    const refresh = await journey.rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh", 30_000);
    expect(refresh.envelope.status).not.toBe("ok");
    const after = await journey.rpc.plugin("--non-interactive browse --scope user --limit 50", "browse");
    expect(after.envelope.data.candidates.map((entry: any) => entry.id)).toEqual(baseline);
    await journey.rpc.shutdown();
  });

  it("survives a closed RPC output channel and reports converged state after restart", async () => {
    sandbox = await createCleanE2ESandbox("failure-closed-rpc-output");
    const journey = await seedRemoteMarketplace(sandbox);
    await journey.rpc.plugin("--non-interactive status", "status");
    journey.rpc.process.child.stdout.destroy();
    journey.rpc.process.write(`${JSON.stringify({ id: "closed-output", type: "prompt", message: `/${journey.rpc.commandName} status` })}\n`);
    journey.rpc.process.endInput();
    await journey.rpc.process.waitForExit(15_000).catch(async () => { await journey.rpc.process.terminate(); });
    const restarted = await PiRpcProcess.start({ sandbox });
    const status = await restarted.plugin("--non-interactive status", "status");
    expect(status.envelope.status).toBe("ok");
    expect(JSON.stringify(status.envelope)).not.toMatch(/RECOVERY_REQUIRED|PENDING_TRANSITION|recovery-required|pending-transition|staged/iu);
    await restarted.shutdown();
  });

  it("returns deterministic conflict evidence when two sessions race one target", async () => {
    sandbox = await createCleanE2ESandbox("failure-race-target");
    const journey = await seedRemoteMarketplace(sandbox);
    const installed = await journey.rpc.plugin("install core-local@native-e2e-market --scope user", "install.run");
    expect(installed.envelope.status).toBe("ok");
    const peer = await PiRpcProcess.start({ sandbox });
    const [left, right] = await Promise.all([
      journey.rpc.plugin("disable core-local@native-e2e-market --scope user --yes", "lifecycle.disable"),
      peer.plugin("disable core-local@native-e2e-market --scope user --yes", "lifecycle.disable"),
    ]);
    expect([left.envelope.status, right.envelope.status].every((status) => ["ok", "no-change", "conflict", "stale"].includes(status))).toBe(true);
    expect(JSON.stringify({ left, right })).not.toMatch(/recovery|required|pending/iu);
    expect(await publicStateDigest(journey.rpc)).toBe(await publicStateDigest(peer));
    await Promise.all([journey.rpc.shutdown(), peer.shutdown()]);
  });

  it("does not delay a retry on a foreign session's lifecycle operation", async () => {
    sandbox = await createCleanE2ESandbox("failure-foreign-session-retry");
    const journey = await seedRemoteMarketplace(sandbox);
    const peer = await PiRpcProcess.start({ sandbox });
    const before = Date.now();
    const report = await peer.plugin("--non-interactive status", "status");
    expect(report.envelope.status).toBe("ok");
    expect(Date.now() - before).toBeLessThan(10_000);
    await Promise.all([journey.rpc.shutdown(), peer.shutdown()]);
  });
});
