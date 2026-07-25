import { z } from "zod";
import { RetainedMetadataSchema, PluginComponentsSchema } from "./components.js";
import { PluginConfigurationSchema } from "./configuration.js";
import { PluginIdentitySchema } from "./identity.js";
import { ClaimedSchema } from "./provenance.js";
import { ResolvedPluginSourceSchema } from "./source.js";

export const NormalizedPluginSchema = z
  .object({
    identity: PluginIdentitySchema,
    version: ClaimedSchema(z.string().min(1)).optional(),
    description: ClaimedSchema(z.string()).optional(),
    source: ResolvedPluginSourceSchema,
    configuration: PluginConfigurationSchema,
    components: PluginComponentsSchema,
    metadata: z.array(RetainedMetadataSchema).readonly(),
  })
  .strict()
  .readonly();
export type NormalizedPlugin = z.infer<typeof NormalizedPluginSchema>;
