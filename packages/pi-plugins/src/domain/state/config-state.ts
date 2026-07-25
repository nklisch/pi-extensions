import { z } from "zod";
import { HostPrecedenceSchema } from "../host-precedence.js";
import { MarketplaceNameSchema } from "../identity.js";
import {
  MarketplaceSourceSchema,
  serializeMarketplaceSource,
  type MarketplaceSource,
} from "../source.js";
import {
  MarketplaceRegistrationRecordSchema,
  UpdateApplicationModeSchema,
  UpdateCadenceSchema,
  UpdateSchedulerLeaseSchema,
  type MarketplaceRegistrationRecord,
  type MarketplaceUpdateRecord,
} from "../update-policy.js";

/** A logical compare-and-swap value, never a timestamp or filesystem id. */
export const GenerationSchema = z.number().int().nonnegative().safe().brand<"Generation">();
export type Generation = z.infer<typeof GenerationSchema>;

export { UpdateApplicationPreferenceSchema } from "../update-policy.js";
export type { UpdateApplicationPreference } from "../update-policy.js";

/** Current records are policy/lease/notice authorities. */
export const MarketplaceConfigurationRecordSchema = MarketplaceRegistrationRecordSchema;
export type MarketplaceConfigurationRecord = MarketplaceRegistrationRecord;

function addDuplicateMarketplaceIssues(
  records: readonly { marketplace: string; source?: MarketplaceSource }[],
  path: string,
  context: z.RefinementCtx,
): void {
  const firstByMarketplace = new Map<string, number>();
  const firstBySource = new Map<string, number>();
  for (const [index, record] of records.entries()) {
    const firstIndex = firstByMarketplace.get(record.marketplace);
    if (firstIndex !== undefined) context.addIssue({ code: "custom", path: [path, index, "marketplace"], message: `duplicate marketplace configuration; first declared at index ${firstIndex}` });
    else firstByMarketplace.set(record.marketplace, index);
    if (record.source !== undefined) {
      const parsed = MarketplaceSourceSchema.safeParse(record.source);
      if (parsed.success) {
        const source = serializeMarketplaceSource(parsed.data);
        const sourceIndex = firstBySource.get(source);
        if (sourceIndex !== undefined) context.addIssue({ code: "custom", path: [path, index, "source"], message: `duplicate marketplace source; first declared at index ${sourceIndex}` });
        else firstBySource.set(source, index);
      }
    }
  }
}

export const HostUpdateGlobalPolicySchema = z.object({
  application: UpdateApplicationModeSchema,
  cadence: UpdateCadenceSchema,
  // Additive reconciliation preferences; the default keeps every pre-existing
  // document decodable, so this does not bump the hostConfig schemaVersion.
  resolution: z.object({
    hostPrecedence: HostPrecedenceSchema,
  }).strict().readonly().default({ hostPrecedence: ["claude", "codex"] }),
}).strict().readonly();
export type HostUpdateGlobalPolicy = z.infer<typeof HostUpdateGlobalPolicySchema>;

export const HostUpdateScopePolicySchema = z.object({
  application: UpdateApplicationModeSchema.optional(),
  schedulerLease: UpdateSchedulerLeaseSchema.optional(),
}).strict().readonly();
export type HostUpdateScopePolicy = z.infer<typeof HostUpdateScopePolicySchema>;

/**
 * The only host configuration schema. The literal version remains so a future
 * clean cut-over can recognize stale documents; stale versions are
 * reinitialized by the state codec, never migrated.
 */
export const HostConfigDocumentSchema = z.object({
  schemaVersion: z.literal(4),
  generation: GenerationSchema,
  global: HostUpdateGlobalPolicySchema.default({ application: "manual", cadence: "balanced", resolution: { hostPrecedence: ["claude", "codex"] } }),
  scope: HostUpdateScopePolicySchema.default({}),
  records: z.array(MarketplaceRegistrationRecordSchema).readonly(),
}).strict().readonly().superRefine((document, context) => addDuplicateMarketplaceIssues(document.records, "records", context));
export type HostConfigDocument = z.infer<typeof HostConfigDocumentSchema>;

export type { MarketplaceSource, MarketplaceUpdateRecord };
