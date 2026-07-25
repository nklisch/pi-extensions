import { z } from "zod";
import { canonicalJson } from "../domain/canonical-json.js";
import { ContentDigestSchema } from "../domain/content-manifest.js";
import { PluginKeySchema } from "../domain/identity.js";
import {
  MarketplaceCandidateIdSchema,
  MarketplaceRegistrationIdSchema,
  MarketplaceSnapshotTokenSchema,
} from "../domain/marketplace-registration.js";
import { ScopeReferenceSchema } from "../domain/state/scope.js";
import type { Sha256 } from "../domain/source.js";
import type { InspectionSnapshotBinding } from "./ports/native-inspection-evidence.js";
import {
  InspectionCursorSchema,
  InspectionDetailIdSchema,
  InspectionSnapshotIdSchema,
  type InspectionCursor,
  type InspectionDetailId,
  type InspectionSnapshotId,
} from "./native-inspection-contract.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const InstalledInspectionDetailSubjectSchema = z.object({
  version: z.literal(1),
  subject: z.literal("installed"),
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
  selectedRevision: ContentDigestSchema,
}).strict().readonly();

export const CandidateInspectionDetailSubjectSchema = z.object({
  version: z.literal(1),
  subject: z.literal("marketplace-candidate"),
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
  registrationId: MarketplaceRegistrationIdSchema,
  candidateId: MarketplaceCandidateIdSchema,
  catalogSnapshot: MarketplaceSnapshotTokenSchema,
}).strict().readonly();

export const InspectionDetailSubjectSchema = z.discriminatedUnion("subject", [
  InstalledInspectionDetailSubjectSchema,
  CandidateInspectionDetailSubjectSchema,
]);

export const InspectionCursorPayloadSchema = z.object({
  version: z.literal(1),
  snapshotId: InspectionSnapshotIdSchema,
  filterHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  lastSort: z.array(z.string().max(4096)).min(1).max(8).readonly(),
}).strict().readonly();

export type InstalledInspectionDetailSubject = z.infer<typeof InstalledInspectionDetailSubjectSchema>;
export type CandidateInspectionDetailSubject = z.infer<typeof CandidateInspectionDetailSubjectSchema>;
export type InspectionDetailSubject = z.infer<typeof InspectionDetailSubjectSchema>;
export type InspectionCursorPayload = z.infer<typeof InspectionCursorPayloadSchema>;

function digestHex(bytes: Uint8Array, sha256: Sha256): string {
  if (typeof sha256 !== "function") throw new TypeError("inspection identifiers require SHA-256");
  const digest = sha256(bytes);
  if (!(digest instanceof Uint8Array) || digest.byteLength !== 32) {
    throw new Error("SHA-256 function must return exactly 32 bytes");
  }
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function taggedDigest(tag: string, value: unknown, sha256: Sha256): string {
  return digestHex(encoder.encode(`${tag}\0${canonicalJson(value)}`), sha256);
}

function checksum(prefix: "inspection-detail-v1" | "inspection-cursor-v1", payload: string, sha256: Sha256): string {
  return digestHex(encoder.encode(`${prefix}\0${payload}`), sha256);
}

function encodePayload(value: unknown): string {
  return Buffer.from(encoder.encode(canonicalJson(value))).toString("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function decodeEnvelope(value: string, prefix: "inspection-detail-v1" | "inspection-cursor-v1", sha256: Sha256): unknown | undefined {
  const match = new RegExp(`^${prefix}:([A-Za-z0-9_-]+)\\.([0-9a-f]{64})$`).exec(value);
  if (match === null) return undefined;
  const payload = match[1]!;
  if (!constantTimeEqual(match[2]!, checksum(prefix, payload, sha256))) return undefined;
  try {
    const bytes = Buffer.from(payload, "base64url");
    // Node's decoder accepts non-canonical base64url spellings; round-tripping
    // prevents alternate text identities for the same payload.
    if (bytes.toString("base64url") !== payload) return undefined;
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return undefined;
  }
}

/** Derive a safe snapshot token from an already-redacted canonical binding. */
export function deriveInspectionSnapshotId(binding: unknown, sha256: Sha256): InspectionSnapshotId {
  return InspectionSnapshotIdSchema.parse(`inspection-snapshot-v1:sha256:${taggedDigest("inspection-snapshot-v1", binding, sha256)}`);
}

/** Capture time is observational metadata, not an authority epoch. */
export function deriveInspectionEvidenceSnapshotId(binding: InspectionSnapshotBinding, sha256: Sha256): InspectionSnapshotId {
  const { capturedAt: _capturedAt, ...authority } = binding;
  return deriveInspectionSnapshotId(authority, sha256);
}

export function deriveInspectionDetailId(subjectInput: InspectionDetailSubject, sha256: Sha256): InspectionDetailId {
  const subject = InspectionDetailSubjectSchema.parse(subjectInput);
  const payload = encodePayload(subject);
  return InspectionDetailIdSchema.parse(`inspection-detail-v1:${payload}.${checksum("inspection-detail-v1", payload, sha256)}`);
}

export function decodeInspectionDetailId(idInput: string, sha256: Sha256): InspectionDetailSubject | undefined {
  if (!InspectionDetailIdSchema.safeParse(idInput).success) return undefined;
  const decoded = decodeEnvelope(idInput, "inspection-detail-v1", sha256);
  const result = InspectionDetailSubjectSchema.safeParse(decoded);
  return result.success ? result.data : undefined;
}

export const verifyInspectionDetailId = decodeInspectionDetailId;

export function encodeInspectionCursor(payloadInput: InspectionCursorPayload, sha256: Sha256): InspectionCursor {
  const value = InspectionCursorPayloadSchema.parse(payloadInput);
  const payload = encodePayload(value);
  return InspectionCursorSchema.parse(`inspection-cursor-v1:${payload}.${checksum("inspection-cursor-v1", payload, sha256)}`);
}

export type InspectionCursorDecodeResult =
  | Readonly<{ kind: "valid"; payload: InspectionCursorPayload }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "stale" }>;

export function decodeInspectionCursor(
  cursorInput: string,
  expected: Readonly<{ snapshotId?: InspectionSnapshotId; filterHash?: string }>,
  sha256: Sha256,
): InspectionCursorDecodeResult {
  if (!InspectionCursorSchema.safeParse(cursorInput).success) return { kind: "invalid" };
  const decoded = decodeEnvelope(cursorInput, "inspection-cursor-v1", sha256);
  const result = InspectionCursorPayloadSchema.safeParse(decoded);
  if (!result.success) return { kind: "invalid" };
  if ((expected.snapshotId !== undefined && result.data.snapshotId !== expected.snapshotId) ||
      (expected.filterHash !== undefined && result.data.filterHash !== expected.filterHash)) {
    return { kind: "stale" };
  }
  return { kind: "valid", payload: result.data };
}

export const verifyInspectionCursor = decodeInspectionCursor;

export function deriveInspectionFilterHash(filter: unknown, sha256: Sha256): string {
  return ContentDigestSchema.parse(`sha256:${taggedDigest("inspection-filter-v1", filter, sha256)}`);
}
