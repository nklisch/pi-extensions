import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPluginMcpProjection } from "../../../src/application/mcp-plugin-projection.js";
import { createMcpRevisionLeaseProvider } from "../../../src/runtime/mcp/revision-lease-provider.js";
import type { McpLaunchActiveSelectionPort } from "../../../src/application/ports/mcp-launch-context.js";
import type {
  RevisionLease,
  RevisionLeaseStore,
} from "../../../src/application/ports/revision-lease-store.js";
import { RevisionLeaseSchema } from "../../../src/application/ports/revision-lease-store.js";
import { EpochMillisecondsSchema } from "../../../src/application/ports/lifecycle-clock.js";
import {
  createActiveProjectionExpectation,
  createPluginRuntimeProjection,
} from "../../../src/application/ports/runtime-projection.js";
import { McpRuntimeCapabilitiesSchemaV1 } from "../../../src/application/ports/mcp-runtime.js";
import { evaluateCompatibility } from "../../../src/domain/compatibility-evaluator.js";
import { deriveComponentId } from "../../../src/domain/component-identity.js";
import { createContentManifest } from "../../../src/domain/content-manifest.js";
import { createInstalledRevisionRecord } from "../../../src/domain/state/installed-state.js";
import { CanonicalProjectRootSchema, deriveProjectKey } from "../../../src/domain/state/scope.js";
import {
  capabilities,
  claimFixture,
  directPlugin,
  fixtureProvenance,
} from "../../fixtures/compatibility/common.js";
import { FakeMcpRuntime } from "../../support/fakes/mcp-runtime.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const now = EpochMillisecondsSchema.parse(1_700_000_000_000);
const clock = { nowEpochMilliseconds: () => now, monotonicMilliseconds: () => 1 };
const projectIdentity = {
  kind: "path-only" as const,
  canonicalRoot: CanonicalProjectRootSchema.parse("file:///workspace/project/"),
  limitation: "identity-changes-with-canonical-root" as const,
};
const projectKey = deriveProjectKey(projectIdentity, sha256);
const currentProject = { identity: projectIdentity, projectKey, trust: { kind: "trusted" as const } };

function fixture() {
  const provenance = fixtureProvenance("plugin.mcp.json", "/mcpServers/server-1", "claude", "mcp");
  const component = {
    kind: "mcp-server" as const,
    id: deriveComponentId("fixture@compatibility" as never, {
      kind: "mcp-server",
      nativeKey: "server-1",
    }, sha256),
    nativeKey: claimFixture("server-1", provenance),
    declaration: claimFixture({ transport: "stdio", command: "server" }, provenance),
    metadata: [],
  };
  const plugin = directPlugin({ components: { mcpServers: [component] } });
  const compatibility = evaluateCompatibility({ plugin, capabilities: capabilities() });
  const revision = createInstalledRevisionRecord({
    plugin,
    compatibility,
    content: createContentManifest([], sha256),
    scope: { kind: "user" },
  }, sha256);
  const projection = createPluginRuntimeProjection({
    scope: { kind: "user" },
    plugin,
    compatibility,
    revision,
    sha256,
  });
  const expectation = createActiveProjectionExpectation(projection, sha256);
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
  const mcpProjection = createPluginMcpProjection({ projection, compatibility, runtimeCapabilities, sha256 });
  if (mcpProjection.kind !== "source") throw new Error("source projection required");
  const [serverKey, server] = Object.entries(mcpProjection.registration.source.servers)[0]!;
  const binding = {
    schemaVersion: 1 as const,
    source: mcpProjection.registration.source.identity,
    serverKey: serverKey as never,
    componentId: server.componentId,
    transport: server.transport,
  };
  const selection = {
    expectation,
    revision,
    component,
    currentProject,
  };
  return { mcpProjection, binding, selection, expectation, revision };
}

class Leases implements RevisionLeaseStore {
  acquired: Parameters<RevisionLeaseStore["acquire"]>[0][] = [];
  released: RevisionLease[] = [];
  failReleaseCount = 0;
  private readonly live = new Map<string, RevisionLease>();

  async acquire(request: Parameters<RevisionLeaseStore["acquire"]>[0]) {
    this.acquired.push(request);
    const lease = RevisionLeaseSchema.parse({
      leaseId: `00000000-0000-4000-8000-${String(this.acquired.length).padStart(12, "0")}`,
      sessionId: request.sessionId,
      artifacts: request.artifacts,
      acquiredAt: request.at,
    });
    this.live.set(lease.leaseId, lease);
    return lease;
  }
  async replace() { throw new Error("not used"); }
  async release(lease: RevisionLease) {
    if (this.failReleaseCount > 0) {
      this.failReleaseCount -= 1;
      throw new Error("CANARY_RELEASE_FAILURE");
    }
    this.live.delete(lease.leaseId);
    this.released.push(lease);
  }
  async list() {
    const leases = [...this.live.values()];
    return {
      complete: true,
      leases,
      owners: leases.map((lease) => ({ leaseId: lease.leaseId, status: "live" as const })),
    };
  }
}

function activePort(selection: ReturnType<typeof fixture>["selection"]): McpLaunchActiveSelectionPort {
  return {
    async withSelection(_binding, signal, use) {
      signal.throwIfAborted();
      await use(selection as never);
    },
  };
}

function provider(
  fixtureValue: ReturnType<typeof fixture>,
  leases: Leases,
  active = activePort(fixtureValue.selection),
) {
  return createMcpRevisionLeaseProvider({
    source: fixtureValue.mcpProjection.registration,
    active,
    leases,
    clock,
    sessionId: "runtime-session",
    sha256,
  });
}

