import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  McpBridgeTransportSchema,
  McpConfigSourceSchemaV1,
  McpLaunchValueRequestSchema,
  McpRuntimeCapabilitiesSchemaV1,
  McpRuntimeServerBindingSchemaV1,
  McpRuntimeServerKeySchemaV1,
  deriveMcpRuntimeServerKey,
  McpToolAliasSegmentSchema,
  McpToolAliasTemplateSchemaV1,
  McpSourceIdentitySchemaV1,
  McpSourcePreconditionSchemaV1,
  McpSourceRegistrationSchemaV1,
  McpSourceRemoveResultSchema,
  McpSourceReplaceResultSchema,
  McpSourceServerSchemaV1,
  McpSourceStatusSchema,
  McpSourceValidationResultSchema,
  type McpConfigSource,
  type McpLaunchValues,
  type McpRuntimeCapabilities,
  type McpRuntimePort,
} from "../../src/application/ports/mcp-runtime.js";
import {
  createMcpSourceRegistration,
  verifyMcpSourceRegistration,
} from "../../src/application/mcp-source-registration.js";
import { ContentDigestSchema } from "../../src/domain/content-manifest.js";
import { ComponentIdSchema } from "../../src/domain/components.js";
import { PluginKeySchema } from "../../src/domain/identity.js";
import { SourceLocationSchema } from "../../src/domain/provenance-location.js";

const location = SourceLocationSchema.parse({
  host: "claude",
  documentKind: "mcp",
  path: "plugin.mcp.json",
  pointer: "/mcpServers/search",
});
const componentId = ComponentIdSchema.parse(`component-v1:mcp-server:${"a".repeat(64)}`);
const serverKey = `mcp-server-v1:${"a".repeat(64)}`;
const plugin = PluginKeySchema.parse("demo@community");
const digest = (hex: string) => ContentDigestSchema.parse(`sha256:${hex.repeat(64).slice(0, 64)}`);
const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

function identity(overrides: Record<string, unknown> = {}) {
  return McpSourceIdentitySchemaV1.parse({
    schemaVersion: 1,
    scope: { kind: "user" },
    plugin,
    revision: digest("1"),
    projectionDigest: digest("2"),
    ...overrides,
  });
}

function source(overrides: Record<string, unknown> = {}): McpConfigSource {
  return McpConfigSourceSchemaV1.parse({
    schemaVersion: 1,
    identity: identity(),
    servers: {
      [serverKey]: {
        componentId,
        nativeKey: "search",
        transport: "stdio",
        options: { schemaVersion: 1, startupTimeoutMs: 1000, auth: { kind: "none" } },
        projection: {
          schemaVersion: 1,
          componentId,
          contentRef: `plugin-content-v1:sha256:${"c".repeat(64)}`,
          dataRef: `plugin-data-v1:sha256:${"d".repeat(64)}`,
        },
        launchTemplate: {
          schemaVersion: 1,
          transport: "stdio",
          command: "search-command",
          args: [],
          env: [],
        },
        toolAliases: [],
        provenance: [location],
      },
    },
    ...overrides,
  });
}

function capabilities(): McpRuntimeCapabilities {
  return McpRuntimeCapabilitiesSchemaV1.parse({
    schemaVersion: 1,
    sourceLifecycle: {
      initialSourcesBeforeToolRegistration: true,
      isolatedFileDiscovery: true,
      localValidation: true,
      atomicReplace: true,
      exactRemove: true,
      inspect: true,
      cancellable: true,
      lateLaunchValues: true,
      runtimeLeases: true,
    },
    transports: {
      stdio: true,
      streamableHttp: true,
      legacySse: false,
      websocket: false,
    },
    oauth: { authorizationCode: true, clientCredentials: false },
    features: {
      sampling: true,
      elicitationForm: true,
      elicitationUrl: false,
      toolApproval: true,
      resources: true,
      pluginToolAliases: false,
    },
  });
}

