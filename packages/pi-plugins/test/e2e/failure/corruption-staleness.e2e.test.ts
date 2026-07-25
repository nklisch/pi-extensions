import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { cleanupSandbox, createCleanE2ESandbox, type CleanE2ESandbox } from "../harness/environment.js";
import { publishFixtureRevision } from "../harness/git-service.js";
import { seedRemoteMarketplace, startPackedRpc } from "../harness/journey.js";
import { PiRpcProcess } from "../harness/pi-rpc.js";
import { runChecked } from "../harness/process.js";
import { assertAllSqliteIntegrity, fileInventory, mutateCurrentPointer, publicStateDigest } from "../harness/state-inspector.js";

let sandbox: CleanE2ESandbox | undefined;
afterEach(async (context) => {
  if (sandbox !== undefined) await cleanupSandbox(sandbox, context);
  sandbox = undefined;
});

describe("packed corruption and stale authority failures", () => {
  it("diagnoses a digest-corrupt pointer without rewriting it and keeps project scope readable [idea-packed-corruption-startup-diagnosis]", async () => {
    sandbox = await createCleanE2ESandbox("failure-corrupt-pointer");
    const initial = await startPackedRpc(sandbox);
    await initial.shutdown();
    const state = join(sandbox.agentDir, "plugin-host", "state", "v1", "user.sqlite");
    await mutateCurrentPointer(state, "digest");
    const before = new DatabaseSync(state, { readOnly: true });
    const pointer = before.prepare("SELECT pointer_json FROM current_pointer WHERE singleton = 1").get() as { pointer_json: string };
    before.close();

    const recovered = await PiRpcProcess.start({ sandbox });
    const diagnosis = await recovered.plugin("--non-interactive diagnose", "inspection.diagnose", 15_000);
    expect(diagnosis.envelope.status).toBe("ok");
    expect(JSON.stringify(diagnosis.envelope.data)).toContain("STATE_CORRUPT");
    const sibling = await recovered.plugin("--non-interactive list --scope project --limit 50", "inspection.list");
    expect(sibling.envelope.status).toBe("ok");
    expect(sibling.envelope.data.items).toEqual([]);
    await recovered.shutdown();

    const after = new DatabaseSync(state, { readOnly: true });
    expect((after.prepare("SELECT pointer_json FROM current_pointer WHERE singleton = 1").get() as { pointer_json: string }).pointer_json).toBe(pointer.pointer_json);
    after.close();
    await assertAllSqliteIntegrity(sandbox.agentDir);
  });

  it("rejects mutated and missing operation capabilities without changing public authority", async () => {
    sandbox = await createCleanE2ESandbox("failure-stale-capabilities");
    const rpc = await startPackedRpc(sandbox);
    const before = await publicStateDigest(rpc);
    const tokens = [
      `trusted-install-session-v1:123e4567-e89b-42d3-a456-426614174000.${"a".repeat(64)}`,
      `trusted-install-session-v1:123e4567-e89b-42d3-a456-426614174000.${"b".repeat(64)}`,
      `native-operation-session-v1:123e4567-e89b-42d3-a456-426614174000.${"c".repeat(64)}`,
    ];
    for (const token of tokens) {
      const result = await rpc.plugin(`--non-interactive operation status ${token}`, "operation.status");
      expect(result.envelope.status).toMatch(/not-found|stale|failed/u);
      expect(result.envelope.exit.code).not.toBe(0);
    }
    expect(await publicStateDigest(rpc)).toBe(before);
    await rpc.shutdown();
  });

  it("expires an exact browse cursor after a real marketplace revision change", async () => {
    sandbox = await createCleanE2ESandbox("failure-stale-cursor");
    const journey = await seedRemoteMarketplace(sandbox);
    const first = await journey.rpc.plugin("--non-interactive browse --scope user --limit 1", "browse");
    const cursor = first.envelope.data.nextCursor as string;
    expect(cursor).toBeTruthy();
    await publishFixtureRevision(sandbox, journey.repository, "2.0.0", "v2");
    await journey.rpc.plugin("--non-interactive marketplace refresh", "marketplace.refresh");
    const stale = await journey.rpc.plugin(`--non-interactive browse --scope user --limit 1 --cursor ${cursor}`, "browse");
    expect(stale.envelope.status).toBe("stale");
    expect(stale.envelope.exit.code).not.toBe(0);
    await journey.rpc.shutdown();
  });

  it("rebuilds missing projection and isolates immutable installed-content tamper [idea-production-projection-publication]", async () => {
    sandbox = await createCleanE2ESandbox("failure-installed-corruption-xfail");
    const journey = await seedRemoteMarketplace(sandbox);
    const install = await journey.rpc.plugin("install core-local@native-e2e-market --scope user", "install.run");
    expect(install.envelope.data.kind).toBe("succeeded");
    await journey.rpc.shutdown();
    const inventory = await fileInventory(sandbox.agentDir);
    const projection = inventory.find((entry) => entry.path.endsWith("/projection.json"));
    expect(projection).toBeDefined();
    const projectionRoot = join(sandbox.agentDir, projection!.path, "..");
    await runChecked(sandbox.capabilities.chmod, ["-R", "u+w", projectionRoot]);
    await rm(projectionRoot, { recursive: true });
    const rebuilt = await PiRpcProcess.start({ sandbox });
    const resources = await rebuilt.request({ type: "get_commands" });
    expect(resources.data.commands).toContainEqual(expect.objectContaining({ name: "skill:core-local" }));
    await rebuilt.shutdown();

    const afterRebuildInventory = await fileInventory(sandbox.agentDir);
    const metadata = afterRebuildInventory.find((entry) => /stores\/v1\/plugins\/.+\/metadata\.json$/u.test(entry.path));
    expect(metadata).toBeDefined();
    const metadataPath = join(sandbox.agentDir, metadata!.path);
    await runChecked(sandbox.capabilities.chmod, ["u+w", metadataPath]);
    await writeFile(metadataPath, `${await readFile(metadataPath, "utf8")}tamper`);
    const blocked = await PiRpcProcess.start({ sandbox });
    const diagnosis = await blocked.plugin("--non-interactive diagnose core-local@native-e2e-market --scope user", "inspection.diagnose");
    expect(JSON.stringify(diagnosis.envelope.data)).toMatch(/CORRUPT|CONTENT|BLOCKED/u);
    const commands = await blocked.request({ type: "get_commands" });
    expect(commands.data.commands).not.toContainEqual(expect.objectContaining({ name: "skill:core-local" }));
    await blocked.shutdown();
  });
});
