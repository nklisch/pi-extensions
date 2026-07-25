import { describe, expect, it, vi } from "vitest";
import { createMcpLaunchContextPort } from "../../src/application/mcp-launch-context.js";
import { deriveMcpRuntimeServerKey } from "../../src/application/ports/mcp-runtime.js";
import {
  McpLaunchBindingSchemaV1,
  McpLaunchErrorCodes,
  type McpLaunchActiveSelection,
} from "../../src/application/ports/mcp-launch-context.js";
import { createResolvedConfiguration } from "../../src/application/resolved-configuration.js";
import { createProjectRootAuthorityPort } from "../../src/composition/create-project-root-authority.js";
import { evaluateCompatibility } from "../../src/domain/compatibility-evaluator.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { createPluginStoreIdentityFromEvidence } from "../../src/domain/content-store.js";
import { createResolvedMarketplaceSource } from "../../src/domain/source.js";
import { createInstalledRevisionRecord } from "../../src/domain/state/installed-state.js";
import { createScopeContext, deriveProjectKey, toScopeReference } from "../../src/domain/state/scope.js";
import { createTrustCandidate, grantTrust } from "../../src/domain/trust-policy.js";
import { createActiveProjectionExpectation, createPluginRuntimeProjection } from "../../src/application/ports/runtime-projection.js";
import { capabilities, directPlugin } from "../fixtures/compatibility/common.js";
import { mcp } from "../fixtures/compatibility/mcp.js";
import { FakeMcpLaunchActiveSelection, mcpLaunchSha256 as sha256 } from "../support/fakes/mcp-launch-context.js";

const projectIdentity = {
  kind: "path-only" as const,
  canonicalRoot: "file:///workspace/project/" as const,
  limitation: "identity-changes-with-canonical-root" as const,
};
const projectKey = deriveProjectKey(projectIdentity, sha256);
const currentProject = {
  identity: projectIdentity,
  projectKey,
  trust: { kind: "trusted" as const },
};

function fixture(projectScoped = false) {
  const scopeContext = projectScoped
    ? createScopeContext({ kind: "project", identity: projectIdentity, projectKey }, sha256)
    : createScopeContext({ kind: "user" }, sha256);
  const scope = toScopeReference(scopeContext);
  const component = mcp({
    command: "${PLUGIN_ROOT}/bin/server",
    args: ["--data", "${PLUGIN_DATA}"],
  }, "a") as never;
  const plugin = directPlugin({ components: { mcpServers: [component] } });
  const compatibility = evaluateCompatibility({ plugin, capabilities: capabilities() });
  const contentManifest = createContentManifest([], sha256);
  const revision = createInstalledRevisionRecord({ plugin, compatibility, content: contentManifest, scope }, sha256);
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
  const binding = McpLaunchBindingSchemaV1.parse({
    schemaVersion: 1,
    source: {
      schemaVersion: 1,
      scope,
      plugin: projection.plugin,
      revision: projection.revision,
      projectionDigest: projection.digest,
    },
    serverKey: deriveMcpRuntimeServerKey(component.id),
    componentId: component.id,
    transport: "stdio",
  });
  const selection: McpLaunchActiveSelection = {
    expectation,
    revision,
    component,
    currentProject,
    candidate,
    trustRecords: [grantTrust(candidate, sha256)],
    descriptors: plugin.configuration,
    pathContext: { scope: scopeContext, ...(projectScoped ? {} : { trustedBaseDirectory: "/trusted" }) },
  };
  return { scope, scopeContext, component, plugin, compatibility, contentManifest, revision, projection, candidate, binding, selection };
}

function setup(input = fixture(), selection: McpLaunchActiveSelection = input.selection) {
  const active = new FakeMcpLaunchActiveSelection(input.binding, selection);
  const calls = { content: 0, data: 0, configuration: 0, callback: 0, projectTrust: 0 };
  const projectRoots = createProjectRootAuthorityPort({ resolve: async () => ({
    kind: "project",
    identity: projectIdentity,
    projectKey,
  }) }, sha256);
  const resolvedConfiguration = createResolvedConfiguration([]);
  const withResolvedPluginConfiguration = vi.fn(async (_request, _dependencies, signal: AbortSignal, use) => {
    calls.configuration += 1;
    signal.throwIfAborted();
    try {
      await use(resolvedConfiguration);
    } finally {
      resolvedConfiguration.dispose();
    }
  });
  const content = {
    async resolvePlugin() {
      calls.content += 1;
      return {
        kind: "plugin" as const,
        root: "/store/plugin",
        identity: createPluginStoreIdentityFromEvidence({
          sourceHash: input.revision.evidence.source.sourceHash,
          binding: input.revision.revision,
        }, sha256),
        manifest: input.contentManifest,
        contentRef: input.revision.contentRef,
      };
    },
    async ensureDataRoot() {
      calls.data += 1;
      return {
        root: "/data/plugin",
        scope: input.scope,
        plugin: input.projection.plugin,
        dataRef: input.revision.dataRef,
      };
    },
  };
  const port = createMcpLaunchContextPort({
    active,
    content,
    projectRoots,
    projectTrust: {
      async assess() {
        calls.projectTrust += 1;
        return { kind: "trusted" as const };
      },
    },
    configuration: {
      withResolvedPluginConfiguration: withResolvedPluginConfiguration as never,
      dependencies: {} as never,
    },
    sha256,
  });
  return { port, active, content, calls, resolvedConfiguration, withResolvedPluginConfiguration };
}

