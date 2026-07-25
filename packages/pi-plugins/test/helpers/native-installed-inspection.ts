import { createHash } from "node:crypto";
import { vi } from "vitest";
import { createNativeInstalledInspector } from "../../src/application/native-installed-inspection.js";
import { createMarketplaceConfigurationRecord, deriveMarketplaceSourceIdentity, derivePluginSourceIdentity, deriveUpdateCandidateKey } from "../../src/domain/update-policy.js";
import { deriveMarketplaceRegistrationId } from "../../src/domain/marketplace-registration.js";
import { deriveUpdateNoticeId } from "../../src/application/native-update-identifiers.js";
import { deriveMcpRuntimeServerKey } from "../../src/application/ports/mcp-runtime.js";
import { evaluateCompatibility } from "../../src/domain/compatibility-evaluator.js";
import { createContentManifest, createMaterializationBinding } from "../../src/domain/content-manifest.js";
import { createInstalledRevisionRecord } from "../../src/domain/state/installed-state.js";
import { createResolvedMarketplaceSource } from "../../src/domain/source.js";
import { capabilities, claimFixture, componentId, directPlugin, fixtureProvenance, sha256 as fixtureSha } from "../fixtures/compatibility/common.js";
import { mcp } from "../fixtures/compatibility/mcp.js";

export const nativeInspectionSha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const marketplaceSource = createResolvedMarketplaceSource({ declared: { kind: "github", repository: "owner/market" }, revision: "a".repeat(40) }, fixtureSha);
const projectionDigest = `sha256:${"55".repeat(32)}` as never;
const projectKey = `project-v1:sha256:${"11".repeat(32)}` as never;
const projectIdentity = { kind: "path-only" as const, canonicalRoot: "file:///project/" as never, limitation: "identity-changes-with-canonical-root" as const };

export type NativeInstalledHarnessOptions = Readonly<{
  enabled?: boolean;
  remote?: "failed" | "needs-auth" | "connected";
  pending?: boolean;
  skill?: boolean;
  skillMismatch?: boolean;
  mcpUnavailable?: boolean;
  noRuntime?: boolean;
  projectUntrusted?: boolean;
  trust?: "authorized" | "required" | "revoked" | "invalid-evidence" | "unavailable";
  hostileNativeKey?: string;
  updateFailed?: boolean;
  updatePending?: boolean;
  updateClockRegressed?: boolean;
}>;

