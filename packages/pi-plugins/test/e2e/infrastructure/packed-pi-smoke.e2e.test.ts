import { afterEach, describe, expect, it } from "vitest";
import { E2E_CHECKOUT_ROOT, E2E_PI_VERSION } from "../harness/constants.js";
import {
  cleanupSandbox,
  createCleanE2ESandbox,
  installPackedProduct,
  loadSuiteArtifact,
  type CleanE2ESandbox,
} from "../harness/environment.js";
import { PiRpcProcess } from "../harness/pi-rpc.js";
import { createGitFixtureRepository, startGitService } from "../harness/git-service.js";
import { closeNextGitConnection } from "../harness/faults.js";
import { runCommand, runChecked } from "../harness/process.js";
import { assertNoConsumerCheckoutResolution, assertAllSqliteIntegrity, fileInventory } from "../harness/state-inspector.js";

let sandbox: CleanE2ESandbox | undefined;
afterEach(async (context) => {
  if (sandbox !== undefined) await cleanupSandbox(sandbox, context);
  sandbox = undefined;
});

describe("packed clean-environment Pi infrastructure", () => {
  it("installs the tarball through npm and Pi 0.80.8, discovers /plugin, and shuts down locally", async () => {
    const artifact = await loadSuiteArtifact();
    expect(artifact.packFiles).toContain("dist/pi/extension.js");
    expect(artifact.packFiles).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^src\//u),
      expect.stringMatching(/^test\//u),
      expect.stringMatching(/^\.work\//u),
    ]));

    sandbox = await createCleanE2ESandbox("packed-smoke");
    await installPackedProduct(sandbox);
    expect(sandbox.installedList).toContain(sandbox.packageRoot);
    expect(sandbox.installedList).not.toContain(E2E_CHECKOUT_ROOT);
    await assertNoConsumerCheckoutResolution(sandbox);

    const rpc = await PiRpcProcess.start({ sandbox });
    const commands = await rpc.request({ type: "get_commands" });
    const owned = commands.data.commands.filter((command: any) => command.source === "extension" && command.name === rpc.commandName);
    expect(owned).toHaveLength(1);
    expect(owned[0].path ?? owned[0].sourceInfo?.path).toBe(sandbox.extensionPath);

    const status = await rpc.plugin("--non-interactive status", "status");
    expect(status.envelope).toMatchObject({
      command: { id: "status" },
      status: "ok",
      exit: { code: 0 },
      data: {
        local: { recovery: "settled", runtime: "reconciled" },
        capabilities: {
          mcp: { status: "available" },
          subagents: { status: "available" },
        },
      },
    });
    expect(JSON.stringify(status)).not.toContain(E2E_CHECKOUT_ROOT);
    expect(await fileInventory(sandbox.home)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringMatching(/\.claude|\.codex/u) }),
    ]));

    await rpc.shutdown();
    await assertAllSqliteIntegrity(sandbox.agentDir);
    const piManifest = await import(`${sandbox.consumer}/node_modules/@earendil-works/pi-coding-agent/package.json`, { with: { type: "json" } });
    expect((piManifest.default as { version: string }).version).toBe(E2E_PI_VERSION);
  });

  it("composes the bundled published subagent lifecycle from one top-level Pi installation", async () => {
    sandbox = await createCleanE2ESandbox("published-subagents");
    await installPackedProduct(sandbox);
    expect(sandbox.installedList).toContain("@nklisch/pi-plugins");
    expect(sandbox.installedList).not.toContain("@nklisch/pi-subagents");

    const rpc = await PiRpcProcess.start({ sandbox });
    const [commands, status] = await Promise.all([
      rpc.request({ type: "get_commands" }),
      rpc.plugin("--non-interactive status", "status"),
    ]);
    expect(commands.data.commands).toContainEqual(expect.objectContaining({
      name: "subagents:settings",
      sourceInfo: expect.objectContaining({ path: expect.stringMatching(/production-subagents-extension\.js$/u) }),
    }));
    expect(status.envelope.data).toMatchObject({ capabilities: { subagents: { status: "available" } } });
    expect(JSON.stringify(status)).not.toContain("@nklisch/pi-subagents");
    expect(JSON.stringify(status)).not.toContain(sandbox.consumer);
    await rpc.shutdown();
  });

  it("serves a bare fixture through real HTTPS git-http-backend and exposes deterministic external faults", async () => {
    sandbox = await createCleanE2ESandbox("git-service-smoke");
    const repository = await createGitFixtureRepository(sandbox);
    const service = await startGitService(sandbox, repository);
    const clone = `${sandbox.root}/git-clone`;
    await runChecked(sandbox.capabilities.git, ["clone", "--quiet", service.url, clone], {
      cwd: sandbox.project,
      env: sandbox.env,
      timeoutMs: 30_000,
    });
    expect(await fileInventory(clone)).toContainEqual(expect.objectContaining({ path: ".claude-plugin/marketplace.json", kind: "file" }));
    expect(await service.requestCount()).toBeGreaterThan(0);

    service.pause();
    service.resume();
    await closeNextGitConnection(service.controlFile);
    const failed = await runCommand(sandbox.capabilities.git, ["ls-remote", service.url], {
      cwd: sandbox.project,
      env: sandbox.env,
      timeoutMs: 30_000,
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).not.toContain(E2E_CHECKOUT_ROOT);
  });
});
