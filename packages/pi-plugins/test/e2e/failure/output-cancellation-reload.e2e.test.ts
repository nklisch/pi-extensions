import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cleanupSandbox, createCleanE2ESandbox, type CleanE2ESandbox } from "../harness/environment.js";
import { seedRemoteMarketplace } from "../harness/journey.js";
import { PiRpcProcess } from "../harness/pi-rpc.js";
import { ManagedProcess, runChecked, waitForCondition } from "../harness/process.js";
import { pauseNextGitBackend, waitForFile } from "../harness/faults.js";
import { publicStateDigest } from "../harness/state-inspector.js";

const lockHolderFixture = resolve(process.cwd(), "test/fixtures/locking/child-lock-holder.mjs");

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
    try {
      cancelled = await pending;
    } finally {
      journey.git.resume();
    }
    expect(cancelled.envelope.status).toBe("cancelled");
    expect(JSON.stringify(cancelled.envelope.data)).toMatch(/CANCELLED|ABORTED|cancelled|aborted/u);
    const after = await journey.rpc.plugin("--non-interactive browse --scope user --limit 50", "browse");
    expect(after.envelope.data.candidates.map((entry: any) => [entry.plugin, entry.snapshot])).toEqual(baseline);
    await journey.rpc.shutdown();
  });

  it("cancels a real lock-stalled packed operation and preserves missing and post-commit owner truth", async () => {
    sandbox = await createCleanE2ESandbox("failure-operation-cancel");
    const journey = await seedRemoteMarketplace(sandbox);
    const opened = await journey.rpc.plugin("--non-interactive install open core-local@native-e2e-market --scope user", "install.open");
    expect(opened.envelope).toMatchObject({ status: "ok", data: { kind: "opened" } });
    const token = opened.envelope.operation.token as string;
    const before = await publicStateDigest(journey.rpc);

    const holder = ManagedProcess.start(process.execPath, [lockHolderFixture, join(sandbox.agentDir, "plugin-host", "locks", "v1", "user.sqlite")], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: "", VITEST: undefined },
      label: "E2E user-scope lock holder",
    });
    const releaseHolder = async () => {
      if (holder.exited() !== undefined) return;
      holder.write("release\n");
      await holder.waitForExit(10_000);
      holder.assertGroupReleased();
    };
    try {
      await holder.waitForOutput('"kind":"ready"', { timeoutMs: 15_000 });
      const applying = journey.rpc.plugin(`install apply ${token}`, "install.apply", 60_000);
      await waitForCondition("packed operation stalls at pre-commit trust mutation", async () => {
        const entries = await journey.rpc.getEntries();
        return entries.data.entries?.some((entry: any) =>
          entry?.type === "custom" && entry.customType === "plugin-host:control-frame-v1" &&
          entry.data?.type === "progress" && entry.data.phase === "trust-decision" && entry.data.state === "started")
          ? true
          : undefined;
      }, 15_000);

      const peer = await PiRpcProcess.start({ sandbox });
      const missing = await peer.plugin(`--non-interactive operation cancel ${token}`, "operation.cancel");
      expect(missing.envelope).toMatchObject({ status: "not-found", data: { kind: "missing" } });
      await peer.shutdown();

      const cancelled = await journey.rpc.plugin(`--non-interactive operation cancel ${token}`, "operation.cancel");
      expect(cancelled.envelope).toMatchObject({ status: "ok", data: { kind: "accepted", state: "activating" } });
      await releaseHolder();
      expect((await applying).envelope).toMatchObject({ status: "cancelled", data: { kind: "cancelled" } });
      const cancelledStatus = await journey.rpc.plugin(`--non-interactive operation status ${token}`, "operation.status");
      expect(cancelledStatus.envelope).toMatchObject({ status: "ok", data: { kind: "found", session: { state: "cancelled" }, result: { kind: "cancelled" } } });
      expect(await publicStateDigest(journey.rpc)).toBe(before);
      const freshAfterCancel = await PiRpcProcess.start({ sandbox });
      expect((await freshAfterCancel.plugin("--non-interactive list --scope user", "inspection.list")).envelope.data.items).not.toContainEqual(
        expect.objectContaining({ plugin: "core-local@native-e2e-market" }),
      );
      await freshAfterCancel.shutdown();

      const reopened = await journey.rpc.plugin("--non-interactive install open core-local@native-e2e-market --scope user", "install.open");
      const committedToken = reopened.envelope.operation.token as string;
      const committed = await journey.rpc.plugin(`install apply ${committedToken}`, "install.apply");
      expect(committed.envelope).toMatchObject({ status: "ok", data: { kind: "succeeded" } });
      const postCommitCancel = await journey.rpc.plugin(`--non-interactive operation cancel ${committedToken}`, "operation.cancel");
      expect(postCommitCancel.envelope).toMatchObject({ status: "not-found", data: { kind: "missing" } });
      const committedStatus = await journey.rpc.plugin(`--non-interactive operation status ${committedToken}`, "operation.status");
      expect(committedStatus.envelope).toMatchObject({ status: "not-found", data: { kind: "missing" } });
      const installed = await journey.rpc.plugin("--non-interactive list --scope user", "inspection.list");
      expect(installed.envelope.data.items).toContainEqual(expect.objectContaining({ plugin: "core-local@native-e2e-market" }));
      await journey.rpc.shutdown();
    } finally {
      await releaseHolder().catch(async () => { await holder.terminate(); });
    }
  });

  it("keeps the last selected catalog after malformed remote output", async () => {
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

  it("survives a closed RPC output channel and reports durable state after restart", async () => {
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
    await restarted.shutdown();
  });

  it("preserves rolled-back recovery truth when the operation owner dies before successor proof", async () => {
    sandbox = await createCleanE2ESandbox("failure-reload-owner");
    const journey = await seedRemoteMarketplace(sandbox);
    const opened = await journey.rpc.plugin("--non-interactive install open core-local@native-e2e-market --scope user", "install.open");
    const token = opened.envelope.operation.token as string;
    const peer = await PiRpcProcess.start({ sandbox });
    const applying = journey.rpc.plugin(`install apply ${token}`, "install.apply", 60_000);
    const statePath = join(sandbox.agentDir, "plugin-host", "state", "v1", "user.sqlite");
    await waitForCondition("durable pending lifecycle authority", () => {
      let database: DatabaseSync | undefined;
      try {
        database = new DatabaseSync(statePath, { readOnly: true });
        return database.prepare("SELECT 1 AS present FROM state_blobs WHERE document LIKE '%pending-transition-v1:%' LIMIT 1").get() === undefined
          ? undefined
          : true;
      } catch {
        return undefined;
      } finally {
        database?.close();
      }
    }, 15_000);
    journey.rpc.process.signal("SIGSTOP");
    try {
      const pending = await peer.plugin("--non-interactive show core-local@native-e2e-market --scope user", "inspection.show");
      expect(pending.envelope).toMatchObject({ status: "ok", data: { kind: "found", detail: { lifecycle: { installed: true } } } });
      expect(pending.envelope.data.detail.lifecycle.transition).not.toBe("none");
    } finally {
      journey.rpc.process.signal("SIGKILL");
      await journey.rpc.process.waitForExit(10_000);
    }
    await applying.catch(() => undefined);
    await peer.shutdown();

    const successor = await PiRpcProcess.start({ sandbox });
    const cancelAfterOwnerLoss = await successor.plugin(`--non-interactive operation cancel ${token}`, "operation.cancel");
    expect(cancelAfterOwnerLoss.envelope).toMatchObject({ status: "not-found", data: { kind: "missing" } });
    const installed = await successor.plugin("--non-interactive list --scope user", "inspection.list");
    expect(installed.envelope.data.items).not.toContainEqual(expect.objectContaining({ plugin: "core-local@native-e2e-market" }));
    const detail = await successor.plugin("--non-interactive show core-local@native-e2e-market --scope user", "inspection.show");
    expect(detail.envelope.data.detail.lifecycle).toMatchObject({ installed: false, transition: "none" });
    const commands = await successor.request({ type: "get_commands" });
    expect(commands.data.commands).not.toContainEqual(expect.objectContaining({ name: "skill:core-local" }));
    const operations = await successor.plugin("--non-interactive diagnose core-local@native-e2e-market --scope user", "inspection.diagnose");
    expect(JSON.stringify(operations.envelope.data)).not.toMatch(/STALE_CONTEXT|PARTIAL/u);
    await successor.shutdown();
  });
});
