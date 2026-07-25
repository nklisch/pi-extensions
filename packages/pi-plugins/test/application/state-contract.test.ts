import { describe, expect, it } from "vitest";
import {
  StateMutationInputSchema,
  isVerifiedStateMutation,
  parseStateMutation,
} from "../../src/application/state-contract.js";
import { HostConfigDocumentSchema } from "../../src/domain/state/config-state.js";
import { createMarketplaceConfigurationRecord } from "../../src/domain/update-policy.js";
import { MarketplaceNameSchema } from "../../src/domain/identity.js";
import {
  MarketplaceSourceSchema,
  PluginSourceSchema,
  serializeMarketplaceSource,
  serializePluginSource,
} from "../../src/domain/source.js";

const source = MarketplaceSourceSchema.parse({ kind: "github", repository: "example/plugins" });
const config = HostConfigDocumentSchema.parse({
  schemaVersion: 4,
  generation: 2,
  records: [createMarketplaceConfigurationRecord({
    marketplace: MarketplaceNameSchema.parse("team"),
    source,
  })],
});
const sha256 = () => new Uint8Array(32);

describe("lifecycle state application contracts", () => {
  it("requires a non-empty expected-generation replacement", () => {
    expect(StateMutationInputSchema.safeParse({
      scope: { kind: "user" },
      expectedGeneration: 2,
      replace: {},
    }).success).toBe(false);
    expect(StateMutationInputSchema.safeParse({
      scope: { kind: "user" },
      expectedGeneration: 2,
      replace: { config, nextGeneration: 3 },
    }).success).toBe(false);
    expect(StateMutationInputSchema.safeParse({
      scope: { kind: "user" },
      expectedGeneration: 1,
      replace: { config },
    }).success).toBe(false);
  });

  it("returns a verified replacement and keeps adapter concerns outside the contract", () => {
    const mutation = parseStateMutation({
      scope: { kind: "user" },
      expectedGeneration: 2,
      replace: { config },
    }, sha256);
    expect(mutation.expectedGeneration).toBe(2);
    expect(isVerifiedStateMutation(mutation)).toBe(true);
    expect(Object.isFrozen(mutation)).toBe(true);
    expect(Object.isFrozen(mutation.replace)).toBe(true);
    expect(isVerifiedStateMutation({ ...mutation })).toBe(false);
    expect(mutation.replace).toHaveProperty("config");
    expect(mutation.replace.config.records[0]).toMatchObject({
      refresh: { consecutiveFailures: 0 },
      notices: [],
    });
    expect(mutation).not.toHaveProperty("transaction");
    expect(mutation).not.toHaveProperty("path");
    expect(mutation).not.toHaveProperty("lock");
  });

  it("lets structural parsing accept shape but rejects forged trust evidence at verification", () => {
    const pluginSource = PluginSourceSchema.parse({
      kind: "git",
      url: "https://example.com/demo.git",
    });
    const forgedTrust = {
      schemaVersion: 1,
      generation: 2,
      records: [{
        subject: `trust-subject-v1:sha256:${"ff".repeat(32)}`,
        evidence: {
          plugin: "demo@team",
          scope: { kind: "user" },
          marketplaceSource: serializeMarketplaceSource(source),
          pluginSource: serializePluginSource(pluginSource),
          immutableRevision: "a".repeat(40),
          executableSurfaceDigest: `sha256:${"00".repeat(32)}`,
        },
        status: "granted",
      }],
    };
    const structural = StateMutationInputSchema.parse({
      scope: { kind: "user" },
      expectedGeneration: 2,
      replace: { trust: forgedTrust },
    });
    expect(isVerifiedStateMutation(structural)).toBe(false);
    expect(() => parseStateMutation(structural, sha256)).toThrow();
  });
});
