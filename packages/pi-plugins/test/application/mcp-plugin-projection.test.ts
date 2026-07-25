import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createPluginMcpProjection,
  verifyPluginMcpProjection,
  verifyPluginMcpProjectionAgainstExpectation,
} from "../../src/application/mcp-plugin-projection.js";
import { createMcpSourceRegistration } from "../../src/application/mcp-source-registration.js";
import {
  McpConfigSourceSchemaV1,
  McpRuntimeCapabilitiesSchemaV1,
  deriveMcpRuntimeServerKey,
} from "../../src/application/ports/mcp-runtime.js";
import { createPluginRuntimeProjection } from "../../src/application/ports/runtime-projection.js";
import { canonicalJson } from "../../src/domain/canonical-json.js";
import { evaluateCompatibility } from "../../src/domain/compatibility-evaluator.js";
import {
  CompatibilityPolicyRegistry,
  RuntimeCapabilityRegistry,
  RuntimeCapabilitySnapshotSchema,
} from "../../src/domain/compatibility-policy.js";
import { deriveComponentId } from "../../src/domain/component-identity.js";
import { createContentManifest, hashContent } from "../../src/domain/content-manifest.js";
import { DomainContractError } from "../../src/domain/errors.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { claim } from "../../src/domain/provenance.js";
import { createResolvedPluginSource } from "../../src/domain/source.js";
import { createInstalledRevisionRecord } from "../../src/domain/state/installed-state.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const content = createContentManifest([], sha256);
const location = (host: "claude" | "codex", pointer: string) => ({
  location: {
    host,
    documentKind: "mcp" as const,
    path: host === "claude" ? ".mcp.json" : ".codex-plugin/plugin.json",
    pointer,
  },
  declaration: { secret: "CANARY_DECLARATION" },
});

function capabilities(overrides: Record<string, "available" | "unavailable"> = {}) {
  return RuntimeCapabilitySnapshotSchema.parse({
    capabilities: Object.fromEntries(Object.values(RuntimeCapabilityRegistry).map((entry) => [
      entry.id,
      { status: overrides[entry.id] ?? "available", explanation: "fixture" },
    ])),
    capturedBy: "projection-test",
  });
}

function runtime(overrides: Record<string, unknown> = {}) {
  const base = {
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
    transports: { stdio: true, streamableHttp: true, legacySse: false, websocket: false },
    oauth: { authorizationCode: true, clientCredentials: true },
    features: {
      sampling: true,
      elicitationForm: true,
      elicitationUrl: true,
      toolApproval: true,
      resources: true,
      pluginToolAliases: true,
    },
  };
  return McpRuntimeCapabilitiesSchemaV1.parse({ ...base, ...overrides });
}

type ServerInput = Readonly<{
  nativeKey: string;
  declaration: Record<string, unknown>;
  hosts?: readonly ("claude" | "codex")[];
  pointer?: string;
  reverseProvenance?: boolean;
  duplicateProvenance?: boolean;
  forgedId?: string;
}>;

