import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPluginMcpProjection } from "../../src/application/mcp-plugin-projection.js";
import { createMcpLifecycleParticipant, type McpLifecycleState } from "../../src/runtime/mcp/lifecycle-participant.js";
import {
  createActiveProjectionExpectation,
  createInactiveProjectionExpectation,
  createPluginRuntimeProjection,
} from "../../src/application/ports/runtime-projection.js";
import { McpRuntimeCapabilitiesSchemaV1 } from "../../src/application/ports/mcp-runtime.js";
import { evaluateCompatibility } from "../../src/domain/compatibility-evaluator.js";
import { deriveComponentId } from "../../src/domain/component-identity.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { createInstalledRevisionRecord } from "../../src/domain/state/installed-state.js";
import { CanonicalProjectRootSchema, deriveProjectKey, type ScopeReference } from "../../src/domain/state/scope.js";
import { PluginKeySchema } from "../../src/domain/identity.js";
import { capabilities, claimFixture, directPlugin, fixtureProvenance } from "../fixtures/compatibility/common.js";
import { FakeMcpRuntime } from "../support/fakes/mcp-runtime.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const projectIdentity = {
  kind: "path-only" as const,
  canonicalRoot: CanonicalProjectRootSchema.parse("file:///workspace/project/"),
  limitation: "identity-changes-with-canonical-root" as const,
};
const projectKey = deriveProjectKey(projectIdentity, sha256);
const currentProject = { identity: projectIdentity, projectKey, trust: { kind: "trusted" as const } };
const runtimeCapabilities = McpRuntimeCapabilitiesSchemaV1.parse({
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
});

function fixture(input: Readonly<{
  plugin?: string;
  scope?: ScopeReference;
  command?: string | null;
}> = {}) {
  const pluginKey = PluginKeySchema.parse(input.plugin ?? "fixture@compatibility");
  const [entryName, marketplaceName] = pluginKey.split("@");
  const scope = input.scope ?? { kind: "user" as const };
  const provenance = fixtureProvenance("plugin.mcp.json", "/mcpServers/shared", "claude", "mcp");
  const component = {
    kind: "mcp-server" as const,
    id: deriveComponentId(pluginKey, { kind: "mcp-server", nativeKey: "shared" }, sha256),
    nativeKey: claimFixture("shared", provenance),
    declaration: claimFixture({ transport: "stdio", command: input.command ?? "CANARY_TEMPLATE" }, provenance),
    metadata: [],
  };
  const plugin = directPlugin({
    identity: { key: pluginKey, marketplaceName, marketplaceEntryName: entryName },
    components: { mcpServers: input.command === null ? [] : [component] },
  });
  const compatibility = evaluateCompatibility({ plugin, capabilities: capabilities() });
  const revision = createInstalledRevisionRecord({
    plugin,
    compatibility,
    content: createContentManifest([], sha256),
    scope,
  }, sha256);
  const projection = createPluginRuntimeProjection({ scope, plugin, compatibility, revision, sha256 });
  const expectation = createActiveProjectionExpectation(projection, sha256);
  const mcpProjection = createPluginMcpProjection({
    projection,
    compatibility,
    runtimeCapabilities,
    sha256,
  });
  const state: McpLifecycleState = mcpProjection.kind === "source"
    ? { kind: "source", expectation, projection: mcpProjection, capabilities: runtimeCapabilities }
    : { kind: "none", expectation, projection: mcpProjection };
  const inactive: McpLifecycleState = {
    kind: "inactive",
    expectation: createInactiveProjectionExpectation({ scope, plugin: pluginKey, sha256 }),
  };
  return { state, inactive };
}

function participant(runtime?: FakeMcpRuntime) {
  const effects = { resolved: 0, disposed: 0, acquired: 0, released: 0 };
  const leases = new WeakSet<object>();
  const issued: object[] = [];
  return {
    effects,
    value: createMcpLifecycleParticipant({
      runtime,
      launchValues: () => ({
        async resolve() {
          effects.resolved += 1;
          return { transport: "stdio", command: "CANARY_PLAINTEXT", args: [] };
        },
        dispose() { effects.disposed += 1; },
      }),
      runtimeLeases: () => ({
        async acquire() {
          effects.acquired += 1;
          const lease = Object.freeze({ toJSON: () => "[REDACTED]" });
          leases.add(lease);
          issued.push(lease);
          return lease as never;
        },
        async release(lease) {
          if (!leases.has(lease as object)) throw new Error("lease mismatch");
          leases.delete(lease as object);
          effects.released += 1;
        },
        async drain(signal) {
          for (const lease of issued) {
            if (leases.has(lease)) await this.release(lease as never, signal);
          }
        },
      }),
      sha256,
    }),
  };
}

