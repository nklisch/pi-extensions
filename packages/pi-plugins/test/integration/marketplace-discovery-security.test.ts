import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createPackagedPluginHost } from "../../src/composition/create-packaged-plugin-host.js";
import { createLocalMarketplace, extensionContext, fakePi, runMarketplaceOperation } from "../helpers/packaged-marketplace.js";

const execFile = promisify(execFileCallback);

describe("packaged marketplace discovery security", () => {
  it("rejects credential URLs and symlink local roots without leaking paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-marketplace-security-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(project)]);
    const repository = await createLocalMarketplace(root);
    const alias = join(root, "marketplace-alias");
    await symlink(repository, alias);
    const context = extensionContext(project, false);
    const host = createPackagedPluginHost({ pi: fakePi().api as never, agentDir });
    try {
      const started = await host.start({ type: "session_start", reason: "startup" } as never, context as never);
      expect(started.startup.capabilities.secrets).toMatchObject({ status: "unavailable" });
      expect(JSON.stringify(started.startup)).not.toContain(root);
      const credential = await host.runWithPiOperationContext(context as never, new AbortController().signal, (application) =>
        application.control.runArgv(["marketplace", "add", "https://secret:marker@example.test/catalog.git", "--source-kind", "git"], { mode: "headless", output: "json" }, new AbortController().signal));
      expect(credential.envelope).toMatchObject({ status: "failed", exit: { code: 2 }, diagnostics: [{ code: "CONTROL_REQUEST_INVALID" }] });
      expect(JSON.stringify(credential)).not.toContain("secret");

      const symlinked = await runMarketplaceOperation(host, context, (marketplace, signal) => marketplace.registration.add({
        source: { kind: "local-git", path: alias },
        scope: "user",
        origin: { kind: "native" },
      }, signal));
      expect(symlinked).toEqual({ kind: "rejected", code: "INVALID_SOURCE" });
      expect(JSON.stringify(symlinked)).not.toContain(root);
    } finally {
      await host.dispose("quit");
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed when the bound project identity changes after startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-marketplace-project-identity-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(project)]);
    const context = extensionContext(project);
    const host = createPackagedPluginHost({ pi: fakePi().api as never, agentDir });
    try {
      await host.start({ type: "session_start", reason: "startup" } as never, context as never);
      await execFile("git", ["init", "--quiet", "-b", "main"], { cwd: project });

      const failure = await host.runWithPiOperationContext(context as never, new AbortController().signal, (application) =>
        application.control.runArgv(["browse", "--scope", "project"], { mode: "headless", output: "json" }, new AbortController().signal));

      expect(failure.envelope).toMatchObject({ status: "unavailable", diagnostics: [{ code: "ADAPTER_FAILED" }] });
      expect(JSON.stringify(failure)).not.toContain(root);
    } finally {
      await host.dispose("quit");
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
