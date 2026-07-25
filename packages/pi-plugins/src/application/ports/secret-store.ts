import { z } from "zod";
import { SecretLocatorSchema, type SecretLocator } from "../../domain/configured-values.js";
import { SensitiveValue } from "../sensitive-value.js";

/**
 * Creation evidence is intentionally opaque to application code. A concrete
 * adapter must issue an identity-bearing token and accept it only for a
 * successful create from that adapter; a locator string by itself is never
 * sufficient proof that this operation owns the credential.
 */
declare const secretCreationEvidenceBrand: unique symbol;
export type SecretCreationEvidence = Readonly<{
  readonly [secretCreationEvidenceBrand]: true;
}>;

const SecretCreationEvidenceSchema = z.custom<SecretCreationEvidence>(
  (value) => value !== null && typeof value === "object",
);

/** The result registry is the single source for create-result variants and types. */
export const SecretStoreCreateResultSchemaRegistry = {
  created: z.object({
    kind: z.literal("created"),
    locator: SecretLocatorSchema,
    evidence: SecretCreationEvidenceSchema,
  }).strict().readonly(),
  collision: z.object({
    kind: z.literal("collision"),
  }).strict().readonly(),
} as const;

const secretStoreCreateResultSchemas = Object.values(SecretStoreCreateResultSchemaRegistry) as [
  (typeof SecretStoreCreateResultSchemaRegistry)[keyof typeof SecretStoreCreateResultSchemaRegistry],
  ...(typeof SecretStoreCreateResultSchemaRegistry)[keyof typeof SecretStoreCreateResultSchemaRegistry][],
];
export const SecretStoreCreateResultSchema = z.discriminatedUnion("kind", secretStoreCreateResultSchemas);
export type SecretStoreCreateResult = z.infer<typeof SecretStoreCreateResultSchema>;
// `put` is the existing port verb; retain a directly named alias so adapter
// implementations and conformance suites cannot fall back to an untyped void.
export const SecretStorePutResultSchema = SecretStoreCreateResultSchema;
export type SecretStorePutResult = SecretStoreCreateResult;

const SecretStoreGetResultSchemaRegistry = {
  found: z.object({
    kind: z.literal("found"),
    value: z.custom<SensitiveValue>((value) => value instanceof SensitiveValue),
  }).strict().readonly(),
  missing: z.object({ kind: z.literal("missing") }).strict().readonly(),
} as const;
const secretStoreGetResultSchemas = Object.values(SecretStoreGetResultSchemaRegistry) as [
  (typeof SecretStoreGetResultSchemaRegistry)[keyof typeof SecretStoreGetResultSchemaRegistry],
  ...(typeof SecretStoreGetResultSchemaRegistry)[keyof typeof SecretStoreGetResultSchemaRegistry][],
];
export const SecretStoreGetResultSchema = z.discriminatedUnion("kind", secretStoreGetResultSchemas);
export type SecretStoreGetResult = z.infer<typeof SecretStoreGetResultSchema>;

const SecretStoreRemoveResultSchemaRegistry = {
  removed: z.literal("removed"),
  missing: z.literal("missing"),
} as const;
const secretStoreRemoveResultSchemas = Object.values(SecretStoreRemoveResultSchemaRegistry) as [
  (typeof SecretStoreRemoveResultSchemaRegistry)[keyof typeof SecretStoreRemoveResultSchemaRegistry],
  ...(typeof SecretStoreRemoveResultSchemaRegistry)[keyof typeof SecretStoreRemoveResultSchemaRegistry][],
];
export const SecretStoreRemoveResultSchema = z.union(secretStoreRemoveResultSchemas);
export type SecretStoreRemoveResult = z.infer<typeof SecretStoreRemoveResultSchema>;

/**
 * Adapter-neutral OS credential boundary. `put` is an atomic no-replace
 * create: it returns `collision` when the locator already exists and must not
 * alter the existing value. `removeOwned` requires evidence returned by a
 * successful `put`; `remove` is reserved for an explicitly authoritative
 * document retirement and therefore still takes its proven locator.
 */
export interface SecretStore {
  put(locator: SecretLocator, value: SensitiveValue, signal: AbortSignal): Promise<SecretStorePutResult>;
  get(
    locator: SecretLocator,
    signal: AbortSignal,
  ): Promise<SecretStoreGetResult>;
  remove(locator: SecretLocator, signal: AbortSignal): Promise<SecretStoreRemoveResult>;
  removeOwned(evidence: SecretCreationEvidence, signal: AbortSignal): Promise<SecretStoreRemoveResult>;
}
