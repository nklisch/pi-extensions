import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileNativeDiagnostics, deriveNativeInspectionCondition, unavailableEvidenceFinding } from "../../src/application/native-diagnostic-compiler.js";
import { toSafeDisplayField } from "../../src/application/native-inspection-display.js";
import { deriveInspectionDetailId } from "../../src/application/native-inspection-identifiers.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const subjectId = deriveInspectionDetailId({ version: 1, subject: "installed", scope: { kind: "user" }, plugin: "demo@market" as never, selectedRevision: `sha256:${"11".repeat(32)}` as never }, sha256);
const componentId = `component-v1:mcp-server:${"22".repeat(32)}` as never;
const fact = (key: string, value: string) => ({ key, value: toSafeDisplayField(value, { maxScalars: 256 }) });

describe("native diagnostic compiler", () => {
  it("orders and deduplicates byte-identically across evidence permutations", () => {
    const findings = [
      { key: "catalogStale" as const, subjectId, facts: [fact("marketplace", "market")] },
      { key: "mcpRemoteFailed" as const, subjectId, componentId, facts: [fact("state", "failed")] },
      { key: "trustRequired" as const, subjectId },
      { key: "mcpRemoteFailed" as const, subjectId, componentId, facts: [fact("state", "failed")] },
    ];
    const first = compileNativeDiagnostics({ findings }, sha256);
    const second = compileNativeDiagnostics({ findings: [...findings].reverse() }, sha256);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.map((item) => item.code)).toEqual(["TRUST_REQUIRED", "MCP_REMOTE_HEALTH_FAILED", "CATALOG_STALE"]);
    expect(first).toHaveLength(3);
    expect(new Set(first.map((item) => item.id)).size).toBe(3);
  });

  it("retains distinct component and fact evidence", () => {
    const other = `component-v1:mcp-server:${"33".repeat(32)}` as never;
    const result = compileNativeDiagnostics({ findings: [
      { key: "mcpRemoteFailed", subjectId, componentId, facts: [fact("state", "failed")] },
      { key: "mcpRemoteFailed", subjectId, componentId: other, facts: [fact("state", "failed")] },
      { key: "mcpRemoteFailed", subjectId, componentId, facts: [fact("state", "needs-auth")] },
    ] }, sha256);
    expect(result).toHaveLength(3);
  });

  it("derives exact unavailable/degraded/blocked/ready semantics from registry metadata", () => {
    expect(deriveNativeInspectionCondition([])).toBe("ready");
    expect(deriveNativeInspectionCondition(compileNativeDiagnostics({ findings: [{ key: "mcpRemoteFailed", subjectId, componentId }] }, sha256))).toBe("degraded");
    expect(deriveNativeInspectionCondition(compileNativeDiagnostics({ findings: [unavailableEvidenceFinding("runtime", subjectId)] }, sha256))).toBe("unavailable");
    expect(deriveNativeInspectionCondition(compileNativeDiagnostics({ findings: [{ key: "trustRequired", subjectId }, unavailableEvidenceFinding("runtime", subjectId)] }, sha256))).toBe("blocked");
  });

  it("rejects forged unsafe facts at the compiler boundary", () => {
    expect(() => compileNativeDiagnostics({ findings: [{
      key: "catalogStale",
      subjectId,
      facts: [{ key: "owner", value: { text: "forged\u001b[2J", escaped: false, truncated: false } }],
    }] }, sha256)).toThrow();
  });

  it("maps unknown native failures to fixed subsystem facts without leakage", () => {
    const native = "SECRET_NATIVE_CAUSE /home/alice/private stderr";
    const result = compileNativeDiagnostics({ findings: [unavailableEvidenceFinding("source", subjectId)] }, sha256);
    const json = JSON.stringify(result);
    expect(json).toContain("EVIDENCE_UNAVAILABLE");
    expect(json).toContain("source");
    expect(json).not.toContain(native);
    expect(json).not.toContain("/home/alice");
    expect(result[0]?.action).toBe("retry-read");
  });
});
