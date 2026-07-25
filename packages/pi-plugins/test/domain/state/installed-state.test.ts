import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  CompatibilityReportSchema,
  type CompatibilityReport,
} from "../../../src/domain/compatibility.js";
import {
  ContentManifestSchema,
  createContentManifest,
  hashContent,
} from "../../../src/domain/content-manifest.js";
import { NormalizedPluginSchema, type NormalizedPlugin } from "../../../src/domain/plugin.js";
import { createResolvedMarketplaceSource, createResolvedPluginSource } from "../../../src/domain/source.js";
import {
  InstalledPluginRecordSchema,
  InstalledRevisionRecordSchema,
  InstalledUserStateDocumentSchema,
  MarketplaceSnapshotRecordSchema,
  createInstalledPluginRecord,
  createInstalledRevisionRecord,
  createInstalledUserStateDocument,
  createMarketplaceSnapshotRecord,
  decodeInstalledUserPlugins,
  type InstalledPluginRecord,
  type InstalledRevisionRecord,
  type InstalledUserStateDocument,
  type MarketplaceSnapshotRecord,
} from "../../../src/domain/state/installed-state.js";
import {
  derivePluginContentRef,
  PluginContentRefSchema,
} from "../../../src/domain/state/references.js";
import { claim, type Provenance } from "../../../src/domain/provenance.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const location: Provenance = {
  location: { host: "claude", documentKind: "manifest", path: ".claude-plugin/plugin.json", pointer: "" },
};

const pluginSource = createResolvedPluginSource({
  kind: "git",
  url: "https://example.com/demo.git",
  revision: "a".repeat(40),
}, sha256);
const plugin = NormalizedPluginSchema.parse({
  identity: {
    key: "demo@community",
    marketplaceName: "community",
    marketplaceEntryName: "demo",
  },
  version: claim("1.0.0", location),
  source: pluginSource,
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
  path: "README.md",
  mode: 0o644,
  size: 7,
  digest: hashContent(text("content"), sha256),
}], sha256);
const marketplaceSource = createResolvedMarketplaceSource({
  declared: { kind: "github", repository: "example/marketplace" },
  revision: "b".repeat(40),
}, sha256);

const revisionInput = () => ({
  plugin,
  compatibility: report,
  content,
});

function makeRevision(): InstalledRevisionRecord {
  return createInstalledRevisionRecord(revisionInput(), sha256);
}

function makeMarketplace(): MarketplaceSnapshotRecord {
  return createMarketplaceSnapshotRecord({
    marketplace: "community",
    source: marketplaceSource,
    content,
  }, sha256);
}