function fixture(input: Readonly<{
  plugin?: string;
  manifestName?: string;
  scope?: { kind: "user" } | { kind: "project"; projectKey: string };
  servers?: readonly ServerInput[];
  capabilityOverrides?: Record<string, "available" | "unavailable">;
  includeSkill?: boolean;
}> = {}) {
  const pluginKey = (input.plugin ?? "demo@community") as never;
  const [entryName, marketplaceName] = (input.plugin ?? "demo@community").split("@");
  const servers = (input.servers ?? [{
    nativeKey: "search/../opaque",
    declaration: {
      transport: "stdio",
      command: "${PLUGIN_ROOT}/bin/server",
      args: ["--root", "${PLUGIN_DATA}"],
      env: { TRACE: "${TRACE_VALUE}" },
      cwd: "${CLAUDE_PROJECT_DIR}",
      startupTimeout: 1000,
      allowTools: ["read"],
      instructions: "read-only",
    },
    hosts: ["codex", "claude"],
  }]).map((server, index) => {
    const hosts = server.hosts ?? ["claude"];
    const sourceProvenance = hosts.map((host) =>
      location(host, server.pointer ?? `/servers/${index}`));
    const ordered = server.reverseProvenance ? [...sourceProvenance].reverse() : sourceProvenance;
    const provenances = server.duplicateProvenance ? [...ordered, ordered[0]!] : ordered;
    const id = server.forgedId ?? deriveComponentId(pluginKey, {
      kind: "mcp-server",
      nativeKey: server.nativeKey,
    }, sha256);
    return {
      kind: "mcp-server" as const,
      id,
      nativeKey: { value: server.nativeKey, provenance: [...provenances].reverse() },
      declaration: { value: server.declaration, provenance: provenances },
      metadata: [],
    };
  });
  const skillProvenance = {
    location: {
      host: "claude" as const,
      documentKind: "skill" as const,
      path: "skills/bound/SKILL.md",
      pointer: "/frontmatter",
    },
  };
  const skills = input.includeSkill ? [{
    kind: "skill" as const,
    id: deriveComponentId(pluginKey, { kind: "skill", root: "skills/bound" }, sha256),
    name: claim("bound", skillProvenance),
    root: claim("skills/bound", skillProvenance),
    metadata: [],
  }] : [];
  const plugin = NormalizedPluginSchema.parse({
    identity: {
      key: pluginKey,
      marketplaceName,
      marketplaceEntryName: entryName,
      ...(input.manifestName === undefined ? {} : { manifestName: input.manifestName }),
    },
    source: createResolvedPluginSource({
      kind: "git",
      url: "https://example.invalid/plugin.git",
      revision: "a".repeat(40),
    }, sha256),
    configuration: { options: [] },
    components: { skills, hooks: [], mcpServers: servers, foreign: [] },
    metadata: [],
  });
  const compatibility = evaluateCompatibility({
    plugin,
    capabilities: capabilities(input.capabilityOverrides),
  });
  const scope = input.scope ?? { kind: "user" as const };
  const revision = createInstalledRevisionRecord({ plugin, compatibility, content, scope }, sha256);
  const projection = createPluginRuntimeProjection({
    scope,
    plugin,
    compatibility,
    revision,
    sha256,
  });
  return { plugin, compatibility, projection };
}

function create(f = fixture(), runtimeCapabilities = runtime()) {
  return createPluginMcpProjection({
    projection: f.projection,
    compatibility: f.compatibility,
    runtimeCapabilities,
    sha256,
  });
}

function rehashClaimedProjection(
  projection: Extract<ReturnType<typeof create>, { kind: "source" }>,
  sourceInput: unknown,
) {
  const source = McpConfigSourceSchemaV1.parse(sourceInput);
  const registration = createMcpSourceRegistration({ source, sha256 });
  const withoutDigest = {
    schemaVersion: 1 as const,
    kind: "source" as const,
    registration,
    aliasOmissions: projection.aliasOmissions,
  };
  return {
    ...withoutDigest,
    digest: hashContent(
      new TextEncoder().encode(`plugin-mcp-projection-v1\0${canonicalJson(withoutDigest)}`),
      sha256,
    ),
  };
}

