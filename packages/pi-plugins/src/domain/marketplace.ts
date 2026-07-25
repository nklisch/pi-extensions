import { z } from "zod";
import { RetainedMetadataSchema } from "./components.js";
import { DiagnosticSchema } from "./errors.js";
import { MarketplaceNameSchema, PluginIdentitySchema } from "./identity.js";
import { ClaimedSchema, NativeHostSchema, ProvenanceSchema } from "./provenance.js";
import { JsonValueSchema } from "./schema.js";
import { PluginSourceSchema } from "./source.js";

/** The catalog availability vocabulary is shared by every marketplace reader. */
export const MarketplaceAvailabilityRegistry = {
  available: "available",
  installedByDefault: "installed-by-default",
  notAvailable: "not-available",
} as const;

export const MarketplaceAvailabilitySchema = z.enum([
  MarketplaceAvailabilityRegistry.available,
  MarketplaceAvailabilityRegistry.installedByDefault,
  MarketplaceAvailabilityRegistry.notAvailable,
]);
export type MarketplaceAvailability = z.infer<typeof MarketplaceAvailabilitySchema>;

/**
 * Catalog installation intent is retained as claims because it is input to
 * policy evaluation, not proof that a source was acquired or installed.
 */
export const MarketplaceInstallationPolicySchema = z
  .object({
    availability: ClaimedSchema(MarketplaceAvailabilitySchema),
    authentication: ClaimedSchema(z.string().min(1)).optional(),
    declaration: ClaimedSchema(JsonValueSchema),
  })
  .strict()
  .readonly();
export type MarketplaceInstallationPolicy = z.infer<
  typeof MarketplaceInstallationPolicySchema
>;

/**
 * Authority describes which document wins when a later bundle reader sees a
 * catalog and a manifest. It is deliberately data-only: this contract does
 * not resolve a source or apply the authority to a plugin bundle.
 */
export const MarketplaceAuthoritySchema = z
  .object({
    nativeHost: NativeHostSchema,
    strict: ClaimedSchema(z.boolean()).optional(),
    manifest: ClaimedSchema(z.enum(["required", "optional"])),
    catalogRuntime: ClaimedSchema(z.enum(["supplemental", "authoritative"])),
  })
  .strict()
  .readonly()
  .superRefine((value, context) => {
    const strict = value.strict?.value;
    const expectedManifest = value.nativeHost === "codex"
      ? "required"
      : strict === false
        ? "optional"
        : "required";
    const expectedCatalogRuntime = value.nativeHost === "codex"
      ? "supplemental"
      : strict === false
        ? "authoritative"
        : "supplemental";

    if (value.nativeHost === "codex" && value.strict !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["strict"],
        message: "Codex marketplace authority cannot carry Claude strictness",
      });
    }

    if (value.manifest.value !== expectedManifest) {
      context.addIssue({
        code: "custom",
        path: ["manifest", "value"],
        message: `${value.nativeHost} authority requires manifest ${expectedManifest}`,
      });
    }
    if (value.catalogRuntime.value !== expectedCatalogRuntime) {
      context.addIssue({
        code: "custom",
        path: ["catalogRuntime", "value"],
        message: `${value.nativeHost} authority requires catalogRuntime ${expectedCatalogRuntime}`,
      });
    }
  });
export type MarketplaceAuthority = z.infer<typeof MarketplaceAuthoritySchema>;

/** Known catalog declarations that are not yet a resolved plugin inventory. */
export const MarketplaceDeclarationCategoryRegistry = {
  component: "component",
  dependency: "dependency",
  runtimeMetadata: "runtime-metadata",
} as const;

export const MarketplaceEntryDeclarationSchema = z
  .object({
    nativeHost: NativeHostSchema,
    category: z.enum([
      MarketplaceDeclarationCategoryRegistry.component,
      MarketplaceDeclarationCategoryRegistry.dependency,
      MarketplaceDeclarationCategoryRegistry.runtimeMetadata,
    ]),
    field: z.string().min(1),
    declaration: ClaimedSchema(JsonValueSchema),
  })
  .strict()
  .readonly();
