import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveUpdateNoticeId,
  deriveUpdatePolicyConsentId,
  deriveUpdatePolicyPreviewId,
} from "../../src/application/native-update-identifiers.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());

describe("native update identifiers", () => {
  it("binds exact semantic evidence and ignores object insertion order", () => {
    const evidence = { scope: { kind: "user" }, plugin: "demo@community", candidate: `update-candidate-v1:sha256:${"a".repeat(64)}` };
    const reordered = { candidate: evidence.candidate, plugin: evidence.plugin, scope: evidence.scope };
    expect(deriveUpdateNoticeId(evidence, sha256)).toBe(deriveUpdateNoticeId(reordered, sha256));
    expect(deriveUpdateNoticeId({ ...evidence, candidate: `update-candidate-v1:sha256:${"b".repeat(64)}` }, sha256)).not.toBe(deriveUpdateNoticeId(evidence, sha256));
  });

  it("domain-separates notice, preview, and consent identities", () => {
    const evidence = { policy: "automatic", scope: "global" };
    const values = [
      deriveUpdateNoticeId({ scope: { kind: "user" }, plugin: "demo@community", candidate: evidence }, sha256),
      deriveUpdatePolicyPreviewId(evidence, sha256),
      deriveUpdatePolicyConsentId(evidence, sha256),
    ];
    expect(new Set(values).size).toBe(3);
  });
});
