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

  it("excludes unresolved pending records from startup publication", async () => {
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
    expect(installed.load).not.toHaveBeenCalled();
    expect(result.selections).toEqual([]);
    expect(result.blocked).toEqual([{ plugin: "bundle@community", code: "RECOVERY_REQUIRED", explanation: "pending lifecycle state is excluded until recovery settles" }]);
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
});
