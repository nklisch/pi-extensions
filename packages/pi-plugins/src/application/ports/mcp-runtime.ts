import { z } from "zod";
import {
  ComponentIdSchema,
  type ComponentId,
} from "../../domain/components.js";
import {
  ContentDigestSchema,
  type ContentDigest,
} from "../../domain/content-manifest.js";
import {
  DiagnosticSchema,
  ErrorCodeSchema,
  ReadResultSchema,
  type Diagnostic,
  type ReadResult,
} from "../../domain/errors.js";
import { PluginKeySchema, type PluginKey } from "../../domain/identity.js";
import {
  ScopeReferenceSchema,
  type ScopeReference,
} from "../../domain/state/scope.js";
import {
  SourceLocationSchema,
  type SourceLocation,
} from "../../domain/provenance-location.js";
import {
  PluginConfigurationRefSchema,
  PluginContentRefSchema,
  PluginDataRefSchema,
} from "../../domain/state/references.js";
import type { JsonValue } from "../../domain/schema.js";
import { hasLoneSurrogate } from "../../domain/canonical-json.js";
import { McpCanonicalOptionsSchemaV1 } from "../../domain/mcp-compatibility-plan.js";
import { McpLaunchTemplateSchemaV1 } from "../../domain/mcp-launch-template.js";

/** The only transports that the Plugin Host source bridge may claim. */
export const McpBridgeTransportSchema = z.enum(["stdio", "streamable-http"]);
export type McpBridgeTransport = z.infer<typeof McpBridgeTransportSchema>;

/**
 * A source is owned by the complete versioned projection identity. Native MCP
 * server names are deliberately absent from this key: they are only unique
 * inside one source.
 */
export const McpSourceIdentitySchemaV1 = z
  .object({
    schemaVersion: z.literal(1),
    scope: ScopeReferenceSchema,
    plugin: PluginKeySchema,
    revision: ContentDigestSchema,
    projectionDigest: ContentDigestSchema,
  })
  .strict()
  .readonly();
export type McpSourceIdentity = z.infer<typeof McpSourceIdentitySchemaV1>;

export const McpRuntimeServerKeySchemaV1 = z
  .string()
  .regex(/^mcp-server-v1:[0-9a-f]{64}$/)
  .brand<"McpRuntimeServerKey">();
export type McpRuntimeServerKey = z.infer<typeof McpRuntimeServerKeySchemaV1>;

/** The server key is a pure projection of its globally stable component id. */
export function deriveMcpRuntimeServerKey(componentIdInput: ComponentId): McpRuntimeServerKey {
  const componentId = ComponentIdSchema.parse(componentIdInput);
  const match = /^component-v1:mcp-server:([0-9a-f]{64})$/.exec(componentId);
  if (match === null) throw new Error("MCP component id cannot derive a runtime server key");
  return McpRuntimeServerKeySchemaV1.parse(`mcp-server-v1:${match[1]}`);
}

export const McpToolAliasSegmentSchema = z
  .string()
  .min(1)
  .max(1024)
  .superRefine((value, context) => {
    if (hasLoneSurrogate(value)) {
      context.addIssue({ code: "custom", message: "alias segments must contain only Unicode scalar values" });
    }
    for (const scalar of value) {
      const codePoint = scalar.codePointAt(0)!;
      if (codePoint <= 0x1f || codePoint >= 0x7f && codePoint <= 0x9f) {
        context.addIssue({ code: "custom", message: "alias segments cannot contain control characters" });
        break;
      }
    }
  });
export type McpToolAliasSegment = z.infer<typeof McpToolAliasSegmentSchema>;

export const McpToolAliasTemplateSchemaV1 = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("claude-plugin"),
    pluginName: McpToolAliasSegmentSchema,
    nativeServerKey: McpToolAliasSegmentSchema,
    collisionPolicy: z.literal("omit-all"),
    preserveNativeDiscovery: z.literal(true),
  })
  .strict()
  .readonly();
