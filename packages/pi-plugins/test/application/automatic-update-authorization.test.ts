import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeAutomaticUpdateCandidate } from "../../src/application/automatic-update-authorization.js";
import { createContentManifest, createMaterializationBinding } from "../../src/domain/content-manifest.js";
import { CompatibilityReportSchema } from "../../src/domain/compatibility.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import {
  createResolvedMarketplaceSource,
  createResolvedPluginSource,
} from "../../src/domain/source.js";
import {
  createInstalledRevisionRecord,
  type InstalledRevisionRecord,
} from "../../src/domain/state/installed-state.js";
import {
  createMarketplaceConfigurationRecord,
  deriveMarketplaceSourceIdentity,
  derivePluginSourceIdentity,
} from "../../src/domain/update-policy.js";
import { createTrustCandidate, grantTrust } from "../../src/domain/trust-policy.js";
import { deriveProjectKey } from "../../src/domain/state/scope.js";
import type { LoadedInstalledPlugin } from "../../src/application/ports/installed-plugin-loader.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const declaredMarketplace = { kind: "github" as const, repository: "example/community" };
const revision = "a".repeat(40);
const declaredPluginSource = { kind: "marketplace-path" as const, path: "plugin" };
const pluginSource = createResolvedPluginSource({ kind: "marketplace-path", marketplaceRevision: revision, path: "plugin" }, sha256);
const marketplaceSource = createResolvedMarketplaceSource({ declared: declaredMarketplace, revision }, sha256);
const plugin = NormalizedPluginSchema.parse({
  identity: { key: "demo@community", marketplaceName: "community", marketplaceEntryName: "demo" },
  source: pluginSource,
  configuration: { options: [] },
  components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
  metadata: [],
});
const compatibility = CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
const content = createContentManifest([], sha256);
const binding = createMaterializationBinding(pluginSource.hash, content.rootDigest, sha256);
const loaded: LoadedInstalledPlugin = { plugin, compatibility, marketplaceSource, content, binding };
const previousRecord: InstalledRevisionRecord = createInstalledRevisionRecord({
  plugin,
  compatibility,
  content,
  scope: { kind: "user" },
  marketplaceSourceIdentity: deriveMarketplaceSourceIdentity(declaredMarketplace, sha256),
  pluginSourceIdentity: derivePluginSourceIdentity(declaredPluginSource, sha256),
}, sha256);
const policy = createMarketplaceConfigurationRecord({ marketplace: "community", source: declaredMarketplace, applicationOverride: "automatic" });
const candidate = createTrustCandidate({ scope: { kind: "user" }, marketplaceSource, plugin, compatibility, content, materializationBinding: binding }, sha256);
const trust = grantTrust(candidate, sha256);
const projectIdentity = { kind: "path-only" as const, canonicalRoot: "file:///workspace/project/", limitation: "identity-changes-with-canonical-root" as const };
const projectScope = { kind: "project" as const, identity: projectIdentity, projectKey: deriveProjectKey(projectIdentity, sha256) };
const projectRecord = createInstalledRevisionRecord({
  plugin,
  compatibility,
  content,
  scope: { kind: "project", projectKey: projectScope.projectKey },
  marketplaceSourceIdentity: deriveMarketplaceSourceIdentity(declaredMarketplace, sha256),
  pluginSourceIdentity: derivePluginSourceIdentity(declaredPluginSource, sha256),
}, sha256);
const projectLoaded: LoadedInstalledPlugin = { ...loaded };
const projectCandidate = createTrustCandidate({ scope: { kind: "project", projectKey: projectScope.projectKey }, marketplaceSource, plugin, compatibility, content, materializationBinding: binding }, sha256);
const projectTrust = grantTrust(projectCandidate, sha256);

function request(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    scope: { kind: "user" as const },
    previous: loaded,
    previousRecord,
    candidate,
    candidateMarketplaceSourceIdentity: deriveMarketplaceSourceIdentity(declaredMarketplace, sha256),
    candidatePluginSourceIdentity: derivePluginSourceIdentity(declaredPluginSource, sha256),
    expectedRevision: previousRecord.revision,
    policyRecord: policy,
    trustRecords: [trust],
    ...overrides,
  };
}

describe("automatic update authority", () => {
  it("requires current manual policy and unchanged source identities", async () => {
    const manual = await authorizeAutomaticUpdateCandidate({ ...request(), policyRecord: { ...policy, applicationOverride: "manual" } }, { projectTrust: { async assess() { return { kind: "trusted" as const }; } }, sha256 }, new AbortController().signal);
    expect(manual).toEqual({ kind: "denied", code: "POLICY_MANUAL" });

    const changed = await authorizeAutomaticUpdateCandidate({ ...request(), candidateMarketplaceSourceIdentity: deriveMarketplaceSourceIdentity({ kind: "github", repository: "other/community" }, sha256) }, { projectTrust: { async assess() { return { kind: "trusted" as const }; } }, sha256 }, new AbortController().signal);
    expect(changed).toEqual({ kind: "denied", code: "MARKETPLACE_SOURCE_CHANGED" });
  });

  it("denies an untrusted project even with a valid user-like baseline", async () => {
    const denied = await authorizeAutomaticUpdateCandidate({
      scope: projectScope,
      previous: projectLoaded,
      previousRecord: projectRecord,
      candidate: projectCandidate,
      candidateMarketplaceSourceIdentity: deriveMarketplaceSourceIdentity(declaredMarketplace, sha256),
      candidatePluginSourceIdentity: derivePluginSourceIdentity(declaredPluginSource, sha256),
      expectedRevision: projectRecord.revision,
      policyRecord: policy,
      trustRecords: [projectTrust],
      projectDeclarationDigest: content.rootDigest,
    }, { projectTrust: { async assess() { return { kind: "untrusted" as const }; } }, sha256 }, new AbortController().signal);
    expect(denied).toEqual({ kind: "denied", code: "PROJECT_UNTRUSTED" });
  });

  it("requires the exact baseline trust record and never treats missing trust as approval", async () => {
    const denied = await authorizeAutomaticUpdateCandidate(request({ trustRecords: [] }), { projectTrust: { async assess() { return { kind: "trusted" as const }; } }, sha256 }, new AbortController().signal);
    expect(denied).toEqual({ kind: "denied", code: "BASELINE_TRUST_ABSENT" });

    const authorized = await authorizeAutomaticUpdateCandidate(request(), { projectTrust: { async assess() { return { kind: "trusted" as const }; } }, sha256 }, new AbortController().signal);
    expect(authorized.kind).toBe("authorized");
  });
});
