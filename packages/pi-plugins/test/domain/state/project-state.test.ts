import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { CompatibilityReportSchema, type CompatibilityReport } from "../../../src/domain/compatibility.js";
import { createContentManifest, hashContent } from "../../../src/domain/content-manifest.js";
import { NormalizedPluginSchema } from "../../../src/domain/plugin.js";
import { createResolvedMarketplaceSource, createResolvedPluginSource } from "../../../src/domain/source.js";
import { claim, type Provenance } from "../../../src/domain/provenance.js";
import {
  CanonicalProjectRootSchema,
  ProjectIdentitySchema,
  deriveProjectKey,
  type ScopeContext,
} from "../../../src/domain/state/scope.js";
import { createMarketplaceConfigurationRecord } from "../../../src/domain/update-policy.js";
import {
  ProjectLocalStateDocumentSchema,
  createProjectLocalStateDocument,
  decodeProjectPlugins,
  type ProjectLocalStateDocument,
} from "../../../src/domain/state/project-state.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const location: Provenance = {
  location: { host: "claude", documentKind: "manifest", path: ".claude-plugin/plugin.json", pointer: "" },
};
const source = createResolvedPluginSource({
  kind: "marketplace-path",
  marketplaceRevision: "d".repeat(40),
  path: "./plugin",
}, sha256);
const plugin = NormalizedPluginSchema.parse({
  identity: { key: "demo@community", marketplaceName: "community", marketplaceEntryName: "demo" },
  version: claim("2.0.0", location),
  source,
  configuration: { options: [] },
  components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
  metadata: [],
});
const report: CompatibilityReport = CompatibilityReportSchema.parse({
  plugin: plugin.identity,
  activatable: true,
  components: [],
  requirements: [],
  diagnostics: [],
});
const content = createContentManifest([{
  kind: "file",
  path: "plugin.txt",
  mode: 0o644,
  size: 7,
  digest: hashContent(text("project"), sha256),
}], sha256);
const identity = ProjectIdentitySchema.parse({
  kind: "repository",
  canonicalRoot: CanonicalProjectRootSchema.parse("file:///home/example/project/"),
  repositoryFingerprint: "sha256:" + "9".repeat(64),
});
const projectKey = deriveProjectKey(identity, sha256);
const context: ScopeContext = {
  kind: "project",
  identity,
  projectKey,
};
const pluginInput = {
  plugin: plugin.identity.key,
  activation: "enabled" as const,
  revisions: [{ plugin, compatibility: report, content }],
};
const marketplaceInput = {
  marketplace: "community",
  source: createResolvedMarketplaceSource({
    declared: { kind: "github" as const, repository: "example/marketplace" },
    revision: "d".repeat(40),
  }, sha256),
  content,
};

