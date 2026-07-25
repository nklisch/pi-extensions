import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  CanonicalConfigurationPathSchema,
  ConfiguredValueSchema,
  ConfigurationWriteIdSchema,
  createPluginConfigurationDocument,
  deriveSecretLocator,
  digestConfigurationDescriptors,
  PluginConfigurationDocumentSchemaV1,
  SecretLocatorSchema,
  verifyPluginConfigurationDocument,
} from "../../src/domain/configured-values.js";
import { claimFixture } from "../fixtures/compatibility/common.js";
import type { PluginConfiguration } from "../../src/domain/configuration.js";
import { derivePluginConfigurationRef } from "../../src/domain/state/references.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const userScope = { kind: "user" as const };
const configurationRef = derivePluginConfigurationRef({
  scope: userScope,
  plugin: "demo@catalog",
  content: "content",
  binding: "binding",
}, sha256);

function descriptors(): PluginConfiguration {
  return {
    options: [
      { key: "TEXT", label: claimFixture("Text"), value: { kind: "string", pattern: "^[a-z]+$" }, required: true, sensitive: false, provenance: [claimFixture("TEXT").provenance[0]!] },
      { key: "COUNT", label: claimFixture("Count"), value: { kind: "number", min: 1, max: 3, default: 2 }, required: true, sensitive: false, provenance: [claimFixture("COUNT").provenance[0]!] },
      { key: "ENABLED", label: claimFixture("Enabled"), value: { kind: "boolean", default: true }, required: false, sensitive: false, provenance: [claimFixture("ENABLED").provenance[0]!] },
      { key: "DIR", label: claimFixture("Directory"), value: { kind: "directory", mustExist: false }, required: true, sensitive: false, provenance: [claimFixture("DIR").provenance[0]!] },
      { key: "FILE", label: claimFixture("File"), value: { kind: "file", mustExist: false }, required: false, sensitive: false, provenance: [claimFixture("FILE").provenance[0]!] },
      { key: "LIST", label: claimFixture("List"), value: { kind: "strings", minItems: 1, maxItems: 2 }, required: true, sensitive: false, provenance: [claimFixture("LIST").provenance[0]!] },
      { key: "TOKEN", label: claimFixture("Token"), value: { kind: "string" }, required: true, sensitive: true, provenance: [claimFixture("TOKEN").provenance[0]!] },
    ],
  };
}

describe("configured-value domain contracts", () => {
  it("accepts only canonical absolute file URLs", () => {
    expect(CanonicalConfigurationPathSchema.safeParse("file:///trusted/path").success).toBe(true);
    expect(CanonicalConfigurationPathSchema.safeParse("relative/path").success).toBe(false);
    expect(CanonicalConfigurationPathSchema.safeParse("file:///trusted/../escape").success).toBe(false);
    expect(CanonicalConfigurationPathSchema.safeParse("file://user:password@host/path").success).toBe(false);
    expectTypeOf<z.infer<typeof ConfiguredValueSchema>>().toEqualTypeOf<import("../../src/domain/configured-values.js").ConfiguredValue>();
  });

  it("derives deterministic descriptor/document revisions and opaque locators", () => {
    const configuration = descriptors();
    const descriptorDigest = digestConfigurationDescriptors(configuration, sha256);
    const document = createPluginConfigurationDocument({
      schemaVersion: 1,
      configurationRef,
      plugin: "demo@catalog",
      scope: userScope,
      descriptorDigest,
      values: [
        { key: "TEXT", value: { kind: "string", value: "safe" } },
        { key: "COUNT", value: { kind: "number", value: 2 } },
        { key: "DIR", value: { kind: "directory", value: "file:///trusted/path" } },
        { key: "LIST", value: { kind: "strings", value: ["safe"] } },
      ],
      secrets: [{ key: "TOKEN", locator: `secret-v1:sha256:${"a".repeat(64)}` }],
    }, sha256);
    expect(verifyPluginConfigurationDocument(document, configuration, sha256)).toEqual(document);
    expect(createPluginConfigurationDocument({ ...document, values: [...document.values].reverse() }, sha256)).toEqual(document);
    expect(() => createPluginConfigurationDocument({ ...document, revision: `sha256:${"f".repeat(64)}` }, sha256)).toThrow();
    const locator = deriveSecretLocator({ scope: userScope, plugin: "demo@catalog", configurationRef, key: "TOKEN", writeId: ConfigurationWriteIdSchema.parse(`config-write-v1:${"x".repeat(22)}`) }, sha256);
    expect(SecretLocatorSchema.safeParse(locator).success).toBe(true);
    expect(locator).not.toContain("TOKEN");
    expect(locator).not.toContain("demo");
  });

  it("rejects forged, duplicate, sensitivity-crossing, and required-missing documents", () => {
    const configuration = descriptors();
    const descriptorDigest = digestConfigurationDescriptors(configuration, sha256);
    const base = {
      schemaVersion: 1 as const,
      configurationRef,
      plugin: "demo@catalog" as const,
      scope: userScope,
      descriptorDigest,
      values: [{ key: "TOKEN", value: { kind: "string" as const, value: "CANARY" } }],
      secrets: [],
    };
    expect(() => createPluginConfigurationDocument(base, sha256)).not.toThrow();
    expect(() => verifyPluginConfigurationDocument(createPluginConfigurationDocument(base, sha256), configuration, sha256)).toThrow();
    expect(() => PluginConfigurationDocumentSchemaV1.parse({
      ...base,
      values: [base.values[0], base.values[0]],
    })).toThrow();
  });
});
