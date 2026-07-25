import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupSandbox, createCleanE2ESandbox, installPackedProduct, type CleanE2ESandbox } from "../harness/environment.js";
import { diagnoseClockFault, pauseNextGitBackend, regressedClockEnvironment, waitForFile } from "../harness/faults.js";
import { createGitFixtureRepository, startGitService } from "../harness/git-service.js";
import { seedRemoteMarketplace } from "../harness/journey.js";
import { PiRpcProcess } from "../harness/pi-rpc.js";
import { runChecked, waitForCondition } from "../harness/process.js";
import { assertAllSqliteIntegrity } from "../harness/state-inspector.js";

let sandbox: CleanE2ESandbox | undefined;
afterEach(async (context) => {
  if (sandbox !== undefined) await cleanupSandbox(sandbox, context);
  sandbox = undefined;
});

async function renameMarketplace(sandbox: CleanE2ESandbox, working: string, bare: string, name: string): Promise<void> {
  const path = join(working, ".claude-plugin", "marketplace.json");
  const value = JSON.parse(await readFile(path, "utf8"));
  value.name = name;
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  await runChecked(sandbox.capabilities.git, ["add", "."], { cwd: working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["commit", "--quiet", "-m", `rename ${name}`], { cwd: working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["push", "--quiet", "origin", "main"], { cwd: working, env: sandbox.env });
  await runChecked(sandbox.capabilities.git, ["--git-dir", bare, "update-server-info"], { env: sandbox.env });
}

describe("packed multiprocess contention, network loss, and clock regression", () => {
  it("serializes same registration authority and lets distinct registrations converge [idea-distinct-marketplace-add-contention]", async () => {
    sandbox = await createCleanE2ESandbox("chaos-multiprocess-contention");
    await installPackedProduct(sandbox);
    const first = await createGitFixtureRepository(sandbox, "marketplace");
    const second = await createGitFixtureRepository(sandbox, "marketplace-two");
    const third = await createGitFixtureRepository(sandbox, "marketplace-three");
    await renameMarketplace(sandbox, second.working, second.bare, "native-e2e-market-two");
    await renameMarketplace(sandbox, third.working, third.bare, "native-e2e-market-three");
    const git = await startGitService(sandbox, first);
    sandbox.env.PI_OFFLINE = "0";
    let left = await PiRpcProcess.start({ sandbox });
    await left.plugin("updates policy set --kind cadence --target global --cadence paused", "updates.policy.set");
    let right = await PiRpcProcess.start({ sandbox });
    try {
      const same = await Promise.all([
        left.plugin(`--non-interactive marketplace add ${git.url} --source-kind git`, "marketplace.add", 60_000),
        right.plugin(`--non-interactive marketplace add ${git.url} --source-kind git`, "marketplace.add", 60_000),
      ]);
      expect(same.filter((result) => result.envelope.status === "ok")).toHaveLength(1);
      expect(same.every((result) => /ok|no-change|stale/u.test(result.envelope.status))).toBe(true);

      // A no-change loser has observed the winner's authority but intentionally
      // keeps its immutable process snapshot. Restart both participants so the
      // distinct-target check begins from the same committed generation.
      await Promise.all([left.shutdown(), right.shutdown()]);
      [left, right] = await Promise.all([PiRpcProcess.start({ sandbox }), PiRpcProcess.start({ sandbox })]);
      const base = `https://127.0.0.1:${new URL(git.url).port}`;
      const distinct = await Promise.all([
        left.plugin(`--non-interactive marketplace add ${base}/marketplace-two.git --source-kind git`, "marketplace.add", 60_000),
        right.plugin(`--non-interactive marketplace add ${base}/marketplace-three.git --source-kind git`, "marketplace.add", 60_000),
      ]);
      expect(distinct.every((result) => /ok|no-change/u.test(result.envelope.status))).toBe(true);
      const [leftList, rightList] = await Promise.all([
        left.plugin("--non-interactive marketplace list --limit 50", "marketplace.list"),
        right.plugin("--non-interactive marketplace list --limit 50", "marketplace.list"),
      ]);
      expect(leftList.envelope.data.registrations).toHaveLength(3);
      expect(rightList.envelope.data.registrations.map((entry: any) => entry.id).sort())
        .toEqual(leftList.envelope.data.registrations.map((entry: any) => entry.id).sort());
    } finally {
      await Promise.all([left.shutdown(), right.shutdown()]);
    }
    await assertAllSqliteIntegrity(sandbox.agentDir);
  });

  it("kills Git during acquisition, retains the old catalog, and restarts offline without a request", async () => {
    sandbox = await createCleanE2ESandbox("chaos-network-loss");
    const journey = await seedRemoteMarketplace(sandbox);
    const baseline = journey.browse.envelope.data.candidates.map((entry: any) => entry.snapshot);
    await journey.rpc.plugin("updates policy set --kind cadence --target global --cadence paused", "updates.policy.set");
    await pauseNextGitBackend(journey.git.controlFile);
    const refresh = journey.rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh", 30_000);
    await waitForFile(journey.git.phaseFile, "backend-paused", 15_000);
    await journey.git.kill();
    const failed = await refresh;
    expect(failed.envelope.status).toMatch(/partial|failed|cancelled/u);
    const retained = await journey.rpc.plugin("--non-interactive browse --scope user --limit 50", "browse");
    expect(retained.envelope.data.candidates.map((entry: any) => entry.snapshot)).toEqual(baseline);
    const requests = await journey.git.requestCount();
    await journey.rpc.shutdown();
    sandbox.env.PI_OFFLINE = "1";
    const offline = await PiRpcProcess.start({ sandbox });
    expect((await offline.plugin("--non-interactive status", "status")).envelope.status).toBe("ok");
    expect(await journey.git.requestCount()).toBe(requests);
    await offline.shutdown();
  });

  it("runs the pinned whole-process clock fault or records an explicit unavailable diagnosis", async () => {
    sandbox = await createCleanE2ESandbox("chaos-clock-regression");
    const diagnosis = await diagnoseClockFault(sandbox);
    if (!diagnosis.available) {
      expect(diagnosis.reason).toMatch(/libfaketime|pinned/u);
      return;
    }
    const journey = await seedRemoteMarketplace(sandbox);
    await journey.rpc.shutdown();
    const requests = await journey.git.requestCount();
    const regressed = await PiRpcProcess.start({ sandbox, env: regressedClockEnvironment(sandbox) });
    const status = await waitForCondition(
      "clock-regressed scheduler status",
      async () => {
        const report = await regressed.plugin("--non-interactive status", "status");
        return report.envelope.data.update.state === "clock-regressed" ? report : undefined;
      },
      15_000,
    );
    expect(status.envelope.data.update.state).toBe("clock-regressed");
    expect(await journey.git.requestCount()).toBe(requests);
    await regressed.shutdown();
    const normal = await PiRpcProcess.start({ sandbox });
    expect((await normal.plugin("--non-interactive status", "status")).envelope.data.update.state).not.toBe("clock-regressed");
    await normal.shutdown();
  });
});
