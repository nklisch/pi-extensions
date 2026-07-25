import { describe, expect, it } from "vitest";
import { createNativeInstalledHarness } from "../helpers/native-installed-inspection.js";

async function inspect(options: Parameters<typeof createNativeInstalledHarness>[0] = {}) {
  const value = createNativeInstalledHarness(options);
  const result = await value.inspector.inspect(value.subject, value.snapshot, new AbortController().signal);
  expect(result.kind).toBe("found");
  if (result.kind !== "found") throw new Error(`unexpected result: ${result.kind}`);
  return { ...value, detail: result.detail };
}

describe("native installed inspection", () => {
  it("treats disabled plus exact inactive evidence as ready even when an unused MCP adapter is unavailable", async () => {
    const { detail } = await inspect({ skill: true, mcpUnavailable: true });
    expect(detail.summary.condition).toBe("ready");
    expect(detail.activation).toMatchObject({ intent: "disabled", state: "inactive" });
    expect(detail.activation?.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ participant: "skills-hooks", status: "matching" }),
      expect.objectContaining({ participant: "mcp", status: "matching" }),
    ]));
  });

  it.each(["failed", "needs-auth"] as const)("separates exact MCP activation from %s remote health", async (remote) => {
    const { detail } = await inspect({ enabled: true, remote, hostileNativeKey: "native\u001b[2J\u202Ekey" });
    expect(detail.activation?.state).toBe("active");
    expect(detail.mcpHealth?.localRegistration).toBe("matching");
    expect(detail.mcpHealth?.servers[0]).toMatchObject({ authority: "current", transport: "stdio", state: remote });
    expect(detail.summary.condition).toBe("degraded");
    expect(detail.diagnostics.map((item) => item.code)).toContain(remote === "failed" ? "MCP_REMOTE_HEALTH_FAILED" : "MCP_REMOTE_AUTH_REQUIRED");
    expect(detail.mcpHealth?.servers[0]?.nativeKey.escaped).toBe(true);
  });

  it("marks old MCP health stale during recovery and does not compile it as current health", async () => {
    const { detail } = await inspect({ enabled: true, remote: "failed", pending: true });
    expect(detail.activation?.state).toBe("pending");
    expect(detail.summary.condition).toBe("blocked");
    expect(detail.mcpHealth?.servers[0]?.authority).toBe("stale");
    expect(detail.diagnostics.map((item) => item.code)).toEqual(["TRANSITION_PENDING"]);
  });

  it("marks otherwise exact runtime health stale when project trust is not authoritative", async () => {
    const { detail } = await inspect({ enabled: true, remote: "connected", projectUntrusted: true });
    expect(detail.trust).toBe("project-untrusted");
    expect(detail.activation?.state).toBe("blocked");
    expect(detail.mcpHealth?.servers[0]?.authority).toBe("stale");
    expect(detail.diagnostics.map((item) => item.code)).toEqual(["PROJECT_UNTRUSTED"]);
  });

  it.each([
    { enabled: true, state: "unavailable" },
    { enabled: false, state: "unavailable" },
  ])("reports missing runtime evidence as unavailable for $state intent", async ({ enabled }) => {
    const { detail } = await inspect({ enabled, skill: true, noRuntime: true });
    expect(detail.summary.condition).toBe("unavailable");
    expect(detail.activation?.state).toBe("unavailable");
    expect(detail.activation?.participants[0]?.status).toBe("missing");
    expect(detail.diagnostics.map((item) => item.code)).toContain("RUNTIME_EVIDENCE_MISSING");
  });

  it("keeps inventory inspectable but readiness unavailable without capability authority", async () => {
    const value = createNativeInstalledHarness({ enabled: true, skill: true });
    delete value.snapshot.capabilities;
    value.snapshot.binding.capability = { status: "unavailable" };
    const result = await value.inspector.inspect(value.subject, value.snapshot, new AbortController().signal);
    expect(result.kind).toBe("found");
    if (result.kind !== "found") return;
    expect(result.detail.compatibility.status).toBe("unavailable");
    expect(result.detail.compatibility.components.skills).toHaveLength(1);
    expect(result.detail.activation?.state).toBe("unavailable");
    expect(result.detail.summary.condition).toBe("unavailable");
    expect(result.detail.diagnostics.map((item) => item.code)).toContain("CAPABILITY_EVIDENCE_UNAVAILABLE");
  });

  it("distinguishes unavailable projection evidence from a known mismatch", async () => {
    const unavailable = createNativeInstalledHarness({ enabled: true, skill: true });
    unavailable.snapshot.runtime[0].skillsHooks = { kind: "unavailable", code: "ADAPTER_FAILED" };
    const unavailableResult = await unavailable.inspector.inspect(unavailable.subject, unavailable.snapshot, new AbortController().signal);
    expect(unavailableResult.kind === "found" && unavailableResult.detail.summary.condition).toBe("unavailable");
    expect(unavailableResult.kind === "found" && unavailableResult.detail.diagnostics.map((item) => item.code)).toContain("PROJECTION_UNAVAILABLE");

    const mismatch = await inspect({ enabled: true, skill: true, skillMismatch: true });
    expect(mismatch.detail.summary.condition).toBe("blocked");
    expect(mismatch.detail.activation?.participants[0]?.status).toBe("mismatched");
    expect(mismatch.detail.diagnostics.map((item) => item.code)).toContain("ACTIVATION_EVIDENCE_MISMATCH");
  });

  it("projects policy, unread/unresolved notice, schedule, and host update status without work", async () => {
    const { detail } = await inspect({ updatePending: true, updateClockRegressed: true });
    expect(detail.lifecycle).toMatchObject({
      update: "automatic-pending",
      notice: { disposition: "automatic-pending", unread: true, unresolved: true },
      schedule: { state: "clock-regressed", nextAt: 30 },
      updateSubsystem: "running",
    });
    expect(detail.lifecycle.policy).toMatchObject({ application: "manual", winningLevel: "guard" });
    expect(detail.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(["UPDATE_AUTOMATIC_PENDING", "UPDATE_CLOCK_REGRESSED"]));
  });

  it("derives failed update condition from compiled registry diagnostics", async () => {
    const { detail } = await inspect({ updateFailed: true });
    expect(detail.lifecycle.update).toBe("failed");
    expect(detail.summary.condition).toBe("degraded");
    expect(detail.diagnostics.map((item) => item.code)).toContain("UPDATE_FAILED");
    expect(JSON.stringify(detail)).not.toContain("SOURCE_UNAVAILABLE");
  });

  it("distinguishes unavailable, missing, and mismatched MCP authority without inventing transport", async () => {
    const unavailable = await inspect({ enabled: true, remote: "connected", mcpUnavailable: true });
    expect(unavailable.detail.summary.condition).toBe("unavailable");
    expect(unavailable.detail.mcpHealth).toMatchObject({ localRegistration: "unavailable", servers: [] });
    expect(unavailable.detail.diagnostics.map((item) => item.code)).toContain("RUNTIME_EVIDENCE_UNAVAILABLE");

    const missingHarness = createNativeInstalledHarness({ enabled: true, remote: "connected" });
    missingHarness.snapshot.runtime[0].mcp.status.status = null;
    const missing = await missingHarness.inspector.inspect(missingHarness.subject, missingHarness.snapshot, new AbortController().signal);
    expect(missing.kind === "found" && missing.detail.mcpHealth?.localRegistration).toBe("absent");
    expect(missing.kind === "found" && missing.detail.diagnostics.map((item) => item.code)).toContain("MCP_REGISTRATION_MISSING");

    const mismatchHarness = createNativeInstalledHarness({ enabled: true, remote: "connected" });
    mismatchHarness.snapshot.runtime[0].mcp.status.status.registrationDigest = `sha256:${"ab".repeat(32)}`;
    mismatchHarness.snapshot.runtime[0].mcp.expected.servers = [];
    const mismatch = await mismatchHarness.inspector.inspect(mismatchHarness.subject, mismatchHarness.snapshot, new AbortController().signal);
    expect(mismatch.kind).toBe("found");
    if (mismatch.kind !== "found") return;
    expect(mismatch.detail.summary.condition).toBe("blocked");
    expect(mismatch.detail.mcpHealth?.localRegistration).toBe("mismatched");
    expect(mismatch.detail.mcpHealth?.servers[0]).toMatchObject({ authority: "stale" });
    expect(mismatch.detail.mcpHealth?.servers[0]).not.toHaveProperty("transport");
    expect(mismatch.detail.diagnostics.map((item) => item.code)).toContain("MCP_REGISTRATION_MISMATCH");
  });
});
