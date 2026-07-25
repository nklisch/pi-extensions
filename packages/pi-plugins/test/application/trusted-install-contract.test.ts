import { describe, expect, it } from "vitest";
import {
  TrustedInstallActivationResultSchema,
  TrustedInstallInputIssueSchema,
  TrustedInstallOpenResultSchema,
  TrustedInstallSessionTokenSchema,
  TrustedInstallSubmissionSchema,
} from "../../src/application/trusted-install-contract.js";
import { SensitiveValue } from "../../src/application/sensitive-value.js";

const token = `trusted-install-session-v1:2d6737b6-7482-4a50-9310-cd35ce7ddcad.${"a".repeat(64)}`;
const consentId = `trusted-install-consent-v1:sha256:${"b".repeat(64)}`;

describe("trusted-install public contract", () => {
  it("rejects malformed, oversized, and unknown-field token/submission input", () => {
    expect(TrustedInstallSessionTokenSchema.safeParse(token).success).toBe(true);
    expect(TrustedInstallSessionTokenSchema.safeParse(`${token}0`).success).toBe(false);
    expect(TrustedInstallSubmissionSchema.safeParse({
      expectedVersion: 0,
      nonSensitive: [{ key: "NAME", value: "safe" }],
      sensitive: [{ key: "TOKEN", value: SensitiveValue.fromUnknown("CANARY_SECRET") }],
      consent: { kind: "grant", consentId },
      extra: true,
    }).success).toBe(false);
    expect(TrustedInstallSubmissionSchema.safeParse({
      expectedVersion: 0,
      nonSensitive: [],
      sensitive: [{ key: "TOKEN", value: "CANARY_SECRET" }],
      consent: { kind: "grant", consentId },
    }).success).toBe(false);
  });

  it("rejects impossible result combinations and structurally excludes native evidence", () => {
    expect(TrustedInstallActivationResultSchema.safeParse({
      kind: "succeeded",
      plugin: "demo@market",
      scope: { kind: "user" },
      revision: `sha256:${"1".repeat(64)}`,
      projectionDigest: `sha256:${"2".repeat(64)}`,
      components: { skills: 1, hooks: 1, mcpServers: 1 },
      progress: [],
      retained: { configuration: true, trust: true },
      snapshot: { generation: 3 },
    }).success).toBe(false);
    expect(TrustedInstallOpenResultSchema.safeParse({ kind: "stale", reason: "candidate", root: "/private/root" }).success).toBe(false);
  });

  it("keeps input issues constrained to stable key/code evidence", () => {
    const issues = [
      TrustedInstallInputIssueSchema.parse({ code: "CONFIG_REQUIRED", key: "A" }),
      TrustedInstallInputIssueSchema.parse({ code: "CONSENT_REQUIRED" }),
    ];
    expect(issues).toEqual([{ code: "CONFIG_REQUIRED", key: "A" }, { code: "CONSENT_REQUIRED" }]);
    expect(TrustedInstallInputIssueSchema.safeParse({ code: "CONFIG_TYPE", key: "A", value: "CANARY_SECRET" }).success).toBe(false);
  });
});
