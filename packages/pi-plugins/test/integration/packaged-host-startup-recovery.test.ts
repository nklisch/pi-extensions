import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPackagedPluginHost } from "../../src/composition/create-packaged-plugin-host.js";
import { PackagedPluginHostErrorCode } from "../../src/composition/packaged-plugin-host-contract.js";

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

function context(cwd: string, sessionId = "packaged-startup-session") {
  return {
    cwd,
    mode: "interactive",
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    isProjectTrusted: () => true,
  };
}

describe("packaged host startup and recovery", () => {
  it("keeps construction inert, opens clean local authority on start, and closes idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-packaged-host-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(agentDir), mkdir(project)]));
    const fake = pi();
    let networkCalls = 0;
    const host = createPackagedPluginHost({
      pi: fake.api as never,
      agentDir,
      source: { fetch: (async () => { networkCalls += 1; throw new Error("startup must not call network"); }) as never },
    });
    await expect(stat(join(agentDir, "plugin-host"))).rejects.toMatchObject({ code: "ENOENT" });
    const started = await host.start({ type: "session_start", reason: "startup" } as never, context(project) as never);
    expect(started.startup.status).toBe("ready");
    expect(networkCalls).toBe(0);
    expect(started.startup.capabilities.mcp.status).toBe("unavailable");
    expect(started.startup.capabilities.subagents.status).toBe("unavailable");
    expect(Object.keys(started.application)).toEqual(["control"]);
    expect(started.application).not.toHaveProperty("lifecycle");
    expect(started.application).not.toHaveProperty("recovery");
    expect(() => started.application.control.runArgv(["status"], { mode: "direct", output: "json" }, new AbortController().signal)).toThrow(expect.objectContaining({ code: PackagedPluginHostErrorCode.reloadContextUnavailable }));
    await expect(host.start({ type: "session_start", reason: "startup" } as never, context(project, "other-session") as never))
      .rejects.toMatchObject({ code: PackagedPluginHostErrorCode.sessionMismatch });
    await expect(host.runWithPiOperationContext(context(project, "other-session") as never, new AbortController().signal, async () => undefined))
      .rejects.toMatchObject({ code: PackagedPluginHostErrorCode.sessionMismatch });
    await started.close();
    await started.close();
    await host.dispose("quit");
    await stat(join(agentDir, "plugin-host", "state", "v1", "user.sqlite"));
    await rm(root, { recursive: true, force: true });
  }, 30_000);
});
