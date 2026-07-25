import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { collectConfigurationValidation, validateConfigurationSubmission, ConfigurationValidationError } from "../../src/application/configuration-validation.js";
import { derivePluginConfigurationRef } from "../../src/domain/state/references.js";
import { CanonicalConfigurationPathSchema, digestConfigurationDescriptors, createPluginConfigurationDocument } from "../../src/domain/configured-values.js";
import { claimFixture } from "../fixtures/compatibility/common.js";
import type { ConfigurationPathPort } from "../../src/application/ports/configuration-path.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const scope = { kind: "user" as const };
const pathContext = { scope, trustedBaseDirectory: "/trusted/base" };
const configurationRef = derivePluginConfigurationRef({ scope, plugin: "demo@catalog", content: "content", binding: "binding" }, sha256);

const descriptors = {
  options: [
    { key: "NAME", label: claimFixture("Name"), value: { kind: "string", pattern: "^[a-z]+$" }, required: true, sensitive: false, provenance: [claimFixture("NAME").provenance[0]!] },
    { key: "COUNT", label: claimFixture("Count"), value: { kind: "number", min: 1, max: 5, default: 2 }, required: true, sensitive: false, provenance: [claimFixture("COUNT").provenance[0]!] },
    { key: "DIR", label: claimFixture("Dir"), value: { kind: "directory", mustExist: false }, required: true, sensitive: false, provenance: [claimFixture("DIR").provenance[0]!] },
    { key: "FLAGS", label: claimFixture("Flags"), value: { kind: "strings", minItems: 1, maxItems: 2 }, required: false, sensitive: false, provenance: [claimFixture("FLAGS").provenance[0]!] },
    { key: "TOKEN", label: claimFixture("Token"), value: { kind: "string" }, required: true, sensitive: true, provenance: [claimFixture("TOKEN").provenance[0]!] },
    { key: "OPTIONAL_TOKEN", label: claimFixture("Optional"), value: { kind: "string" }, required: false, sensitive: true, provenance: [claimFixture("OPTIONAL_TOKEN").provenance[0]!] },
  ],
} as const;

const pathPort: ConfigurationPathPort = {
  async normalizeAndInspect(input) {
    return {
      kind: "valid",
      canonicalPath: CanonicalConfigurationPathSchema.parse(`file:///trusted/${input.value.split("/").at(-1)}`),
    };
  },
};

function base(values: Record<string, unknown> = {}) {
  return {
    configurationRef,
    plugin: "demo@catalog" as const,
    scope,
    descriptors,
    values,
    pathContext,
  };
}

