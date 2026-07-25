import { z } from "zod";
import { PluginKeySchema, type PluginKey } from "./identity.js";
import { JsonValueSchema, type JsonValue } from "./schema.js";
import { SourceLocationSchema, type SourceLocation } from "./provenance-location.js";

/**
 * Stable machine-readable failures at domain boundaries. These values are a
 * persistence and package contract; add new codes rather than changing an
 * existing meaning.
 */
export const ErrorCodeRegistry = {
  schemaInvalid: "SCHEMA_INVALID",
  entryInvalid: "ENTRY_INVALID",
  identityInvalid: "IDENTITY_INVALID",
  sourceInvalid: "SOURCE_INVALID",
  claimConflict: "CLAIM_CONFLICT",
  unsupportedDeclaration: "UNSUPPORTED_DECLARATION",
  requirementUnavailable: "REQUIREMENT_UNAVAILABLE",
  marketplaceRootInvalid: "MARKETPLACE_ROOT_INVALID",
  manifestRootInvalid: "MANIFEST_ROOT_INVALID",
  sourceResolutionFailed: "SOURCE_RESOLUTION_FAILED",
  pathContainmentFailed: "PATH_CONTAINMENT_FAILED",
  stagingAllocationInvalid: "STAGING_ALLOCATION_INVALID",
  contentVerificationFailed: "CONTENT_VERIFICATION_FAILED",
  storeIdentityCollision: "STORE_IDENTITY_COLLISION",
  durabilityUnavailable: "DURABILITY_UNAVAILABLE",
  transitionJournalCorrupt: "TRANSITION_JOURNAL_CORRUPT",
  recoveryConflict: "RECOVERY_CONFLICT",
  collectionDeferred: "COLLECTION_DEFERRED",
  adapterFailed: "ADAPTER_FAILED",
  foreignStateRootInvalid: "FOREIGN_STATE_ROOT_INVALID",
  mcpLaunchAuthorityRejected: "MCP_LAUNCH_AUTHORITY_REJECTED",
  mcpLaunchConfigurationFailed: "MCP_LAUNCH_CONFIGURATION_FAILED",
  mcpLaunchEnvironmentFailed: "MCP_LAUNCH_ENVIRONMENT_FAILED",
  mcpLaunchValueInvalid: "MCP_LAUNCH_VALUE_INVALID",
  mcpLaunchCancelled: "MCP_LAUNCH_CANCELLED",
  mcpLaunchTimeout: "MCP_LAUNCH_TIMEOUT",
  mcpLaunchCleanupFailed: "MCP_LAUNCH_CLEANUP_FAILED",
} as const;

type ErrorCodeValue =
  (typeof ErrorCodeRegistry)[keyof typeof ErrorCodeRegistry];

const errorCodeValues = Object.values(ErrorCodeRegistry) as [
  ErrorCodeValue,
  ...ErrorCodeValue[],
];

/** Runtime validation is derived from the single error-code registry. */
export const ErrorCodeSchema = z.enum(errorCodeValues);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

const fatalBoundaryCodes = [
  ErrorCodeRegistry.marketplaceRootInvalid,
  ErrorCodeRegistry.manifestRootInvalid,
  ErrorCodeRegistry.sourceResolutionFailed,
  ErrorCodeRegistry.pathContainmentFailed,
  ErrorCodeRegistry.adapterFailed,
] as const;

export const FatalBoundaryCodeSchema = z.enum(fatalBoundaryCodes);
export type FatalBoundaryCode = z.infer<typeof FatalBoundaryCodeSchema>;

export const DiagnosticSchema = z
  .object({
    code: ErrorCodeSchema,
    severity: z.enum(["warning", "error"]),
    operation: z.string().min(1),
    message: z.string().min(1),
    location: SourceLocationSchema.optional(),
    plugin: PluginKeySchema.optional(),
    details: JsonValueSchema.optional(),
  })
  .strict()
  .readonly();
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

export type DomainContractErrorInput = Readonly<{
  code: ErrorCode;
  operation: string;
  message: string;
  location?: SourceLocation;
  plugin?: PluginKey;
  details?: JsonValue;
  cause?: unknown;
}>;
