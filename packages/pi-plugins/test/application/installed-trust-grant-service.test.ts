import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createInstalledTrustGrantService } from "../../src/application/installed-trust-grant-service.js";
import { digestCompatibilityReport } from "../../src/application/ports/runtime-projection.js";
import { createContentManifest, createMaterializationBinding } from "../../src/domain/content-manifest.js";
import { CompatibilityReportSchema } from "../../src/domain/compatibility.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { createResolvedMarketplaceSource, createResolvedPluginSource } from "../../src/domain/source.js";
import { HostConfigDocumentSchema, GenerationSchema, type Generation } from "../../src/domain/state/config-state.js";
import {
  createInstalledPluginRecord,
  createInstalledRevisionRecord,
  createInstalledUserStateDocument,
  createMarketplaceSnapshotRecord,
} from "../../src/domain/state/installed-state.js";
import { StatePointersDocumentSchema } from "../../src/domain/state/pointers.js";
import { TrustStateDocumentSchema } from "../../src/domain/state/trust-state.js";
import { deriveStateBlobRef } from "../../src/domain/state/references.js";
import { deriveProjectKey, type ScopeContext } from "../../src/domain/state/scope.js";
import { createTrustCandidate, grantTrust } from "../../src/domain/trust-policy.js";
import { deriveMarketplaceSourceIdentity, derivePluginSourceIdentity } from "../../src/domain/update-policy.js";
import { readClaudeMarketplace } from "../../src/formats/claude/marketplace-reader.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;
const declaredSource = { kind: "github" as const, repository: "example/community" };
const revision = "b".repeat(40);
const marketplaceSource = createResolvedMarketplaceSource({ declared: declaredSource, revision }, sha256);
const entry = readClaudeMarketplace({ name: "community", plugins: [{ name: "fixture", source: "./plugin", strict: false }] }).marketplace.entries[0]!;
const pluginSourcePath = entry.source.value.kind === "marketplace-path" ? entry.source.value.path : "plugin";

const plugin = NormalizedPluginSchema.parse({
  identity: { key: "fixture@community", marketplaceName: "community", marketplaceEntryName: "fixture" },
  source: createResolvedPluginSource({ kind: "marketplace-path", marketplaceRevision: revision, path: pluginSourcePath }, sha256),
  configuration: { options: [] },
  components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
  metadata: [],
});
const compatibility = CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
const content = createContentManifest([], sha256);
const binding = createMaterializationBinding(plugin.source.hash, content.rootDigest, sha256);
const marketplace = createMarketplaceSnapshotRecord({ marketplace: "community", source: marketplaceSource, content }, sha256);
const scopeRef = { kind: "user" as const };
const installedRevision = createInstalledRevisionRecord({
  plugin,
  compatibility,
  content,
  scope: scopeRef,
  marketplaceSourceIdentity: deriveMarketplaceSourceIdentity(declaredSource, sha256),
  pluginSourceIdentity: derivePluginSourceIdentity(entry.source.value, sha256),
}, sha256);
const installedRecord = createInstalledPluginRecord({
  plugin: "fixture@community",
  activation: "enabled",
  selectedRevision: installedRevision.revision,
  revisions: [installedRevision],
  scope: scopeRef,
}, sha256);

function pointers(generation: Generation) {
  return StatePointersDocumentSchema.parse({
    schemaVersion: 1,
    scope: scopeRef,
    generation,
    documents: ["hostConfig", "installedUser", "trust"].map((kind) => ({
      kind,
      generation,
      blob: deriveStateBlobRef({ document: kind, scope: "user", generation }, sha256),
      digest: `sha256:${"0".repeat(64)}`,
    })),
  });
}

