import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createNativeInspectionService } from "../../src/application/native-inspection-service.js";
import { presentNativeDiagnostics } from "../../src/application/native-failure-presenter.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());

function evidence() {
  return {
    async capture() {
      return {
        states: [],
        currentProject: { projectKey: "project-v1:sha256:test", trust: { kind: "untrusted" } },
        runtime: [],
        binding: {
          capturedAt: 1,
          scopes: [],
          currentProject: {
            projectKey: "project-v1:sha256:test",
            trust: { kind: "untrusted" },
            epoch: `sha256:${"1".repeat(64)}`,
          },
          catalogs: [],
          capability: { status: "ready", digest: `sha256:${"2".repeat(64)}`, capturedBy: "test" },
          runtimeEpoch: `sha256:${"3".repeat(64)}`,
          convergenceDigest: `sha256:${"4".repeat(64)}`,
          updateDigest: `sha256:${"5".repeat(64)}`,
        },
        convergence: { results: [], deferred: false, processed: 0 },
        startup: {
          status: "degraded",
          blocked: [{
            plugin: "demo@community",
            scope: { kind: "user" },
            selectedRevision: `sha256:${"a".repeat(64)}`,
            code: "MCP_RUNTIME_UNAVAILABLE",
            explanation: "MCP runtime is unavailable: The installed MCP adapter package does not match the required release. (PACKAGE_DRIFT)",
          }],
          capabilities: {
            mcp: { status: "unavailable", explanation: "MCP runtime unavailable (PACKAGE_DRIFT): receipt mismatch" },
            subagents: { status: "available", explanation: "available" },
            piReload: { status: "available", explanation: "available" },
            secrets: { status: "available", explanation: "available" },
          },
        },
      } as never;
    },
    async validate() { return "current" as const; },
    async validateForInstall() { return "current" as const; },
  };
}

describe("native MCP runtime availability diagnosis", () => {
  it("reports the safe reason and sibling remediation for an attach failure", async () => {
    const service = createNativeInspectionService({
      evidence: evidence() as never,
      installed: {} as never,
      candidates: {} as never,
      catalog: {} as never,
      adoption: {} as never,
      clock: { nowEpochMilliseconds: () => 1 as never },
      sha256,
    });

    const report = await service.diagnose({ target: { kind: "host" }, includeAdoption: false }, new AbortController().signal);
    const diagnostic = report.diagnostics.find((entry) => entry.code === "MCP_RUNTIME_UNAVAILABLE");
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "reason", value: expect.objectContaining({ text: expect.stringContaining("PACKAGE_DRIFT") }) }),
      expect.objectContaining({ key: "remediation", value: expect.objectContaining({ text: expect.stringContaining("pi-mcp-adapter") }) }),
    ]));

    const human = presentNativeDiagnostics(report.diagnostics).map((entry) => entry.text).join("\n");
    expect(human).toContain("PACKAGE_DRIFT");
    expect(human).toContain("Update pi-plugins and pi-mcp-adapter together");
    expect(human).not.toContain("receipt mismatch");
  });
});
