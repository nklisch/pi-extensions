import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMcpLaunchContextPort } from "../../src/application/mcp-launch-context.js";
import { createMcpSourceRegistration } from "../../src/application/mcp-source-registration.js";
import { deriveMcpRuntimeServerKey } from "../../src/application/ports/mcp-runtime.js";
import { withResolvedPluginConfiguration } from "../../src/application/configuration-resolver.js";
import type { McpLaunchActiveSelectionPort } from "../../src/application/ports/mcp-launch-context.js";
import type { McpLaunchEnvironmentPort } from "../../src/application/ports/mcp-launch-environment.js";
import type { PluginConfigurationStore } from "../../src/application/ports/plugin-configuration-store.js";
import type { SecretCreationEvidence, SecretStore } from "../../src/application/ports/secret-store.js";
import { SensitiveValue } from "../../src/application/sensitive-value.js";
import { createProjectRootAuthorityPort } from "../../src/composition/create-project-root-authority.js";
import { evaluateCompatibility } from "../../src/domain/compatibility-evaluator.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { createPluginStoreIdentityFromEvidence } from "../../src/domain/content-store.js";
import {
  CanonicalConfigurationPathSchema,
  createPluginConfigurationDocument,
  deriveSecretLocator,
  digestConfigurationDescriptors,
  type PluginConfigurationDocument,
} from "../../src/domain/configured-values.js";
import { createMcpLaunchTemplate } from "../../src/domain/mcp-launch-template.js";
import { createResolvedMarketplaceSource } from "../../src/domain/source.js";
import { createInstalledRevisionRecord } from "../../src/domain/state/installed-state.js";
import { CanonicalProjectRootSchema, createScopeContext, deriveProjectKey } from "../../src/domain/state/scope.js";
import { createTrustCandidate, grantTrust } from "../../src/domain/trust-policy.js";
import { createActiveProjectionExpectation, createPluginRuntimeProjection } from "../../src/application/ports/runtime-projection.js";
import { McpConfigSourceSchemaV1 } from "../../src/application/ports/mcp-runtime.js";
import { createTrustedMcpLaunchValueProvider } from "../../src/runtime/mcp/launch-value-provider.js";
import {
  FakeMcpRuntime,
  FakeMcpRuntimeLeaseProvider,
} from "../support/fakes/mcp-runtime.js";
import { FakeMcpLaunchEnvironment } from "../support/fakes/mcp-launch-context.js";
import { capabilities, claimFixture, directPlugin } from "../fixtures/compatibility/common.js";
import { mcp } from "../fixtures/compatibility/mcp.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const scope = { kind: "user" as const };
const descriptors = {
  options: [
    { key: "NAME", label: claimFixture("Name"), value: { kind: "string" as const }, required: true, sensitive: false, provenance: [claimFixture("NAME").provenance[0]!] },
    { key: "TOKEN", label: claimFixture("Token"), value: { kind: "string" as const }, required: true, sensitive: true, provenance: [claimFixture("TOKEN").provenance[0]!] },
  ],
};

class ConfigurationStore implements PluginConfigurationStore {
  constructor(public document: PluginConfigurationDocument) {}
  async read() { return { kind: "found" as const, document: this.document }; }
  async replace(request: { document: PluginConfigurationDocument }) { this.document = request.document; return { kind: "stored" as const }; }
  async remove() { return "removed" as const; }
}

class Secrets implements SecretStore {
  value = "CANARY_SECRET_V1";
  async put(_locator: string, _value: SensitiveValue) {
    return { kind: "created" as const, locator: _locator as never, evidence: Object.freeze({}) as SecretCreationEvidence };
  }
  async get() { return { kind: "found" as const, value: SensitiveValue.fromUnknown(this.value) }; }
  async remove() { return "removed" as const; }
  async removeOwned() { return "removed" as const; }
}