export type McpToolAliasTemplate = z.infer<typeof McpToolAliasTemplateSchemaV1>;

/**
 * Exact logical projection evidence travels beside the executable template.
 * Physical roots and configured values remain absent until immediate launch.
 */
export const McpSourceProjectionBindingSchemaV1 = z
  .object({
    schemaVersion: z.literal(1),
    componentId: ComponentIdSchema,
    contentRef: PluginContentRefSchema,
    dataRef: PluginDataRefSchema,
    configurationRef: PluginConfigurationRefSchema.optional(),
  })
  .strict()
  .readonly();
export type McpSourceProjectionBinding = z.infer<typeof McpSourceProjectionBindingSchemaV1>;

/** A source server contains structure only; plaintext launch values arrive later. */
export const McpSourceServerSchemaV1 = z
  .object({
    componentId: ComponentIdSchema,
    nativeKey: z.string().min(1),
    transport: McpBridgeTransportSchema,
    options: McpCanonicalOptionsSchemaV1,
    projection: McpSourceProjectionBindingSchemaV1,
    launchTemplate: McpLaunchTemplateSchemaV1,
    toolAliases: z.array(McpToolAliasTemplateSchemaV1).max(1).readonly(),
    provenance: z.array(SourceLocationSchema).min(1).readonly(),
  })
  .strict()
  .readonly()
  .superRefine((server, context) => {
    if (server.projection.componentId !== server.componentId) {
      context.addIssue({
        code: "custom",
        path: ["projection", "componentId"],
        message: "source projection component must match the server component",
      });
    }
    if (server.launchTemplate.transport !== server.transport) {
      context.addIssue({
        code: "custom",
        path: ["launchTemplate", "transport"],
        message: "launch template transport must match the server transport",
      });
    }
    const templateHasBearer = server.launchTemplate.transport === "streamable-http" &&
      server.launchTemplate.bearerToken !== undefined;
    if ((server.options.auth.kind === "bearer-environment") !== templateHasBearer ||
        server.transport === "stdio" && server.options.auth.kind !== "none" ||
        server.launchTemplate.transport === "streamable-http" &&
          server.launchTemplate.endpointSecurity === "consent-bound-loopback-plaintext" &&
          server.options.auth.kind !== "none") {
      context.addIssue({
        code: "custom",
        path: ["options", "auth"],
        message: "canonical authentication options must match the launch template",
      });
    }
  });
export type McpSourceServer = z.infer<typeof McpSourceServerSchemaV1>;

export const McpConfigSourceSchemaV1 = z
  .object({
    schemaVersion: z.literal(1),
    identity: McpSourceIdentitySchemaV1,
    servers: z
      .record(McpRuntimeServerKeySchemaV1, McpSourceServerSchemaV1)
      .readonly(),
  })
  .strict()
  .readonly()
  .superRefine((source, context) => {
    const componentIds = new Map<ComponentId, string>();
    for (const [serverKey, server] of Object.entries(source.servers)) {
      let expectedKey: McpRuntimeServerKey | undefined;
      try {
        expectedKey = deriveMcpRuntimeServerKey(server.componentId);
      } catch {
        // The issue below is deliberately value-free because source input may
        // contain credential canaries elsewhere in the same server record.
      }
      if (serverKey !== expectedKey) {
        context.addIssue({
          code: "custom",
          path: ["servers", serverKey],
          message: "server key must be derived from the server component id",
        });
      }
      const previousKey = componentIds.get(server.componentId);
      if (previousKey !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["servers", serverKey, "componentId"],
          message: `component id is duplicated by server ${previousKey}`,
        });
      } else {
        componentIds.set(server.componentId, serverKey);
      }
    }
    if (Object.keys(source.servers).length === 0) {
      context.addIssue({
        code: "custom",
        path: ["servers"],
        message: "MCP configuration source must contain at least one server",
      });
    }
  });
