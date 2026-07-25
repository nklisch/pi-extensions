import { canonicalJson } from "../domain/canonical-json.js";
import { ContentDigestSchema, type ContentDigest } from "../domain/content-manifest.js";
import type { Sha256 } from "../domain/source.js";
import {
  NativeLifecycleOperationTokenSchema,
  NativeLifecyclePreviewIdSchema,
  type NativeLifecycleOperationToken,
  type NativeLifecyclePreviewId,
} from "./native-lifecycle-operation-contract.js";
import {
  ProjectIntentObservationIdSchema,
  ProjectSyncActionIdSchema,
  ProjectSyncConflictIdSchema,
  type ProjectIntentObservationId,
  type ProjectSyncActionId,
  type ProjectSyncConflictId,
} from "./project-sync-contract.js";

const encoder = new TextEncoder();

function digestHex(tag: string, value: unknown, sha256: Sha256): string {
  if (typeof sha256 !== "function") throw new TypeError("native operation identifiers require SHA-256");
  const bytes = sha256(encoder.encode(`${tag}\0${canonicalJson(value)}`));
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

export function createNativeLifecycleOperationToken(
  sessionIdInput: string,
  hostEpochInput: ContentDigest,
  sha256: Sha256,
): NativeLifecycleOperationToken {
  const sessionId = sessionIdInput.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId)) {
    throw new TypeError("native operation session id must be a UUID v4");
  }
  const hostEpoch = ContentDigestSchema.parse(hostEpochInput);
  const checksum = digestHex("native-operation-session-v1", { sessionId, hostEpoch }, sha256);
  return NativeLifecycleOperationTokenSchema.parse(`native-operation-session-v1:${sessionId}.${checksum}`);
}

export function verifyNativeLifecycleOperationToken(
  tokenInput: unknown,
  hostEpochInput: ContentDigest,
  sha256: Sha256,
): string | undefined {
  const token = NativeLifecycleOperationTokenSchema.safeParse(tokenInput);
  if (!token.success) return undefined;
  const match = /^native-operation-session-v1:([0-9a-f-]{36})\.([0-9a-f]{64})$/.exec(token.data);
  if (match === null) return undefined;
  const hostEpoch = ContentDigestSchema.parse(hostEpochInput);
  const expected = digestHex("native-operation-session-v1", { sessionId: match[1], hostEpoch }, sha256);
  return constantTimeEqual(match[2]!, expected) ? match[1] : undefined;
}

/** Bind a confirmation to every safe authority value captured by preview. */
export function deriveNativeLifecyclePreviewId(evidence: unknown, sha256: Sha256): NativeLifecyclePreviewId {
  return NativeLifecyclePreviewIdSchema.parse(`native-operation-preview-v1:sha256:${digestHex("native-operation-preview-v1", evidence, sha256)}`);
}

/** Public IDs disclose no filesystem identity or raw file bytes. */
export function deriveProjectIntentObservationId(evidence: unknown, sha256: Sha256): ProjectIntentObservationId {
  return ProjectIntentObservationIdSchema.parse(`project-intent-observation-v1:sha256:${digestHex("project-intent-observation-v1", evidence, sha256)}`);
}

export function deriveProjectSyncActionId(evidence: unknown, sha256: Sha256): ProjectSyncActionId {
  return ProjectSyncActionIdSchema.parse(`project-sync-action-v1:sha256:${digestHex("project-sync-action-v1", evidence, sha256)}`);
}

export function deriveProjectSyncConflictId(evidence: unknown, sha256: Sha256): ProjectSyncConflictId {
  return ProjectSyncConflictIdSchema.parse(`project-sync-conflict-v1:sha256:${digestHex("project-sync-conflict-v1", evidence, sha256)}`);
}
