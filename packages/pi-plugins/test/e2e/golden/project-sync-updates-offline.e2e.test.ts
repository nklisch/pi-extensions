import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupSandbox, createCleanE2ESandbox, type CleanE2ESandbox } from "../harness/environment.js";
import { publishFixtureConfigurationFreeRevision, publishFixtureRevision } from "../harness/git-service.js";
import { seedRemoteMarketplace } from "../harness/journey.js";
import { PiRpcProcess } from "../harness/pi-rpc.js";

let sandbox: CleanE2ESandbox | undefined;
afterEach(async (context) => {
  if (sandbox !== undefined) await cleanupSandbox(sandbox, context);
  sandbox = undefined;
});

describe("packed project sync, update policy, and offline restart", () => {
  it("publishes canonical portable project authority without machine state", async () => {
    sandbox = await createCleanE2ESandbox("golden-project-sync");
    const journey = await seedRemoteMarketplace(sandbox);
    const projectMarketplace = await journey.rpc.plugin(
      `--non-interactive marketplace add ${journey.git.url} --source-kind git`,
      "marketplace.add",
    );
    expect(projectMarketplace.envelope.status).toMatch(/ok|no-change/u);
    const projectBrowse = await journey.rpc.plugin("--non-interactive browse --scope project --limit 50", "browse");
    expect(projectBrowse.envelope.data.candidates).toContainEqual(expect.objectContaining({ plugin: "project-local@native-e2e-market", scope: expect.objectContaining({ kind: "project" }) }));
    const projectShow = await journey.rpc.plugin("--non-interactive show project-local@native-e2e-market --scope project", "inspection.show");
    expect(projectShow.envelope).toMatchObject({ status: "ok", data: { kind: "found", detail: { summary: { plugin: "project-local@native-e2e-market", scope: { kind: "project" } } } } });
    const projectInstall = await journey.rpc.plugin("install project-local@native-e2e-market --scope project", "install.run");
    expect(projectInstall.envelope.data.kind).toBe("succeeded");
    const result = await journey.rpc.plugin("project sync --mode publish-intent --yes", "project.sync");
    expect(result.envelope).toMatchObject({ status: "ok", data: { kind: "succeeded" } });
    const path = join(sandbox.project, ".pi", "plugins.json");
    const text = await readFile(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const intent = JSON.parse(text);
    expect(intent).toEqual({
      schemaVersion: 1,
      marketplaces: [],
      plugins: [{ plugin: "project-local@native-e2e-market", enabled: true }],
    });
    expect(text).not.toMatch(/\/tmp\/|revision|configuration|trust|cache|timestamp|secret/iu);
    const projectItems = await journey.rpc.plugin("--non-interactive list --scope project", "inspection.list");
    const userItems = await journey.rpc.plugin("--non-interactive list --scope user", "inspection.list");
    const converged = await journey.rpc.plugin("project sync --mode apply-intent", "project.sync");
    expect(projectItems.envelope.data.items).toContainEqual(expect.objectContaining({ plugin: "project-local@native-e2e-market", scope: expect.objectContaining({ kind: "project" }) }));
    expect(userItems.envelope.data.items).toEqual([]);
    expect(converged.envelope.status).toMatch(/ok|no-change/u);
    await journey.rpc.shutdown();
  });

  it("restarts offline from the selected local catalog without new Git requests", async () => {
    sandbox = await createCleanE2ESandbox("golden-offline-restart");
    const journey = await seedRemoteMarketplace(sandbox);
    const before = await journey.git.requestCount();
    await journey.rpc.shutdown();
    await journey.git.stop();
    sandbox.env.PI_OFFLINE = "1";
    const started = Date.now();
    const offline = await PiRpcProcess.start({ sandbox });
    const startupMs = Date.now() - started;
    const [status, browse] = await Promise.all([
      offline.plugin("--non-interactive status", "status"),
      offline.plugin("--non-interactive browse --scope user --limit 50", "browse"),
    ]);
    expect(startupMs).toBeLessThan(15_000);
    expect(status.envelope.status).toBe("ok");
    expect(browse.envelope.data.candidates).toContainEqual(expect.objectContaining({ plugin: "core-local@native-e2e-market" }));
    expect(await journey.git.requestCount()).toBe(before);
    await offline.shutdown();
  });

  it("deduplicates V2/V3 notices and applies exact manual/automatic updates [idea-production-projection-publication]", async () => {
    sandbox = await createCleanE2ESandbox("golden-update-notices-xfail");
    const journey = await seedRemoteMarketplace(sandbox);
    await journey.rpc.plugin("updates policy set --kind cadence --target global --cadence paused", "updates.policy.set");
    const installed = await journey.rpc.plugin("install core-local@native-e2e-market --scope user", "install.run");
    expect(installed.envelope.data.kind).toBe("succeeded");
    await publishFixtureRevision(sandbox, journey.repository, "2.0.0", "v2");
    await journey.rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh");
    const notices = await journey.rpc.plugin("--non-interactive updates notices list --scope user", "updates.notices.list");
    expect(notices.envelope.data.notices).toHaveLength(1);
    const noticeId = notices.envelope.data.notices[0].id as string;
    expect(noticeId).toMatch(/^update-notice-v1:/u);
    const updated = await journey.rpc.plugin("update core-local@native-e2e-market --scope user --yes", "lifecycle.update");
    expect(updated.envelope.data.kind).toBe("succeeded");

    const policy = await journey.rpc.plugin("--non-interactive updates policy preview --kind application --target global --mode automatic", "updates.policy.preview");
    expect(policy.envelope.data.kind).toBe("previewed");
    const previewId = policy.envelope.data.preview.previewId as string;
    const consentId = policy.envelope.data.preview.consent.consentId as string;
    const appliedPolicy = await journey.rpc.plugin(`--non-interactive updates policy apply --kind application --target global --mode automatic --preview-id ${previewId} --consent-id ${consentId}`, "updates.policy.apply");
    expect(appliedPolicy.envelope.data.kind).toBe("changed");

    // Automatic updates never copy revision-bound configuration. Removing the
    // descriptor makes this candidate independently ready while still changing
    // the executable surface covered by the explicit automatic policy.
    await publishFixtureConfigurationFreeRevision(sandbox, journey.repository, "3.0.0");
    await journey.rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh");
    const v3Notices = await journey.rpc.plugin("--non-interactive updates notices list --scope user", "updates.notices.list");
    expect(v3Notices.envelope.data.notices.filter((notice: any) => notice.unresolved)).toEqual([
      expect.objectContaining({ installed: "2.0.0", available: "3.0.0" }),
    ]);
    const automatic = await journey.rpc.plugin("updates automatic run", "updates.automatic.run");
    expect(automatic.envelope.data.outcomes).toContainEqual(expect.objectContaining({ kind: "applied" }));
    await journey.rpc.shutdown();
  });
});
