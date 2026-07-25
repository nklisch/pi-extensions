import { describe, expect, it } from "vitest";
import { SensitiveValue } from "../../src/application/sensitive-value.js";
import { validateNativeControlInput, toTrustedInstallSubmission } from "../../src/application/native-control-input.js";

const consentId = `trusted-install-consent-v1:sha256:${"a".repeat(64)}`;
const request = {
  executionId: "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000",
  purpose: "trusted-install" as const,
  channel: { kind: "provided" as const },
  expectedVersion: 2,
  fields: [
    { key: "name", label: { text: "Name", escaped: false, truncated: false }, kind: "string" as const, required: true, sensitive: false, defaultPresent: false, constraints: {}, state: "missing" as const },
    { key: "token", label: { text: "Token", escaped: false, truncated: false }, kind: "string" as const, required: true, sensitive: true, defaultPresent: false, constraints: {}, state: "missing" as const },
  ],
  consent: { consentId, source: { kind: "github" as const, location: { text: "owner/repo", escaped: false, truncated: false } }, immutableRevision: `sha256:${"b".repeat(64)}`, executableSurfaceDigest: `sha256:${"c".repeat(64)}`, components: { skills: [], hooks: [], mcpServers: [], foreign: [] }, requirements: [], persistentData: true as const, configurationEnvironmentNames: [], subagentInterception: "not-declared" as const, remoteMcpDiscovery: "not-performed" as const, statement: { text: "Grant", escaped: false, truncated: false } },
  expected: { plugin: "demo@market", scope: { kind: "user" as const }, consentId },
} as const;

describe("native control input boundary", () => {
  it("collects all key/sensitivity/required issues before owner dispatch", () => {
    const result = validateNativeControlInput(request as never, {
      kind: "supplied",
      nonSensitive: [{ key: "token", value: "wrong" }, { key: "unknown", value: "x" }],
      sensitive: [],
      decision: { kind: "grant", consentId: "stale" },
    });
    expect(result).toMatchObject({ kind: "invalid", issues: [
      { code: "INPUT_SENSITIVITY_MISMATCH", key: "token" },
      { code: "INPUT_UNKNOWN_KEY", key: "unknown" },
      { code: "INPUT_REQUIRED", key: "name" },
      { code: "INPUT_EXPECTATION_STALE" },
      { code: "INPUT_EXPECTATION_STALE" },
    ] });
  });

  it("builds only the existing trusted-install submission", () => {
    const result = validateNativeControlInput(request as never, {
      kind: "supplied",
      nonSensitive: [{ key: "name", value: "demo" }],
      sensitive: [{ key: "token", value: SensitiveValue.fromUnknown("canary") }],
      decision: { kind: "grant", consentId },
    });
    expect(result.kind).toBe("supplied");
    if (result.kind !== "supplied") return;
    const submission = toTrustedInstallSubmission(request as never, result);
    expect(submission).toMatchObject({ expectedVersion: 2, consent: { kind: "grant", consentId } });
    expect(JSON.stringify(submission)).not.toContain("canary");
  });
});
