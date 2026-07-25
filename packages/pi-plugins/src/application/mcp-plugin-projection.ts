import { z } from "zod";
import { canonicalJson, compareUtf8 } from "../domain/canonical-json.js";
import { verifyComponentId } from "../domain/component-identity.js";
import { ComponentIdSchema, type ComponentId } from "../domain/components.js";
import {
  CompatibilityReportSchema,
  RuntimeRequirementStatusRegistry,
  type CompatibilityReport,
} from "../domain/compatibility.js";
import { analyzeMcpCompatibility, compareMcpSourceLocations } from "../domain/mcp-compatibility-plan.js";
import { createMcpLaunchTemplate } from "../domain/mcp-launch-template.js";
import type { PluginIdentity } from "../domain/identity.js";
import { RuntimeCapabilityRegistry, type RuntimeCapabilityId } from "../domain/compatibility-policy.js";
import { ContentDigestSchema, hashContent, type ContentDigest } from "../domain/content-manifest.js";
import { DomainContractError, ErrorCodeRegistry } from "../domain/errors.js";
import { SourceLocationSchema, type SourceLocation } from "../domain/provenance-location.js";
import type { Sha256 } from "../domain/source.js";
import {
  McpConfigSourceSchemaV1,
  McpRuntimeCapabilitiesSchemaV1,
  McpRuntimeServerKeySchemaV1,
  deriveMcpRuntimeServerKey,
  McpSourceIdentitySchemaV1,
  McpSourceRegistrationSchemaV1,
  McpSourceProjectionBindingSchemaV1,
  McpToolAliasSegmentSchema,
  McpToolAliasTemplateSchemaV1,
  type McpConfigSource,
  type McpRuntimeCapabilities,
  type McpRuntimeServerKey,
  type McpSourceIdentity,
} from "./ports/mcp-runtime.js";
import {
  createMcpSourceRegistration,
  verifyMcpSourceRegistration,
} from "./mcp-source-registration.js";
import {
  PluginRuntimeProjectionSchemaV1,
  createActiveProjectionExpectation,
  digestCompatibilityReport,
  type PluginRuntimeProjection,
} from "./ports/runtime-projection.js";

export const PluginMcpLaunchTemplateSchemaV1 = McpSourceProjectionBindingSchemaV1;
export type PluginMcpLaunchTemplate = z.infer<typeof PluginMcpLaunchTemplateSchemaV1>;

export const PluginMcpAliasOmissionCodeSchema = z.enum([
  "RUNTIME_ALIAS_UNAVAILABLE",
  "UNREPRESENTABLE_ALIAS_SEGMENT",
]);
export type PluginMcpAliasOmissionCode = z.infer<typeof PluginMcpAliasOmissionCodeSchema>;

export const PluginMcpAliasOmissionSchema = z.object({
  componentId: ComponentIdSchema,
  serverKey: McpRuntimeServerKeySchemaV1,
  code: PluginMcpAliasOmissionCodeSchema,
}).strict().readonly();
export type PluginMcpAliasOmission = z.infer<typeof PluginMcpAliasOmissionSchema>;

const PluginMcpProjectionNoneSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("none"),
  identity: McpSourceIdentitySchemaV1,
  aliasOmissions: z.tuple([]),
  digest: ContentDigestSchema,
}).strict().readonly();

const PluginMcpProjectionSourceSchemaV1 = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("source"),
  registration: McpSourceRegistrationSchemaV1,
  aliasOmissions: z.array(PluginMcpAliasOmissionSchema).readonly(),
  digest: ContentDigestSchema,
}).strict().readonly();

export const PluginMcpProjectionSchemaV1 = z.discriminatedUnion("kind", [
  PluginMcpProjectionNoneSchemaV1,
  PluginMcpProjectionSourceSchemaV1,
]);
export type PluginMcpProjection = z.infer<typeof PluginMcpProjectionSchemaV1>;

const encoder = new TextEncoder();
const OPERATION = "createPluginMcpProjection";

function fail(reason: string, componentIds: readonly string[] = []): never {
  throw new DomainContractError({
    code: ErrorCodeRegistry.sourceInvalid,
    operation: OPERATION,
    message: "MCP projection evidence is inconsistent",
    details: {
      reason,
      ...(componentIds.length === 0 ? {} : { componentIds: [...componentIds].sort(compareUtf8) }),
    },
  });
}

function digestProjection(
  value: Omit<PluginMcpProjection, "digest">,
  sha256: Sha256,
): ContentDigest {
  return hashContent(
    encoder.encode(`plugin-mcp-projection-v1\0${canonicalJson(value)}`),
    sha256,
  );
}

