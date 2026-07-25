import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPluginMcpProjection } from "../../src/application/mcp-plugin-projection.js";
import { createComposedMcpRuntime } from "../../src/composition/create-mcp-runtime.js";
import { createRuntimeSelectionCatalog, type RuntimeSelection } from "../../src/composition/runtime-selection-catalog.js";
import { createActiveProjectionExpectation, createInactiveProjectionExpectation, createPluginRuntimeProjection } from "../../src/application/ports/runtime-projection.js";
import { McpRuntimeCapabilitiesSchemaV1 } from "../../src/application/ports/mcp-runtime.js";
import { evaluateCompatibility } from "../../src/domain/compatibility-evaluator.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { createInstalledRevisionRecord } from "../../src/domain/state/installed-state.js";
import { deriveProjectKey } from "../../src/domain/state/scope.js";
import { capabilities, directPlugin } from "../fixtures/compatibility/common.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const identity = { kind: "path-only" as const, canonicalRoot: "file:///workspace/project/" as never, limitation: "identity-changes-with-canonical-root" as const };
const projectKey = deriveProjectKey(identity, sha256);
const currentProject = { identity, projectKey, trust: { kind: "trusted" as const } };
const noRuntime = McpRuntimeCapabilitiesSchemaV1.parse({
  schemaVersion: 1,
  sourceLifecycle: { initialSourcesBeforeToolRegistration: false, isolatedFileDiscovery: false, localValidation: false, atomicReplace: false, exactRemove: false, inspect: false, cancellable: false, lateLaunchValues: false, runtimeLeases: false },
  transports: { stdio: false, streamableHttp: false, legacySse: false, websocket: false },
  oauth: { authorizationCode: false, clientCredentials: false },
  features: { sampling: false, elicitationForm: false, elicitationUrl: false, toolApproval: false, resources: false, pluginToolAliases: false },
});

function fixture(): RuntimeSelection {
  const plugin = directPlugin();
  const compatibility = evaluateCompatibility({ plugin, capabilities: capabilities() });
  const content = createContentManifest([], sha256);
  const revision = createInstalledRevisionRecord({ plugin, compatibility, content, scope: { kind: "user" } }, sha256);
  const projection = createPluginRuntimeProjection({ scope: { kind: "user" }, plugin, compatibility, revision, sha256 });
  const expectation = createActiveProjectionExpectation(projection, sha256);
  return {
    scope: { kind: "user" },
    plugin: plugin.identity.key,
    revision,
    compatibility,
    skillHook: { prepared: { expectation, projection, payloadDigest: `sha256:${"3".repeat(64)}` }, revision },
    hooks: [],
    mcp: [],
  };
}

function composed() {
  const selection = fixture();
  const catalog = createRuntimeSelectionCatalog(currentProject);
  const runtime = createComposedMcpRuntime({
    selections: catalog,
    content: {} as never,
    project: {
      current: () => currentProject,
      authority: {} as never,
      trust: {} as never,
    } as never,
    configuration: {} as never,
    environment: {} as never,
    leases: {} as never,
    clock: { nowEpochMilliseconds: () => 1 as never, monotonicMilliseconds: () => 1 },
    sessionId: "session-1",
    sha256,
  });
  return { selection, runtime };
}

describe("composed MCP runtime", () => {
  it("reports exact none/inactive evidence without a runtime and performs no launch effect", async () => {
    const { selection, runtime } = composed();
    const expectation = selection.skillHook.prepared.expectation;
    const projection = createPluginMcpProjection({
      projection: expectation.projection,
      compatibility: selection.compatibility,
      runtimeCapabilities: noRuntime,
      sha256,
    });
    expect(projection.kind).toBe("none");
    const to = { kind: "none" as const, expectation, projection };
    const from = { kind: "inactive" as const, expectation: createInactiveProjectionExpectation({ scope: selection.scope, plugin: selection.plugin, sha256 }) };
    await expect(runtime.reconcileAll([{ from, to }], new AbortController().signal)).resolves.toEqual([{ kind: "unchanged" }]);
    const observed = await runtime.participant.observe({ from, to, currentProject }, new AbortController().signal);
    expect(observed).toMatchObject({ kind: "ready", observation: { participant: "mcp", registration: { kind: "none" } } });
    await runtime.close();
    await runtime.close();
  });

  it("does not probe or call a supplied runtime during construction", () => {
    const selection = fixture();
    const runtimePort = { capabilities: vi.fn() };
    createComposedMcpRuntime({
      runtime: runtimePort as never,
      selections: createRuntimeSelectionCatalog(currentProject),
      content: {} as never,
      project: { current: () => currentProject, authority: {}, trust: {} } as never,
      configuration: {} as never,
      environment: {} as never,
      leases: {} as never,
      clock: { nowEpochMilliseconds: () => 1 as never, monotonicMilliseconds: () => 1 },
      sessionId: "session-1",
      sha256,
    });
    expect(runtimePort.capabilities).not.toHaveBeenCalled();
    expect(selection.plugin).toBeTruthy();
  });
});
