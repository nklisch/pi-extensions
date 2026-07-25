import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createPluginMcpProjection,
  type PluginMcpProjection,
} from "../../src/application/mcp-plugin-projection.js";
import {
  formatMcpToolAlias,
  resolveMcpToolAliases,
  type McpToolAliasClaim,
} from "../../src/application/mcp-tool-aliases.js";
import {
  McpRuntimeCapabilitiesSchemaV1,
  type McpLaunchValueProvider,
} from "../../src/application/ports/mcp-runtime.js";
import { createPluginRuntimeProjection } from "../../src/application/ports/runtime-projection.js";
import { evaluateCompatibility } from "../../src/domain/compatibility-evaluator.js";
import { RuntimeCapabilityRegistry, RuntimeCapabilitySnapshotSchema } from "../../src/domain/compatibility-policy.js";
import { deriveComponentId } from "../../src/domain/component-identity.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { createResolvedPluginSource } from "../../src/domain/source.js";
import { createInstalledRevisionRecord } from "../../src/domain/state/installed-state.js";
import { mcpProjectionConformanceVectors } from "../fixtures/compatibility/mcp.js";
import {
  FakeMcpRuntime,
  FakeMcpRuntimeLeaseProvider,
} from "../support/fakes/mcp-runtime.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const content = createContentManifest([], sha256);
const projectKey = `project-v1:sha256:${"f".repeat(64)}`;

function capabilitySnapshot() {
  return RuntimeCapabilitySnapshotSchema.parse({
    capabilities: Object.fromEntries(Object.values(RuntimeCapabilityRegistry).map((entry) => [
      entry.id,
      { status: "available", explanation: "conformance fixture" },
    ])),
    capturedBy: "mcp-projection-conformance",
  });
}

function runtimeCapabilities(pluginToolAliases: boolean) {
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
    transports: { stdio: true, streamableHttp: true, legacySse: false, websocket: false },
    oauth: { authorizationCode: true, clientCredentials: true },
    features: {
      sampling: true,
      elicitationForm: true,
      elicitationUrl: true,
      toolApproval: true,
      resources: true,
      pluginToolAliases,
    },
  });
}

type Scope = { kind: "user" } | { kind: "project"; projectKey: string };

function fixture(input: Readonly<{
  plugin?: string;
  scope?: Scope;
  declarations?: readonly Readonly<{ nativeKey: string; value: Record<string, unknown>; host?: "claude" | "codex" }>[];
  aliases?: boolean;
}> = {}): Readonly<{
  mcp: PluginMcpProjection;
  compatibility: ReturnType<typeof evaluateCompatibility>;
  projection: ReturnType<typeof createPluginRuntimeProjection>;
}> {
  const pluginKey = input.plugin ?? "demo@community";
  const [entry, marketplace] = pluginKey.split("@");
  const declarations = input.declarations ?? [
    { nativeKey: "shared/../server", value: mcpProjectionConformanceVectors.stdio, host: "claude" },
    { nativeKey: "远程-é", value: mcpProjectionConformanceVectors.streamableHttp, host: "codex" },
  ];
  const components = declarations.map((declaration, index) => {
    const provenance = {
      location: {
        host: declaration.host ?? "claude",
        documentKind: "mcp" as const,
        path: `.mcp-${index}.json`,
        pointer: `/mcpServers/${index}`,
      },
      declaration: { secret: `CANARY_DECLARATION_${index}` },
    };
    return {
      kind: "mcp-server" as const,
      id: deriveComponentId(pluginKey as never, {
        kind: "mcp-server",
        nativeKey: declaration.nativeKey,
      }, sha256),
      nativeKey: { value: declaration.nativeKey, provenance: [provenance] },
      declaration: { value: declaration.value, provenance: [provenance] },
      metadata: [],
    };
  });
  const plugin = NormalizedPluginSchema.parse({
    identity: { key: pluginKey, marketplaceName: marketplace, marketplaceEntryName: entry },
    source: createResolvedPluginSource({
      kind: "git",
      url: `https://example.invalid/${entry}.git`,
      revision: "a".repeat(40),
    }, sha256),
    configuration: { options: [] },
    components: { skills: [], hooks: [], mcpServers: components, foreign: [] },
    metadata: [],
  });
  const compatibility = evaluateCompatibility({ plugin, capabilities: capabilitySnapshot() });
  const scope = input.scope ?? { kind: "user" as const };
  const revision = createInstalledRevisionRecord({ plugin, compatibility, content, scope }, sha256);
  const projection = createPluginRuntimeProjection({ scope, plugin, compatibility, revision, sha256 });
  const mcp = createPluginMcpProjection({
    projection,
    compatibility,
    runtimeCapabilities: runtimeCapabilities(input.aliases ?? true),
    sha256,
  });
  return { mcp, compatibility, projection };
}