describe("portable MCP runtime contract", () => {
  it("derives the public serializable types from strict schemas", () => {
    expectTypeOf<McpConfigSource>().toEqualTypeOf<z.infer<typeof McpConfigSourceSchemaV1>>();
    expectTypeOf<McpRuntimeCapabilities>().toEqualTypeOf<z.infer<typeof McpRuntimeCapabilitiesSchemaV1>>();
    expectTypeOf<McpLaunchValues>().not.toEqualTypeOf<McpConfigSource>();
    expectTypeOf<McpRuntimePort>().toMatchTypeOf<{
      capabilities: Function;
      validateSource: Function;
      replaceSource: Function;
      removeSource: Function;
      inspectSource: Function;
      inspectSources: Function;
    }>();
  });

  it("accepts only the two bridge transports", () => {
    expect(McpBridgeTransportSchema.parse("stdio")).toBe("stdio");
    expect(McpBridgeTransportSchema.parse("streamable-http")).toBe("streamable-http");
    expect(McpBridgeTransportSchema.safeParse("sse").success).toBe(false);
    expect(McpBridgeTransportSchema.safeParse("websocket").success).toBe(false);
  });

  it("rejects unknown fields, empty sources, duplicate components, functions, and non-JSON templates", () => {
    expect(McpSourceIdentitySchemaV1.safeParse({ ...identity(), extra: true }).success).toBe(false);
    expect(McpSourceServerSchemaV1.safeParse({
      ...source().servers[serverKey],
      launchTemplate: { callback: () => "secret" },
    }).success).toBe(false);
    expect(McpConfigSourceSchemaV1.safeParse({ ...source(), servers: {} }).success).toBe(false);
    expect(McpConfigSourceSchemaV1.safeParse({
      ...source(),
      servers: {
        [serverKey]: source().servers[serverKey],
        [`mcp-server-v1:${"c".repeat(64)}`]: { ...source().servers[serverKey], provenance: [location] },
      },
    }).success).toBe(false);
    expect(McpConfigSourceSchemaV1.safeParse({
      ...source(),
      servers: { [serverKey]: { ...source().servers[serverKey], transport: "sse" } },
    }).success).toBe(false);
    expect(McpSourceServerSchemaV1.safeParse({
      ...source().servers[serverKey],
      options: { ...source().servers[serverKey]!.options, startupTimeoutMs: Number.NaN },
    }).success).toBe(false);
    expect(McpSourceServerSchemaV1.safeParse({
      ...source().servers[serverKey],
      projection: {
        ...source().servers[serverKey]!.projection,
        componentId: ComponentIdSchema.parse(`component-v1:mcp-server:${"f".repeat(64)}`),
      },
    }).success).toBe(false);
    expect(McpSourceServerSchemaV1.safeParse({
      ...source().servers[serverKey],
      launchTemplate: {
        schemaVersion: 1,
        transport: "streamable-http",
        url: "https://example.invalid/mcp",
        headers: [],
      },
    }).success).toBe(false);
  });

  it("derives and enforces the only server key for each component id", () => {
    expect(deriveMcpRuntimeServerKey(componentId)).toBe(serverKey);
    const tamperedKey = `mcp-server-v1:${"f".repeat(64)}`;
    const tampered = {
      ...source(),
      servers: { [tamperedKey]: source().servers[serverKey] },
    };
    expect(McpConfigSourceSchemaV1.safeParse(tampered).success).toBe(false);
  });

  it("rejects secret-bearing options and templates at the public schema boundary", () => {
    const optionCanary = "CANARY_PUBLIC_OPTION";
    const templateCanary = "CANARY_PUBLIC_TEMPLATE";
    const candidate = {
      ...source(),
      servers: {
        [serverKey]: {
          ...source().servers[serverKey],
          options: { ...source().servers[serverKey]!.options, secret: optionCanary },
          launchTemplate: {
            schemaVersion: 1,
            transport: "stdio",
            command: "safe-command",
            args: [],
            env: [{ name: "JWT", value: templateCanary }],
          },
        },
      },
    };
    const parsed = McpConfigSourceSchemaV1.safeParse(candidate);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).not.toMatch(/CANARY_PUBLIC_/u);
  });

  it("rejects malformed opaque server keys and unsafe or authority-bearing aliases", () => {
    expect(McpRuntimeServerKeySchemaV1.safeParse("search").success).toBe(false);
    expect(McpToolAliasSegmentSchema.safeParse("safe/../opaque").success).toBe(true);
    expect(McpToolAliasSegmentSchema.safeParse("bad\u0000alias").success).toBe(false);
    expect(McpToolAliasSegmentSchema.safeParse("bad\ud800alias").success).toBe(false);
    const template = {
      schemaVersion: 1,
      kind: "claude-plugin",
      pluginName: "demo",
      nativeServerKey: "search",
      collisionPolicy: "omit-all",
      preserveNativeDiscovery: true,
    } as const;
    expect(McpToolAliasTemplateSchemaV1.parse(template)).toEqual(template);
    expect(McpToolAliasTemplateSchemaV1.safeParse({ ...template, collisionPolicy: "suffix" }).success).toBe(false);
    expect(McpToolAliasTemplateSchemaV1.safeParse({ ...template, preserveNativeDiscovery: false }).success).toBe(false);
    expect(McpToolAliasTemplateSchemaV1.safeParse({ ...template, authority: true }).success).toBe(false);
    expect(McpSourceServerSchemaV1.safeParse({
      ...source().servers[serverKey],
      toolAliases: [template, template],
    }).success).toBe(false);
  });

  it("binds exact canonical source bytes and rejects supplied digest drift", () => {
    const registration = createMcpSourceRegistration({ source: source(), sha256 });
    expect(McpSourceRegistrationSchemaV1.parse(registration)).toEqual(registration);
    expect(verifyMcpSourceRegistration(registration, sha256)).toEqual(registration);

    const server = source().servers[serverKey]!;
    const mutations = [
      { ...source(), identity: identity({ revision: digest("9") }) },
      { ...source(), servers: { [serverKey]: { ...server, nativeKey: "changed" } } },
      { ...source(), servers: { [serverKey]: { ...server, options: { ...server.options, toolTimeoutMs: 2000 } } } },
      { ...source(), servers: { [serverKey]: { ...server, transport: "streamable-http", launchTemplate: { schemaVersion: 1, transport: "streamable-http", endpointSecurity: "tls", url: "https://changed.invalid", headers: [] } } } },
      { ...source(), servers: { [serverKey]: { ...server, toolAliases: [{ schemaVersion: 1, kind: "claude-plugin", pluginName: "demo", nativeServerKey: "search", collisionPolicy: "omit-all", preserveNativeDiscovery: true }] } } },
      { ...source(), servers: { [serverKey]: { ...server, provenance: [{ ...location, pointer: "/changed" }] } } },
    ];
    for (const candidate of mutations) {
      const changed = createMcpSourceRegistration({
        source: McpConfigSourceSchemaV1.parse(candidate),
        sha256,
      });
      expect(changed.digest).not.toBe(registration.digest);
      expect(() => createMcpSourceRegistration({
        source: changed.source,
        digest: registration.digest,
        sha256,
      })).toThrow();
    }
  });

  it("keeps exact scope, plugin, revision, and projection identity", () => {
    const project = identity({
      scope: { kind: "project", projectKey: `project-v1:sha256:${"f".repeat(64)}` },
    });
    const otherRevision = identity({ revision: digest("3") });
    const otherProjection = identity({ projectionDigest: digest("4") });
    expect(new Set([
      JSON.stringify(identity()),
      JSON.stringify(project),
      JSON.stringify(otherRevision),
      JSON.stringify(otherProjection),
    ]).size).toBe(4);
    expect(McpConfigSourceSchemaV1.parse(source()).identity).toEqual(identity());
  });

  it("round-trips redacted status and typed operation outcomes", () => {
    const registration = createMcpSourceRegistration({ source: source(), sha256 });
    const status = McpSourceStatusSchema.parse({
      identity: identity(),
      registrationDigest: registration.digest,
      state: "registered",
      servers: [{
        key: serverKey,
        componentId,
        nativeKey: "search",
        provenance: [location],
        state: "idle",
        toolCount: 2,
        errorCode: "ADAPTER_FAILED",
      }],
    });
    expect(McpSourceStatusSchema.parse(status)).toEqual(status);
    expect(JSON.stringify(status)).not.toContain("commandRef");
    expect(McpSourceValidationResultSchema.parse({ ok: true, value: registration, diagnostics: [] }).ok).toBe(true);
    expect(McpSourceValidationResultSchema.safeParse({ ok: false, diagnostics: [] }).success).toBe(false);
    expect(McpSourceReplaceResultSchema.parse({ kind: "stale", currentIdentity: identity() }).kind).toBe("stale");
    expect(McpSourceReplaceResultSchema.parse({
      kind: "rejected",
      diagnostics: [{
        code: "SCHEMA_INVALID",
        severity: "error",
        operation: "validateMcpSource",
        message: "source is invalid",
      }],
    }).kind).toBe("rejected");
    expect(McpSourceRemoveResultSchema.parse({ kind: "absent" }).kind).toBe("absent");
    const mismatch = McpSourceRemoveResultSchema.parse({
      kind: "ownership-mismatch",
      requestedIdentity: identity(),
      currentIdentity: identity({ revision: digest("9") }),
    });
    expect(JSON.stringify(mismatch)).not.toContain("secret");
  });

  it("requires exact CAS, one runtime binding, cancellation, and mandatory cleanup callbacks", () => {
    const methods = [
      "capabilities",
      "validateSource",
      "replaceSource",
      "removeSource",
      "inspectSource",
      "inspectSources",
    ] as const;
    for (const method of methods) expect(method).toBeTypeOf("string");
    expect(McpSourcePreconditionSchemaV1.parse({ kind: "absent" })).toEqual({ kind: "absent" });
    expect(McpSourcePreconditionSchemaV1.parse({ kind: "exact", identity: identity() })).toMatchObject({ kind: "exact" });
    expect(McpSourcePreconditionSchemaV1.safeParse({ kind: "exact" }).success).toBe(false);
    const request = McpLaunchValueRequestSchema.parse({
      schemaVersion: 1,
      source: identity(),
      serverKey,
      componentId,
      transport: "stdio",
    });
    expect(McpRuntimeServerBindingSchemaV1.parse(request)).toEqual(request);
    expect(request.transport).toBe("stdio");
  });
});