function sourceIdentity(projection: PluginRuntimeProjection): McpSourceIdentity {
  return McpSourceIdentitySchemaV1.parse({
    schemaVersion: 1,
    scope: projection.scope,
    plugin: projection.plugin,
    revision: projection.revision,
    projectionDigest: projection.digest,
  });
}

function exactSet(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareUtf8);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = exactSet(left);
  const b = exactSet(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function runtimeSupports(
  capability: RuntimeCapabilityId,
  runtime: McpRuntimeCapabilities,
): boolean {
  switch (capability) {
    case RuntimeCapabilityRegistry.mcpRuntime.id:
      return Object.values(runtime.sourceLifecycle).every(Boolean);
    case RuntimeCapabilityRegistry.mcpTransportStdio.id:
      return runtime.transports.stdio;
    case RuntimeCapabilityRegistry.mcpTransportStreamableHttp.id:
      return runtime.transports.streamableHttp;
    case RuntimeCapabilityRegistry.mcpOAuthAuthorizationCode.id:
      return runtime.oauth.authorizationCode;
    case RuntimeCapabilityRegistry.mcpOAuthClientCredentials.id:
      return runtime.oauth.clientCredentials;
    case RuntimeCapabilityRegistry.mcpToolApproval.id:
      return runtime.features.toolApproval;
    case RuntimeCapabilityRegistry.mcpSampling.id:
      return runtime.features.sampling;
    case RuntimeCapabilityRegistry.mcpElicitationForm.id:
      return runtime.features.elicitationForm;
    case RuntimeCapabilityRegistry.mcpElicitationUrl.id:
      return runtime.features.elicitationUrl;
    case RuntimeCapabilityRegistry.mcpResources.id:
      return runtime.features.resources;
    default:
      return false;
  }
}

function requirementId(componentId: string, capability: RuntimeCapabilityId): string {
  return `requirement-v1:${capability}:${componentId}`;
}

function canonicalLocations(locations: readonly SourceLocation[]): readonly [SourceLocation, ...SourceLocation[]] {
  const sorted = locations.map((location) => SourceLocationSchema.parse(location)).sort(compareMcpSourceLocations);
  const unique = sorted.filter((location, index) =>
    index === 0 || compareMcpSourceLocations(location, sorted[index - 1]!) !== 0);
  if (unique.length === 0) fail("MISSING_MCP_PROVENANCE");
  return unique as [SourceLocation, ...SourceLocation[]];
}

function reportAssessment(report: CompatibilityReport, componentId: string) {
  return report.components.find((assessment) => assessment.componentId === componentId);
}

function verifyReportPlan(
  report: CompatibilityReport,
  componentId: string,
  capabilities: readonly RuntimeCapabilityId[],
  runtime: McpRuntimeCapabilities,
): void {
  const assessment = reportAssessment(report, componentId);
  if (assessment === undefined || assessment.verdict.kind !== "supported") {
    fail("MCP_COMPONENT_NOT_SUPPORTED", [componentId]);
  }
  const expectedIds = capabilities.map((capability) => requirementId(componentId, capability));
  if (!sameStrings(assessment.requirementIds, expectedIds)) {
    fail("MCP_REQUIREMENT_SET_MISMATCH", [componentId]);
  }
  const byId = new Map<string, CompatibilityReport["requirements"][number]>(
    report.requirements.map((entry) => [entry.requirement.id, entry]),
  );
  for (const [index, id] of expectedIds.entries()) {
    const requirement = byId.get(id);
    if (requirement === undefined || requirement.status !== RuntimeRequirementStatusRegistry.available.tag) {
      fail("MCP_REQUIREMENT_UNAVAILABLE", [componentId]);
    }
    if (requirement.requirement.capability !== capabilities[index] ||
        !runtimeSupports(capabilities[index]!, runtime)) {
      fail("MCP_RUNTIME_CAPABILITY_MISMATCH", [componentId]);
    }
  }
}

function aliasFor(
  pluginIdentity: PluginIdentity,
  componentId: ComponentId,
  serverKey: McpRuntimeServerKey,
  nativeKey: string,
  provenance: readonly SourceLocation[],
  runtime: McpRuntimeCapabilities,
): Readonly<{
  aliases: readonly z.infer<typeof McpToolAliasTemplateSchemaV1>[];
  omission?: PluginMcpAliasOmission;
}> {
  if (!provenance.some((location) => location.host === "claude")) return { aliases: [] };
  if (!runtime.features.pluginToolAliases) {
    return {
      aliases: [],
      omission: PluginMcpAliasOmissionSchema.parse({
        componentId,
        serverKey,
        code: "RUNTIME_ALIAS_UNAVAILABLE",
      }),
    };
  }
  const pluginName = pluginIdentity.manifestName ?? pluginIdentity.marketplaceEntryName;
  const validPlugin = McpToolAliasSegmentSchema.safeParse(pluginName);
  const validNativeKey = McpToolAliasSegmentSchema.safeParse(nativeKey);
  if (!validPlugin.success || !validNativeKey.success) {
    return {
      aliases: [],
      omission: PluginMcpAliasOmissionSchema.parse({
        componentId,
        serverKey,
        code: "UNREPRESENTABLE_ALIAS_SEGMENT",
      }),
    };
  }
  return {
    aliases: [McpToolAliasTemplateSchemaV1.parse({
      schemaVersion: 1,
      kind: "claude-plugin",
      pluginName: validPlugin.data,
      nativeServerKey: validNativeKey.data,
      collisionPolicy: "omit-all",
      preserveNativeDiscovery: true,
    })],
  };
}

function canonicalWithoutDigest(value: PluginMcpProjection): Omit<PluginMcpProjection, "digest"> {
  const { digest: _digest, ...withoutDigest } = value;
  return withoutDigest;
}

function derivePluginMcpProjection(
  projection: PluginRuntimeProjection,
  runtime: McpRuntimeCapabilities,
  sha256: Sha256,
  verifyPlan?: (
    componentId: ComponentId,
    capabilities: readonly RuntimeCapabilityId[],
  ) => void,
): PluginMcpProjection {
  const identity = sourceIdentity(projection);
  if (projection.components.mcpServers.length === 0) {
    const withoutDigest = {
      schemaVersion: 1 as const,
      kind: "none" as const,
      identity,
      aliasOmissions: [] as const,
    };
    return PluginMcpProjectionSchemaV1.parse({
      ...withoutDigest,
      digest: digestProjection(withoutDigest, sha256),
    });
  }

  const rows = projection.components.mcpServers.map((component) => {
    try {
      verifyComponentId(component.id, projection.plugin, {
        kind: "mcp-server",
        nativeKey: component.nativeKey.value,
      }, sha256);
    } catch {
      fail("MCP_COMPONENT_ID_MISMATCH", [component.id]);
    }
    const analysis = analyzeMcpCompatibility({ plugin: projection.plugin, component });
    // Runtime projection only receives activatable components; a degraded or
    // blocked analysis here means the activation evidence drifted.
    if (analysis.kind !== "supported") fail("MCP_DECLARATION_UNSUPPORTED", [component.id]);
    for (const capability of analysis.plan.requirementCapabilityIds) {
      if (!runtimeSupports(capability, runtime)) {
        fail("MCP_RUNTIME_CAPABILITY_MISMATCH", [component.id]);
      }
    }
    verifyPlan?.(component.id, analysis.plan.requirementCapabilityIds);

    const serverKey = deriveMcpRuntimeServerKey(component.id);
    const provenance = canonicalLocations(analysis.plan.provenance);
    const alias = aliasFor(
      projection.pluginIdentity,
      component.id,
      serverKey,
      component.nativeKey.value,
      provenance,
      runtime,
    );
    const projectionBinding = PluginMcpLaunchTemplateSchemaV1.parse({
      schemaVersion: 1,
      componentId: component.id,
      contentRef: projection.contentRef,
      dataRef: projection.dataRef,
      ...(projection.configurationRef === undefined ? {} : { configurationRef: projection.configurationRef }),
    });
    let launchTemplate: ReturnType<typeof createMcpLaunchTemplate>;
    try {
      launchTemplate = createMcpLaunchTemplate(component, projection.plugin);
    } catch {
      fail("MCP_LAUNCH_TEMPLATE_MISMATCH", [component.id]);
    }
    return {
      serverKey,
      server: {
        componentId: component.id,
        nativeKey: component.nativeKey.value,
        transport: analysis.plan.transport,
        options: analysis.plan.options,
        projection: projectionBinding,
        launchTemplate,
        toolAliases: alias.aliases,
        provenance,
      },
      ...(alias.omission === undefined ? {} : { omission: alias.omission }),
    };
  }).sort((left, right) => compareUtf8(left.serverKey, right.serverKey));

  const source: McpConfigSource = McpConfigSourceSchemaV1.parse({
    schemaVersion: 1,
    identity,
    servers: Object.fromEntries(rows.map((row) => [row.serverKey, row.server])),
  });
  const aliasOmissions = rows.flatMap((row) => row.omission === undefined ? [] : [row.omission])
    .sort((left, right) => compareUtf8(left.serverKey, right.serverKey) || compareUtf8(left.code, right.code));
  const registration = createMcpSourceRegistration({ source, sha256 });
  const withoutDigest = {
    schemaVersion: 1 as const,
    kind: "source" as const,
    registration,
    aliasOmissions,
  };
  return PluginMcpProjectionSchemaV1.parse({
    ...withoutDigest,
    digest: digestProjection(withoutDigest, sha256),
  });
}

/**
 * Recompute MCP contribution bytes from the authoritative whole-plugin
 * projection. Lifecycle callers use this rather than trusting a separately
 * self-hashed MCP projection supplied beside the expectation.
 */
export function createPluginMcpProjectionFromExpectation(input: Readonly<{
  projection: PluginRuntimeProjection;
  runtimeCapabilities: McpRuntimeCapabilities;
  sha256: Sha256;
}>): PluginMcpProjection {
  let projection: PluginRuntimeProjection;
  let runtime: McpRuntimeCapabilities;
  try {
    projection = createActiveProjectionExpectation(
      PluginRuntimeProjectionSchemaV1.parse(input.projection),
      input.sha256,
    ).projection;
    runtime = McpRuntimeCapabilitiesSchemaV1.parse(input.runtimeCapabilities);
  } catch {
    fail("INVALID_MCP_PROJECTION_INPUT");
  }
  return derivePluginMcpProjection(projection, runtime, input.sha256);
}

/** Verify a claimed source projection against independently derived authority. */
export function verifyPluginMcpProjectionAgainstExpectation(input: Readonly<{
  claimed: unknown;
  projection: PluginRuntimeProjection;
  runtimeCapabilities: McpRuntimeCapabilities;
  sha256: Sha256;
}>): PluginMcpProjection {
  const claimed = verifyPluginMcpProjection(input.claimed, input.sha256);
  const authoritative = createPluginMcpProjectionFromExpectation(input);
  if (canonicalJson(claimed) !== canonicalJson(authoritative)) {
    fail("MCP_PROJECTION_AUTHORITY_MISMATCH");
  }
  return authoritative;
}

export function createPluginMcpProjection(input: Readonly<{
  projection: PluginRuntimeProjection;
  compatibility: CompatibilityReport;
  runtimeCapabilities: McpRuntimeCapabilities;
  sha256: Sha256;
  digest?: ContentDigest;
}>): PluginMcpProjection {
  let projection: PluginRuntimeProjection;
  let compatibility: CompatibilityReport;
  let runtime: McpRuntimeCapabilities;
  try {
    projection = createActiveProjectionExpectation(
      PluginRuntimeProjectionSchemaV1.parse(input.projection),
      input.sha256,
    ).projection;
    compatibility = CompatibilityReportSchema.parse(input.compatibility);
    runtime = McpRuntimeCapabilitiesSchemaV1.parse(input.runtimeCapabilities);
  } catch {
    fail("INVALID_MCP_PROJECTION_INPUT");
  }
  if (projection.pluginIdentity.key !== projection.plugin ||
      canonicalJson(compatibility.plugin) !== canonicalJson(projection.pluginIdentity)) {
    fail("PLUGIN_IDENTITY_MISMATCH");
  }
  if (digestCompatibilityReport(compatibility, input.sha256) !== projection.compatibilityDigest) {
    fail("COMPATIBILITY_EVIDENCE_MISMATCH");
  }
  if (!compatibility.activatable) fail("REPORT_NOT_ACTIVATABLE");

  const inventoryIds = projection.components.mcpServers.map((component) => component.id);
  const reportMcpIds = compatibility.components
    .filter((assessment) => assessment.componentId.startsWith("component-v1:mcp-server:"))
    .filter((assessment) => assessment.verdict.kind === "supported")
    .map((assessment) => assessment.componentId);
  if (!sameStrings(inventoryIds, reportMcpIds)) {
    fail("MCP_INVENTORY_MISMATCH", [...inventoryIds, ...reportMcpIds]);
  }

  const result = derivePluginMcpProjection(
    projection,
    runtime,
    input.sha256,
    (componentId, capabilityIds) => verifyReportPlan(
      compatibility,
      componentId,
      capabilityIds,
      runtime,
    ),
  );
  if (input.digest !== undefined && ContentDigestSchema.parse(input.digest) !== result.digest) {
    fail("MCP_PROJECTION_DIGEST_MISMATCH");
  }
  return result;
}

export function verifyPluginMcpProjection(
  input: unknown,
  sha256: Sha256,
): PluginMcpProjection {
  let value: PluginMcpProjection;
  try {
    value = PluginMcpProjectionSchemaV1.parse(input);
  } catch {
    fail("INVALID_MCP_PROJECTION_SHAPE");
  }
  if (value.kind === "source") {
    // The projection digest includes the claimed registration digest, so the
    // registration must also be independently recomputed from its source.
    verifyMcpSourceRegistration(value.registration, sha256);
  }
  const expected = digestProjection(canonicalWithoutDigest(value), sha256);
  if (value.digest !== expected) fail("MCP_PROJECTION_DIGEST_MISMATCH");
  return value;
}
