import { describe, expect, it, vi } from "vitest";
import { createHookExecutionContextPort } from "../../src/application/hook-execution-context.js";
import type { HookExecutionBinding, HookExecutionContextPortDependencies } from "../../src/application/ports/hook-execution-context.js";
import type { ResolvedConfiguration } from "../../src/application/resolved-configuration.js";
import { project } from "../runtime/hooks/fixtures.js";
import { ComponentIdSchema } from "../../src/domain/components.js";
import { ContentDigestSchema } from "../../src/domain/content-manifest.js";
import { PluginKeySchema } from "../../src/domain/identity.js";

const binding: HookExecutionBinding = {
  scope: { kind: "user" },
  plugin: PluginKeySchema.parse("demo@catalog"),
  revision: ContentDigestSchema.parse(`sha256:${"1".repeat(64)}`),
  projectionDigest: ContentDigestSchema.parse(`sha256:${"2".repeat(64)}`),
  contributionDigest: ContentDigestSchema.parse(`sha256:${"3".repeat(64)}`),
  componentId: ComponentIdSchema.parse(`component-v1:hook:${"4".repeat(64)}`),
  sourceOrder: { snapshotOrdinal: 0, hookOrdinal: 0 },
};

const facade: ResolvedConfiguration = {
  has: () => false,
  substitute: (value) => value,
  environment: () => Object.freeze({}),
  redact: (value) => value,
  dispose: () => undefined,
  toString: () => "[REDACTED]",
  toJSON: () => "[REDACTED]",
};

function dependencies(overrides: Partial<HookExecutionContextPortDependencies> = {}) {
  const withResolvedPluginConfiguration = vi.fn(async (_request, _dependencies, _signal, use) => use(facade));
  const active = {
    currentProject: () => project,
    get: () => ({ binding, pluginRoot: "/plugin", pluginDataRoot: "/data", currentProject: project, candidate: {} as never, trustRecords: [], configurationRef: undefined, descriptors: { options: [] } as never, pathContext: { scope: { kind: "user" }, trustedBaseDirectory: "/workspace/project" } }),
  };
  const result: HookExecutionContextPortDependencies = {
    active,
    projectRoots: { acquire: async () => ({ identity: project.identity, projectKey: project.projectKey, canonicalRoot: "file:///workspace/project/" }) as never, verify: () => ({ kind: "user" }) as never },
    configuration: { withResolvedPluginConfiguration, dependencies: {} as never },
    ...overrides,
  };
  return { result, withResolvedPluginConfiguration };
}

function request(overrides: Partial<{ plannedPluginRoot: string; plannedPluginDataRoot: string; currentProject: typeof project }> = {}) {
  return {
    binding,
    sessionCwd: "/workspace/project",
    plannedPluginRoot: overrides.plannedPluginRoot ?? "/plugin",
    plannedPluginDataRoot: overrides.plannedPluginDataRoot ?? "/data",
    currentProject: overrides.currentProject ?? project,
  };
}

describe("hook execution context authority", () => {
  it("rejects root and binding mismatches before configuration or secret resolution", async () => {
    const { result, withResolvedPluginConfiguration } = dependencies();
    const port = createHookExecutionContextPort(result);
    await expect(port.withContext(request({ plannedPluginRoot: "/wrong" }), new AbortController().signal, async () => undefined)).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    expect(withResolvedPluginConfiguration).not.toHaveBeenCalled();
  });

  it("rejects an untrusted project-scoped binding before callback execution", async () => {
    const untrusted = { ...project, trust: { kind: "untrusted" as const } };
    const active = {
      currentProject: () => untrusted,
      get: () => ({ ...dependencies().result.active.get(binding)!, binding: { ...binding, scope: { kind: "project", projectKey: project.projectKey } }, currentProject: untrusted }),
    };
    const { result, withResolvedPluginConfiguration } = dependencies({ active });
    const port = createHookExecutionContextPort(result);
    await expect(port.withContext({ ...request({ currentProject: untrusted }), binding: { ...binding, scope: { kind: "project", projectKey: project.projectKey } } }, new AbortController().signal, async () => undefined)).rejects.toMatchObject({ code: "BINDING_MISMATCH" });
    expect(withResolvedPluginConfiguration).not.toHaveBeenCalled();
  });

  it("discards callback completion and returns only the scoped context", async () => {
    const { result, withResolvedPluginConfiguration } = dependencies();
    const port = createHookExecutionContextPort(result);
    let observed: unknown;
    await port.withContext(request(), new AbortController().signal, async (value) => { observed = value; });
    expect(observed).toMatchObject({ cwd: "/workspace/project", pluginRoot: "/plugin", pluginDataRoot: "/data", projectRoot: "file:///workspace/project/" });
    expect(withResolvedPluginConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ pathContext: { scope: { kind: "user" }, trustedBaseDirectory: "/workspace/project" } }),
      expect.anything(),
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });
});