function providerCounters() {
  const counters = { resolved: 0, disposed: 0 };
  const provider: McpLaunchValueProvider = {
    async resolve() {
      counters.resolved += 1;
      return { transport: "stdio", command: "CANARY_PROVIDER_COMMAND", args: [] };
    },
    dispose() { counters.disposed += 1; },
  };
  return { counters, provider };
}

async function register(runtime: FakeMcpRuntime, projection: PluginMcpProjection, provider: McpLaunchValueProvider) {
  if (projection.kind === "none") return undefined;
  const signal = new AbortController().signal;
  const validation = await runtime.validateSource(projection.registration, signal);
  expect(validation.ok).toBe(true);
  return runtime.replaceSource({
    registration: projection.registration,
    expected: { kind: "absent" },
    launchValues: provider,
    runtimeLeases: new FakeMcpRuntimeLeaseProvider(),
  }, signal);
}

describe("MCP plugin projection through the portable fake", () => {
  it("validates, replaces, inspects, and removes exact redacted plugin sources without launch calls", async () => {
    const generated = fixture();
    const runtime = new FakeMcpRuntime();
    const { counters, provider } = providerCounters();
    const applied = await register(runtime, generated.mcp, provider);
    expect(applied?.kind).toBe("applied");
    expect(counters).toEqual({ resolved: 0, disposed: 0 });
    if (generated.mcp.kind !== "source") throw new Error("expected source");

    const signal = new AbortController().signal;
    const status = await runtime.inspectSource(generated.mcp.registration.source.identity, signal);
    expect(status?.identity).toEqual(generated.mcp.registration.source.identity);
    expect(status?.registrationDigest).toBe(generated.mcp.registration.digest);
    expect(status?.servers.map((server) => server.key)).toEqual(
      Object.keys(generated.mcp.registration.source.servers).sort(),
    );
    expect(status?.servers.map((server) => server.nativeKey).sort()).toEqual([
      "shared/../server",
      "远程-é",
    ].sort());
    const serialized = JSON.stringify({ status, applied });
    expect(serialized).not.toMatch(/CANARY_(?:DECLARATION|PROVIDER|STDIO|HTTP|HEADER|BEARER|PATH)/u);
    expect(serialized).not.toContain("launchTemplate");
    expect(serialized).not.toContain("options");

    const wrong = { ...generated.mcp.registration.source.identity, revision: `sha256:${"0".repeat(64)}` } as never;
    expect(await runtime.removeSource(wrong, signal)).toMatchObject({ kind: "ownership-mismatch" });
    expect(await runtime.inspectSource(generated.mcp.registration.source.identity, signal)).toBeDefined();
    expect(await runtime.removeSource(generated.mcp.registration.source.identity, signal)).toEqual({ kind: "removed" });
    expect(counters).toEqual({ resolved: 0, disposed: 0 });
  });

  it("isolates equal native keys across scopes/plugins and enforces stale replacement ownership", async () => {
    const user = fixture({ declarations: [{ nativeKey: "same", value: mcpProjectionConformanceVectors.stdio }] });
    const project = fixture({
      scope: { kind: "project", projectKey },
      declarations: [{ nativeKey: "same", value: mcpProjectionConformanceVectors.stdio }],
    });
    const other = fixture({
      plugin: "other@community",
      declarations: [{ nativeKey: "same", value: mcpProjectionConformanceVectors.stdio }],
    });
    const runtime = new FakeMcpRuntime();
    const signal = new AbortController().signal;
    for (const generated of [user, project, other]) {
      await register(runtime, generated.mcp, providerCounters().provider);
    }
    const statuses = await runtime.inspectSources(signal);
    expect(statuses).toHaveLength(3);
    expect(new Set(statuses.map((status) => JSON.stringify(status.identity))).size).toBe(3);
    expect(statuses.every((status) => status.servers[0]?.nativeKey === "same")).toBe(true);

    const replacement = fixture({
      declarations: [{ nativeKey: "same", value: { transport: "stdio", command: "changed" } }],
    });
    if (replacement.mcp.kind !== "source" || user.mcp.kind !== "source") throw new Error("expected sources");
    const stale = await runtime.replaceSource({
      registration: replacement.mcp.registration,
      expected: {
        kind: "exact",
        identity: {
          ...user.mcp.registration.source.identity,
          revision: `sha256:${"9".repeat(64)}` as never,
        },
      },
      launchValues: providerCounters().provider,
      runtimeLeases: new FakeMcpRuntimeLeaseProvider(),
    }, signal);
    expect(stale).toMatchObject({ kind: "stale", currentIdentity: user.mcp.registration.source.identity });
    expect(await runtime.inspectSource(user.mcp.registration.source.identity, signal)).toBeDefined();
  });

  it("keeps none and report-mismatch paths offline and aliases optional", async () => {
    const runtime = new FakeMcpRuntime();
    const none = fixture({ declarations: [] });
    expect(none.mcp.kind).toBe("none");
    await register(runtime, none.mcp, providerCounters().provider);
    expect(await runtime.inspectSources(new AbortController().signal)).toEqual([]);

    const aliasDisabled = fixture({ aliases: false, declarations: [{
      nativeKey: "alias-server",
      value: mcpProjectionConformanceVectors.stdio,
      host: "claude",
    }] });
    if (aliasDisabled.mcp.kind !== "source") throw new Error("expected source");
    expect(Object.values(aliasDisabled.mcp.registration.source.servers)[0]!.toolAliases).toEqual([]);
    expect(aliasDisabled.mcp.aliasOmissions[0]?.code).toBe("RUNTIME_ALIAS_UNAVAILABLE");

    const incompatibleReport = fixture({ declarations: [] }).compatibility;
    const sourceFixture = fixture();
    expect(() => createPluginMcpProjection({
      projection: sourceFixture.projection,
      compatibility: incompatibleReport,
      runtimeCapabilities: runtimeCapabilities(true),
      sha256,
    })).toThrow();
    expect(await runtime.inspectSources(new AbortController().signal)).toEqual([]);
  });

  it("resolves post-discovery aliases native-first and omit-all across source identities", () => {
    const first = fixture({ plugin: "first@community", declarations: [{
      nativeKey: "shared",
      value: mcpProjectionConformanceVectors.stdio,
      host: "claude",
    }] });
    const second = fixture({ plugin: "second@community", declarations: [{
      nativeKey: "shared",
      value: mcpProjectionConformanceVectors.stdio,
      host: "claude",
    }] });
    if (first.mcp.kind !== "source" || second.mcp.kind !== "source") throw new Error("expected sources");
    const claims: McpToolAliasClaim[] = [first, second].map((fixtureValue) => {
      if (fixtureValue.mcp.kind !== "source") throw new Error("expected source");
      const [serverKey, server] = Object.entries(fixtureValue.mcp.registration.source.servers)[0]!;
      const template = server.toolAliases[0]!;
      return {
        source: fixtureValue.mcp.registration.source.identity,
        serverKey: serverKey as never,
        componentId: server.componentId,
        nativeToolName: "read",
        alias: "contested-alias",
      };
    });
    const nativeAlias = (() => {
      const [serverKey, server] = Object.entries(first.mcp.registration.source.servers)[0]!;
      const template = server.toolAliases[0]!;
      return {
        source: first.mcp.registration.source.identity,
        serverKey: serverKey as never,
        componentId: server.componentId,
        nativeToolName: "write",
        alias: formatMcpToolAlias(template, "write"),
      } as McpToolAliasClaim;
    })();
    const result = resolveMcpToolAliases({
      nativeToolNames: [nativeAlias.alias, "ordinary-native"],
      claims: [nativeAlias, ...claims].reverse(),
      isRepresentable: () => true,
    });
    expect(result.exposed).toEqual([]);
    expect(result.omitted.map((entry) => entry.code).sort()).toEqual([
      "ALIAS_CLAIM_COLLISION",
      "ALIAS_CLAIM_COLLISION",
      "NATIVE_NAME_COLLISION",
    ]);
  });
});
