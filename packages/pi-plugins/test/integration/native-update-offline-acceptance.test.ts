import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPackagedPluginHost } from "../../src/composition/create-packaged-plugin-host.js";

function pi() {
  return {
    on() {},
    sendMessage() {},
    setSessionName() {},
  };
}

function context(cwd: string, sessionId: string) {
  return {
    cwd,
    mode: "interactive",
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
    isProjectTrusted: () => true,
  };
}

describe("native update offline packaged acceptance", () => {
  it("starts without network, applies policy through the facade, persists it across restart, and shuts down cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-native-update-offline-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(project)]);
    const firstContext = context(project, "offline-acceptance-1");
    const first = createPackagedPluginHost({ pi: pi() as never, agentDir });
    const started = await first.start({ type: "session_start", reason: "startup" } as never, firstContext as never);
    expect(started.startup).toMatchObject({ status: "ready", capabilities: { mcp: { status: "unavailable" }, subagents: { status: "unavailable" } } });

    await first.runWithPiOperationContext(firstContext as never, new AbortController().signal, async (application) => {
      const invoke = (argv: string[]) => application.control.runArgv(argv, { mode: "direct", output: "json" }, new AbortController().signal);
      const previewReport = await invoke(["updates", "policy", "preview", "--kind", "application", "--target", "global", "--mode", "automatic"]);
      const preview = previewReport.envelope.data as any;
      expect(preview.kind).toBe("previewed");
      const apply = await invoke(["updates", "policy", "apply", "--kind", "application", "--target", "global", "--mode", "automatic", "--preview-id", preview.preview.previewId, "--consent-id", preview.preview.consent.consentId]);
      expect(apply.envelope.data).toMatchObject({ kind: "changed" });
      const status = await invoke(["updates", "status", "--scope", "all-current"]);
      expect(status.envelope.data).toMatchObject({ policy: { global: { application: "automatic" } }, unreadCount: 0, unresolvedCount: 0 });
      const automatic = await invoke(["updates", "automatic", "run", "--limit", "10"]);
      expect(automatic.envelope.data).toEqual({ outcomes: [] });
    });
    await first.dispose("reload");

    const secondContext = context(project, "offline-acceptance-2");
    const second = createPackagedPluginHost({ pi: pi() as never, agentDir });
    const restarted = await second.start({ type: "session_start", reason: "startup" } as never, secondContext as never);
    expect(restarted.startup.status).toBe("ready");
    await second.runWithPiOperationContext(secondContext as never, new AbortController().signal, async (application) => {
      const report = await application.control.runArgv(["updates", "status", "--scope", "all-current"], { mode: "direct", output: "json" }, new AbortController().signal);
      expect(report.envelope.data).toMatchObject({ policy: { global: { application: "automatic" } }, unreadCount: 0, unresolvedCount: 0 });
    });
    await second.dispose("quit");
    await rm(root, { recursive: true, force: true });
  }, 30_000);
});