function userSnapshot(records: readonly unknown[] = []) {
  const generation = GenerationSchema.parse(0);
  return {
    scope: scopeRef,
    generation,
    pointers: pointers(generation),
    config: HostConfigDocumentSchema.parse({ schemaVersion: 4, generation, global: { application: "manual", cadence: "balanced" }, records: [] }),
    installed: createInstalledUserStateDocument({ generation, marketplaces: [marketplace], plugins: [installedRecord] }, sha256),
    trust: TrustStateDocumentSchema.parse({ schemaVersion: 1, generation, records }),
    corruptions: [],
  };
}

function setup(options: {
  records?: readonly unknown[];
  activatable?: boolean;
  grant?: unknown;
  projectTrusted?: boolean;
} = {}) {
  const grantResult = options.grant ?? { kind: "recorded", subject: "trust-subject-v1:sha256:" + "1".repeat(64), generation: 1 };
  const trust = { grant: vi.fn(async () => grantResult) };
  const service = createInstalledTrustGrantService({
    state: {
      async read(readScope: ScopeContext) {
        if (readScope.kind !== "user") return { ok: false as const, reason: "missing" };
        return { ok: true as const, snapshot: userSnapshot(options.records ?? []) };
      },
    } as never,
    installed: {
      async load() {
        return { plugin, compatibility, marketplaceSource, content, binding };
      },
    } as never,
    compatibility: {
      async assess() {
        // The service only reads the verdict; a schema-invalid refinement
        // (activatable must agree with component verdicts) is irrelevant here.
        return options.activatable === false
          ? { ...compatibility, activatable: false }
          : compatibility;
      },
    } as never,
    trust: trust as never,
    projectRoots: { async acquire() { throw new Error("no project root in user-scope tests"); } } as never,
    projectScope: {
      kind: "project",
      identity: { kind: "path-only", canonicalRoot: "file:///project/", limitation: "identity-changes-with-canonical-root" },
      projectKey: deriveProjectKey({ kind: "path-only", canonicalRoot: "file:///project/", limitation: "identity-changes-with-canonical-root" }, sha256),
    },
    sha256,
  });
  return { service, trust };
}

const target = {
  scope: scopeRef,
  plugin: "fixture@community",
  expectedRevision: installedRevision.revision,
  expectedCompatibilityFingerprint: digestCompatibilityReport(compatibility, sha256),
} as const;

