import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createPluginMcpProjection,
  type PluginMcpProjection,
} from "../../../src/application/mcp-plugin-projection.js";
import { createMcpSourceRegistration } from "../../../src/application/mcp-source-registration.js";
import {
  createMcpLifecycleParticipant,
  type McpLifecycleState,
} from "../../../src/runtime/mcp/lifecycle-participant.js";
import {
  McpRuntimeCapabilitiesSchemaV1,
  McpSourceStatusSchema,
  type McpRuntimeCapabilities,
  type McpRuntimePort,
} from "../../../src/application/ports/mcp-runtime.js";
import {
  createActiveProjectionExpectation,
  createInactiveProjectionExpectation,
  createPluginRuntimeProjection,
} from "../../../src/application/ports/runtime-projection.js";
import { evaluateCompatibility } from "../../../src/domain/compatibility-evaluator.js";
import { deriveComponentId } from "../../../src/domain/component-identity.js";
import { canonicalJson } from "../../../src/domain/canonical-json.js";
import { createContentManifest, hashContent } from "../../../src/domain/content-manifest.js";
import { createInstalledRevisionRecord } from "../../../src/domain/state/installed-state.js";
import {
  CanonicalProjectRootSchema,
  deriveProjectKey,
  type ScopeReference,
} from "../../../src/domain/state/scope.js";
import {
  capabilities,
  claimFixture,
  directPlugin,
  fixtureProvenance,
} from "../../fixtures/compatibility/common.js";
import {
  FakeMcpRuntime,
  FakeMcpRuntimeLeaseProvider,
} from "../../support/fakes/mcp-runtime.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const content = createContentManifest([], sha256);
const projectIdentity = {
  kind: "path-only" as const,
  canonicalRoot: CanonicalProjectRootSchema.parse("file:///workspace/project/"),
  limitation: "identity-changes-with-canonical-root" as const,
};
const projectKey = deriveProjectKey(projectIdentity, sha256);
const currentProject = {
  identity: projectIdentity,
  projectKey,
  trust: { kind: "trusted" as const },
};

function runtimeCapabilities(
  overrides: Readonly<Partial<McpRuntimeCapabilities["sourceLifecycle"]>> = {},
): McpRuntimeCapabilities {
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
      ...overrides,
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
}

function stateFixture(input: Readonly<{
  scope?: ScopeReference;
  command?: string;
  servers?: boolean;
}> = {}) {
  const scope = input.scope ?? { kind: "user" as const };
  const provenance = fixtureProvenance("plugin.mcp.json", "/mcpServers/server-1", "claude", "mcp");
  const component = {
    kind: "mcp-server" as const,
    id: deriveComponentId("fixture@compatibility" as never, {
      kind: "mcp-server",
      nativeKey: "server-1",
    }, sha256),
    nativeKey: claimFixture("server-1", provenance),
    declaration: claimFixture({
      transport: "stdio",
      command: input.command ?? "server-v1",
    }, provenance),
    metadata: [],
  };
  const plugin = directPlugin({
    components: { mcpServers: input.servers === false ? [] : [component] },
  });
  const compatibility = evaluateCompatibility({ plugin, capabilities: capabilities() });
  const revision = createInstalledRevisionRecord({ plugin, compatibility, content, scope }, sha256);
  const projection = createPluginRuntimeProjection({ scope, plugin, compatibility, revision, sha256 });
  const expectation = createActiveProjectionExpectation(projection, sha256);
  const mcpProjection = createPluginMcpProjection({
    projection,
    compatibility,
    runtimeCapabilities: runtimeCapabilities(),
    sha256,
  });
  const state: McpLifecycleState = mcpProjection.kind === "source"
    ? { kind: "source", expectation, projection: mcpProjection, capabilities: runtimeCapabilities() }
    : { kind: "none", expectation, projection: mcpProjection };
  const inactive: McpLifecycleState = {
    kind: "inactive",
    expectation: createInactiveProjectionExpectation({
      scope,
      plugin: projection.plugin,
      sha256,
    }),
  };
  return { state, inactive, projection: mcpProjection };
}

function participant(runtime?: McpRuntimePort) {
  const calls = { launchValues: 0, runtimeLeases: 0 };
  const value = createMcpLifecycleParticipant({
    runtime,
    launchValues() {
      calls.launchValues += 1;
      return {
        async resolve() { return { transport: "stdio", command: "CANARY_PLAINTEXT", args: [] }; },
        dispose() {},
      };
    },
    runtimeLeases() {
      calls.runtimeLeases += 1;
      return new FakeMcpRuntimeLeaseProvider();
    },
    sha256,
  });
  return { participant: value, calls };
}

