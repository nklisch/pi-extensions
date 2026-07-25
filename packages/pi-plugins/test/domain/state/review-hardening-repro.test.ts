import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { claim, type Provenance } from "../../../src/domain/provenance.js";
import { CompatibilityReportSchema } from "../../../src/domain/compatibility.js";
import { ContentDigestSchema } from "../../../src/domain/content-manifest.js";
import { createContentManifest, hashContent } from "../../../src/domain/content-manifest.js";
import { NormalizedPluginSchema } from "../../../src/domain/plugin.js";
import { JsonValueSchema } from "../../../src/domain/schema.js";
import { createResolvedPluginSource, MarketplaceSourceSchema } from "../../../src/domain/source.js";
import {
  createInstalledRevisionRecord,
} from "../../../src/domain/state/installed-state.js";
import {
  StateCodecError,
  StateCorruptionSchema,
  decodeStateDocument,
  encodeStateDocument,
  hashStateDocument,
} from "../../../src/domain/state/codec.js";
import { GenerationSchema, HostConfigDocumentSchema } from "../../../src/domain/state/config-state.js";
import { createMarketplaceConfigurationRecord } from "../../../src/domain/update-policy.js";
import { MarketplaceNameSchema } from "../../../src/domain/identity.js";
import { parseStateMutation } from "../../../src/application/state-contract.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const location: Provenance = {
  location: { host: "claude", documentKind: "manifest", path: ".claude-plugin/plugin.json", pointer: "" },
};
const source = createResolvedPluginSource({ kind: "git", url: "https://example.com/demo.git", revision: "a".repeat(40) }, sha256);
const content = createContentManifest([{ kind: "file", path: "README.md", mode: 0o644, size: 7, digest: hashContent(new TextEncoder().encode("content"), sha256) }], sha256);
const componentId = `component-v1:foreign:${"0".repeat(64)}`;
const plugin = NormalizedPluginSchema.parse({
  identity: { key: "demo@team", marketplaceName: "team", marketplaceEntryName: "demo" },
  source,
  configuration: { options: [] },
  components: {
    skills: [],
    hooks: [],
    mcpServers: [],
    foreign: [{
      kind: "foreign",
      id: componentId,
      nativeHost: "claude",
      nativeKind: claim("mcp", location),
      declarationSubkey: "server",
      declaration: claim({ authorization: "CANARY_SECRET_VALUE", projectionPath: "/tmp/projection", env: { NODE_ENV: "production" } }, location),
    }],
  },
  metadata: [],
});
const report = CompatibilityReportSchema.parse({
  plugin: plugin.identity,
  activatable: true,
  components: [{ componentId, verdict: { kind: "supported" }, requirementIds: [], diagnostics: [] }],
  requirements: [],
  diagnostics: [],
});
const revisionInput = { plugin, compatibility: report, content };
const context = { scope: { kind: "user" as const }, generation: GenerationSchema.parse(0), sha256 };
const sourceRecord = createMarketplaceConfigurationRecord({
  marketplace: MarketplaceNameSchema.parse("team"),
  source: MarketplaceSourceSchema.parse({ kind: "github", repository: "example/plugins" }),
});
const validConfig = HostConfigDocumentSchema.parse({ schemaVersion: 4, generation: 0, records: [sourceRecord] });

function rawConfig(records: unknown[]) {
  return {
    schemaVersion: 4,
    generation: 0,
    global: { application: "manual", cadence: "balanced" },
    scope: {},
    records,
  };
}

describe("review hardening regressions", () => {
  it("persists only a strict evidence summary, never normalized declarations", () => {
    const record = createInstalledRevisionRecord(revisionInput, sha256);
    const serialized = JSON.stringify(record);
    expect(record).not.toHaveProperty("plugin");
    expect(record).not.toHaveProperty("compatibility");
    expect(record).not.toHaveProperty("content");
    for (const canary of ["CANARY_SECRET_VALUE", "authorization", "projectionPath", "NODE_ENV", "/tmp/projection"]) {
      expect(serialized).not.toContain(canary);
    }
    expect(serialized).toContain("executableSurfaceDigest");
    expect(serialized).toContain("plugin-content-v1:sha256:");
  });

  it("verifies the exact raw digest before isolating identifiable siblings", () => {
    const raw = rawConfig([sourceRecord, { marketplace: "bad", sourceRecord: true }]) as const;
    const rawDigest = hashStateDocument(JsonValueSchema.parse(raw), sha256);
    const decoded = decodeStateDocument("hostConfig", raw, { ...context, expectedDigest: rawDigest });
    expect(decoded.value.records).toHaveLength(1);
    expect(decoded.corruptions).toHaveLength(1);

    const cleaned = encodeStateDocument("hostConfig", validConfig, context);
    const cleanedDigest = hashStateDocument(cleaned, sha256);
    expect(() => decodeStateDocument("hostConfig", raw, { ...context, expectedDigest: ContentDigestSchema.parse(cleanedDigest) }))
      .toThrowError(StateCodecError);
  });

  it("requires a verifier on every public mutation parse", () => {
    const mutation = { scope: { kind: "user" }, expectedGeneration: 0, replace: { config: validConfig } };
    const parseWithoutVerifier = parseStateMutation as unknown as (input: unknown) => unknown;
    expect(() => parseWithoutVerifier(mutation)).toThrow(/SHA-256 verifier/);
    expect(parseStateMutation(mutation, sha256).expectedGeneration).toBe(0);
  });

  it("fails the smallest document for an unidentifiable record but isolates a bad sibling", () => {
    const raw = rawConfig([sourceRecord, { source: sourceRecord.source }]);
    expect(() => decodeStateDocument("hostConfig", raw, context)).toThrowError(StateCodecError);

    const identifiableCorruption = rawConfig([sourceRecord, { marketplace: "other", source: sourceRecord.source, updateApplication: "broken" }]);
    const decoded = decodeStateDocument("hostConfig", identifiableCorruption, context);
    expect(decoded.value.records.map((record) => record.marketplace)).toEqual(["team"]);
    expect(decoded.corruptions).toHaveLength(1);
  });

  it("uses a fixed, registry-driven corruption projection", () => {
    expect(() => StateCorruptionSchema.parse({
      document: "hostConfig",
      scope: { kind: "user" },
      code: "RECORD_INVALID",
      schemaPath: "/tmp/secret",
      message: "CANARY_SECRET_VALUE native cause",
    })).toThrow();

    const safe = StateCorruptionSchema.parse({
      document: "hostConfig",
      scope: { kind: "user" },
      code: "RECORD_INVALID",
      location: { kind: "pointer", value: "/records/0" },
      summary: "state record was quarantined",
    });
    expect(JSON.stringify(safe)).not.toContain("CANARY_SECRET_VALUE");
    expect(JSON.stringify(safe)).not.toContain("/tmp");
    expect(JSON.stringify(safe)).not.toContain("native cause");
  });
});
