import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  MarketplaceContentRefSchema,
  PendingTransitionRefSchema,
  PluginConfigurationRefSchema,
  PluginContentRefSchema,
  PluginDataRefSchema,
  ReferenceIdentitySchema,
  StateBlobRefSchema,
  StateReferenceKindRegistry,
  StateReferenceSchema,
  TrustSubjectRefSchema,
  deriveMarketplaceContentRef,
  derivePendingTransitionRef,
  derivePluginConfigurationRef,
  derivePluginContentRef,
  derivePluginDataRef,
  deriveStateBlobRef,
  deriveTrustSubjectRef,
  verifyPluginContentRef,
  type MarketplaceContentRef,
  type PendingTransitionRef,
  type PluginConfigurationRef,
  type PluginContentRef,
  type PluginDataRef,
  type StateBlobRef,
  type TrustSubjectRef,
} from "../../../src/domain/state/references.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const identity = {
  scope: "project-v1:sha256:" + "aa".repeat(32),
  plugin: "demo@marketplace",
  source: "source-v1|git|url:30:https://example.com/plugin.git",
} as const;

describe("versioned logical state references", () => {
  it("derives deterministic golden references from canonical identity values", () => {
    const first = derivePluginContentRef(identity, sha256);
    const second = derivePluginContentRef({
      source: identity.source,
      plugin: identity.plugin,
      scope: identity.scope,
    }, sha256);

    expect(first).toBe("plugin-content-v1:sha256:e3848c6ef0e881b43ba317b029633cb824574816ff67ffc5ba6c3e1fa69fc1a3");
    expect(second).toBe(first);
    expect(PluginContentRefSchema.parse(first)).toBe(first);
  });

  it("uses one distinct versioned tag per reference family", () => {
    const references = [
      [StateReferenceKindRegistry.stateBlob.tag, deriveStateBlobRef(identity, sha256), StateBlobRefSchema],
      [StateReferenceKindRegistry.marketplaceContent.tag, deriveMarketplaceContentRef(identity, sha256), MarketplaceContentRefSchema],
      [StateReferenceKindRegistry.pluginContent.tag, derivePluginContentRef(identity, sha256), PluginContentRefSchema],
      [StateReferenceKindRegistry.pluginData.tag, derivePluginDataRef(identity, sha256), PluginDataRefSchema],
      [StateReferenceKindRegistry.pluginConfiguration.tag, derivePluginConfigurationRef(identity, sha256), PluginConfigurationRefSchema],
      [StateReferenceKindRegistry.trustSubject.tag, deriveTrustSubjectRef(identity, sha256), TrustSubjectRefSchema],
      [StateReferenceKindRegistry.pendingTransition.tag, derivePendingTransitionRef(identity, sha256), PendingTransitionRefSchema],
    ] as const;
    const values = references.map(([, value]) => value);

    expect(new Set(values).size).toBe(references.length);
    for (const [tag, value, schema] of references) {
      expect(value.startsWith(`${tag}:sha256:`)).toBe(true);
      expect(schema.safeParse(value).success).toBe(true);
      expect(StateReferenceSchema.safeParse(value).success).toBe(true);
    }
  });

  it("rejects paths, unversioned tags, unknown tags, and cross-family values", () => {
    const invalid = [
      "state-blob:sha256:" + "00".repeat(32),
      "unknown-v1:sha256:" + "00".repeat(32),
      "file:///tmp/state",
      "../state",
      "C:\\state",
      "\\\\server\\share\\state",
      "state-blob-v2:sha256:" + "00".repeat(32),
      "state-blob-v1:sha256:" + "0".repeat(63),
    ];
    for (const value of invalid) {
      expect(StateReferenceSchema.safeParse(value).success, value).toBe(false);
    }
    const pluginRef = derivePluginContentRef(identity, sha256);
    expect(StateBlobRefSchema.safeParse(pluginRef).success).toBe(false);
  });

  it("canonicalizes identity object property order without accepting non-JSON values", () => {
    const reordered = {
      source: identity.source,
      plugin: identity.plugin,
      scope: identity.scope,
    };
    expect(derivePluginContentRef(reordered, sha256)).toBe(derivePluginContentRef(identity, sha256));
    expect(ReferenceIdentitySchema.safeParse({ value: undefined }).success).toBe(false);
    expect(ReferenceIdentitySchema.safeParse({ value: BigInt(1) }).success).toBe(false);
    expect(ReferenceIdentitySchema.safeParse({ value: String.fromCharCode(0xd800) }).success).toBe(false);
    expect(() => derivePluginContentRef({ value: String.fromCharCode(0xd800) }, sha256)).toThrow(/surrogate/);
  });

  it("verifies a reference against its identity and injected hash contract", () => {
    const reference = derivePluginContentRef(identity, sha256);
    expect(verifyPluginContentRef(reference, identity, sha256)).toBe(reference);
    expect(() => verifyPluginContentRef(reference, { ...identity, plugin: "other@marketplace" }, sha256)).toThrow();
    expect(() => derivePluginContentRef(identity, () => new Uint8Array(31))).toThrow(/exactly 32/);
    expect(() => derivePluginContentRef(identity, undefined as never)).toThrow(/SHA-256/);
  });

  it("derives each public reference type from its schema", () => {
    expectTypeOf<z.infer<typeof StateBlobRefSchema>>().toEqualTypeOf<StateBlobRef>();
    expectTypeOf<z.infer<typeof MarketplaceContentRefSchema>>().toEqualTypeOf<MarketplaceContentRef>();
    expectTypeOf<z.infer<typeof PluginContentRefSchema>>().toEqualTypeOf<PluginContentRef>();
    expectTypeOf<z.infer<typeof PluginDataRefSchema>>().toEqualTypeOf<PluginDataRef>();
    expectTypeOf<z.infer<typeof PluginConfigurationRefSchema>>().toEqualTypeOf<PluginConfigurationRef>();
    expectTypeOf<z.infer<typeof TrustSubjectRefSchema>>().toEqualTypeOf<TrustSubjectRef>();
    expectTypeOf<z.infer<typeof PendingTransitionRefSchema>>().toEqualTypeOf<PendingTransitionRef>();
  });
});
