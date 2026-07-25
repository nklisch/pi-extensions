import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPackagedPluginHost, PackagedPluginHostErrorCode } from "../../src/pi/index.js";

function pi() {
  const handlers = new Map<string, Array<(event: unknown, context: unknown) => unknown>>();
  return {
    api: {
      on(name: string, handler: (event: unknown, context: unknown) => unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      sendMessage() {},
      setSessionName() {},
    },
    handlers,
  };
}
function context(cwd: string, id = "session") {
  return { cwd, mode: "interactive", sessionManager: { getSessionId: () => id, getSessionFile: () => undefined }, isProjectTrusted: () => true };
}

describe("packaged host disposal matrix", () => {
  it("rejects duplicate roots and releases the process-local claim on repeated disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-host-duplicate-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    const fake = pi();
    const first = createPackagedPluginHost({ pi: fake.api as never, agentDir });
    expect(() => createPackagedPluginHost({ pi: fake.api as never, agentDir })).toThrowError(expect.objectContaining({ code: PackagedPluginHostErrorCode.duplicateComposition }));
    await first.dispose("quit");
    await first.dispose("quit");
    const replacement = createPackagedPluginHost({ pi: fake.api as never, agentDir });
    await replacement.dispose("quit");
    await rm(root, { recursive: true, force: true });
  });

  it("reverse-cleans a partial startup and permits a fresh composition claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-host-partial-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(project)]);
    await writeFile(join(agentDir, "plugin-host"), "not-a-directory");
    const fake = pi();
    const failed = createPackagedPluginHost({ pi: fake.api as never, agentDir });
    await expect(failed.start({ type: "session_start", reason: "startup" } as never, context(project) as never)).rejects.toMatchObject({ code: PackagedPluginHostErrorCode.startupFailed });
    await failed.dispose("quit");
    const replacement = createPackagedPluginHost({ pi: fake.api as never, agentDir });
    await replacement.dispose("quit");
    await rm(root, { recursive: true, force: true });
  });

  it("exposes control execution only through admitted operation context", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-host-update-admission-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(project)]);
    const fake = pi();
    const bound = context(project);
    const host = createPackagedPluginHost({ pi: fake.api as never, agentDir });
    const started = await host.start({ type: "session_start", reason: "startup" } as never, bound as never);
    expect(() => started.application.control.runArgv(["updates", "status"], { mode: "direct", output: "json" }, new AbortController().signal))
      .toThrowError(expect.objectContaining({ code: PackagedPluginHostErrorCode.reloadContextUnavailable }));
    await expect(host.runWithPiOperationContext(bound as never, new AbortController().signal, (application) =>
      application.control.runArgv(["updates", "status"], { mode: "direct", output: "json" }, new AbortController().signal)))
      .resolves.toMatchObject({ envelope: { data: { unreadCount: 0, unresolvedCount: 0 } } });
    expect(Object.keys(started.application)).toEqual(["control"]);
    await host.dispose("quit");
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  it("drains admitted work before quit closes its application adapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-host-quit-drain-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(project)]);
    const fake = pi();
    const bound = context(project);
    const host = createPackagedPluginHost({ pi: fake.api as never, agentDir });
    await host.start({ type: "session_start", reason: "startup" } as never, bound as never);
    let continueOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => { continueOperation = resolve; });
    const operation = host.runWithPiOperationContext(bound as never, new AbortController().signal, async (application) => {
      const report = await application.control.runArgv(["marketplace", "list"], { mode: "direct", output: "json" }, new AbortController().signal);
      await operationGate;
      return report.envelope.data;
    });

    const disposal = host.dispose("quit");
    await expect(host.runWithPiOperationContext(bound as never, new AbortController().signal, async () => undefined))
      .rejects.toMatchObject({ code: PackagedPluginHostErrorCode.terminal });
    continueOperation();
    await expect(operation).resolves.toEqual({ registrations: [] });
    await disposal;
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  it("quiesces shutdown admission but keeps pinned application adapters live until an admitted operation settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-host-operation-lease-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(project)]);
    const fake = pi();
    const bound = context(project);
    const host = createPackagedPluginHost({ pi: fake.api as never, agentDir });
    const started = await host.start({ type: "session_start", reason: "startup" } as never, bound as never);
    let continueOperation!: () => void;
    const operationGate = new Promise<void>((resolve) => { continueOperation = resolve; });
    const operation = host.runWithPiOperationContext(bound as never, new AbortController().signal, async (application) => {
      const report = await application.control.runArgv(["marketplace", "list"], { mode: "direct", output: "json" }, new AbortController().signal);
      await operationGate;
      return report.envelope.data;
    });

    const shutdown = fake.handlers.get("session_shutdown")?.[0];
    await shutdown?.({ type: "session_shutdown", reason: "reload" }, bound);
    await expect(host.runWithPiOperationContext(bound as never, new AbortController().signal, async () => undefined))
      .rejects.toMatchObject({ code: PackagedPluginHostErrorCode.terminal });
    continueOperation();
    await expect(operation).resolves.toEqual({ registrations: [] });
    await host.dispose("reload");
    expect(() => started.application.control.runArgv(["status"], { mode: "direct", output: "json" }, new AbortController().signal)).toThrowError(expect.objectContaining({ code: PackagedPluginHostErrorCode.reloadContextUnavailable }));
    await rm(root, { recursive: true, force: true });
  }, 30_000);
});
