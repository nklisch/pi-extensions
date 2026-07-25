import { canonicalJson } from "../domain/canonical-json.js";
import type { Sha256 } from "../domain/source.js";
import {
  UpdateNoticeIdSchema,
  UpdatePolicyConsentIdSchema,
  UpdatePolicyPreviewIdSchema,
  type UpdateNoticeId,
  type UpdatePolicyConsentId,
  type UpdatePolicyPreviewId,
} from "../domain/update-policy.js";

const encoder = new TextEncoder();

function digestHex(tag: string, evidence: unknown, sha256: Sha256): string {
  if (typeof sha256 !== "function") throw new TypeError("native update identifiers require SHA-256");
  const digest = sha256(encoder.encode(`${tag}\0${canonicalJson(evidence)}`));
  if (!(digest instanceof Uint8Array) || digest.byteLength !== 32) throw new Error("SHA-256 must return exactly 32 bytes");
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function deriveUpdateNoticeId(evidence: Readonly<{
  scope: unknown;
  plugin: unknown;
  candidate: unknown;
}>, sha256: Sha256): UpdateNoticeId {
  return UpdateNoticeIdSchema.parse(`update-notice-v1:sha256:${digestHex("update-notice-v1", evidence, sha256)}`);
}

export function deriveUpdatePolicyPreviewId(evidence: unknown, sha256: Sha256): UpdatePolicyPreviewId {
  return UpdatePolicyPreviewIdSchema.parse(`update-policy-preview-v1:sha256:${digestHex("update-policy-preview-v1", evidence, sha256)}`);
}

export function deriveUpdatePolicyConsentId(evidence: unknown, sha256: Sha256): UpdatePolicyConsentId {
  return UpdatePolicyConsentIdSchema.parse(`update-policy-consent-v1:sha256:${digestHex("update-policy-consent-v1", evidence, sha256)}`);
}
