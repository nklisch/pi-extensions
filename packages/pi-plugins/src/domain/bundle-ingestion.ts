import { z } from "zod";
import {
  ComponentKindRegistry,
  RetainedMetadataSchema,
} from "./components.js";
import { ConfigurationOptionSchema } from "./configuration.js";
import {
  ClaimedSchema,
  NativeHostSchema,
  ProvenanceSchema,
} from "./provenance.js";
import { JsonValueSchema } from "./schema.js";

/** Manifest locations are a shared contract for readers and discovery planning. */
export const PluginManifestPathRegistry = {
  claude: ".claude-plugin/plugin.json",
  codex: ".codex-plugin/plugin.json",
} as const;

export type PluginManifestPath = (typeof PluginManifestPathRegistry)[keyof typeof PluginManifestPathRegistry];

function registryEnum<const T extends readonly [string, ...string[]]>(
  values: T,
): z.ZodEnum<{ [K in T[number]]: K }> {
  return z.enum(values as unknown as [T[number], ...T[number][]]) as z.ZodEnum<{
    [K in T[number]]: K;
  }>;
}

const componentKinds = registryEnum([
  ComponentKindRegistry.skill.tag,
  ComponentKindRegistry.hook.tag,
  ComponentKindRegistry.mcpServer.tag,
  ComponentKindRegistry.foreign.tag,
] as const);

/** Authorities are normalized before discovery; they are not compatibility verdicts. */
export const ComponentLocatorAuthorityRegistry = {
  authoritative: "authoritative",
  supplemental: "supplemental",
  conventional: "conventional",
} as const;
export const ComponentLocatorAuthoritySchema = registryEnum([
  ComponentLocatorAuthorityRegistry.authoritative,
  ComponentLocatorAuthorityRegistry.supplemental,
  ComponentLocatorAuthorityRegistry.conventional,
] as const);
export type ComponentLocatorAuthority = z.infer<
  typeof ComponentLocatorAuthoritySchema
>;

export const ComponentLocatorSourceRegistry = {
  catalog: "catalog",
  manifest: "manifest",
  convention: "convention",
} as const;
export const ComponentLocatorSourceSchema = registryEnum([
  ComponentLocatorSourceRegistry.catalog,
  ComponentLocatorSourceRegistry.manifest,
  ComponentLocatorSourceRegistry.convention,
] as const);
export type ComponentLocatorSource = z.infer<typeof ComponentLocatorSourceSchema>;

const relativeTargetPath = z.string().min(1);
const fileTargetSchema = z
  .object({ kind: z.literal("file"), path: relativeTargetPath })
  .strict()
  .readonly();
const directoryTargetSchema = z
  .object({ kind: z.literal("directory"), path: relativeTargetPath })
  .strict()
  .readonly();
const inlineTargetSchema = z
  .object({ kind: z.literal("inline"), declaration: JsonValueSchema })
  .strict()
  .readonly();

export const ComponentLocatorTargetSchema = z.discriminatedUnion("kind", [
  fileTargetSchema,
  directoryTargetSchema,
  inlineTargetSchema,
]);
export type ComponentLocatorTarget = z.infer<typeof ComponentLocatorTargetSchema>;

/** A source-located request for one finite, manifest-backed inspection target. */
export const ComponentLocatorClaimSchema = z
  .object({
    nativeHost: NativeHostSchema,
    componentKind: componentKinds,
    authority: ComponentLocatorAuthoritySchema,
    source: ComponentLocatorSourceSchema,
    target: ComponentLocatorTargetSchema,
    provenance: z.array(ProvenanceSchema).nonempty().readonly(),
  })
  .strict()
  .readonly()
  .superRefine((claim, context) => {
    if (claim.source === "convention" && claim.authority !== "conventional") {
      context.addIssue({
        code: "custom",
        path: ["authority"],
        message: "conventional locators must use conventional authority",
      });
    }
    if (claim.source !== "convention" && claim.authority === "conventional") {
      context.addIssue({
        code: "custom",
        path: ["authority"],
        message: "only convention locators may use conventional authority",
      });
    }
  });
export type ComponentLocatorClaim = z.infer<typeof ComponentLocatorClaimSchema>;

/**
 * A recognized declaration that cannot yet be mapped to a Pi runtime surface.
 * Keeping this contract in the domain lets readers retain inventory without
 * assigning compatibility policy or importing the compatibility layer.
 */
export const ForeignComponentDeclarationSchema = z
  .object({
    nativeHost: NativeHostSchema,
    nativeKind: ClaimedSchema(z.string().min(1)),
    declarationSubkey: z.string().min(1),
    declaration: ClaimedSchema(JsonValueSchema),
  })
  .strict()
  .readonly();
export type ForeignComponentDeclaration = z.infer<
  typeof ForeignComponentDeclarationSchema
>;

/** Shared normalized output for pure host-manifest readers. */
export const PluginManifestClaimsSchema = z
  .object({
    nativeHost: NativeHostSchema,
    document: ProvenanceSchema,
    name: ClaimedSchema(z.string().min(1)).optional(),
    version: ClaimedSchema(z.string().min(1)).optional(),
    description: ClaimedSchema(z.string()).optional(),
    locators: z.array(ComponentLocatorClaimSchema).readonly(),
    configuration: z.array(ConfigurationOptionSchema).readonly(),
    foreign: z.array(ForeignComponentDeclarationSchema).readonly(),
    metadata: z.array(RetainedMetadataSchema).readonly(),
  })
  .strict()
  .readonly();
export type PluginManifestClaims = z.infer<typeof PluginManifestClaimsSchema>;