describe("project-local lifecycle state", () => {
  it("binds the document to the verified context and declaration digest", () => {
    const document = createProjectLocalStateDocument({
      generation: 2,
      projectKey,
      identity,
      declarationDigest: content.rootDigest,
      marketplaces: [marketplaceInput],
      plugins: [pluginInput],
    }, context as Extract<ScopeContext, { kind: "project" }>, sha256);

    expect(ProjectLocalStateDocumentSchema.parse(document)).toEqual(document);
    expect(document.schemaVersion).toBe(4);
    expect(document.projectKey).toBe(projectKey);
    expect(document.identity).toEqual(identity);
    expect(document.plugins[0]!.revisions[0]!.dataRef).toContain("plugin-data-v1:");
    expect(JSON.stringify(document)).toContain(projectKey);
  });

  it("rejects a mismatched key, identity, or malformed context before records are built", () => {
    expect(() => createProjectLocalStateDocument({
      generation: 0,
      projectKey: "project-v1:sha256:" + "0".repeat(64),
      identity,
      declarationDigest: content.rootDigest,
      marketplaces: [marketplaceInput],
      plugins: [pluginInput],
    }, context as Extract<ScopeContext, { kind: "project" }>, sha256)).toThrow(/project key|scope context/i);

    expect(() => createProjectLocalStateDocument({
      generation: 0,
      projectKey,
      identity: { ...identity, kind: "path-only", limitation: "identity-changes-with-canonical-root" },
      declarationDigest: content.rootDigest,
      marketplaces: [marketplaceInput],
      plugins: [pluginInput],
    }, context as Extract<ScopeContext, { kind: "project" }>, sha256)).toThrow(/identity/);

    expect(() => createProjectLocalStateDocument({
      generation: 0,
      projectKey,
      identity,
      declarationDigest: content.rootDigest,
      marketplaces: [marketplaceInput],
      plugins: [{ ...pluginInput, plugin: "other@community" }],
    }, context as Extract<ScopeContext, { kind: "project" }>, sha256)).toThrow();
  });

  it("does not share project data references with user records", async () => {
    const project = createProjectLocalStateDocument({
      generation: 0,
      projectKey,
      identity,
      declarationDigest: content.rootDigest,
      marketplaces: [marketplaceInput],
      plugins: [pluginInput],
    }, context as Extract<ScopeContext, { kind: "project" }>, sha256);
    const { createInstalledUserStateDocument } = await import("../../../src/domain/state/installed-state.js");
    const user = createInstalledUserStateDocument({
      generation: 0,
      marketplaces: [{ marketplace: "community", source: marketplaceInput.source, content }],
      plugins: [pluginInput],
    }, sha256);

    expect(project.plugins[0]!.revisions[0]!.dataRef).not.toBe(user.plugins[0]!.revisions[0]!.dataRef);
    expect(project.plugins[0]!.revisions[0]!.contentRef).not.toBe(user.plugins[0]!.revisions[0]!.contentRef);
  });

  it("quarantines invalid and duplicate project plugins", () => {
    const result = decodeProjectPlugins([
      pluginInput,
      pluginInput,
      { ...pluginInput, activation: "invalid" },
    ], context as Extract<ScopeContext, { kind: "project" }>, sha256);
    expect(result.records).toHaveLength(0);
    expect(result.quarantined.filter((entry) => entry.code === "RECORD_DUPLICATE")).toHaveLength(2);
    expect(result.quarantined.some((entry) => entry.code === "RECORD_INVALID")).toBe(true);
  });

  it("allows project-scoped plugins to reference the host-global marketplace registry", () => {
    const document = createProjectLocalStateDocument({
      schemaVersion: 4,
      generation: 3,
      projectKey,
      identity,
      declarationDigest: content.rootDigest,
      scope: {},
      marketplaces: [],
      plugins: [{ ...pluginInput, pendingTransition: `pending-transition-v1:sha256:${"a".repeat(64)}` }],
      marketplaceUpdates: [],
    }, context as Extract<ScopeContext, { kind: "project" }>, sha256);

    expect(document.plugins).toHaveLength(1);
    expect(document.marketplaces).toEqual([]);
  });

  it("preserves validated v4 marketplace registration memory through the constructor", () => {
    const updateRecord = createMarketplaceConfigurationRecord({
      marketplace: "community",
      source: marketplaceInput.source.declared,
    });
    const document = createProjectLocalStateDocument({
      schemaVersion: 4,
      generation: 3,
      projectKey,
      identity,
      declarationDigest: content.rootDigest,
      scope: {},
      marketplaces: [marketplaceInput],
      plugins: [],
      marketplaceUpdates: [updateRecord],
    }, context as Extract<ScopeContext, { kind: "project" }>, sha256);

    expect(document.marketplaceUpdates).toEqual([updateRecord]);
  });

  it("keeps the single current schema strict and schema-derived", () => {
    expect(ProjectLocalStateDocumentSchema.safeParse({
      schemaVersion: 4,
      generation: 0,
      projectKey,
      identity,
      declarationDigest: content.rootDigest,
      marketplaces: [],
      plugins: [],
      marketplaceUpdates: [],
      operation: { kind: "install" },
    }).success).toBe(false);
    expect(ProjectLocalStateDocumentSchema.safeParse({
      schemaVersion: 3,
      generation: 0,
      projectKey,
      identity,
      declarationDigest: content.rootDigest,
      marketplaces: [],
      plugins: [],
      marketplaceUpdates: [],
    }).success).toBe(false);
    expectTypeOf<z.infer<typeof ProjectLocalStateDocumentSchema>>().toEqualTypeOf<ProjectLocalStateDocument>();
  });
});