describe("installed trust grant service", () => {
  it("grants exact trust for the installed revision when no record exists", async () => {
    const { service, trust } = setup();
    const result = await service.grant(target, signal);
    expect(result.kind).toBe("granted");
    expect(trust.grant).toHaveBeenCalledOnce();
    const request = trust.grant.mock.calls[0]?.[0] as { candidate: { evidence: { immutableRevision: string } } };
    expect(request.candidate.evidence.immutableRevision).toBe(installedRevision.revision);
  });

  it("reports current-state when the exact candidate is already authorized", async () => {
    const candidate = createTrustCandidate({
      scope: scopeRef,
      marketplaceSource,
      plugin,
      compatibility,
      content,
      materializationBinding: binding,
    }, sha256);
    const { service, trust } = setup({ records: [grantTrust(candidate, sha256)] });
    const result = await service.grant(target, signal);
    expect(result).toMatchObject({ kind: "current-state", reason: "already-authorized" });
    expect(trust.grant).not.toHaveBeenCalled();
  });

  it("fails stale when the installed revision moved after inspection", async () => {
    const { service, trust } = setup();
    const result = await service.grant({ ...target, expectedRevision: `sha256:${"9".repeat(64)}` }, signal);
    expect(result).toMatchObject({ kind: "stale", reason: "revision" });
    expect(trust.grant).not.toHaveBeenCalled();
  });

  it("rejects when the live compatibility assessment is not activatable", async () => {
    const { service, trust } = setup({ activatable: false });
    const result = await service.grant(target, signal);
    expect(result).toMatchObject({ kind: "rejected", code: "INCOMPATIBLE" });
    expect(trust.grant).not.toHaveBeenCalled();
  });

  it("maps a project-untrusted grant outcome to a rejection", async () => {
    const { service } = setup({ grant: { kind: "project-untrusted" } });
    const result = await service.grant(target, signal);
    expect(result).toMatchObject({ kind: "rejected", code: "PROJECT_UNTRUSTED" });
  });

  it("maps grant generation conflicts to stale", async () => {
    const { service } = setup({ grant: { kind: "stale", expected: 0, actual: 1 } });
    const result = await service.grant(target, signal);
    expect(result).toMatchObject({ kind: "stale", reason: "generation" });
  });

  it("fails stale when the live capability report drifts from the reviewed fingerprint", async () => {
    const { service, trust } = setup();
    const result = await service.grant({ ...target, expectedCompatibilityFingerprint: `sha256:${"7".repeat(64)}` }, signal);
    expect(result).toMatchObject({ kind: "stale", reason: "capability" });
    expect(trust.grant).not.toHaveBeenCalled();
  });

  it("grants project-scope trust against the host's bound project with an acquired root", async () => {
    const identity = { kind: "path-only" as const, canonicalRoot: "file:///project/", limitation: "identity-changes-with-canonical-root" as const };
    const projectScope = { kind: "project" as const, identity, projectKey: deriveProjectKey(identity, sha256) };
    const projectRef = { kind: "project" as const, projectKey: projectScope.projectKey };
    const projectRevision = createInstalledRevisionRecord({
      plugin,
      compatibility,
      content,
      scope: projectRef,
      marketplaceSourceIdentity: deriveMarketplaceSourceIdentity(declaredSource, sha256),
      pluginSourceIdentity: derivePluginSourceIdentity(entry.source.value, sha256),
    }, sha256);
    const projectRecord = createInstalledPluginRecord({
      plugin: "fixture@community",
      activation: "enabled",
      selectedRevision: projectRevision.revision,
      revisions: [projectRevision],
      scope: projectRef,
    }, sha256);
    const acquired = { kind: "acquired" } as const;
    const trust = { grant: vi.fn(async () => ({ kind: "recorded", subject: "trust-subject-v1:sha256:" + "1".repeat(64), generation: 1 })) };
    const service = createInstalledTrustGrantService({
      state: {
        async read(readScope: ScopeContext) {
          if (readScope.kind === "project") {
            const generation = GenerationSchema.parse(0);
            return {
              ok: true as const,
              snapshot: {
                scope: projectScope,
                generation,
                pointers: pointers(generation),
                project: { plugins: [projectRecord] },
                corruptions: [],
              },
            };
          }
          return { ok: true as const, snapshot: userSnapshot([]) };
        },
      } as never,
      installed: {
        async load() {
          return { plugin, compatibility, marketplaceSource, content, binding };
        },
      } as never,
      compatibility: { async assess() { return compatibility; } } as never,
      trust: trust as never,
      projectRoots: { async acquire() { return acquired; } } as never,
      projectScope,
      sha256,
    });
    const result = await service.grant({
      scope: projectRef,
      plugin: "fixture@community",
      expectedRevision: projectRevision.revision,
      expectedCompatibilityFingerprint: digestCompatibilityReport(compatibility, sha256),
    }, signal);
    expect(result.kind).toBe("granted");
    const request = trust.grant.mock.calls[0]?.[0] as { scope: unknown; projectRoot?: unknown };
    expect(request.scope).toBe(projectScope);
    expect(request.projectRoot).toBe(acquired);
  });

  it("treats a project reference outside the host's bound project as stale", async () => {
    const { service, trust } = setup();
    const foreign = deriveProjectKey({ kind: "path-only", canonicalRoot: "file:///elsewhere/", limitation: "identity-changes-with-canonical-root" }, sha256);
    const result = await service.grant({ ...target, scope: { kind: "project", projectKey: foreign } }, signal);
    expect(result).toMatchObject({ kind: "stale", reason: "project" });
    expect(trust.grant).not.toHaveBeenCalled();
  });
});