function integratedFixture() {
  const stdio = mcp({
    command: "${PLUGIN_ROOT}/bin/server",
    args: ["--token", "${user_config.TOKEN}"],
    env: { PLUGIN_TOKEN: "${user_config.TOKEN}" },
  }, "1") as never;
  const remote = mcp({
    type: "http",
    url: "https://example.invalid/mcp?name=${user_config.NAME}",
    headers: { "X-Trace": { env: "TRACE_VALUE" } },
    bearerTokenEnv: "CLAUDE_PLUGIN_OPTION_TOKEN",
  }, "2") as never;
  const plugin = directPlugin({ components: { mcpServers: [stdio, remote] }, configuration: descriptors });
  const compatibility = evaluateCompatibility({ plugin, capabilities: capabilities() });
  const contentManifest = createContentManifest([], sha256);
  const revision = createInstalledRevisionRecord({ plugin, compatibility, content: contentManifest, scope }, sha256);
  if (revision.configurationRef === undefined) throw new Error("configuration ref was not derived");
  const projection = createPluginRuntimeProjection({ scope, plugin, compatibility, revision, sha256 });
  const expectation = createActiveProjectionExpectation(projection, sha256);
  const candidate = createTrustCandidate({
    scope,
    marketplaceSource: createResolvedMarketplaceSource({
      declared: { kind: "github", repository: "example/marketplace" },
      revision: "b".repeat(40),
    }, sha256),
    plugin,
    compatibility,
    content: contentManifest,
  }, sha256);
  const source = McpConfigSourceSchemaV1.parse({
    schemaVersion: 1,
    identity: {
      schemaVersion: 1,
      scope,
      plugin: projection.plugin,
      revision: projection.revision,
      projectionDigest: projection.digest,
    },
    servers: Object.fromEntries([stdio, remote].map((component) => [deriveMcpRuntimeServerKey(component.id), {
      componentId: component.id,
      nativeKey: component.nativeKey.value,
      transport: createMcpLaunchTemplate(component, projection.plugin).transport,
      options: {
        schemaVersion: 1,
        auth: component === remote
          ? { kind: "bearer-environment" }
          : { kind: "none" },
      },
      projection: {
        schemaVersion: 1,
        componentId: component.id,
        contentRef: projection.contentRef,
        dataRef: projection.dataRef,
        configurationRef: projection.configurationRef,
      },
      launchTemplate: createMcpLaunchTemplate(component, projection.plugin),
      toolAliases: [],
      provenance: component.declaration.provenance.map((entry: { location: unknown }) => entry.location),
    }])),
  });
  const registration = createMcpSourceRegistration({ source, sha256 });
  const configurationRef = revision.configurationRef;
  const secretLocator = deriveSecretLocator({
    scope,
    plugin: projection.plugin,
    configurationRef,
    key: "TOKEN",
    writeId: `config-write-v1:${"x".repeat(22)}`,
  }, sha256);
  const document = createPluginConfigurationDocument({
    schemaVersion: 1,
    configurationRef,
    plugin: projection.plugin,
    scope,
    descriptorDigest: digestConfigurationDescriptors(descriptors, sha256),
    values: [{ key: "NAME", value: { kind: "string", value: "demo" } }],
    secrets: [{ key: "TOKEN", locator: secretLocator }],
  }, sha256);
  const projectIdentity = {
    kind: "path-only" as const,
    canonicalRoot: CanonicalProjectRootSchema.parse("file:///workspace/project/"),
    limitation: "identity-changes-with-canonical-root" as const,
  };
  const projectKey = deriveProjectKey(projectIdentity, sha256);
  const currentProject = { identity: projectIdentity, projectKey, trust: { kind: "trusted" as const } };
  const pathScope = createScopeContext(scope, sha256);
  let trustRecords = [grantTrust(candidate, sha256)];
  const active: McpLaunchActiveSelectionPort = {
    async withSelection(binding, signal, use) {
      signal.throwIfAborted();
      if (JSON.stringify(binding.source) !== JSON.stringify(source.identity)) throw new Error("source selection mismatch");
      const server = source.servers[binding.serverKey];
      const component = projection.components.mcpServers.find((entry) => entry.id === binding.componentId);
      if (server === undefined || component === undefined || server.transport !== binding.transport) throw new Error("server selection mismatch");
      await use({
        expectation,
        revision,
        component,
        currentProject,
        candidate,
        trustRecords,
        descriptors: plugin.configuration,
        pathContext: { scope: pathScope, trustedBaseDirectory: "/trusted" },
      });
    },
  };
  const roots = createProjectRootAuthorityPort({ resolve: async () => ({
    kind: "project",
    identity: projectIdentity,
    projectKey,
  }) }, sha256);
  const configurations = new ConfigurationStore(document);
  const secrets = new Secrets();
  const projectTrust = { assess: async () => ({ kind: "trusted" as const }) };
  const paths = { normalizeAndInspect: async () => ({ kind: "valid" as const, canonicalPath: CanonicalConfigurationPathSchema.parse("file:///trusted/path") }) };
  const configurationDependencies = {
    projectTrust,
    configurations,
    secrets,
    paths,
    projectRoots: roots,
    sha256,
  };
  const context = createMcpLaunchContextPort({
    active,
    content: {
      async resolvePlugin() {
        return {
          kind: "plugin" as const,
          root: "/store/plugin",
          identity: createPluginStoreIdentityFromEvidence({
            sourceHash: revision.evidence.source.sourceHash,
            binding: revision.revision,
          }, sha256),
          manifest: contentManifest,
          contentRef: revision.contentRef,
        };
      },
      async ensureDataRoot() {
        return { root: "/data/plugin", scope, plugin: projection.plugin, dataRef: revision.dataRef };
      },
    },
    projectRoots: roots,
    projectTrust,
    configuration: {
      withResolvedPluginConfiguration,
      dependencies: configurationDependencies,
    },
    sha256,
  });
  const environment = new FakeMcpLaunchEnvironment({ TRACE_VALUE: "trace-v1" });
  const provider = createTrustedMcpLaunchValueProvider({ source, context, environment, platform: "posix" });
  return {
    source,
    registration,
    projection,
    configurationDocument: document,
    context,
    provider,
    environment,
    secrets,
    resolveDirect: (use: Parameters<typeof withResolvedPluginConfiguration>[3]) => withResolvedPluginConfiguration({
      candidate,
      trustRecords,
      configurationRef,
      descriptors: plugin.configuration,
      pathContext: { scope: pathScope, trustedBaseDirectory: "/trusted" },
    }, configurationDependencies, new AbortController().signal, use),
    revoke: () => { trustRecords = []; },
  };
}