export function createNativeInstalledHarness(options: NativeInstalledHarnessOptions = {}) {
  const component = mcp({ transport: "stdio", command: "server" }, "a") as any;
  component.nativeKey = { ...component.nativeKey, value: options.hostileNativeKey ?? "native-key" };
  const skill = {
    kind: "skill" as const,
    id: componentId("skill", "b"),
    name: claimFixture("demo", fixtureProvenance("skills/demo/SKILL.md", "/name", "claude", "skill")),
    root: claimFixture("skills/demo", fixtureProvenance("skills/demo/SKILL.md", "/root", "claude", "skill")),
    metadata: [],
  };
  const plugin = options.remote !== undefined
    ? directPlugin({ components: { mcpServers: [component] } })
    : options.skill ? directPlugin({ components: { skills: [skill] } }) : directPlugin();
  const report = evaluateCompatibility({ plugin, capabilities: capabilities() });
  const content = createContentManifest([], fixtureSha);
  const scopeReference = options.projectUntrusted ? { kind: "project" as const, projectKey } : { kind: "user" as const };
  const scopeContext = options.projectUntrusted ? { kind: "project" as const, identity: projectIdentity, projectKey } : { kind: "user" as const };
  const revision = createInstalledRevisionRecord({ plugin, compatibility: report, content, scope: scopeReference }, fixtureSha);
  const record = {
    plugin: plugin.identity.key,
    activation: options.enabled ? "enabled" : "disabled",
    selectedRevision: revision.revision,
    revisions: [revision],
    ...(options.pending ? { pendingTransition: `pending-transition-v1:sha256:${"77".repeat(32)}` } : {}),
  } as never;
  const serverKey = options.remote === undefined ? undefined : deriveMcpRuntimeServerKey(component.id);
  const skillIds = options.skill && !options.skillMismatch ? [skill.id] : [];
  const runtime = {
    scope: scopeReference,
    plugin: plugin.identity.key,
    selectedRevision: revision.revision,
    ...(options.enabled ? { projectionDigest } : {}),
    skillsHooks: { kind: "ready", observation: options.enabled ? {
      kind: "active", participant: "skills-hooks", scope: scopeReference, plugin: plugin.identity.key,
      revision: revision.revision, projectionDigest, currentProject: { projectKey, trust: { kind: options.projectUntrusted ? "untrusted" : "trusted" } },
      contributionDigest: `sha256:${"22".repeat(32)}`, skillComponentIds: skillIds, hookComponentIds: [],
    } : {
      kind: "inactive", participant: "skills-hooks", scope: scopeReference, plugin: plugin.identity.key,
      projectionDigest: `sha256:${"33".repeat(32)}`, currentProject: { projectKey, trust: { kind: options.projectUntrusted ? "untrusted" : "trusted" } },
      contributionDigest: `sha256:${"22".repeat(32)}`, skillComponentIds: [], hookComponentIds: [],
    } },
    mcp: options.remote === undefined
      ? { expected: { kind: "inactive", servers: [] }, status: options.mcpUnavailable ? { kind: "unavailable", code: "RUNTIME_UNAVAILABLE" } : { kind: "ready", status: null } }
      : {
          expected: { kind: "source", registrationDigest: `sha256:${"44".repeat(32)}`, servers: [{ componentId: component.id, serverKey, transport: "stdio" }] },
          status: options.mcpUnavailable ? { kind: "unavailable", code: "RUNTIME_UNAVAILABLE" } : { kind: "ready", status: {
            identity: { schemaVersion: 1, scope: scopeReference, plugin: plugin.identity.key, revision: revision.revision, projectionDigest },
            registrationDigest: `sha256:${"44".repeat(32)}`, state: "registered",
            servers: [{ key: serverKey, componentId: component.id, nativeKey: component.nativeKey.value, provenance: [{ host: "claude", documentKind: "mcp", path: "plugin.mcp.json" }], state: options.remote }],
          } },
        },
  } as never;
  const updateSource = { kind: "github" as const, repository: "owner/market" };
  const marketplaceIdentity = deriveMarketplaceSourceIdentity(updateSource, fixtureSha);
  const pluginIdentity = plugin.source.hash;
  const candidate = deriveUpdateCandidateKey({ scope: scopeReference, plugin: plugin.identity.key, marketplaceSourceIdentity: marketplaceIdentity, pluginSourceIdentity: pluginIdentity, immutableRevision: revision.revision }, fixtureSha);
  const updateRecord = createMarketplaceConfigurationRecord({
    marketplace: "compatibility",
    source: updateSource,
    ...(options.updatePending ? { applicationOverride: "automatic" as const } : {}),
    refresh: options.updateFailed
      ? { lastCompletedAt: 10, lastAttempt: { completedAt: 10, outcome: "failed", code: "SOURCE_UNAVAILABLE" }, schedule: { anchorAt: 10, baseDelayMs: 10, jitterMs: 0, dueAt: 20, reason: "failure" }, consecutiveFailures: 1 }
      : { schedule: { anchorAt: options.updateClockRegressed ? 10 : 0, baseDelayMs: 20, jitterMs: 0, dueAt: options.updateClockRegressed ? 30 : 20, reason: "success" }, consecutiveFailures: 0 },
    notices: options.updatePending ? [{
      id: deriveUpdateNoticeId({ scope: scopeReference, plugin: plugin.identity.key, candidate }, fixtureSha),
      scope: scopeReference,
      plugin: plugin.identity.key,
      registrationId: deriveMarketplaceRegistrationId({ scope: scopeReference, source: updateSource }, fixtureSha),
      snapshot: `marketplace-snapshot-v1:sha256:${"aa".repeat(32)}`,
      candidateId: `marketplace-candidate-v1:sha256:${"bb".repeat(32)}`,
      candidate,
      available: { immutableRevision: revision.revision, marketplaceSourceIdentity: marketplaceIdentity, pluginSourceIdentity: pluginIdentity, sourceRevision: "b".repeat(40) },
      display: { installed: "1.0.0", available: "1.1.0" },
      disposition: "automatic-pending",
      publication: "pending",
      unread: true,
      discoveredAt: 1,
      automatic: { state: "pending", reason: "awaiting-host-context" },
    }] : [],
  });
  const stateSnapshot = options.projectUntrusted
    ? { scope: scopeContext, generation: 0, corruptions: [], project: { scope: {}, plugins: [record], marketplaces: [], marketplaceUpdates: options.updateFailed || options.updatePending ? [updateRecord] : [] } }
    : { scope: scopeContext, generation: 0, corruptions: [], installed: { plugins: [record], marketplaces: [] }, config: { global: { application: "manual", cadence: "balanced" }, scope: {}, records: options.updateFailed || options.updatePending ? [updateRecord] : [] }, trust: { records: [] } };
  const snapshot = {
    binding: { capturedAt: 1, scopes: [{ scope: scopeReference, generation: 0, status: "ready", corruptionCodes: [] }], currentProject: { projectKey, trust: { kind: options.projectUntrusted ? "untrusted" : "trusted" }, epoch: `sha256:${"66".repeat(32)}` }, catalogs: [], capability: { status: "ready", digest: `sha256:${"88".repeat(32)}`, capturedBy: "fixture" }, runtimeEpoch: `sha256:${"99".repeat(32)}`, recoveryDigest: `sha256:${"aa".repeat(32)}`, updateDigest: `sha256:${"bb".repeat(32)}` },
    states: [{ ok: true, snapshot: stateSnapshot }],
    currentProject: { identity: projectIdentity, projectKey, trust: { kind: options.projectUntrusted ? "untrusted" : "trusted" } },
    capabilities: capabilities(), runtime: options.noRuntime ? [] : [runtime], recovery: { results: [], deferred: false, processed: 0 },
    startup: { status: "ready", blocked: [], capabilities: { mcp: { status: "available", explanation: "ready" }, subagents: { status: "unavailable", explanation: "none" }, piReload: { status: "available", explanation: "ready" }, secrets: { status: "available", explanation: "ready" } } },
    ...(options.updatePending ? { hostStatus: { status: "ready", local: { recovery: "settled", runtime: "reconciled" }, update: { state: "running", unreadCount: 1, unresolvedCount: 1, scopes: [] }, blocked: [], capabilities: { mcp: { status: "available", explanation: "ready" }, subagents: { status: "unavailable", explanation: "none" }, piReload: { status: "available", explanation: "ready" }, secrets: { status: "available", explanation: "ready" } } } } : {}),
  } as any;
  const inspector = createNativeInstalledInspector({
    installed: { load: vi.fn(async () => ({ plugin, compatibility: report, marketplaceSource, content, binding: createMaterializationBinding(plugin.source.hash, content.rootDigest, fixtureSha) })) },
    readiness: { trust: vi.fn(async () => options.trust ?? "authorized"), configuration: vi.fn(async () => []), secretCustody: () => ({ status: "available", explanation: "ready" }) },
    sha256: nativeInspectionSha256,
  });
  const subject = { version: 1 as const, subject: "installed" as const, scope: scopeReference, plugin: plugin.identity.key, selectedRevision: revision.revision };
  return { inspector, snapshot, subject, runtime, component, plugin, record, revision };
}
