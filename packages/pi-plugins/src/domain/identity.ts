import { z } from "zod";

const IdentityNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const MarketplaceNameSchema = z
  .string()
  .regex(IdentityNamePattern)
  .brand<"MarketplaceName">();
export type MarketplaceName = z.infer<typeof MarketplaceNameSchema>;

export const PluginNameSchema = z
  .string()
  .regex(IdentityNamePattern)
  .brand<"PluginName">();
export type PluginName = z.infer<typeof PluginNameSchema>;

export const PluginKeySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/,
  )
  .brand<"PluginKey">();
export type PluginKey = z.infer<typeof PluginKeySchema>;

export const PluginIdentitySchema = z
  .object({
    key: PluginKeySchema,
    marketplaceName: MarketplaceNameSchema,
    marketplaceEntryName: PluginNameSchema,
    manifestName: z.string().min(1).optional(),
  })
  .readonly()
  .superRefine((value, context) => {
    const expectedKey = `${value.marketplaceEntryName}@${value.marketplaceName}`;
    if (value.key !== expectedKey) {
      context.addIssue({
        code: "custom",
        path: ["key"],
        message: "key must match marketplaceEntryName@marketplaceName",
      });
    }
  });
export type PluginIdentity = z.infer<typeof PluginIdentitySchema>;

/**
 * Format the external identity using validated, canonical name components.
 * Names are deliberately not trimmed or case-folded: changing either would
 * make a foreign declaration refer to a different plugin.
 */
export function formatPluginKey(
  plugin: PluginName,
  marketplace: MarketplaceName,
): PluginKey {
  const validPlugin = PluginNameSchema.parse(plugin);
  const validMarketplace = MarketplaceNameSchema.parse(marketplace);
  return PluginKeySchema.parse(`${validPlugin}@${validMarketplace}`);
}

/**
 * Parse at the final delimiter before validating each component. The grammar
 * currently permits only one delimiter, but final-delimiter parsing keeps the
 * operation's boundary explicit if the grammar grows later.
 */
export function parsePluginKey(input: unknown): {
  plugin: PluginName;
  marketplace: MarketplaceName;
} {
  const key = PluginKeySchema.parse(input);
  const delimiter = key.lastIndexOf("@");
  return {
    plugin: PluginNameSchema.parse(key.slice(0, delimiter)),
    marketplace: MarketplaceNameSchema.parse(key.slice(delimiter + 1)),
  };
}

export function createPluginIdentity(input: unknown): PluginIdentity {
  return PluginIdentitySchema.parse(input);
}