describe("package-neutral MCP lifecycle integration", () => {
  it("registers and observes committed local projection evidence without network, launch values, leases, or tools", async () => {
    const runtime = new FakeMcpRuntime();
    const source = fixture();
    if (source.state.kind !== "source") throw new Error("source state required");
    const created = participant(runtime);
    const signal = new AbortController().signal;
    expect((await created.value.reconcile({ from: source.inactive, to: source.state, currentProject }, signal)).kind)
      .toBe("applied");
    expect(created.effects).toEqual({ resolved: 0, disposed: 0, acquired: 0, released: 0 });
    const observation = await created.value.observe({ from: source.inactive, to: source.state, currentProject }, signal);
    expect(observation.kind).toBe("ready");
    if (observation.kind !== "ready" || observation.observation.kind !== "active") throw new Error("active evidence required");
    expect(observation.observation.registration).toMatchObject({
      kind: "source",
      identity: source.state.projection.registration.source.identity,
      registrationDigest: source.state.projection.registration.digest,
    });
    expect(JSON.stringify(observation)).not.toMatch(/CANARY_TEMPLATE|CANARY_PLAINTEXT/);
  });

  it("keeps same native keys isolated across plugins and user/project scopes", async () => {
    const runtime = new FakeMcpRuntime();
    const user = fixture();
    const other = fixture({ plugin: "other@compatibility" });
    const project = fixture({ scope: { kind: "project", projectKey } });
    const signal = new AbortController().signal;
    for (const target of [user, other, project]) {
      expect((await participant(runtime).value.reconcile({ from: target.inactive, to: target.state, currentProject }, signal)).kind)
        .toBe("applied");
    }
    expect(await runtime.inspectSources(signal)).toHaveLength(3);
    expect((await participant(runtime).value.reconcile({ from: user.state, to: user.inactive, currentProject }, signal)).kind)
      .toBe("applied");
    const remaining = await runtime.inspectSources(signal);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((status) => status.identity.plugin).sort()).toEqual([
      "fixture@compatibility",
      "other@compatibility",
    ]);
    expect(remaining.some((status) => status.identity.scope.kind === "project")).toBe(true);
  });

  it("separates later remote health from exact local activation identity", async () => {
    const runtime = new FakeMcpRuntime();
    const target = fixture();
    if (target.state.kind !== "source") throw new Error("source state required");
    const created = participant(runtime);
    const signal = new AbortController().signal;
    await created.value.reconcile({ from: target.inactive, to: target.state, currentProject }, signal);
    const key = Object.keys(target.state.projection.registration.source.servers)[0]!;
    runtime.setServerHealth(target.state.projection.registration.source.identity, key, {
      state: "needs-auth",
      errorCode: "ADAPTER_FAILED",
      toolCount: 0,
    });
    expect((await created.value.observe({ from: target.inactive, to: target.state, currentProject }, signal)).kind)
      .toBe("ready");
    expect(created.effects).toEqual({ resolved: 0, disposed: 0, acquired: 0, released: 0 });
  });

  it("degrades no-MCP structurally without a runtime but never waves away a source needing cleanup", async () => {
    const none = fixture({ command: null });
    const source = fixture();
    const created = participant();
    const signal = new AbortController().signal;
    expect((await created.value.observe({ from: none.inactive, to: none.state, currentProject }, signal)).kind)
      .toBe("ready");
    expect(await created.value.observe({ from: source.state, to: none.state, currentProject }, signal))
      .toEqual({ kind: "failed", code: "RUNTIME_UNAVAILABLE" });
  });

  it("revokes project activation before provider construction and exposes only redacted status", async () => {
    const runtime = new FakeMcpRuntime();
    const target = fixture({ scope: { kind: "project", projectKey } });
    const created = participant(runtime);
    const untrusted = { ...currentProject, trust: { kind: "untrusted" as const } };
    expect(await created.value.reconcile({ from: target.inactive, to: target.state, currentProject: untrusted }, new AbortController().signal))
      .toEqual({ kind: "failed", code: "PROJECT_UNTRUSTED" });
    expect(created.effects).toEqual({ resolved: 0, disposed: 0, acquired: 0, released: 0 });
    expect(JSON.stringify(await created.value.status({
      scope: { kind: "project", projectKey },
      plugin: PluginKeySchema.parse("fixture@compatibility"),
    }, new AbortController().signal))).not.toMatch(/CANARY_TEMPLATE|CANARY_PLAINTEXT|launchTemplate|options/);
  });
});