export type McpConfigSource = z.infer<typeof McpConfigSourceSchemaV1>;

/** Canonical, secret-free bytes registered with one MCP runtime source. */
export const McpSourceRegistrationSchemaV1 = z
  .object({
    schemaVersion: z.literal(1),
    source: McpConfigSourceSchemaV1,
    digest: ContentDigestSchema,
  })
  .strict()
  .readonly();
export type McpSourceRegistration = z.infer<typeof McpSourceRegistrationSchemaV1>;

/** Every source publication is an exact owner-local compare-and-replace. */
export const McpSourcePreconditionSchemaV1 = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict().readonly(),
  z.object({
    kind: z.literal("exact"),
    identity: McpSourceIdentitySchemaV1,
  }).strict().readonly(),
]);
export type McpSourcePrecondition = z.infer<typeof McpSourcePreconditionSchemaV1>;

/**
 * One binding vocabulary is shared by launch-value and execution-lease
 * providers so a runtime cannot ask either callback about another component.
 */
export const McpRuntimeServerBindingSchemaV1 = z
  .object({
    schemaVersion: z.literal(1),
    source: McpSourceIdentitySchemaV1,
    serverKey: McpRuntimeServerKeySchemaV1,
    componentId: ComponentIdSchema,
    transport: McpBridgeTransportSchema,
  })
  .strict()
  .readonly()
  .superRefine((binding, context) => {
    let expectedKey: McpRuntimeServerKey | undefined;
    try {
      expectedKey = deriveMcpRuntimeServerKey(binding.componentId);
    } catch {
      // Report one static issue rather than preserving malformed input.
    }
    if (binding.serverKey !== expectedKey) {
      context.addIssue({
        code: "custom",
        path: ["serverKey"],
        message: "runtime server key must be derived from the component id",
      });
    }
  });
export type McpRuntimeServerBinding = z.infer<typeof McpRuntimeServerBindingSchemaV1>;

export const McpLaunchValueRequestSchema = McpRuntimeServerBindingSchemaV1;
export type McpLaunchValueRequest = McpRuntimeServerBinding;

/**
 * Plaintext launch values intentionally cannot be represented by a serialized
 * schema. They are only valid during one immediate runtime launch/connect
 * callback and must be disposed by the provider on every outcome.
 */
export type McpLaunchValues =
  | Readonly<{
      transport: "stdio";
      command: string;
      args: readonly string[];
      cwd?: string;
      env?: Readonly<Record<string, string>>;
    }>
  | Readonly<{
      transport: "streamable-http";
      url: string;
      headers?: Readonly<Record<string, string>>;
      bearerToken?: string;
    }>;

export interface McpLaunchValueProvider {
  resolve(
    request: McpLaunchValueRequest,
    signal: AbortSignal,
  ): Promise<McpLaunchValues>;
  dispose(values: McpLaunchValues): void | Promise<void>;
}

// Opaque and intentionally absent from every serializable schema.
declare const mcpRuntimeLeaseBrand: unique symbol;
export type McpRuntimeLease = Readonly<{
  readonly [mcpRuntimeLeaseBrand]: true;
}>;

