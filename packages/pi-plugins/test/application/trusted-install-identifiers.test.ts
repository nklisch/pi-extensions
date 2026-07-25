import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createTrustedInstallSessionToken,
  deriveTrustedInstallConsentId,
  verifyTrustedInstallSessionToken,
} from "../../src/application/trusted-install-identifiers.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const digest = (byte: string) => `sha256:${byte.repeat(64)}` as never;
const base = {
  scope: { kind: "user" as const },
  registrationId: `marketplace-registration-v1:sha256:${"1".repeat(64)}` as never,
  candidateId: `marketplace-candidate-v1:sha256:${"2".repeat(64)}` as never,
  catalogSnapshot: `marketplace-snapshot-v1:sha256:${"3".repeat(64)}` as never,
  plugin: "demo@market" as never,
  sourceIdentity: `sha256:${"4".repeat(64)}` as never,
  immutableRevision: digest("5"),
  contentDigest: digest("6"),
  compatibilityFingerprint: digest("7"),
  configurationDescriptorDigest: digest("8"),
  consentDisclosureDigest: digest("f"),
  trustSubject: `trust-subject-v1:sha256:${"9".repeat(64)}` as never,
  executableSurfaceDigest: digest("a"),
  capabilityDigest: digest("b"),
};

describe("trusted-install identifiers", () => {
  it("binds session tokens to one host epoch and rejects tampering", () => {
    const id = "2d6737b6-7482-4a50-9310-cd35ce7ddcad";
    const epoch = digest("c");
    const token = createTrustedInstallSessionToken(id, epoch, sha256);
    expect(verifyTrustedInstallSessionToken(token, epoch, sha256)).toBe(id);
    expect(verifyTrustedInstallSessionToken(token, digest("d"), sha256)).toBeUndefined();
    expect(verifyTrustedInstallSessionToken(`${token.slice(0, -1)}0`, epoch, sha256)).toBeUndefined();
    expect(token).not.toContain("demo");
    expect(token).not.toContain("/");
  });

  it("changes consent across every executable authority dimension", () => {
    const consent = deriveTrustedInstallConsentId(base, sha256);
    for (const changed of [
      { scope: { kind: "project", projectKey: `project-v1:sha256:${"d".repeat(64)}` } },
      { registrationId: `marketplace-registration-v1:sha256:${"e".repeat(64)}` },
      { candidateId: `marketplace-candidate-v1:sha256:${"e".repeat(64)}` },
      { catalogSnapshot: `marketplace-snapshot-v1:sha256:${"e".repeat(64)}` },
      { sourceIdentity: `sha256:${"e".repeat(64)}` },
      { immutableRevision: digest("e") },
      { configurationDescriptorDigest: digest("e") },
      { consentDisclosureDigest: digest("e") },
      { trustSubject: `trust-subject-v1:sha256:${"e".repeat(64)}` },
      { executableSurfaceDigest: digest("e") },
      { compatibilityFingerprint: digest("e") },
      { capabilityDigest: digest("e") },
      { projectEpoch: digest("e") },
    ]) expect(deriveTrustedInstallConsentId({ ...base, ...changed } as never, sha256)).not.toBe(consent);
  });
});
