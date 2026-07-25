import { describe, expect, it, vi } from "vitest";
import { createNativePluginControlService } from "../../src/application/native-control-service.js";

const status = { status: "ready", local: { recovery: "settled", runtime: "reconciled" }, update: { state: "standby", unreadCount: 0, unresolvedCount: 0, scopes: [] }, blocked: [], capabilities: { mcp: { status: "unavailable", explanation: "none" }, subagents: { status: "unavailable", explanation: "none" }, piReload: { status: "available", explanation: "yes" }, secrets: { status: "available", explanation: "yes" } } } as const;
function fixture() {
  let counter = 0;
  const ids = { issue: vi.fn(async () => `native-control-execution-v1:123e4567-e89b-42d3-a456-${String(426614174000 + counter++).padStart(12, "0")}` as never) };
  const applications = {
    marketplace: { registration: { add: vi.fn(), remove: vi.fn(), list: vi.fn(async () => ({ registrations: [] })) }, refresh: { refresh: vi.fn() }, catalog: { search: vi.fn(async () => ({ candidates: [], observations: [] })), detail: vi.fn() }, adoption: { preview: vi.fn(async () => ({ candidates: [], documents: [], diagnostics: [] })), import: vi.fn() } },
    inspection: { list: vi.fn(), detail: vi.fn(), diagnose: vi.fn() },
    trustedInstallation: { open: vi.fn(), activate: vi.fn(), recover: vi.fn(), run: vi.fn(), status: vi.fn(), cancel: vi.fn() },
    operations: { preview: vi.fn(), apply: vi.fn(), run: vi.fn(), status: vi.fn(), cancel: vi.fn() },
    updates: { previewPolicy: vi.fn(), applyPolicy: vi.fn(), status: vi.fn(), notifications: vi.fn(), acknowledge: vi.fn(), runAutomatic: vi.fn() },
    status: { snapshot: vi.fn(() => status) },
    currentProject: { current: vi.fn(async () => ({ kind: "unavailable" })) },
  };
  const service = createNativePluginControlService({ applications: applications as never, ids, timeouts: { arm: vi.fn((_ms, parent) => ({ signal: parent, dispose: vi.fn() })) } });
  return { service, applications, ids };
}
const options = { mode: "direct" as const, output: "json" as const };

describe("native plugin control service", () => {
  it("constructs inert and rejects hostile parse before IDs/services/output", async () => {
    const { service, applications, ids } = fixture();
    expect(ids.issue).not.toHaveBeenCalled();
    const sink = { write: vi.fn(), close: vi.fn() };
    const report = await service.runArgv(["unknown", "--secret", "canary"], { ...options, sink }, new AbortController().signal);
    expect(report.envelope).toMatchObject({ status: "failed", exit: { code: 2 } });
    expect(report.envelope.executionId).toContain("00000000-0000-4000-8000");
    expect(ids.issue).not.toHaveBeenCalled();
    expect(sink.write).not.toHaveBeenCalled();
    expect(applications.status.snapshot).not.toHaveBeenCalled();
  });

  it("converges typed argv and text calls on one dispatcher", async () => {
    const { service, applications, ids } = fixture();
    const parsed = service.parseArgv(["status"]);
    if (parsed.kind !== "parsed") throw new Error("fixture failed");
    const typed = await service.execute(parsed.command, options, new AbortController().signal);
    const argv = await service.runArgv(["status"], options, new AbortController().signal);
    const text = await service.runText("status", options, new AbortController().signal);
    expect([typed, argv, text].map((entry) => ({ status: entry.envelope.status, data: entry.envelope.data, exit: entry.envelope.exit }))).toEqual(Array(3).fill({ status: "ok", data: status, exit: { classification: "success", code: 0 } }));
    expect(applications.status.snapshot).toHaveBeenCalledTimes(3);
    expect(ids.issue).toHaveBeenCalledTimes(3);
  });

  it("marks an explicit caller input port as the provided safe channel", async () => {
    const { service, applications } = fixture();
    const token = `trusted-install-session-v1:123e4567-e89b-42d3-a456-426614174000.${"a".repeat(64)}`;
    applications.trustedInstallation.status.mockResolvedValue({ kind: "found", session: { token, version: 0, fields: [], consent: { consentId: `trusted-install-consent-v1:sha256:${"b".repeat(64)}` }, binding: { plugin: "demo@market", scope: { kind: "user" }, immutableRevision: `sha256:${"c".repeat(64)}`, executableSurfaceDigest: `sha256:${"d".repeat(64)}` } } } as never);
    let channel: unknown;
    const input = { collect: async (request: any) => { channel = request.channel; return { kind: "unavailable" as const, code: "NO_INPUT_CHANNEL" as const }; } };
    const report = await service.runArgv(["install", "apply", token], { ...options, input }, new AbortController().signal);
    expect(channel).toEqual({ kind: "provided" });
    expect(report.envelope.status).toBe("input-required");
  });

  it.each([
    ["untrusted", "rejected", 7, "CONTROL_PROJECT_UNTRUSTED", "confirm-exact"],
    ["stale", "stale", 5, "CONTROL_PROJECT_STALE", "reparse"],
    ["unavailable", "unavailable", 6, "CONTROL_PROJECT_UNAVAILABLE", "retry"],
  ] as const)("preserves exact %s current-project policy and sync classification", async (kind, expectedStatus, exit, code, action) => {
    const { service, applications } = fixture();
    applications.currentProject.current.mockResolvedValue({ kind } as never);
    for (const argv of [
      ["project", "sync", "--mode", "apply-intent", "--preview-only"],
      ["updates", "policy", "preview", "--kind", "application", "--target", "scope", "--scope", "project", "--mode", "manual"],
    ]) {
      const report = await service.runArgv(argv, options, new AbortController().signal);
      expect(report.envelope).toMatchObject({ status: expectedStatus, exit: { code: exit }, diagnostics: [{ code, action }] });
    }
    expect(applications.operations.preview).not.toHaveBeenCalled();
    expect(applications.updates.previewPolicy).not.toHaveBeenCalled();
  });

  it("keeps no-arg presentation intent and reports headless input required", async () => {
    const { service } = fixture();
    await expect(service.runArgv([], { mode: "headless", output: "json" }, new AbortController().signal)).resolves.toMatchObject({ envelope: { status: "presentation-required", exit: { code: 3 } } });
    await expect(service.runArgv([], { mode: "tui", output: "human" }, new AbortController().signal)).resolves.toMatchObject({ envelope: { status: "presentation-required", exit: { code: 0 } } });
  });
});
