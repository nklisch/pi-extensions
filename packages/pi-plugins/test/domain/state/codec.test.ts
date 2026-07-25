import { describe, expect, it } from "vitest";
import {
  StateCodecError,
  StateVersionCutoverError,
  decodeStateDocument,
  encodeStateDocument,
  hashStateDocument,
} from "../../../src/domain/state/codec.js";
import { ContentDigestSchema } from "../../../src/domain/content-manifest.js";
import { GenerationSchema, HostConfigDocumentSchema } from "../../../src/domain/state/config-state.js";
import { createMarketplaceConfigurationRecord } from "../../../src/domain/update-policy.js";
import { MarketplaceNameSchema } from "../../../src/domain/identity.js";
import { MarketplaceSourceSchema } from "../../../src/domain/source.js";

const sha256 = () => new Uint8Array(32);
const marketplace = MarketplaceNameSchema.parse("team");
const source = MarketplaceSourceSchema.parse({ kind: "github", repository: "example/plugins" });
const context = {
  scope: { kind: "user" as const },
  generation: GenerationSchema.parse(0),
  sha256,
};
const validRecord = createMarketplaceConfigurationRecord({ marketplace, source });
const valid = HostConfigDocumentSchema.parse({
  schemaVersion: 4,
  generation: 0,
  records: [validRecord],
});

function encodedWith(records: unknown[]) {
  return {
    schemaVersion: 4,
    generation: 0,
    global: { application: "manual", cadence: "balanced" },
    scope: {},
    records,
  };
}

describe("state codecs", () => {
  it("isolates corrupt and duplicate records while retaining valid siblings", () => {
    const decoded = decodeStateDocument("hostConfig", encodedWith([
      validRecord,
      { ...validRecord, marketplace: "other", unexpected: true },
      validRecord,
    ]), context);

    expect(decoded.value.records).toHaveLength(0);
    expect(decoded.corruptions.map((entry) => entry.code)).toEqual([
      "RECORD_DUPLICATE",
      "RECORD_INVALID",
      "RECORD_DUPLICATE",
    ]);
    expect(decoded.corruptions[0]).not.toHaveProperty("value");
    expect(decoded.corruptions[0]?.summary).not.toContain("unexpected");
  });

  it("keeps valid siblings when one record is malformed", () => {
    const decoded = decodeStateDocument("hostConfig", encodedWith([
      validRecord,
      { marketplace: "other", source, updateApplication: "not-a-preference" },
    ]), context);
    expect(decoded.value.records.map((record) => record.marketplace)).toEqual([marketplace]);
    expect(decoded.corruptions).toHaveLength(1);
  });

  it("cuts a stale or unknown host document version over to the empty default, never corruption", () => {
    for (const schemaVersion of [1, 3, 99]) {
      const decoded = decodeStateDocument("hostConfig", { ...encodedWith([validRecord]), schemaVersion }, context);
      expect(decoded.value).toEqual(HostConfigDocumentSchema.parse({ schemaVersion: 4, generation: 0, records: [] }));
      expect(decoded.corruptions).toEqual([]);
    }
  });

  it("cuts stale installed, trust, and portable documents over to their empty defaults", () => {
    const installed = decodeStateDocument("installedUser", {
      schemaVersion: 1,
      generation: 0,
      marketplaces: [],
      plugins: [{ plugin: "stale@team" }],
    }, context);
    expect(installed.value).toEqual({ schemaVersion: 2, generation: 0, marketplaces: [], plugins: [] });
    expect(installed.corruptions).toEqual([]);

    const trust = decodeStateDocument("trust", { schemaVersion: 7, generation: 0, records: [] }, context);
    expect(trust.value).toEqual({ schemaVersion: 1, generation: 0, records: [] });
    expect(trust.corruptions).toEqual([]);

    const portable = decodeStateDocument("portableProject", {
      schemaVersion: 2,
      marketplaces: [{ marketplace: "stale" }],
      plugins: [],
    }, context);
    expect(portable.value).toEqual({ schemaVersion: 1, marketplaces: [], plugins: [] });
    expect(portable.corruptions).toEqual([]);
  });

  it("cuts a stale project document over to empty defaults bound to the requested scope", () => {
    const projectContext = {
      scope: {
        kind: "project" as const,
        identity: {
          kind: "path-only" as const,
          canonicalRoot: "file:///workspace/project/" as never,
          limitation: "identity-changes-with-canonical-root" as const,
        },
        projectKey: `project-v1:sha256:${"0".repeat(64)}` as never,
      },
      generation: GenerationSchema.parse(3),
      sha256,
    };
    const decoded = decodeStateDocument("projectLocal", {
      schemaVersion: 3,
      generation: 3,
      projectKey: "project-v1:sha256:ignored",
      marketplaces: [],
      plugins: [],
    }, projectContext);
    expect(decoded.value).toMatchObject({
      schemaVersion: 4,
      generation: 3,
      marketplaces: [],
      plugins: [],
      marketplaceUpdates: [],
    });
    expect(decoded.corruptions).toEqual([]);
  });

  it("signals a scope reinitialization, not corruption, for a stale pointers version", () => {
    expect(() => decodeStateDocument("pointers", {
      schemaVersion: 2,
      scope: { kind: "user" },
      generation: 0,
      documents: [],
    }, context)).toThrowError(StateVersionCutoverError);
  });

  it("still fails closed for malformed, generation-mismatched, and digest-mismatched documents", () => {
    expect(() => decodeStateDocument("hostConfig", { generation: 0, records: [] }, context))
      .toThrowError(StateCodecError);
    expect(() => decodeStateDocument("hostConfig", { ...encodedWith([]), generation: 1 }, context))
      .toThrowError(StateCodecError);

    const encoded = encodeStateDocument("hostConfig", valid, context);
    const digest = hashStateDocument(encoded, sha256);
    expect(decodeStateDocument("hostConfig", encoded, { ...context, expectedDigest: digest }).value).toMatchObject({
      schemaVersion: 4,
      generation: valid.generation,
      global: { application: "manual", cadence: "balanced" },
      records: [{ marketplace }],
    });
    expect(() => decodeStateDocument("hostConfig", encoded, {
      ...context,
      expectedDigest: ContentDigestSchema.parse(`sha256:${"ff".repeat(32)}`),
    })).toThrowError(StateCodecError);
  });

  it("writes current-valid documents in deterministic keyed order", () => {
    const other = createMarketplaceConfigurationRecord({
      marketplace: MarketplaceNameSchema.parse("alpha"),
      source: MarketplaceSourceSchema.parse({ kind: "github", repository: "example/alpha" }),
    });
    const left = encodeStateDocument("hostConfig", { ...valid, records: [validRecord, other] }, context);
    const right = encodeStateDocument("hostConfig", { ...valid, records: [other, validRecord] }, context);
    expect(left).toEqual(right);
    expect(JSON.stringify(left)).toContain("alpha");
    expect(JSON.stringify(left).indexOf("alpha")).toBeLessThan(JSON.stringify(left).indexOf("team"));
  });
});
