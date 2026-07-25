import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  GenerationSchema,
  HostConfigDocumentSchema,
  MarketplaceConfigurationRecordSchema,
  UpdateApplicationPreferenceSchema,
  type HostConfigDocument,
} from "../../../src/domain/state/config-state.js";
import { createMarketplaceConfigurationRecord } from "../../../src/domain/update-policy.js";
import { MarketplaceNameSchema } from "../../../src/domain/identity.js";
import { MarketplaceSourceSchema } from "../../../src/domain/source.js";

const marketplace = MarketplaceNameSchema.parse("team");
const remoteSource = MarketplaceSourceSchema.parse({ kind: "github", repository: "example/plugins" });

function record(overrides: Record<string, unknown> = {}) {
  return { ...createMarketplaceConfigurationRecord({ marketplace, source: remoteSource }), ...overrides };
}

function document(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 4,
    generation: 0,
    global: { application: "manual", cadence: "balanced" },
    scope: {},
    records: [record()],
    ...overrides,
  };
}

describe("host marketplace configuration state", () => {
  it("parses the single current document schema and applies policy defaults", () => {
    const parsed = HostConfigDocumentSchema.parse({ schemaVersion: 4, generation: 3, records: [record()] });
    expect(parsed.schemaVersion).toBe(4);
    expect(parsed.generation).toBe(3);
    expect(parsed.global).toEqual({ application: "manual", cadence: "balanced", resolution: { hostPrecedence: ["claude", "codex"] } });
    expect(parsed.scope).toEqual({});
    expect(parsed.records[0]?.marketplace).toBe(marketplace);
    expect(UpdateApplicationPreferenceSchema.parse("manual")).toBe("manual");
    expect(GenerationSchema.parse(0)).toBe(0);
  });

  it("decodes documents without a resolution block to the Claude-first default", () => {
    const parsed = HostConfigDocumentSchema.parse({
      schemaVersion: 4,
      generation: 1,
      global: { application: "automatic", cadence: "frequent" },
      scope: {},
      records: [],
    });
    expect(parsed.global.resolution.hostPrecedence).toEqual(["claude", "codex"]);
  });

  it("round-trips a codex-first resolution preference", () => {
    const parsed = HostConfigDocumentSchema.parse({
      schemaVersion: 4,
      generation: 2,
      global: { application: "manual", cadence: "balanced", resolution: { hostPrecedence: ["codex", "claude"] } },
      scope: {},
      records: [],
    });
    expect(parsed.global.resolution.hostPrecedence).toEqual(["codex", "claude"]);
    expect(HostConfigDocumentSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("rejects malformed resolution preferences", () => {
    expect(HostConfigDocumentSchema.safeParse({
      schemaVersion: 4,
      generation: 2,
      global: { application: "manual", cadence: "balanced", resolution: { hostPrecedence: ["claude", "claude"] } },
      scope: {},
      records: [],
    }).success).toBe(false);
    expect(HostConfigDocumentSchema.safeParse({
      schemaVersion: 4,
      generation: 2,
      global: { application: "manual", cadence: "balanced", resolution: {} },
      scope: {},
      records: [],
    }).success).toBe(false);
  });

  it("rejects duplicate marketplaces, unknown fields, and malformed lease windows", () => {
    expect(HostConfigDocumentSchema.safeParse(document({ records: [record(), record()] })).success).toBe(false);
    expect(HostConfigDocumentSchema.safeParse(document({ unexpected: true })).success).toBe(false);
    expect(HostConfigDocumentSchema.safeParse({
      ...document({ records: [] }),
      scope: { schedulerLease: { id: `update-scheduler-lease-v1:uuid:123e4567-e89b-42d3-a456-426614174000`, startedAt: 10, renewedAt: 9, expiresAt: 20 } },
    }).success).toBe(false);
  });

  it("derives public document types from strict schemas", () => {
    expectTypeOf<z.infer<typeof HostConfigDocumentSchema>>().toEqualTypeOf<HostConfigDocument>();
    expectTypeOf<z.infer<typeof MarketplaceConfigurationRecordSchema>>().toEqualTypeOf<
      import("../../../src/domain/state/config-state.js").MarketplaceConfigurationRecord
    >();
  });
});
