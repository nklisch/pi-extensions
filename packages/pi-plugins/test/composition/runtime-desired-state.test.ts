import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { buildRuntimeDesiredState } from "../../src/composition/runtime-desired-state.js";
import { CompatibilityReportSchema } from "../../src/domain/compatibility.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { MarketplaceInstallationPolicySchema } from "../../src/domain/marketplace.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { createResolvedMarketplaceSource, createResolvedPluginSource } from "../../src/domain/source.js";
import { createInstalledRevisionRecord } from "../../src/domain/state/installed-state.js";
import { deriveProjectKey } from "../../src/domain/state/scope.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const identity = { kind: "path-only" as const, canonicalRoot: "file:///workspace/project/" as never, limitation: "identity-changes-with-canonical-root" as const };
const projectKey = deriveProjectKey(identity, sha256);
const projectScope = { kind: "project" as const, identity, projectKey };

function pointers() {
  return {
    schemaVersion: 1 as const,
    scope: { kind: "user" as const },
    generation: 0 as never,
    documents: [],
  } as never;
}

describe("runtime desired state", () => {
  it("rereads authority and excludes untrusted current-project state", async () => {
    const read = vi.fn(async (scope: { kind: string }) => {
      if (scope.kind !== "user") throw new Error("project state must not be read");
      return {
        ok: true as const,
        snapshot: {
          scope: { kind: "user" as const }, generation: 0 as never, pointers: pointers(),
          config: { schemaVersion: 2 as const, generation: 0 as never, records: [] },
          installed: { schemaVersion: 2 as const, generation: 0 as never, marketplaces: [], plugins: [] },
          trust: { schemaVersion: 1 as const, generation: 0 as never, records: [] },
          corruptions: [],
        },
      };
    });
    const currentProject = { identity, projectKey, trust: { kind: "untrusted" as const } };
    const project = {
      scope: projectScope,
      current: () => currentProject,
      revalidate: async () => currentProject,
    } as never;
    const result = await buildRuntimeDesiredState({
      installed: { load: vi.fn() },
      compatibility: { assess: vi.fn() },
      projections: { prepare: vi.fn(), read: vi.fn() },
      project,
      state: { read, commit: vi.fn() },
      userBaseDirectory: "/workspace",
      sha256,
    }, new AbortController().signal);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ selections: [], mcp: [], blocked: [] });
    expect(result.skillHook.currentProject.trust.kind).toBe("untrusted");
  });

  it("surfaces an MCP candidate receipt failure only for enabled MCP plugins", async () => {
    const record = {
      plugin: "mcp-demo@community",
      activation: "enabled",
      selectedRevision: `sha256:${"a".repeat(64)}`,
      revisions: [{
        revision: `sha256:${"a".repeat(64)}`,
        evidence: { components: [{ kind: "mcp-server" }] },
      }],
    };
    const currentProject = { identity, projectKey, trust: { kind: "untrusted" as const } };
    const result = await buildRuntimeDesiredState({
      installed: { load: vi.fn() },
      compatibility: { assess: vi.fn() },
      projections: { prepare: vi.fn(), read: vi.fn() },
      project: { scope: projectScope, current: () => currentProject, revalidate: async () => currentProject } as never,
      state: {
        async read() {
          return {
            ok: true as const,
            snapshot: {
              scope: { kind: "user" as const }, generation: 0 as never, pointers: pointers(),
              config: { schemaVersion: 2 as const, generation: 0 as never, records: [] },
              installed: { schemaVersion: 2 as const, generation: 0 as never, marketplaces: [], plugins: [record] },
              trust: { schemaVersion: 1 as const, generation: 0 as never, records: [] },
              corruptions: [],
            },
          };
        },
      } as never,
      mcpUnavailable: {
        code: "PACKAGE_DRIFT",
        explanation: "The installed MCP adapter package does not match the required release.",
      },
      userBaseDirectory: "/workspace",
      sha256,
    }, new AbortController().signal);
    expect(result.degraded).toMatchObject([{
      plugin: "mcp-demo@community",
      code: "MCP_RUNTIME_UNAVAILABLE",
      explanation: "MCP runtime is unavailable: The installed MCP adapter package does not match the required release. (PACKAGE_DRIFT)",
    }]);
    expect(result.selections).toEqual([]);
  });

  it("builds the runtime from committed pending candidates so recovery settles with observations", async () => {
    // A pending transition is a committed candidate awaiting activation:
    // reconstruction must activate it (recording an observation), not exclude
    // it — exclusion forced a conservative rollback on every start.
    const pending = {
      plugin: "bundle@community",
      activation: "enabled",
      selectedRevision: `sha256:${"a".repeat(64)}`,
      revisions: [],
      pendingTransition: `pending-transition-v1:sha256:${"b".repeat(64)}`,
    };
    const state = {
      async read() {
        return {
          ok: true as const,
          snapshot: {
            scope: { kind: "user" as const }, generation: 1 as never, pointers: pointers(),
            config: { schemaVersion: 2 as const, generation: 1 as never, records: [] },
            installed: { schemaVersion: 2 as const, generation: 1 as never, marketplaces: [], plugins: [pending] },
            trust: { schemaVersion: 1 as const, generation: 1 as never, records: [] },
            corruptions: [],
          },
        };
      },
    };
    const installed = { load: vi.fn() };
    const currentProject = { identity, projectKey, trust: { kind: "untrusted" as const } };
    const result = await buildRuntimeDesiredState({
      installed: installed as never,
      compatibility: { assess: vi.fn() } as never,
      projections: { prepare: vi.fn(), read: vi.fn() } as never,
      project: { scope: projectScope, current: () => currentProject, revalidate: async () => currentProject } as never,
      state: state as never,
      userBaseDirectory: "/workspace",
      sha256,
    }, new AbortController().signal);
    // The candidate is attempted: only its missing revision evidence blocks.
    expect(installed.load).not.toHaveBeenCalled();
    expect(result.selections).toEqual([]);
    expect(result.blocked).toMatchObject([{
      plugin: "bundle@community",
      scope: { kind: "user" },
      selectedRevision: `sha256:${"a".repeat(64)}`,
      code: "REVISION_UNAVAILABLE",
      explanation: "selected installed revision is unavailable",
    }]);
  });

  it("re-assesses with the install-time marketplace policy so unchanged runtimes match install-time digests", async () => {
    // Policy-bearing entries stranded every install in recovery-required when
    // runtime re-assessment dropped the policy; using the stored report
    // verbatim instead would freeze install-time capability availability and
    // let runtime drift fail open. The runtime must re-assess live WITH the
    // descriptor's stored policy.
    const source = createResolvedPluginSource({ kind: "marketplace-path", marketplaceRevision: "a".repeat(40), path: "./plugin" }, sha256);
    const plugin = NormalizedPluginSchema.parse({
      identity: { key: "fixture@community", marketplaceName: "community", marketplaceEntryName: "fixture" },
      source,
      configuration: { options: [] },
      components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
      metadata: [],
    });
    const compatibility = CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
    const content = createContentManifest([], sha256);
    const revision = createInstalledRevisionRecord({ plugin, compatibility, content, scope: { kind: "user" } }, sha256);
    const location = { host: "claude" as const, documentKind: "marketplace" as const, path: ".claude-plugin/marketplace.json" };
    const installationPolicy = MarketplaceInstallationPolicySchema.parse({
      availability: { value: "available", provenance: [{ location: { ...location, pointer: "/plugins/0/policy/installation" } }] },
      declaration: { value: { installation: "AVAILABLE" }, provenance: [{ location: { ...location, pointer: "/plugins/0/policy" } }] },
    });
    const loaded = {
      plugin,
      compatibility,
      marketplaceSource: createResolvedMarketplaceSource({ declared: { kind: "github", repository: "example/plugins" }, revision: "a".repeat(40) }, sha256),
      content,
      binding: revision.revision,
      installationPolicy,
    };
    const record = { plugin: plugin.identity.key, activation: "enabled", selectedRevision: revision.revision, revisions: [revision] };
    const state = {
      async read() {
        return {
          ok: true as const,
          snapshot: {
            scope: { kind: "user" as const }, generation: 1 as never, pointers: pointers(),
            config: { schemaVersion: 2 as const, generation: 1 as never, records: [] },
            installed: { schemaVersion: 2 as const, generation: 1 as never, marketplaces: [], plugins: [record] },
            trust: { schemaVersion: 1 as const, generation: 1 as never, records: [] },
            corruptions: [],
          },
        };
      },
    };
    const assess = vi.fn(async () => compatibility);
    const currentProject = { identity, projectKey, trust: { kind: "untrusted" as const } };
    const projectionValue = { digest: `sha256:${"c".repeat(64)}` };
    const result = await buildRuntimeDesiredState({
      installed: { load: vi.fn(async () => loaded) } as never,
      compatibility: { assess } as never,
      projections: {
        prepare: vi.fn(async (expectation: unknown) => expectation),
        read: vi.fn(async () => ({ kind: "ready" as const, value: projectionValue })),
      } as never,
      project: { scope: projectScope, current: () => currentProject, revalidate: async () => currentProject } as never,
      state: state as never,
      userBaseDirectory: "/workspace",
      sha256,
    }, new AbortController().signal);
    expect(assess).toHaveBeenCalledWith({ plugin, marketplacePolicy: installationPolicy }, expect.any(AbortSignal));
    expect(result.selections.map((selection: { plugin: string }) => selection.plugin)).toEqual([plugin.identity.key]);
    expect(result.blocked).toEqual([]);
  });

  it("activates a staged candidate on next start: pending records with valid revisions enter selections", async () => {
    const source = createResolvedPluginSource({ kind: "marketplace-path", marketplaceRevision: "a".repeat(40), path: "./plugin" }, sha256);
    const plugin = NormalizedPluginSchema.parse({
      identity: { key: "fixture@community", marketplaceName: "community", marketplaceEntryName: "fixture" },
      source,
      configuration: { options: [] },
      components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
      metadata: [],
    });
    const compatibility = CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
    const content = createContentManifest([], sha256);
    const revision = createInstalledRevisionRecord({ plugin, compatibility, content, scope: { kind: "user" } }, sha256);
    const loaded = {
      plugin,
      compatibility,
      marketplaceSource: createResolvedMarketplaceSource({ declared: { kind: "github", repository: "example/plugins" }, revision: "a".repeat(40) }, sha256),
      content,
      binding: revision.revision,
    };
    const record = {
      plugin: plugin.identity.key,
      activation: "enabled",
      selectedRevision: revision.revision,
      revisions: [revision],
      pendingTransition: `pending-transition-v1:sha256:${"b".repeat(64)}`,
    };
    const state = {
      async read() {
        return {
          ok: true as const,
          snapshot: {
            scope: { kind: "user" as const }, generation: 1 as never, pointers: pointers(),
            config: { schemaVersion: 2 as const, generation: 1 as never, records: [] },
            installed: { schemaVersion: 2 as const, generation: 1 as never, marketplaces: [], plugins: [record] },
            trust: { schemaVersion: 1 as const, generation: 1 as never, records: [] },
            corruptions: [],
          },
        };
      },
    };
    const projectionValue = { digest: `sha256:${"c".repeat(64)}` };
    const currentProject = { identity, projectKey, trust: { kind: "untrusted" as const } };
    const result = await buildRuntimeDesiredState({
      installed: { load: vi.fn(async () => loaded) } as never,
      compatibility: { assess: vi.fn(async () => compatibility) } as never,
      projections: {
        prepare: vi.fn(async (expectation: unknown) => expectation),
        read: vi.fn(async () => ({ kind: "ready" as const, value: projectionValue })),
      } as never,
      project: { scope: projectScope, current: () => currentProject, revalidate: async () => currentProject } as never,
      state: state as never,
      userBaseDirectory: "/workspace",
      sha256,
    }, new AbortController().signal);
    expect(result.selections.map((selection: { plugin: string }) => selection.plugin)).toEqual([plugin.identity.key]);
    expect(result.blocked).toEqual([]);
  });

  it.each([
    ["previous good", true, true],
    ["previous missing", true, false],
    ["no previous", false, false],
  ])("uses the session-local fallback matrix: %s", async (_name, hasPreviousPointer, previousAvailable) => {
    const previousSource = createResolvedPluginSource({ kind: "marketplace-path", marketplaceRevision: "a".repeat(40), path: "./plugin" }, sha256);
    const brokenSource = createResolvedPluginSource({ kind: "marketplace-path", marketplaceRevision: "b".repeat(40), path: "./plugin" }, sha256);
    const previousPlugin = NormalizedPluginSchema.parse({ ...pluginForFallback(previousSource), source: previousSource });
    const brokenPlugin = NormalizedPluginSchema.parse({ ...pluginForFallback(brokenSource), source: brokenSource });
    const previousCompatibility = CompatibilityReportSchema.parse({ plugin: previousPlugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
    const brokenCompatibility = CompatibilityReportSchema.parse({ plugin: brokenPlugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
    const previousRevision = createInstalledRevisionRecord({ plugin: previousPlugin, compatibility: previousCompatibility, content: createContentManifest([], sha256), scope: { kind: "user" } }, sha256);
    const brokenRevision = createInstalledRevisionRecord({ plugin: brokenPlugin, compatibility: brokenCompatibility, content: createContentManifest([], sha256), scope: { kind: "user" } }, sha256);
    const record = {
      plugin: brokenPlugin.identity.key,
      activation: "enabled" as const,
      selectedRevision: brokenRevision.revision,
      ...(hasPreviousPointer ? { previousRevision: previousRevision.revision } : {}),
      revisions: previousAvailable ? [previousRevision, brokenRevision] : [brokenRevision],
    };
    const currentProject = { identity, projectKey, trust: { kind: "untrusted" as const } };
    const loaded = {
      plugin: previousPlugin,
      compatibility: previousCompatibility,
      marketplaceSource: createResolvedMarketplaceSource({ declared: { kind: "github", repository: "example/plugins" }, revision: "a".repeat(40) }, sha256),
      content: createContentManifest([], sha256),
      binding: previousRevision.revision,
    };
    const load = vi.fn(async ({ revision: candidate }: { revision: typeof previousRevision | typeof brokenRevision }) => {
      if (candidate.revision === brokenRevision.revision) throw Object.assign(new Error("broken selected revision"), { code: "INSTALLED_DESCRIPTOR_CORRUPT" });
      return loaded;
    });
    const result = await buildRuntimeDesiredState({
      installed: { load } as never,
      compatibility: { assess: vi.fn(async (_request: unknown) => previousCompatibility) } as never,
      projections: { prepare: vi.fn(async (expectation: unknown) => expectation), read: vi.fn(async () => ({ kind: "ready" as const, value: { digest: `sha256:${"c".repeat(64)}` } })) } as never,
      project: { scope: projectScope, current: () => currentProject, revalidate: async () => currentProject } as never,
      state: { read: async () => ({ ok: true as const, snapshot: { scope: { kind: "user" as const }, generation: 1 as never, pointers: pointers(), config: { schemaVersion: 2 as const, generation: 1 as never, records: [] }, installed: { schemaVersion: 2 as const, generation: 1 as never, marketplaces: [], plugins: [record] }, trust: { schemaVersion: 1 as const, generation: 1 as never, records: [] }, corruptions: [] } }) } as never,
      userBaseDirectory: "/workspace",
      sha256,
    }, new AbortController().signal);
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ revision: brokenRevision }), expect.any(AbortSignal));
    if (previousAvailable) {
      expect(result.selections[0]?.revision.revision).toBe(previousRevision.revision);
      expect(result.degraded[0]).toMatchObject({ plugin: brokenPlugin.identity.key, selectedRevision: brokenRevision.revision, runningRevision: previousRevision.revision });
    } else {
      expect(result.selections).toEqual([]);
      expect(result.degraded[0]).toMatchObject({ plugin: brokenPlugin.identity.key, selectedRevision: brokenRevision.revision });
      expect(result.degraded[0]?.runningRevision).toBeUndefined();
    }
  });
});

function pluginForFallback(source: ReturnType<typeof createResolvedPluginSource>) {
  return {
    identity: { key: "fallback@community", marketplaceName: "community", marketplaceEntryName: "fallback" },
    source,
    configuration: { options: [] },
    components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
    metadata: [],
  };
}
