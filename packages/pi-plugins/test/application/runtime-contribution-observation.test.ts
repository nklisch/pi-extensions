import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { composeActivationObservation } from "../../src/application/ports/lifecycle-reload.js";
import { createActiveProjectionExpectation, createInactiveProjectionExpectation, createPluginRuntimeProjection } from "../../src/application/ports/runtime-projection.js";
import { CompatibilityReportSchema } from "../../src/domain/compatibility.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { createResolvedPluginSource } from "../../src/domain/source.js";
import { createInstalledRevisionRecord } from "../../src/domain/state/installed-state.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const currentProject = {
  identity: { kind: "path-only" as const, canonicalRoot: "file:///workspace/", limitation: "identity-changes-with-canonical-root" as const },
  projectKey: `project-v1:sha256:${"1".repeat(64)}`,
  trust: { kind: "trusted" as const },
};

function fixture() {
  const source = createResolvedPluginSource({ kind: "marketplace-path", marketplaceRevision: "e".repeat(40), path: "./plugin" }, sha256);
  const plugin = NormalizedPluginSchema.parse({ identity: { key: "fixture@community", marketplaceName: "community", marketplaceEntryName: "fixture" }, source, configuration: { options: [] }, components: { skills: [], hooks: [], mcpServers: [], foreign: [] }, metadata: [] });
  const compatibility = CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
  const revision = createInstalledRevisionRecord({ plugin, compatibility, content: createContentManifest([], sha256), scope: { kind: "user" } }, sha256);
  const expectation = createActiveProjectionExpectation(createPluginRuntimeProjection({ scope: { kind: "user" }, plugin, compatibility, revision, sha256 }), sha256);
  return { expectation, plugin: plugin.identity.key };
}

describe("whole-bundle runtime contribution composition", () => {
  it("requires matching independent active contributions", () => {
    const { expectation, plugin } = fixture();
    const base = { scope: { kind: "user" as const }, plugin, revision: expectation.projection.revision, projectionDigest: expectation.projection.digest, currentProject, contributionDigest: `sha256:${"a".repeat(64)}` };
    const skillsHooks = { ...base, kind: "active" as const, participant: "skills-hooks" as const, skillComponentIds: [], hookComponentIds: [] };
    const mcp = { ...base, kind: "active" as const, participant: "mcp" as const, contributionDigest: `sha256:${"b".repeat(64)}`, registration: { kind: "none" as const } };
    expect(composeActivationObservation({ expectation, skillsHooks, mcp })).toMatchObject({ kind: "active", projectionDigest: expectation.projection.digest });
    expect(() => composeActivationObservation({ expectation, skillsHooks, mcp: { ...mcp, projectionDigest: `sha256:${"c".repeat(64)}` } })).toThrow();
    expect(() => composeActivationObservation({ expectation, skillsHooks, mcp: { ...mcp, participant: "skills-hooks" as const } })).toThrow();
    expect(() => composeActivationObservation({
      expectation,
      skillsHooks,
      mcp: { ...mcp, registration: undefined } as never,
    })).toThrow();
  });

  it("requires exact inactive tombstone evidence from both participants", () => {
    const { plugin } = fixture();
    const expectation = createInactiveProjectionExpectation({ scope: { kind: "user" }, plugin, sha256 });
    const skillsHooks = { kind: "inactive" as const, participant: "skills-hooks" as const, scope: expectation.scope, plugin, projectionDigest: expectation.digest, currentProject, contributionDigest: `sha256:${"1".repeat(64)}`, skillComponentIds: [] as [], hookComponentIds: [] as [] };
    const mcp = { kind: "inactive" as const, participant: "mcp" as const, scope: expectation.scope, plugin, projectionDigest: expectation.digest, currentProject, contributionDigest: `sha256:${"2".repeat(64)}`, registration: { kind: "none" as const } };
    expect(composeActivationObservation({ expectation, skillsHooks, mcp })).toMatchObject({ kind: "inactive", projectionDigest: expectation.digest });
    expect(() => composeActivationObservation({ expectation, skillsHooks, mcp: { ...mcp, projectionDigest: `sha256:${"3".repeat(64)}` } })).toThrow();
  });
});