describe("installed lifecycle state", () => {
  it("reuses canonical source, plugin, report, and manifest contracts", () => {
    const revision = makeRevision();
    expect(InstalledRevisionRecordSchema.parse(revision)).toEqual(revision);
    expect(revision.evidence.plugin).toEqual(plugin.identity);
    expect(revision.evidence.compatibility.activatable).toBe(true);
    expect(revision.evidence.components).toEqual([]);
    expect(revision.contentDigest).toBe(content.rootDigest);
    expect(() => ContentManifestSchema.parse(revision.contentDigest)).toThrow();
    expect(revision.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(PluginContentRefSchema.parse(revision.contentRef)).toBe(revision.contentRef);
  });

  it("derives and verifies the materialization binding and logical refs", () => {
    const revision = makeRevision();
    expect(() => createInstalledRevisionRecord({
      ...revisionInput(),
      revision: "sha256:" + "0".repeat(64),
    }, sha256)).toThrow(/binding/);
    expect(() => createInstalledRevisionRecord({
      ...revisionInput(),
      contentRef: derivePluginContentRef({
        scope: { kind: "user" },
        plugin: "other@community",
        source: plugin.source.canonical,
        sourceHash: plugin.source.hash,
        sourceRevision: plugin.source.kind === "git" || plugin.source.kind === "git-subdir"
        ? plugin.source.revision
        : (() => { throw new Error("test plugin source is not Git-backed"); })(),
        content: content.rootDigest,
        binding: revision.revision,
      }, sha256),
    }, sha256)).toThrow(/reference|identity/i);
    expect(() => createInstalledRevisionRecord({
      ...revisionInput(),
      compatibility: { ...report, plugin: { ...report.plugin, key: "other@community", marketplaceEntryName: "other" } },
    }, sha256)).toThrow(/identity/);
  });

  it("keeps user and project constructor references independent", () => {
    const user = createInstalledPluginRecord({
      plugin: plugin.identity.key,
      activation: "enabled",
      revisions: [revisionInput()],
    }, sha256);
    const projectKey = "project-v1:sha256:" + "2".repeat(64);
    const project = createInstalledPluginRecord({
      plugin: plugin.identity.key,
      activation: "enabled",
      revisions: [{ ...revisionInput(), scope: { kind: "project", projectKey } }],
      scope: { kind: "project", projectKey },
    }, sha256);

    expect(user.selectedRevision).toBe(project.selectedRevision);
    expect(user.revisions[0]!.contentRef).not.toBe(project.revisions[0]!.contentRef);
    expect(user.revisions[0]!.dataRef).not.toBe(project.revisions[0]!.dataRef);
    expect(JSON.stringify(user)).not.toContain("project-v1:");
    expect(JSON.stringify(user)).not.toContain("file:");
  });

  it("canonicalizes revision-set order before lifecycle comparisons", () => {
    const alternatePlugin = NormalizedPluginSchema.parse({
      ...plugin,
      version: claim("2.0.0", location),
      source: createResolvedPluginSource({
        kind: "git",
        url: "https://example.com/demo.git",
        revision: "c".repeat(40),
      }, sha256),
    });
    const alternateReport = CompatibilityReportSchema.parse({ ...report, plugin: alternatePlugin.identity });
    const first = makeRevision();
    const second = createInstalledRevisionRecord({ plugin: alternatePlugin, compatibility: alternateReport, content }, sha256);
    const descending = [first, second].sort((left, right) => right.revision.localeCompare(left.revision));
    const record = createInstalledPluginRecord({
      plugin: plugin.identity.key,
      activation: "enabled",
      selectedRevision: second.revision,
      revisions: descending,
    }, sha256);

    expect(record.revisions.map((revision) => revision.revision)).toEqual(
      [first.revision, second.revision].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    );
  });

  it("builds a complete user envelope and rejects dangling or duplicate selections", () => {
    const document = createInstalledUserStateDocument({
      generation: 4,
      marketplaces: [makeMarketplace()],
      plugins: [{
        plugin: plugin.identity.key,
        activation: "disabled",
        revisions: [revisionInput()],
      }],
    }, sha256);
    expect(document.schemaVersion).toBe(2);
    expect(InstalledUserStateDocumentSchema.parse(document)).toEqual(document);
    expect(document.plugins[0]!.selectedRevision).toBe(document.plugins[0]!.revisions[0]!.revision);
    expect(() => InstalledPluginRecordSchema.parse({
      ...document.plugins[0],
      selectedRevision: "sha256:" + "f".repeat(64),
    })).toThrow(/selected/);
    expect(() => InstalledUserStateDocumentSchema.parse({
      ...document,
      plugins: [document.plugins[0], document.plugins[0]],
    })).toThrow(/duplicate/);
  });

  it("quarantines invalid and duplicate plugin records without using file order", () => {
    const valid = createInstalledPluginRecord({
      plugin: plugin.identity.key,
      activation: "enabled",
      revisions: [revisionInput()],
    }, sha256);
    const result = decodeInstalledUserPlugins([
      valid,
      { ...valid, activation: "invalid" },
      valid,
      { ...valid, plugin: "other@community" },
    ], sha256);

    expect(result.records).toHaveLength(0);
    expect(result.quarantined.filter((entry) => entry.code === "RECORD_DUPLICATE")).toHaveLength(2);
    expect(result.quarantined.some((entry) => entry.code === "RECORD_INVALID")).toBe(true);
    expect(result.quarantined.some((entry) => entry.recordKey === "other@community")).toBe(true);
  });

  it("keeps the state surface free of lifecycle payloads and physical refs", () => {
    const document = createInstalledUserStateDocument({
      generation: 0,
      marketplaces: [makeMarketplace()],
      plugins: [{ plugin: plugin.identity.key, activation: "enabled", revisions: [revisionInput()] }],
    }, sha256);
    const serialized = JSON.stringify(document);
    for (const forbidden of ["operation", "journal", "projection", "reload", "secret", "environment", "/tmp/", "trustDecision"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("derives public types from the schemas", () => {
    expectTypeOf<z.infer<typeof MarketplaceSnapshotRecordSchema>>().toEqualTypeOf<MarketplaceSnapshotRecord>();
    expectTypeOf<z.infer<typeof InstalledRevisionRecordSchema>>().toEqualTypeOf<InstalledRevisionRecord>();
    expectTypeOf<z.infer<typeof InstalledPluginRecordSchema>>().toEqualTypeOf<InstalledPluginRecord>();
    expectTypeOf<z.infer<typeof InstalledUserStateDocumentSchema>>().toEqualTypeOf<InstalledUserStateDocument>();
  });
});