describe("plugin MCP projection", () => {
  it("builds a deterministic logical-only source with canonical identity and provenance", () => {
    const f = fixture();
    const first = create(f);
    expect(first.kind).toBe("source");
    if (first.kind !== "source") throw new Error("expected source projection");
    const component = f.projection.components.mcpServers[0]!;
    const key = deriveMcpRuntimeServerKey(component.id);
    expect(first.registration.source.identity).toEqual({
      schemaVersion: 1,
      scope: f.projection.scope,
      plugin: f.projection.plugin,
      revision: f.projection.revision,
      projectionDigest: f.projection.digest,
    });
    expect(Object.keys(first.registration.source.servers)).toEqual([key]);
    expect(first.registration.source.servers[key]).toMatchObject({
      componentId: component.id,
      nativeKey: "search/../opaque",
      transport: "stdio",
      options: {
        schemaVersion: 1,
        startupTimeoutMs: 1000,
        allowedTools: ["read"],
        instructions: "read-only",
        auth: { kind: "none" },
      },
      projection: {
        schemaVersion: 1,
        componentId: component.id,
        contentRef: f.projection.contentRef,
        dataRef: f.projection.dataRef,
      },
      launchTemplate: {
        schemaVersion: 1,
        transport: "stdio",
        command: "${PLUGIN_ROOT}/bin/server",
        args: ["--root", "${PLUGIN_DATA}"],
        cwd: "${CLAUDE_PROJECT_DIR}",
        env: [{ name: "TRACE", value: "${TRACE_VALUE}" }],
      },
      toolAliases: [{
        pluginName: "demo",
        nativeServerKey: "search/../opaque",
        collisionPolicy: "omit-all",
        preserveNativeDiscovery: true,
      }],
    });
    expect(first.registration.source.servers[key]!.provenance.map((entry) => entry.host)).toEqual(["claude", "codex"]);
    expect(verifyPluginMcpProjection(first, sha256)).toEqual(first);
    expect(JSON.stringify(first)).not.toMatch(/CANARY_/u);

    const reorderedReport = {
      ...f.compatibility,
      components: [...f.compatibility.components].reverse(),
      requirements: [...f.compatibility.requirements].reverse(),
      diagnostics: [...f.compatibility.diagnostics].reverse(),
    };
    expect(createPluginMcpProjection({
      projection: f.projection,
      compatibility: reorderedReport,
      runtimeCapabilities: runtime(),
      sha256,
    })).toEqual(first);
  });

  it("uses registry field aliases as the shared evaluator/projector authority", () => {
    const aliases = CompatibilityPolicyRegistry.mcp.keys.fieldGroups.startupTimeout.aliases as unknown as string[];
    const original = [...aliases];
    try {
      aliases.push("runtimeStartupTimeout");
      const added = fixture({ servers: [{
        nativeKey: "registry-alias",
        declaration: { transport: "stdio", command: "server", runtimeStartupTimeout: 37.5 },
      }] });
      expect(added.compatibility.components[0]?.verdict.kind).toBe("supported");
      const projected = create(added);
      if (projected.kind !== "source") throw new Error("expected source");
      expect(Object.values(projected.registration.source.servers)[0]?.options).toMatchObject({ startupTimeoutMs: 37.5 });

      aliases.splice(aliases.indexOf("runtimeStartupTimeout"), 1);
      const removed = evaluateCompatibility({ plugin: added.plugin, capabilities: capabilities() });
      expect(removed.components[0]?.verdict.kind).toBe("metadata-only");
      expect(() => create(added)).toThrow(DomainContractError);
    } finally {
      aliases.splice(0, aliases.length, ...original);
    }
  });

  it("canonicalizes complete projection evidence before every derived digest", () => {
    const firstServers: readonly ServerInput[] = [{
      nativeKey: "alpha-é",
      pointer: "/servers/alpha",
      hosts: ["claude", "codex"],
      declaration: { transport: "stdio", command: "server", startupTimeout: 12.5 },
    }, {
      nativeKey: "beta-é",
      pointer: "/servers/beta",
      hosts: ["claude", "codex"],
      declaration: { transport: "streamable-http", url: "https://example.invalid/mcp", resources: ["docs"] },
    }];
    const secondServers: readonly ServerInput[] = [...firstServers].reverse().map((server) => ({
      ...server,
      reverseProvenance: true,
      duplicateProvenance: true,
      declaration: Object.fromEntries(Object.entries(server.declaration).reverse()),
    }));
    const first = fixture({ servers: firstServers });
    const second = fixture({ servers: secondServers });
    expect(JSON.stringify(second.projection)).toBe(JSON.stringify(first.projection));

    const firstMcp = create(first);
    const secondMcp = create(second);
    expect(JSON.stringify(secondMcp)).toBe(JSON.stringify(firstMcp));
    expect(secondMcp.digest).toBe(firstMcp.digest);
    if (firstMcp.kind !== "source" || secondMcp.kind !== "source") throw new Error("expected sources");
    expect(secondMcp.registration.source.identity).toEqual(firstMcp.registration.source.identity);
  });

  it("keeps composed and decomposed Unicode distinct in complete and MCP identities", () => {
    const composed = fixture({ servers: [{
      nativeKey: "é",
      declaration: { transport: "stdio", command: "server" },
    }] });
    const decomposed = fixture({ servers: [{
      nativeKey: "é",
      declaration: { transport: "stdio", command: "server" },
    }] });
    expect(composed.projection.digest).not.toBe(decomposed.projection.digest);
    const composedMcp = create(composed);
    const decomposedMcp = create(decomposed);
    expect(composedMcp.digest).not.toBe(decomposedMcp.digest);
    if (composedMcp.kind !== "source" || decomposedMcp.kind !== "source") throw new Error("expected sources");
    expect(Object.keys(composedMcp.registration.source.servers)).not.toEqual(Object.keys(decomposedMcp.registration.source.servers));
  });

  it("recomputes every source field from whole-plugin inventory and capability authority", () => {
    const f = fixture();
    const valid = create(f);
    if (valid.kind !== "source") throw new Error("expected source projection");
    const source = valid.registration.source;
    const [key, server] = Object.entries(source.servers)[0]!;
    const forgedComponentId = `component-v1:mcp-server:${"f".repeat(64)}`;
    const forgedServerKey = `mcp-server-v1:${"f".repeat(64)}`;
    const alterations: readonly unknown[] = [
      { ...source, servers: { [key]: { ...server, nativeKey: "altered-native-key" } } },
      {
        ...source,
        servers: {
          [forgedServerKey]: {
            ...server,
            componentId: forgedComponentId,
            projection: { ...server.projection, componentId: forgedComponentId },
          },
        },
      },
      {
        ...source,
        servers: {
          [key]: {
            ...server,
            transport: "streamable-http",
            launchTemplate: {
              schemaVersion: 1,
              transport: "streamable-http",
              endpointSecurity: "tls",
              url: "https://altered.invalid/mcp",
              headers: [],
            },
          },
        },
      },
      { ...source, servers: { [key]: { ...server, options: { ...server.options, toolTimeoutMs: 17 } } } },
      {
        ...source,
        servers: {
          [key]: {
            ...server,
            launchTemplate: { ...server.launchTemplate, command: "altered-command" },
          },
        },
      },
      {
        ...source,
        servers: {
          [key]: {
            ...server,
            provenance: server.provenance.map((entry) => ({ ...entry, pointer: "/altered" })),
          },
        },
      },
      { ...source, servers: { [key]: { ...server, toolAliases: [] } } },
      {
        ...source,
        servers: {
          [key]: {
            ...server,
            projection: {
              ...server.projection,
              contentRef: `plugin-content-v1:sha256:${"f".repeat(64)}`,
            },
          },
        },
      },
    ];

    expect(verifyPluginMcpProjectionAgainstExpectation({
      claimed: valid,
      projection: f.projection,
      runtimeCapabilities: runtime(),
      sha256,
    })).toEqual(valid);
    for (const altered of alterations) {
      const claimed = rehashClaimedProjection(valid, altered);
      expect(() => verifyPluginMcpProjectionAgainstExpectation({
        claimed,
        projection: f.projection,
        runtimeCapabilities: runtime(),
        sha256,
      })).toThrow(DomainContractError);
    }
  });

  it("returns an explicit deterministic none projection without an empty source", () => {
    const f = fixture({ servers: [] });
    const result = create(f);
    expect(result).toMatchObject({
      schemaVersion: 1,
      kind: "none",
      identity: { plugin: "demo@community", projectionDigest: f.projection.digest },
      aliasOmissions: [],
    });
    expect(result).not.toHaveProperty("registration");
    expect(verifyPluginMcpProjection(result, sha256)).toEqual(result);
  });

  it("keeps local server keys stable across revisions while exact source identity changes", () => {
    const firstFixture = fixture();
    const secondFixture = fixture({ servers: [{
      nativeKey: "search/../opaque",
      declaration: { transport: "stdio", command: "new-command" },
      hosts: ["claude"],
    }] });
    const first = create(firstFixture);
    const second = create(secondFixture);
    if (first.kind !== "source" || second.kind !== "source") throw new Error("expected sources");
    expect(Object.keys(first.registration.source.servers)).toEqual(Object.keys(second.registration.source.servers));
    expect(first.registration.source.identity).not.toEqual(second.registration.source.identity);
    expect(first.registration.digest).not.toBe(second.registration.digest);
  });

  it("omits unsafe or unavailable aliases without rewriting canonical identity", () => {
    const unsafe = fixture({ manifestName: "bad\u0000plugin", servers: [{
      nativeKey: "server\u0001name",
      declaration: { transport: "stdio", command: "server" },
      hosts: ["claude"],
    }] });
    const unsafeResult = create(unsafe);
    if (unsafeResult.kind !== "source") throw new Error("expected source");
    const key = Object.keys(unsafeResult.registration.source.servers)[0]!;
    expect(unsafeResult.registration.source.servers[key]!.nativeKey).toBe("server\u0001name");
    expect(unsafeResult.registration.source.servers[key]!.toolAliases).toEqual([]);
    expect(unsafeResult.aliasOmissions[0]?.code).toBe("UNREPRESENTABLE_ALIAS_SEGMENT");

    const aliasDisabled = create(fixture(), runtime({
      features: {
        sampling: true,
        elicitationForm: true,
        elicitationUrl: true,
        toolApproval: true,
        resources: true,
        pluginToolAliases: false,
      },
    }));
    if (aliasDisabled.kind !== "source") throw new Error("expected source");
    expect(Object.values(aliasDisabled.registration.source.servers)[0]!.toolAliases).toEqual([]);
    expect(aliasDisabled.aliasOmissions[0]?.code).toBe("RUNTIME_ALIAS_UNAVAILABLE");
  });

  it("binds aliases to the exact manifest identity and complete non-MCP report inventory", () => {
    const named = fixture({ manifestName: "bound-manifest" });
    const namedProjection = create(named);
    if (namedProjection.kind !== "source") throw new Error("expected source");
    expect(Object.values(namedProjection.registration.source.servers)[0]?.toolAliases[0]?.pluginName).toBe("bound-manifest");

    const manifestOnlyMismatch = {
      ...named.compatibility,
      plugin: { ...named.compatibility.plugin, manifestName: "forged-manifest" },
    };
    expect(() => createPluginMcpProjection({
      projection: named.projection,
      compatibility: manifestOnlyMismatch,
      runtimeCapabilities: runtime(),
      sha256,
    })).toThrow(DomainContractError);

    const complete = fixture({ includeSkill: true });
    const skillId = complete.projection.components.skills[0]!.id;
    const nonMcpInventoryMismatch = {
      ...complete.compatibility,
      components: complete.compatibility.components.filter((component) => component.componentId !== skillId),
    };
    expect(() => createPluginMcpProjection({
      projection: complete.projection,
      compatibility: nonMcpInventoryMismatch,
      runtimeCapabilities: runtime(),
      sha256,
    })).toThrow(DomainContractError);
  });

  it("rejects a forged outer projection digest when the nested registration digest was not recomputed", () => {
    const valid = create();
    if (valid.kind !== "source") throw new Error("expected source projection");
    const [key, server] = Object.entries(valid.registration.source.servers)[0]!;
    const registration = {
      ...valid.registration,
      source: {
        ...valid.registration.source,
        servers: { [key]: { ...server, nativeKey: "forged-native-key" } },
      },
    };
    const withoutDigest = {
      schemaVersion: 1 as const,
      kind: "source" as const,
      registration,
      aliasOmissions: valid.aliasOmissions,
    };
    const digest = hashContent(
      new TextEncoder().encode(`plugin-mcp-projection-v1\0${canonicalJson(withoutDigest)}`),
      sha256,
    );
    expect(() => verifyPluginMcpProjection({ ...withoutDigest, digest }, sha256)).toThrow(DomainContractError);
  });

  it("fails closed with redacted domain errors for mismatched report, capability, component, and digest evidence", () => {
    const valid = fixture();
    const mismatchedReport = fixture({ servers: [] }).compatibility;
    const forged = fixture({ servers: [{
      nativeKey: "search",
      declaration: { transport: "stdio", command: "CANARY_FORGED_COMMAND" },
      forgedId: `component-v1:mcp-server:${"f".repeat(64)}`,
    }] });
    const cases = [
      () => createPluginMcpProjection({ projection: valid.projection, compatibility: mismatchedReport, runtimeCapabilities: runtime(), sha256 }),
      () => create(valid, runtime({ transports: { stdio: false, streamableHttp: true, legacySse: false, websocket: false } })),
      () => create(forged),
      () => verifyPluginMcpProjection({ ...create(valid), digest: `sha256:${"0".repeat(64)}` }, sha256),
    ];
    for (const operation of cases) {
      let error: unknown;
      try { operation(); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(DomainContractError);
      expect(JSON.stringify((error as DomainContractError).toDiagnostic())).not.toMatch(/CANARY_/u);
    }
  });
});