describe("MCP launch trusted-context integration", () => {
  it("delivers both transports through the real trust/configuration resolver and fake runtime", async () => {
    const fixture = integratedFixture();
    const runtime = new FakeMcpRuntime();
    const signal = new AbortController().signal;
    await fixture.resolveDirect(async (configuration) => {
      expect(configuration.substitute("${user_config.TOKEN}")).toBe("CANARY_SECRET_V1");
    });
    const firstServer = Object.entries(fixture.source.servers)[0]!;
    await fixture.context.withContext({
      schemaVersion: 1,
      source: fixture.source.identity,
      serverKey: firstServer[0],
      componentId: firstServer[1].componentId,
      transport: firstServer[1].transport,
    }, signal, async (resolved) => {
      expect(resolved.configuration.substitute("${user_config.TOKEN}")).toBe("CANARY_SECRET_V1");
    });
    await runtime.replaceSource({
      registration: fixture.registration,
      expected: { kind: "absent" },
      launchValues: fixture.provider,
      runtimeLeases: new FakeMcpRuntimeLeaseProvider(),
    }, signal);
    const stdioKey = Object.keys(fixture.source.servers).find((key) => fixture.source.servers[key]!.transport === "stdio")!;
    const httpKey = Object.keys(fixture.source.servers).find((key) => fixture.source.servers[key]!.transport === "streamable-http")!;
    let retained: McpLaunchValues | undefined;
    await runtime.launch(fixture.source.identity, stdioKey, signal, (values) => {
      retained = values;
      expect(values).toMatchObject({
        transport: "stdio",
        command: "/store/plugin/bin/server",
        args: ["--token", "CANARY_SECRET_V1"],
      });
      if (values.transport === "stdio") expect(values.env?.PLUGIN_TOKEN).toBe("CANARY_SECRET_V1");
    });
    expect(() => retained?.transport).toThrow("disposed");

    await runtime.launch(fixture.source.identity, httpKey, signal, (values) => {
      expect(values).toMatchObject({
        transport: "streamable-http",
        url: "https://example.invalid/mcp?name=demo",
        bearerToken: "CANARY_SECRET_V1",
      });
      if (values.transport === "streamable-http") expect(values.headers?.["X-Trace"]).toBe("trace-v1");
    });
    const status = await runtime.inspectSource(fixture.source.identity, signal);
    const evidence = JSON.stringify({
      source: fixture.source,
      projection: fixture.projection,
      configuration: fixture.configurationDocument,
      status,
    });
    expect(evidence).not.toContain("CANARY_SECRET_V1");
    expect(evidence).not.toContain("trace-v1");
  });

  it("keeps concurrent launches on independent authoritative configuration snapshots", async () => {
    const fixture = integratedFixture();
    const baseEnvironment = new FakeMcpLaunchEnvironment();
    let callCount = 0;
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const firstRelease = new Promise<void>((resolve) => { release = resolve; });
    const gatedEnvironment: McpLaunchEnvironmentPort = {
      async withResolved(names, signal, use) {
        callCount += 1;
        if (callCount === 1) {
          entered();
          await firstRelease;
        }
        await baseEnvironment.withResolved(names, signal, use);
      },
    };
    const provider = createTrustedMcpLaunchValueProvider({
      source: fixture.source,
      context: fixture.context,
      environment: gatedEnvironment,
      platform: "posix",
    });
    const runtime = new FakeMcpRuntime();
    const signal = new AbortController().signal;
    await runtime.replaceSource({
      registration: fixture.registration,
      expected: { kind: "absent" },
      launchValues: provider,
      runtimeLeases: new FakeMcpRuntimeLeaseProvider(),
    }, signal);
    const stdioKey = Object.keys(fixture.source.servers).find((key) => fixture.source.servers[key]!.transport === "stdio")!;
    const observed = new Map<string, string>();
    const first = runtime.launch(fixture.source.identity, stdioKey, signal, (values) => {
      if (values.transport === "stdio") observed.set("first", values.args[1]!);
    });
    await firstEntered;
    fixture.secrets.value = "CANARY_SECRET_V2";
    const second = runtime.launch(fixture.source.identity, stdioKey, signal, (values) => {
      if (values.transport === "stdio") observed.set("second", values.args[1]!);
    });
    await second;
    release();
    await first;
    expect(observed).toEqual(new Map([
      ["second", "CANARY_SECRET_V2"],
      ["first", "CANARY_SECRET_V1"],
    ]));
    expect(baseEnvironment.disposed).toBe(2);
  });

  it("observes secret revision changes per launch and fails closed on trust revocation", async () => {
    const fixture = integratedFixture();
    const runtime = new FakeMcpRuntime();
    const signal = new AbortController().signal;
    await runtime.replaceSource({
      registration: fixture.registration,
      expected: { kind: "absent" },
      launchValues: fixture.provider,
      runtimeLeases: new FakeMcpRuntimeLeaseProvider(),
    }, signal);
    const stdioKey = Object.keys(fixture.source.servers).find((key) => fixture.source.servers[key]!.transport === "stdio")!;
    const observed: string[] = [];
    await runtime.launch(fixture.source.identity, stdioKey, signal, (values) => {
      if (values.transport === "stdio") observed.push(values.args[1]!);
    });
    fixture.secrets.value = "CANARY_SECRET_V2";
    await runtime.launch(fixture.source.identity, stdioKey, signal, (values) => {
      if (values.transport === "stdio") observed.push(values.args[1]!);
    });
    expect(observed).toEqual(["CANARY_SECRET_V1", "CANARY_SECRET_V2"]);

    fixture.revoke();
    const failure = await runtime.launch(fixture.source.identity, stdioKey, signal).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "MCP_LAUNCH_AUTHORITY_REJECTED" });
    const status = await runtime.inspectSource(fixture.source.identity, signal);
    expect(status?.servers.find((server) => server.key === stdioKey)?.errorCode)
      .toBe("MCP_LAUNCH_AUTHORITY_REJECTED");
    expect(JSON.stringify({ failure, status })).not.toContain("CANARY_SECRET_V2");
  });
});

type McpLaunchValues = import("../../src/application/ports/mcp-runtime.js").McpLaunchValues;