export interface McpRuntimeLeaseProvider {
  acquire(
    binding: McpRuntimeServerBinding,
    signal: AbortSignal,
  ): Promise<McpRuntimeLease>;
  release(lease: McpRuntimeLease, signal: AbortSignal): Promise<void>;
  /**
   * Retry provider-owned cleanup whose token could not be transferred to the
   * runtime. Replacement and removal must drain before claiming success.
   */
  drain(signal: AbortSignal): Promise<void>;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const McpSourceStateSchema = z.enum([
  "registered",
  "replacing",
  "removing",
  "failed",
]);
const McpServerConnectionStateSchema = z.enum([
  "registered",
  "idle",
  "connecting",
  "connected",
  "needs-auth",
  "failed",
]);

export const McpSourceServerStatusSchema = z
  .object({
    key: McpRuntimeServerKeySchemaV1,
    componentId: ComponentIdSchema,
    nativeKey: z.string().min(1),
    provenance: z.array(SourceLocationSchema).min(1).readonly(),
    state: McpServerConnectionStateSchema,
    toolCount: z.number().int().nonnegative().optional(),
    errorCode: ErrorCodeSchema.optional(),
  })
  .strict()
  .readonly();
export type McpSourceServerStatus = z.infer<typeof McpSourceServerStatusSchema>;

/**
 * Inspection is a local, source-qualified view. It intentionally has no
 * definition, expanded value, error message, native cause, or provider field.
 */
export const McpSourceStatusSchema = z
  .object({
    identity: McpSourceIdentitySchemaV1,
    registrationDigest: ContentDigestSchema,
    state: McpSourceStateSchema,
    servers: z.array(McpSourceServerStatusSchema).readonly(),
  })
  .strict()
  .readonly()
  .superRefine((status, context) => {
    const keys = new Set<string>();
    const componentIds = new Set<string>();
    let previousKey: string | undefined;
    for (const [index, server] of status.servers.entries()) {
      if (keys.has(server.key)) {
        context.addIssue({
          code: "custom",
          path: ["servers", index, "key"],
          message: "source status contains a duplicate server key",
        });
      }
      keys.add(server.key);
      if (componentIds.has(server.componentId)) {
        context.addIssue({
          code: "custom",
          path: ["servers", index, "componentId"],
          message: "source status contains a duplicate component id",
        });
      }
      componentIds.add(server.componentId);
      if (previousKey !== undefined && compareText(previousKey, server.key) > 0) {
        context.addIssue({
          code: "custom",
          path: ["servers", index, "key"],
          message: "source status servers must be sorted by key",
        });
      }
      previousKey = server.key;
    }
  });
export type McpSourceStatus = z.infer<typeof McpSourceStatusSchema>;

export const McpRuntimeProviderSchemaV1 = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("test"),
    name: z.string().min(1),
  }).strict().readonly(),
  z.object({
    kind: z.literal("published-package"),
    packageName: z.string().min(1).regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/),
    version: z.string().min(1),
    integrity: z.string().min(1),
    nodeEngine: z.string().min(1),
    piPeerRange: z.string().min(1),
    contractVersion: z.literal(1),
  }).strict().readonly(),
]);
export type McpRuntimeProvider = z.infer<typeof McpRuntimeProviderSchemaV1>;

