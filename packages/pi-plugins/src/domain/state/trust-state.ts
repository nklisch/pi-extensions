import { z } from "zod";
import {
  CanonicalSourceSchema,
  type CanonicalSource,
  type Sha256,
} from "../source.js";
import { ContentDigestSchema, type ContentDigest } from "../content-manifest.js";
import { PluginKeySchema, type PluginKey } from "../identity.js";
import { ScopeReferenceSchema, type ScopeReference } from "./scope.js";
import {
  TrustSubjectRefSchema,
  deriveTrustSubjectRef,
  verifyTrustSubjectRef,
  type TrustSubjectRef,
} from "./references.js";
import { GenerationSchema } from "./config-state.js";

/** Trust state stores a decision, not the policy that made that decision. */
export const TrustDecisionStatusSchema = z.enum(["granted", "revoked"]);
export type TrustDecisionStatus = z.infer<typeof TrustDecisionStatusSchema>;

/**
 * An immutable revision is deliberately a small evidence token. The source
 * schema owns the exact grammar for each source kind; this envelope does not
 * infer or reimplement that grammar because trust must remain source-format
 * neutral. Control characters and lone surrogates are excluded so this value
 * cannot smuggle a second serialized field or an unsafe diagnostic.
 */
export const ImmutableRevisionEvidenceSchema = z
  .string()
  .min(1)
  .max(4096)
  .superRefine((value, context) => {
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
          context.addIssue({
            code: "custom",
            message: "immutable revision cannot contain lone surrogates",
          });
          return;
        }
        index += 1;
      } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        context.addIssue({
          code: "custom",
          message: "immutable revision cannot contain lone surrogates",
        });
        return;
      }
      if (codeUnit < 0x20 || codeUnit === 0x7f) {
        context.addIssue({
          code: "custom",
          message: "immutable revision cannot contain control characters",
        });
        return;
      }
    }
  });
export type ImmutableRevisionEvidence = z.infer<
  typeof ImmutableRevisionEvidenceSchema
>;

/** Safe, canonical evidence bound to one plugin and one persisted scope. */
export const TrustSubjectEvidenceSchema = z
  .object({
    plugin: PluginKeySchema,
    scope: ScopeReferenceSchema,
    marketplaceSource: CanonicalSourceSchema,
    pluginSource: CanonicalSourceSchema,
    immutableRevision: ImmutableRevisionEvidenceSchema,
    executableSurfaceDigest: ContentDigestSchema,
  })
  .strict()
  .readonly();
export type TrustSubjectEvidence = z.infer<typeof TrustSubjectEvidenceSchema>;

export const TrustStateRecordSchema = z
  .object({
    subject: TrustSubjectRefSchema,
    evidence: TrustSubjectEvidenceSchema,
    status: TrustDecisionStatusSchema,
  })
  .strict()
  .readonly();
export type TrustStateRecord = z.infer<typeof TrustStateRecordSchema>;

function addDuplicateSubjectIssues(
  records: readonly TrustStateRecord[],
  context: z.RefinementCtx,
): void {
  const firstBySubject = new Map<string, number>();
  for (const [index, record] of records.entries()) {
    const firstIndex = firstBySubject.get(record.subject);
    if (firstIndex !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["records", index, "subject"],
        message: `duplicate trust subject; first declared at index ${firstIndex}`,
      });
    } else {
      firstBySubject.set(record.subject, index);
    }
  }
}

/**
 * The only trust envelope schema. The literal version remains so a future
 * clean cut-over can recognize stale documents; stale versions are
 * reinitialized by the state codec, never migrated.
 */
export const TrustStateDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    generation: GenerationSchema,
    records: z.array(TrustStateRecordSchema).readonly(),
  })
  .strict()
  .readonly()
  .superRefine((document, context) => {
    addDuplicateSubjectIssues(document.records, context);
  });
export type TrustStateDocument = z.infer<typeof TrustStateDocumentSchema>;

const TrustSubjectEvidenceInputSchema = TrustSubjectEvidenceSchema;
const TrustStateRecordInputSchema = z
  .object({
    subject: TrustSubjectRefSchema.optional(),
    evidence: TrustSubjectEvidenceInputSchema,
    status: TrustDecisionStatusSchema,
  })
  .strict();

/** Derive the trust subject from safe evidence; caller claims are verified. */
export function createTrustStateRecord(
  input: unknown,
  sha256: Sha256,
): TrustStateRecord {
  const value = TrustStateRecordInputSchema.parse(input);
  const evidence = TrustSubjectEvidenceSchema.parse(value.evidence);
  const subject = deriveTrustSubjectRef(evidence, sha256);
  if (value.subject !== undefined) {
    verifyTrustSubjectRef(value.subject, evidence, sha256);
  }
  return TrustStateRecordSchema.parse({
    subject,
    evidence,
    status: value.status,
  });
}

/** Verify a persisted record without introducing policy semantics. */
export function verifyTrustStateRecord(
  input: unknown,
  sha256: Sha256,
): TrustStateRecord {
  return createTrustStateRecord(input, sha256);
}

export function createTrustStateDocument(
  input: unknown,
  sha256: Sha256,
): TrustStateDocument {
  const value = TrustStateDocumentSchema.parse(input);
  return TrustStateDocumentSchema.parse({
    ...value,
    records: value.records.map((record) => createTrustStateRecord(record, sha256)),
  });
}

/**
 * This helper is intentionally about persistence identity only. It does not
 * answer whether a grant is sufficient, who may update it, or when to prompt.
 */
export function deriveTrustSubject(
  evidence: TrustSubjectEvidence,
  sha256: Sha256,
): TrustSubjectRef {
  return deriveTrustSubjectRef(TrustSubjectEvidenceSchema.parse(evidence), sha256);
}

export type {
  CanonicalSource,
  ContentDigest,
  PluginKey,
  ScopeReference,
};