export type MarketplaceEntryDeclaration = z.infer<
  typeof MarketplaceEntryDeclarationSchema
>;

function addDuplicateKeyIssues(
  values: readonly { readonly key: string }[],
  path: readonly PropertyKey[],
  context: z.RefinementCtx,
  label: string,
): void {
  const seen = new Map<string, number>();
  for (const [index, value] of values.entries()) {
    const firstIndex = seen.get(value.key);
    if (firstIndex !== undefined) {
      context.addIssue({
        code: "custom",
        path: [...path, index, "key"],
        message: `duplicate ${label} key; first declared at index ${firstIndex}`,
      });
    } else {
      seen.set(value.key, index);
    }
  }
}

export const NormalizedMarketplaceEntrySchema = z
  .object({
    identity: ClaimedSchema(PluginIdentitySchema),
    source: ClaimedSchema(PluginSourceSchema),
    version: ClaimedSchema(z.string().min(1)).optional(),
    description: ClaimedSchema(z.string()).optional(),
    policy: MarketplaceInstallationPolicySchema.optional(),
    authorities: z.array(MarketplaceAuthoritySchema).nonempty().readonly(),
    declarations: z.array(MarketplaceEntryDeclarationSchema).readonly(),
    metadata: z.array(RetainedMetadataSchema).readonly(),
    rawDeclaration: ClaimedSchema(JsonValueSchema),
  })
  .strict()
  .readonly()
  .superRefine((entry, context) => {
    // PluginIdentitySchema already binds key to entry and marketplace names;
    // these collection checks make the catalog-specific invariants explicit
    // at the boundary where consumers rely on them.
    const expectedKey = `${entry.identity.value.marketplaceEntryName}@${entry.identity.value.marketplaceName}`;
    if (entry.identity.value.key !== expectedKey) {
      context.addIssue({
        code: "custom",
        path: ["identity", "value", "key"],
        message: "identity key must match marketplaceEntryName@marketplaceName",
      });
    }

    const authorityHosts = new Map<string, number>();
    for (const [index, authority] of entry.authorities.entries()) {
      const firstIndex = authorityHosts.get(authority.nativeHost);
      if (firstIndex !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["authorities", index, "nativeHost"],
          message: `duplicate authority host; first declared at index ${firstIndex}`,
        });
      } else {
        authorityHosts.set(authority.nativeHost, index);
      }
    }

    addDuplicateKeyIssues(entry.metadata, ["metadata"], context, "metadata");
  });
export type NormalizedMarketplaceEntry = z.infer<
  typeof NormalizedMarketplaceEntrySchema
>;

export const NormalizedMarketplaceSchema = z
  .object({
    name: ClaimedSchema(MarketplaceNameSchema),
    entries: z.array(NormalizedMarketplaceEntrySchema).readonly(),
    metadata: z.array(RetainedMetadataSchema).readonly(),
    sourceDocuments: z.array(ProvenanceSchema).nonempty().readonly(),
  })
  .strict()
  .readonly()
  .superRefine((marketplace, context) => {
    const entryKeys = new Map<string, number>();
    for (const [index, entry] of marketplace.entries.entries()) {
      const key = entry.identity.value.key;
      const firstIndex = entryKeys.get(key);
      if (firstIndex !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "identity", "value", "key"],
          message: `duplicate marketplace entry key; first declared at index ${firstIndex}`,
        });
      } else {
        entryKeys.set(key, index);
      }

      if (entry.identity.value.marketplaceName !== marketplace.name.value) {
        context.addIssue({
          code: "custom",
          path: ["entries", index, "identity", "value", "marketplaceName"],
          message: "entry identity marketplaceName must match marketplace root name",
        });
      }
    }

    addDuplicateKeyIssues(marketplace.metadata, ["metadata"], context, "metadata");
  });
export type NormalizedMarketplace = z.infer<typeof NormalizedMarketplaceSchema>;

export const MarketplaceReadResultSchema = z
  .object({
    marketplace: NormalizedMarketplaceSchema,
    diagnostics: z.array(DiagnosticSchema).readonly(),
  })
  .strict()
  .readonly();
export type MarketplaceReadResult = z.infer<typeof MarketplaceReadResultSchema>;