async function install(runtime: FakeMcpRuntime, state: McpLifecycleState) {
  if (state.kind !== "source") throw new Error("source state required");
  const created = participant(runtime);
  const result = await created.participant.reconcile({
    from: stateFixture({ servers: false }).inactive,
    to: state,
    currentProject,
  }, new AbortController().signal);
  expect(result.kind).toBe("applied");
}

function delegated(base: FakeMcpRuntime, overrides: Partial<McpRuntimePort>): McpRuntimePort {
  return {
    capabilities: (signal) => base.capabilities(signal),
    validateSource: (registration, signal) => base.validateSource(registration, signal),
    replaceSource: (request, signal) => base.replaceSource(request, signal),
    removeSource: (identity, signal) => base.removeSource(identity, signal),
    inspectSource: (identity, signal) => base.inspectSource(identity, signal),
    inspectSources: (signal) => base.inspectSources(signal),
    ...overrides,
  };
}

function rehashMcpProjection(
  projection: Extract<PluginMcpProjection, { kind: "source" }>,
  source: Extract<PluginMcpProjection, { kind: "source" }>["registration"]["source"],
): Extract<PluginMcpProjection, { kind: "source" }> {
  const registration = createMcpSourceRegistration({ source, sha256 });
  const withoutDigest = {
    schemaVersion: 1 as const,
    kind: "source" as const,
    registration,
    aliasOmissions: projection.aliasOmissions,
  };
  const digest = hashContent(
    new TextEncoder().encode(`plugin-mcp-projection-v1\0${canonicalJson(withoutDigest)}`),
    sha256,
  );
  return { ...withoutDigest, digest };
}

function forgedNoneProjection(
  source: Extract<PluginMcpProjection, { kind: "source" }>,
): Extract<PluginMcpProjection, { kind: "none" }> {
  const withoutDigest = {
    schemaVersion: 1 as const,
    kind: "none" as const,
    identity: source.registration.source.identity,
    aliasOmissions: [] as const,
  };
  return {
    ...withoutDigest,
    digest: hashContent(
      new TextEncoder().encode(`plugin-mcp-projection-v1\0${canonicalJson(withoutDigest)}`),
      sha256,
    ),
  };
}