describe("trusted MCP launch context", () => {
  it("revalidates exact selection, trust, project root, and logical roots before callback", async () => {
    const input = fixture();
    const { port, calls } = setup(input);
    let observed: unknown;
    await port.withContext(input.binding, new AbortController().signal, async (context) => {
      calls.callback += 1;
      observed = {
        binding: context.binding,
        pluginRoot: context.pluginRoot,
        pluginDataRoot: context.pluginDataRoot,
        projectRoot: context.projectRoot,
        template: context.template,
      };
    });
    expect(observed).toMatchObject({
      binding: input.binding,
      pluginRoot: "/store/plugin",
      pluginDataRoot: "/data/plugin",
      projectRoot: projectIdentity.canonicalRoot,
      template: { transport: "stdio" },
    });
    expect(calls).toEqual({ content: 1, data: 1, configuration: 1, callback: 1, projectTrust: 1 });
  });

  it.each([
    ["projection digest", (value: McpLaunchActiveSelection) => ({
      ...value,
      expectation: { ...value.expectation, projection: { ...value.expectation.projection, digest: `sha256:${"f".repeat(64)}` } },
    })],
    ["installed revision", (value: McpLaunchActiveSelection) => ({
      ...value,
      revision: { ...value.revision, revision: `sha256:${"e".repeat(64)}` },
    })],
    ["executable component", (value: McpLaunchActiveSelection) => ({
      ...value,
      component: { ...value.component, declaration: { ...value.component.declaration, value: { command: "other" } } },
    })],
    ["trust candidate", (value: McpLaunchActiveSelection) => ({
      ...value,
      candidate: { ...value.candidate, surface: { ...value.candidate.surface, entries: [] } },
    })],
    ["current project trust", (value: McpLaunchActiveSelection) => ({
      ...value,
      currentProject: { ...value.currentProject, trust: { kind: "untrusted" } },
    })],
  ] as const)("rejects drifted %s before configuration or callback", async (_name, mutate) => {
    const input = fixture();
    const changed = mutate(input.selection) as McpLaunchActiveSelection;
    const { port, calls } = setup(input, changed);
    await expect(port.withContext(input.binding, new AbortController().signal, async () => {
      calls.callback += 1;
    })).rejects.toMatchObject({ code: McpLaunchErrorCodes.authorityRejected });
    expect(calls.configuration).toBe(0);
    expect(calls.callback).toBe(0);
  });

  it("denies absent executable trust before content/data/configuration effects", async () => {
    const input = fixture();
    const { port, calls } = setup(input, { ...input.selection, trustRecords: [] });
    await expect(port.withContext(input.binding, new AbortController().signal, async () => undefined))
      .rejects.toMatchObject({ code: McpLaunchErrorCodes.authorityRejected });
    expect(calls).toMatchObject({ content: 0, data: 0, configuration: 0, callback: 0 });
  });

  it("rejects a tampered server key before invoking any authority dependency", async () => {
    const input = fixture();
    const configured = setup(input);
    const tampered = {
      ...input.binding,
      serverKey: `mcp-server-v1:${"f".repeat(64)}`,
    };
    await expect(configured.port.withContext(
      tampered as never,
      new AbortController().signal,
      async () => undefined,
    )).rejects.toMatchObject({ code: McpLaunchErrorCodes.authorityRejected });
    expect(configured.active.calls).toBe(0);
    expect(configured.calls).toEqual({
      content: 0,
      data: 0,
      configuration: 0,
      callback: 0,
      projectTrust: 0,
    });
  });

  it("requires exact trusted project authority for project-scoped sources", async () => {
    const input = fixture(true);
    const { port, calls } = setup(input);
    await port.withContext(input.binding, new AbortController().signal, async () => {
      calls.callback += 1;
    });
    expect(calls.callback).toBe(1);

    const wrongBinding = { ...input.binding, source: { ...input.binding.source, scope: { kind: "user" as const } } };
    await expect(port.withContext(wrongBinding, new AbortController().signal, async () => undefined))
      .rejects.toMatchObject({ code: McpLaunchErrorCodes.authorityRejected });
  });

  it("performs no dependency work on pre-abort and propagates the exact reason", async () => {
    const input = fixture();
    const { port, active, calls } = setup(input);
    const controller = new AbortController();
    const reason = new Error("CANARY_ABORT_REASON");
    controller.abort(reason);
    await expect(port.withContext(input.binding, controller.signal, async () => undefined)).rejects.toBe(reason);
    expect(active.calls).toBe(0);
    expect(calls).toEqual({ content: 0, data: 0, configuration: 0, callback: 0, projectTrust: 0 });
  });

  it("propagates exact abort reasons from an awaited root seam and stops later effects", async () => {
    const input = fixture();
    const configured = setup(input);
    const controller = new AbortController();
    const reason = Object.assign(new Error("CANARY_CONTENT_ABORT"), { name: "AbortError" });
    configured.content.resolvePlugin = async () => {
      configured.calls.content += 1;
      controller.abort(reason);
      throw reason;
    };
    await expect(configured.port.withContext(input.binding, controller.signal, async () => undefined))
      .rejects.toBe(reason);
    expect(configured.calls).toMatchObject({ content: 1, data: 0, configuration: 0, callback: 0 });
  });

  it("maps configuration boundary failures to one redacted typed code", async () => {
    const input = fixture();
    const configured = setup(input);
    configured.withResolvedPluginConfiguration.mockRejectedValueOnce(new Error("CANARY_SECRET_FAILURE"));
    const error = await configured.port.withContext(input.binding, new AbortController().signal, async () => undefined)
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: McpLaunchErrorCodes.configurationFailed });
    expect(JSON.stringify(error)).not.toContain("CANARY_SECRET_FAILURE");
  });
});