describe("MCP revision lease provider", () => {
  it("pins exactly the selected plugin and projection behind an opaque token", async () => {
    const value = fixture();
    const leases = new Leases();
    const runtimeLeases = provider(value, leases);
    const token = await runtimeLeases.acquire(value.binding, new AbortController().signal);
    expect(leases.acquired).toHaveLength(1);
    expect(leases.acquired[0]).toMatchObject({
      sessionId: "runtime-session",
      artifacts: [
        { kind: "plugin" },
        { kind: "projection", reference: value.expectation.projectionRef },
      ],
      at: now,
    });
    expect(String(token)).toBe("[REDACTED]");
    expect(JSON.stringify(token)).toBe('"[REDACTED]"');
    expect(JSON.stringify(token)).not.toMatch(/session|lease|plugin|projection|process|path/i);

    await runtimeLeases.release(token, new AbortController().signal);
    await runtimeLeases.release(token, new AbortController().signal);
    expect(leases.released).toHaveLength(1);
  });

  it("rejects source, server, component, and transport disagreement before lease effects", async () => {
    const value = fixture();
    const cases = [
      { ...value.binding, source: { ...value.binding.source, projectionDigest: `sha256:${"f".repeat(64)}` } },
      { ...value.binding, serverKey: `mcp-server-v1:${"f".repeat(64)}` },
      { ...value.binding, componentId: `component-v1:mcp-server:${"f".repeat(64)}` },
      { ...value.binding, transport: "streamable-http" },
    ];
    for (const binding of cases) {
      const leases = new Leases();
      await expect(provider(value, leases).acquire(binding as never, new AbortController().signal)).rejects.toThrow();
      expect(leases.acquired).toEqual([]);
    }
  });

  it("rejects revision, projection, component, project, and trust drift before acquisition", async () => {
    const value = fixture();
    const drifts = [
      { ...value.selection, revision: { ...value.selection.revision, revision: `sha256:${"f".repeat(64)}` } },
      { ...value.selection, expectation: { ...value.selection.expectation, projectionRef: `projection-root-v1:sha256:${"f".repeat(64)}` } },
      { ...value.selection, component: { ...value.selection.component, id: `component-v1:mcp-server:${"f".repeat(64)}` } },
      { ...value.selection, currentProject: { ...currentProject, trust: { kind: "untrusted" } } },
    ];
    for (const selection of drifts) {
      const leases = new Leases();
      await expect(provider(value, leases, activePort(selection as never)).acquire(value.binding, new AbortController().signal)).rejects.toThrow();
      expect(leases.acquired).toEqual([]);
    }
  });

  it("keeps failed release retryable and serializes concurrent successful release", async () => {
    const value = fixture();
    const leases = new Leases();
    const runtimeLeases = provider(value, leases);
    const token = await runtimeLeases.acquire(value.binding, new AbortController().signal);
    leases.failReleaseCount = 1;
    await expect(runtimeLeases.release(token, new AbortController().signal)).rejects.toThrow();
    expect(leases.released).toEqual([]);
    await Promise.all([
      runtimeLeases.release(token, new AbortController().signal),
      runtimeLeases.release(token, new AbortController().signal),
    ]);
    expect(leases.released).toHaveLength(1);
  });

  it("drains a lease retained after cancellation cleanup fails before removal can succeed", async () => {
    const value = fixture();
    const leases = new Leases();
    const controller = new AbortController();
    const active: McpLaunchActiveSelectionPort = {
      async withSelection(_binding, signal, use) {
        await use(value.selection as never);
        controller.abort(new Error("CANARY_CANCEL_AFTER_STORE_ACQUIRE"));
        signal.throwIfAborted();
      },
    };
    const runtimeLeases = provider(value, leases, active);
    const runtime = new FakeMcpRuntime();
    const signal = new AbortController().signal;
    await runtime.replaceSource({
      registration: value.mcpProjection.registration,
      expected: { kind: "absent" },
      launchValues: {
        async resolve() { return { transport: "stdio", command: "server", args: [] }; },
        dispose() {},
      },
      runtimeLeases,
    }, signal);

    leases.failReleaseCount = 2;
    await expect(runtime.openExecution(
      value.mcpProjection.registration.source.identity,
      value.binding.serverKey,
      controller.signal,
    )).rejects.toThrow("CANARY_CANCEL_AFTER_STORE_ACQUIRE");
    expect((await leases.list(signal)).leases).toHaveLength(1);

    await expect(runtime.removeSource(
      value.mcpProjection.registration.source.identity,
      signal,
    )).rejects.toThrow();
    expect((await leases.list(signal)).leases).toHaveLength(1);

    await expect(runtime.removeSource(
      value.mcpProjection.registration.source.identity,
      signal,
    )).resolves.toEqual({ kind: "removed" });
    expect((await leases.list(signal)).leases).toEqual([]);
  });

  it("cleans an acquired lease if active-selection completion is cancelled", async () => {
    const value = fixture();
    const leases = new Leases();
    const controller = new AbortController();
    const active: McpLaunchActiveSelectionPort = {
      async withSelection(_binding, signal, use) {
        await use(value.selection as never);
        controller.abort(new Error("CANARY_CANCEL_AFTER_ACQUIRE"));
        signal.throwIfAborted();
      },
    };
    await expect(provider(value, leases, active).acquire(value.binding, controller.signal)).rejects.toThrow();
    expect(leases.acquired).toHaveLength(1);
    expect(leases.released).toHaveLength(1);
  });
});
