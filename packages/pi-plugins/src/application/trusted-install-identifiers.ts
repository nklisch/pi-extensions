import { canonicalJson } from "../domain/canonical-json.js";
import { ContentDigestSchema, type ContentDigest } from "../domain/content-manifest.js";
import { NativeComponentInventoryViewSchema, type NativeComponentInventoryView } from "./native-inspection-contract.js";
import type { Sha256 } from "../domain/source.js";
import {
  TrustedInstallCandidateBindingSchema,
  TrustedInstallConsentIdSchema,
  TrustedInstallSessionTokenSchema,
  type TrustedInstallCandidateBinding,
  type TrustedInstallConsentId,
  type TrustedInstallSessionToken,
} from "./trusted-install-contract.js";

const encoder = new TextEncoder();

function digestHex(value: string, sha256: Sha256): string {
  const bytes = sha256(encoder.encode(value));
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) throw new Error("SHA-256 must return exactly 32 bytes");
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/** A token is only a host-epoch lookup capability; it contains no workflow evidence. */
export function createTrustedInstallSessionToken(
  sessionId: string,
  hostEpochInput: ContentDigest,
  sha256: Sha256,
): TrustedInstallSessionToken {
  const id = sessionId.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new TypeError("trusted-install session id must be a UUID v4");
  const hostEpoch = ContentDigestSchema.parse(hostEpochInput);
  const checksum = digestHex(`trusted-install-session-v1\0${id}\0${hostEpoch}`, sha256);
  return TrustedInstallSessionTokenSchema.parse(`trusted-install-session-v1:${id}.${checksum}`);
}

export function verifyTrustedInstallSessionToken(
  tokenInput: unknown,
  hostEpochInput: ContentDigest,
  sha256: Sha256,
): string | undefined {
  const parsed = TrustedInstallSessionTokenSchema.safeParse(tokenInput);
  if (!parsed.success) return undefined;
  const hostEpoch = ContentDigestSchema.parse(hostEpochInput);
  const match = /^trusted-install-session-v1:([0-9a-f-]{36})\.([0-9a-f]{64})$/.exec(parsed.data);
  if (match === null) return undefined;
  const expected = digestHex(`trusted-install-session-v1\0${match[1]}\0${hostEpoch}`, sha256);
  return constantTimeEqual(match[2]!, expected) ? match[1] : undefined;
}

export function deriveTrustedInstallConsentDisclosureDigest(
  componentsInput: NativeComponentInventoryView,
  sha256: Sha256,
): ContentDigest {
  const components = NativeComponentInventoryViewSchema.parse(componentsInput);
  return ContentDigestSchema.parse(`sha256:${digestHex(`trusted-install-disclosure-v1\0${canonicalJson(components)}`, sha256)}`);
}

/** Bind consent to the complete exact candidate authority tuple. */
export function deriveTrustedInstallConsentId(
  bindingInput: TrustedInstallCandidateBinding,
  sha256: Sha256,
): TrustedInstallConsentId {
  const binding = TrustedInstallCandidateBindingSchema.parse(bindingInput);
  const digest = digestHex(`trusted-install-consent-v1\0${canonicalJson(binding)}`, sha256);
  return TrustedInstallConsentIdSchema.parse(`trusted-install-consent-v1:sha256:${digest}`);
}