export const McpRuntimeCapabilitiesSchemaV1 = z
  .object({
    schemaVersion: z.literal(1),
    /** Host qualification is optional at the package-neutral port, but production composition requires it. */
    provider: McpRuntimeProviderSchemaV1.optional(),
    sourceLifecycle: z
      .object({
        initialSourcesBeforeToolRegistration: z.boolean(),
        isolatedFileDiscovery: z.boolean(),
        localValidation: z.boolean(),
        atomicReplace: z.boolean(),
        exactRemove: z.boolean(),
        inspect: z.boolean(),
        cancellable: z.boolean(),
        lateLaunchValues: z.boolean(),
        runtimeLeases: z.boolean(),
      })
      .strict()
      .readonly(),
    transports: z
      .object({
        stdio: z.boolean(),
        streamableHttp: z.boolean(),
        legacySse: z.boolean(),
        websocket: z.boolean(),
      })
      .strict()
      .readonly(),
    oauth: z
      .object({
        authorizationCode: z.boolean(),
        clientCredentials: z.boolean(),
      })
      .strict()
      .readonly(),
    features: z
      .object({
        sampling: z.boolean(),
        elicitationForm: z.boolean(),
        elicitationUrl: z.boolean(),
        toolApproval: z.boolean(),
        resources: z.boolean(),
        pluginToolAliases: z.boolean(),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();
export type McpRuntimeCapabilities = z.infer<typeof McpRuntimeCapabilitiesSchemaV1>;

export const McpSourceValidationResultSchema = ReadResultSchema(McpSourceRegistrationSchemaV1);
export type McpSourceValidationResult = ReadResult<McpSourceRegistration>;

const McpSourceReplaceResultSchemaRegistry = {
  applied: z
    .object({
      kind: z.literal("applied"),
      status: McpSourceStatusSchema,
      previousIdentity: McpSourceIdentitySchemaV1.optional(),
    })
    .strict()
    .readonly(),
  stale: z
    .object({
      kind: z.literal("stale"),
      currentIdentity: McpSourceIdentitySchemaV1,
    })
    .strict()
    .readonly(),
  rejected: z
    .object({
      kind: z.literal("rejected"),
      diagnostics: z.array(DiagnosticSchema).min(1).readonly(),
    })
    .strict()
    .readonly(),
} as const;
const McpSourceReplaceResultSchemas = Object.values(
  McpSourceReplaceResultSchemaRegistry,
) as [
  (typeof McpSourceReplaceResultSchemaRegistry)[keyof typeof McpSourceReplaceResultSchemaRegistry],
  ...(typeof McpSourceReplaceResultSchemaRegistry)[keyof typeof McpSourceReplaceResultSchemaRegistry][],
];
export const McpSourceReplaceResultSchema = z.discriminatedUnion(
  "kind",
  McpSourceReplaceResultSchemas,
);
export type McpSourceReplaceResult = z.infer<typeof McpSourceReplaceResultSchema>;

const McpSourceRemoveResultSchemaRegistry = {
  removed: z.object({ kind: z.literal("removed") }).strict().readonly(),
  absent: z.object({ kind: z.literal("absent") }).strict().readonly(),
  ownershipMismatch: z
    .object({
      kind: z.literal("ownership-mismatch"),
      requestedIdentity: McpSourceIdentitySchemaV1,
      currentIdentity: McpSourceIdentitySchemaV1,
    })
    .strict()
    .readonly(),
} as const;
const McpSourceRemoveResultSchemas = Object.values(
  McpSourceRemoveResultSchemaRegistry,
) as [
  (typeof McpSourceRemoveResultSchemaRegistry)[keyof typeof McpSourceRemoveResultSchemaRegistry],
  ...(typeof McpSourceRemoveResultSchemaRegistry)[keyof typeof McpSourceRemoveResultSchemaRegistry][],
];
export const McpSourceRemoveResultSchema = z.discriminatedUnion(
  "kind",
  McpSourceRemoveResultSchemas,
);
export type McpSourceRemoveResult = z.infer<typeof McpSourceRemoveResultSchema>;

export type McpSourceReplaceRequest = Readonly<{
  registration: McpSourceRegistration;
  expected: McpSourcePrecondition;
  launchValues: McpLaunchValueProvider;
  runtimeLeases: McpRuntimeLeaseProvider;
}>;

/** Package-independent MCP runtime lifecycle boundary. */
export interface McpRuntimePort {
  capabilities(signal: AbortSignal): Promise<McpRuntimeCapabilities>;
  validateSource(
    registration: McpSourceRegistration,
    signal: AbortSignal,
  ): Promise<McpSourceValidationResult>;
  replaceSource(
    request: McpSourceReplaceRequest,
    signal: AbortSignal,
  ): Promise<McpSourceReplaceResult>;
  removeSource(
    identity: McpSourceIdentity,
    signal: AbortSignal,
  ): Promise<McpSourceRemoveResult>;
  inspectSource(
    identity: McpSourceIdentity,
    signal: AbortSignal,
  ): Promise<McpSourceStatus | undefined>;
  inspectSources(signal: AbortSignal): Promise<readonly McpSourceStatus[]>;
}

export type {
  ComponentId,
  ContentDigest,
  Diagnostic,
  JsonValue,
  PluginKey,
  ScopeReference,
  SourceLocation,
};