describe("configuration submission validation", () => {
  it("validates all value kinds, applies non-sensitive defaults, and normalizes paths", async () => {
    const result = await validateConfigurationSubmission(base({ NAME: "safe", DIR: "relative/data", FLAGS: ["one"], TOKEN: "CANARY_SECRET" }), pathPort, new AbortController().signal);
    expect(result.values).toEqual(expect.arrayContaining([
      { key: "NAME", value: { kind: "string", value: "safe" } },
      { key: "COUNT", value: { kind: "number", value: 2 } },
      { key: "DIR", value: { kind: "directory", value: "file:///trusted/data" } },
    ]));
    expect(result.secrets).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("CANARY_SECRET");
  });

  it("preserves omitted sensitive locators and permits optional unset only", async () => {
    const descriptorDigest = digestConfigurationDescriptors(descriptors, sha256);
    const existing = createPluginConfigurationDocument({
      schemaVersion: 1,
      configurationRef,
      plugin: "demo@catalog",
      scope,
      descriptorDigest,
      values: [],
      secrets: [
        { key: "TOKEN", locator: `secret-v1:sha256:${"a".repeat(64)}` },
        { key: "OPTIONAL_TOKEN", locator: `secret-v1:sha256:${"b".repeat(64)}` },
      ],
    }, sha256);
    const preserved = await validateConfigurationSubmission({ ...base({ NAME: "safe", DIR: "data" }), existing }, pathPort, new AbortController().signal);
    expect(preserved.preservedSecrets).toEqual([
      { key: "OPTIONAL_TOKEN", locator: `secret-v1:sha256:${"b".repeat(64)}` },
      { key: "TOKEN", locator: `secret-v1:sha256:${"a".repeat(64)}` },
    ]);
    const unset = await validateConfigurationSubmission({ ...base({ NAME: "safe", DIR: "data" }), existing, unset: ["OPTIONAL_TOKEN"] }, pathPort, new AbortController().signal);
    expect(unset.unsetSecrets).toEqual(["OPTIONAL_TOKEN"]);
    await expect(validateConfigurationSubmission({ ...base({ NAME: "safe", DIR: "data" }), unset: ["TOKEN"] }, pathPort, new AbortController().signal))
      .rejects.toMatchObject({ code: "CONFIG_REQUIRED" });
  });

  it("redacts native path adapter failures", async () => {
    const canary = "CANARY_PATH_ADAPTER /private/secret";
    const failing: ConfigurationPathPort = { normalizeAndInspect: async () => { throw new Error(canary); } };
    const error = await validateConfigurationSubmission(base({ NAME: "safe", DIR: "x", TOKEN: "secret" }), failing, new AbortController().signal)
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "CONFIG_PATH_ADAPTER_FAILED" });
    expect((error as Error).message).not.toContain(canary);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(canary);
  });

  it("collects every pure issue deterministically before path effects", async () => {
    const calls: string[] = [];
    const port: ConfigurationPathPort = { normalizeAndInspect: async (input) => {
      calls.push(input.value);
      return pathPort.normalizeAndInspect(input, new AbortController().signal);
    } };
    const result = await collectConfigurationValidation(base({ UNKNOWN: "secret", NAME: "BAD", COUNT: 99 }), port, new AbortController().signal);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") expect(result.issues).toEqual([
      { code: "CONFIG_BOUNDS", key: "COUNT" },
      { code: "CONFIG_REQUIRED", key: "DIR" },
      { code: "CONFIG_PATTERN", key: "NAME" },
      { code: "CONFIG_REQUIRED", key: "TOKEN" },
      { code: "CONFIG_UNKNOWN_KEY", key: "UNKNOWN" },
    ]);
    expect(calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("fails before path effects for unknown, duplicate, pattern, bounds, and required input", async () => {
    const calls: string[] = [];
    const port: ConfigurationPathPort = { normalizeAndInspect: async (input) => {
      calls.push(input.value);
      return pathPort.normalizeAndInspect(input, new AbortController().signal);
    } };
    const unknown = await validateConfigurationSubmission(base({ NAME: "safe", DIR: "x", TOKEN: "s", UNKNOWN: "CANARY_UNKNOWN_SECRET_KEY" }), port, new AbortController().signal).catch((error: unknown) => error);
    expect(unknown).toMatchObject({ code: "CONFIG_UNKNOWN_KEY" });
    expect(JSON.stringify(unknown)).not.toContain("CANARY_UNKNOWN_SECRET_KEY");
    await expect(validateConfigurationSubmission({ ...base({ NAME: "bad-value", DIR: "x" }), values: { NAME: "safe", DIR: "x" }, unset: ["NAME"] }, port, new AbortController().signal)).rejects.toMatchObject({ code: "CONFIG_DUPLICATE_INPUT" });
    await expect(validateConfigurationSubmission(base({ NAME: "BAD", DIR: "x", TOKEN: "s" }), port, new AbortController().signal)).rejects.toMatchObject({ code: "CONFIG_PATTERN" });
    await expect(validateConfigurationSubmission(base({ NAME: "safe", DIR: "x", TOKEN: "s", COUNT: 99 }), port, new AbortController().signal)).rejects.toMatchObject({ code: "CONFIG_BOUNDS" });
    await expect(validateConfigurationSubmission(base({ NAME: "safe", DIR: "x" }), port, new AbortController().signal)).rejects.toMatchObject({ code: "CONFIG_REQUIRED" });
    expect(calls).toEqual([]);
    expect(new ConfigurationValidationError("CONFIG_TYPE", "NAME").message).not.toContain("NAME");
  });
});