describe("MCP lifecycle participant", () => {
  it("reconciles the complete source/none/inactive transition table idempotently", async () => {
    const sourceState = stateFixture().state;
    const noneFixture = stateFixture({ servers: false });
    if (sourceState.kind !== "source" || noneFixture.state.kind !== "none") throw new Error("unexpected fixture");
    const runtime = new FakeMcpRuntime();
    const owner = participant(runtime).participant;
    const signal = new AbortController().signal;

    expect((await owner.reconcile({ from: noneFixture.inactive, to: sourceState, currentProject }, signal)).kind).toBe("applied");
    expect((await owner.reconcile({ from: sourceState, to: sourceState, currentProject }, signal)).kind).toBe("unchanged");
    expect((await owner.reconcile({ from: sourceState, to: noneFixture.state, currentProject }, signal)).kind).toBe("applied");
    expect((await owner.reconcile({ from: noneFixture.state, to: noneFixture.state, currentProject }, signal)).kind).toBe("unchanged");
    expect((await owner.reconcile({ from: noneFixture.state, to: sourceState, currentProject }, signal)).kind).toBe("applied");
    expect((await owner.reconcile({ from: sourceState, to: noneFixture.inactive, currentProject }, signal)).kind).toBe("applied");
    expect((await owner.reconcile({ from: noneFixture.inactive, to: noneFixture.state, currentProject }, signal)).kind).toBe("unchanged");
    expect((await owner.reconcile({ from: noneFixture.state, to: noneFixture.inactive, currentProject }, signal)).kind).toBe("unchanged");
    expect((await owner.reconcile({ from: noneFixture.inactive, to: noneFixture.inactive, currentProject }, signal)).kind).toBe("unchanged");
  });

  it("uses exact old/new identity and never overwrites a third same-owner source", async () => {
    const oldState = stateFixture({ command: "old" }).state;
    const newState = stateFixture({ command: "new" }).state;
    const thirdState = stateFixture({ command: "third" }).state;
    if (oldState.kind !== "source" || newState.kind !== "source" || thirdState.kind !== "source") throw new Error("source states required");
    const runtime = new FakeMcpRuntime();
    await install(runtime, oldState);
    const owner = participant(runtime).participant;
    const signal = new AbortController().signal;
    expect((await owner.reconcile({ from: oldState, to: newState, currentProject }, signal)).kind).toBe("applied");
    expect((await runtime.inspectSource(newState.projection.registration.source.identity, signal))?.registrationDigest)
      .toBe(newState.projection.registration.digest);

    await runtime.replaceSource({
      registration: thirdState.projection.registration,
      expected: { kind: "exact", identity: newState.projection.registration.source.identity },
      launchValues: { async resolve() { return { transport: "stdio", command: "x", args: [] }; }, dispose() {} },
      runtimeLeases: new FakeMcpRuntimeLeaseProvider(),
    }, signal);
    const stale = await owner.reconcile({ from: oldState, to: newState, currentProject }, signal);
    expect(stale).toEqual({ kind: "stale", current: thirdState.projection.registration.source.identity });
    expect(await runtime.inspectSource(thirdState.projection.registration.source.identity, signal)).toBeDefined();
  });

  it("rejects forged none and altered rehashed source evidence before runtime or provider effects", async () => {
    const sourceState = stateFixture().state;
    if (sourceState.kind !== "source") throw new Error("source state required");
    const [key, server] = Object.entries(sourceState.projection.registration.source.servers)[0]!;
    const altered = rehashMcpProjection(sourceState.projection, {
      ...sourceState.projection.registration.source,
      servers: { [key]: { ...server, nativeKey: "forged-native-key" } },
    });
    const forgedStates: McpLifecycleState[] = [
      { ...sourceState, projection: altered },
      {
        kind: "none",
        expectation: sourceState.expectation,
        projection: forgedNoneProjection(sourceState.projection),
      },
    ];

    for (const forged of forgedStates) {
      for (const operation of ["reconcile", "observe"] as const) {
        let runtimeEffects = 0;
        const base = new FakeMcpRuntime();
        const runtime = delegated(base, {
          capabilities: async (signal) => { runtimeEffects += 1; return base.capabilities(signal); },
          inspectSources: async (signal) => { runtimeEffects += 1; return base.inspectSources(signal); },
          inspectSource: async (identity, signal) => { runtimeEffects += 1; return base.inspectSource(identity, signal); },
        });
        const created = participant(runtime);
        const request = { from: stateFixture({ servers: false }).inactive, to: forged, currentProject };
        const result = await created.participant[operation](request, new AbortController().signal);
        expect(result, `${operation}:${forged.kind}`).toEqual({ kind: "failed", code: "INVALID_TRANSITION" });
        expect(runtimeEffects, `${operation}:${forged.kind}`).toBe(0);
        expect(created.calls, `${operation}:${forged.kind}`).toEqual({ launchValues: 0, runtimeLeases: 0 });
      }
    }
  });

  it("independently observes exact registration inventory while ignoring remote health", async () => {
    const sourceState = stateFixture().state;
    if (sourceState.kind !== "source") throw new Error("source state required");
    const runtime = new FakeMcpRuntime();
    await install(runtime, sourceState);
    const key = Object.keys(sourceState.projection.registration.source.servers)[0]!;
    runtime.setServerHealth(sourceState.projection.registration.source.identity, key, {
      state: "failed",
      errorCode: "ADAPTER_FAILED",
      toolCount: 0,
    });
    const created = participant(runtime);
    const result = await created.participant.observe({
      from: sourceState,
      to: sourceState,
      currentProject,
    }, new AbortController().signal);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready" || result.observation.kind !== "active") throw new Error("active evidence required");
    expect(result.observation.registration).toMatchObject({
      kind: "source",
      registrationDigest: sourceState.projection.registration.digest,
      serverKeys: [key],
    });
    expect(JSON.stringify(result)).not.toContain("CANARY_PLAINTEXT");
    expect(created.calls).toEqual({ launchValues: 0, runtimeLeases: 0 });
  });

  it("does not accept applied, partial, or lost-response mutation returns as success evidence", async () => {
    const oldState = stateFixture({ command: "old" }).state;
    const newState = stateFixture({ command: "new" }).state;
    if (oldState.kind !== "source" || newState.kind !== "source") throw new Error("source states required");

    const partialRuntime = new FakeMcpRuntime();
    await install(partialRuntime, oldState);
    partialRuntime.partiallyApplyNextReplacement();
    expect(await participant(partialRuntime).participant.reconcile({ from: oldState, to: newState, currentProject }, new AbortController().signal))
      .toEqual({ kind: "ambiguous", code: "MUTATION_OUTCOME_UNKNOWN" });

    const lostRuntime = new FakeMcpRuntime();
    await install(lostRuntime, oldState);
    lostRuntime.loseNextReplacementResponse();
    expect(await participant(lostRuntime).participant.reconcile({ from: oldState, to: newState, currentProject }, new AbortController().signal))
      .toEqual({ kind: "ambiguous", code: "MUTATION_OUTCOME_UNKNOWN" });
  });

  it("classifies duplicate and disagreeing owner inspection as ambiguity without mutation", async () => {
    const sourceState = stateFixture().state;
    if (sourceState.kind !== "source") throw new Error("source state required");
    const base = new FakeMcpRuntime();
    await install(base, sourceState);
    const duplicate = delegated(base, {
      inspectSources: async (signal) => {
        const rows = await base.inspectSources(signal);
        return [...rows, rows[0]!];
      },
    });
    const duplicateOwner = participant(duplicate);
    expect(await duplicateOwner.participant.reconcile({ from: sourceState, to: sourceState, currentProject }, new AbortController().signal))
      .toEqual({ kind: "ambiguous", code: "INSPECTION_AMBIGUOUS" });
    expect(duplicateOwner.calls).toEqual({ launchValues: 0, runtimeLeases: 0 });

    const disagreement = delegated(base, {
      inspectSource: async (identity, signal) => {
        const status = await base.inspectSource(identity, signal);
        return status === undefined ? undefined : McpSourceStatusSchema.parse({ ...status, state: "failed" });
      },
    });
    expect(await participant(disagreement).participant.observe({ from: sourceState, to: sourceState, currentProject }, new AbortController().signal))
      .toEqual({ kind: "ambiguous", code: "INSPECTION_AMBIGUOUS" });
  });

  it("keeps pre-effect cancellation clean and post-effect cancellation ambiguous", async () => {
    const sourceState = stateFixture().state;
    const nextState = stateFixture({ command: "next" }).state;
    if (sourceState.kind !== "source" || nextState.kind !== "source") throw new Error("source states required");
    const runtime = new FakeMcpRuntime();
    await install(runtime, sourceState);

    const pre = new AbortController();
    pre.abort(new Error("CANARY_ABORT"));
    expect(await participant(runtime).participant.reconcile({ from: sourceState, to: nextState, currentProject }, pre.signal))
      .toEqual({ kind: "cancelled" });

    const during = new AbortController();
    const cancelling = delegated(runtime, {
      replaceSource: async (request, signal) => {
        const result = await runtime.replaceSource(request, signal);
        during.abort(new Error("CANARY_ABORT_AFTER_EFFECT"));
        throw during.signal.reason;
      },
    });
    expect(await participant(cancelling).participant.reconcile({ from: sourceState, to: nextState, currentProject }, during.signal))
      .toEqual({ kind: "ambiguous", code: "MUTATION_OUTCOME_UNKNOWN" });
  });

  it("requires exact trusted project context before providers or runtime mutation", async () => {
    const projectState = stateFixture({ scope: { kind: "project", projectKey } }).state;
    if (projectState.kind !== "source") throw new Error("source state required");
    const runtime = new FakeMcpRuntime();
    const created = participant(runtime);
    const untrusted = { ...currentProject, trust: { kind: "untrusted" as const } };
    expect(await created.participant.reconcile({
      from: stateFixture({ scope: { kind: "project", projectKey }, servers: false }).inactive,
      to: projectState,
      currentProject: untrusted,
    }, new AbortController().signal)).toEqual({ kind: "failed", code: "PROJECT_UNTRUSTED" });
    expect(created.calls).toEqual({ launchValues: 0, runtimeLeases: 0 });
    expect(await runtime.inspectSources(new AbortController().signal)).toEqual([]);
  });

  it("fails closed for runtime disappearance and capability downgrade but permits structural no-MCP absence", async () => {
    const sourceState = stateFixture().state;
    const none = stateFixture({ servers: false });
    if (sourceState.kind !== "source" || none.state.kind !== "none") throw new Error("unexpected fixtures");
    expect(await participant().participant.observe({ from: sourceState, to: none.state, currentProject }, new AbortController().signal))
      .toEqual({ kind: "failed", code: "RUNTIME_UNAVAILABLE" });
    expect((await participant().participant.observe({ from: none.inactive, to: none.state, currentProject }, new AbortController().signal)).kind)
      .toBe("ready");

    const downgraded = new FakeMcpRuntime({ capabilities: runtimeCapabilities({ runtimeLeases: false }) });
    expect(await participant(downgraded).participant.reconcile({ from: none.inactive, to: sourceState, currentProject }, new AbortController().signal))
      .toEqual({ kind: "failed", code: "CAPABILITY_MISMATCH" });
  });

  it("returns a strict redacted owner status without exposing providers or source definitions", async () => {
    const sourceState = stateFixture().state;
    if (sourceState.kind !== "source") throw new Error("source state required");
    const runtime = new FakeMcpRuntime();
    await install(runtime, sourceState);
    const owner = {
      scope: sourceState.projection.registration.source.identity.scope,
      plugin: sourceState.projection.registration.source.identity.plugin,
    };
    const result = await participant(runtime).participant.status(owner, new AbortController().signal);
    expect(result.kind).toBe("ready");
    expect(JSON.stringify(result)).not.toMatch(/CANARY_PLAINTEXT|launchTemplate|options/);
  });
});
