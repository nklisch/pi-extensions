import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withResolvedPluginConfiguration, ConfigurationResolutionError } from "../../src/application/configuration-resolver.js";
import { grantTrust, createTrustCandidate } from "../../src/domain/trust-policy.js";
import { createResolvedMarketplaceSource } from "../../src/domain/source.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { createCompatibilityReport } from "../../src/domain/compatibility.js";
import { derivePluginConfigurationRef } from "../../src/domain/state/references.js";
import { createPluginConfigurationDocument, deriveSecretLocator, digestConfigurationDescriptors, CanonicalConfigurationPathSchema } from "../../src/domain/configured-values.js";
import { SensitiveValue, withSensitiveValue } from "../../src/application/sensitive-value.js";
import { directPlugin, claimFixture } from "../fixtures/compatibility/common.js";
import type { PluginConfigurationStore } from "../../src/application/ports/plugin-configuration-store.js";
import type { SecretCreationEvidence, SecretStore } from "../../src/application/ports/secret-store.js";
import type { ConfigurationPathPort } from "../../src/application/ports/configuration-path.js";
import type { PluginConfigurationDocument, SecretLocator } from "../../src/domain/configured-values.js";
import type { TrustCandidate } from "../../src/domain/trust-policy.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const scope = { kind: "user" as const };
const pathContext = { scope, trustedBaseDirectory: "/trusted" };
const descriptors = {
  options: [
    { key: "NAME", label: claimFixture("Name"), value: { kind: "string" }, required: true, sensitive: false, provenance: [claimFixture("NAME").provenance[0]!] },
    { key: "TOKEN", label: claimFixture("Token"), value: { kind: "string" }, required: true, sensitive: true, provenance: [claimFixture("TOKEN").provenance[0]!] },
    { key: "OPTIONAL", label: claimFixture("Optional"), value: { kind: "string" }, required: false, sensitive: true, provenance: [claimFixture("OPTIONAL").provenance[0]!] },
    { key: "DATA_DIR", label: claimFixture("Directory"), value: { kind: "directory", mustExist: true }, required: false, sensitive: false, provenance: [claimFixture("DATA_DIR").provenance[0]!] },
  ],
} as const;
const configurationRef = derivePluginConfigurationRef({ scope, plugin: "demo@catalog", content: "content", binding: "binding" }, sha256);
const tokenLocator = deriveSecretLocator({ scope, plugin: "demo@catalog", configurationRef, key: "TOKEN", writeId: `config-write-v1:${"x".repeat(22)}` }, sha256);
const optionalLocator = deriveSecretLocator({ scope, plugin: "demo@catalog", configurationRef, key: "OPTIONAL", writeId: `config-write-v1:${"y".repeat(22)}` }, sha256);

function candidate(): TrustCandidate {
  const plugin = directPlugin({
    identity: { key: "demo@catalog", marketplaceName: "catalog", marketplaceEntryName: "demo" },
    configuration: descriptors,
  });
  return createTrustCandidate({
    scope,
    marketplaceSource: createResolvedMarketplaceSource({ declared: { kind: "github", repository: "example/marketplace" }, revision: "b".repeat(40) }, sha256),
    plugin,
    compatibility: createCompatibilityReport({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] }),
    content: createContentManifest([], sha256),
  }, sha256);
}

class ConfigStore implements PluginConfigurationStore {
  document: PluginConfigurationDocument | undefined;
  async read() { return this.document === undefined ? { kind: "missing" as const } : { kind: "found" as const, document: this.document }; }
  async replace() { return { kind: "stored" as const }; }
  async remove() { return "removed" as const; }
}
class Secrets implements SecretStore {
  values = new Map<string, SensitiveValue>();
  missing = new Set<string>();
  private readonly owned = new WeakMap<object, string>();
  async put(locator: string, value: SensitiveValue) {
    if (this.values.has(locator)) return { kind: "collision" as const };
    this.values.set(locator, value);
    const evidence = Object.freeze({}) as SecretCreationEvidence;
    this.owned.set(evidence, locator);
    return { kind: "created" as const, locator, evidence };
  }
  async get(locator: string) { return !this.missing.has(locator) && this.values.has(locator) ? { kind: "found" as const, value: this.values.get(locator)! } : { kind: "missing" as const }; }
  async remove() { return "removed" as const; }
  async removeOwned(evidence: object) {
    const locator = this.owned.get(evidence);
    if (locator === undefined) throw new Error("unowned evidence");
    this.owned.delete(evidence);
    return this.remove(locator);
  }
}
const paths: ConfigurationPathPort = {
  async normalizeAndInspect(input) {
    if (input.value === "file:///trusted/missing") return { kind: "missing" as const };
    return { kind: "valid" as const, canonicalPath: CanonicalConfigurationPathSchema.parse(input.value) };
  },
};

function document(candidateValue: TrustCandidate, includePath = false, includeOptional = false): PluginConfigurationDocument {
  const descriptorDigest = digestConfigurationDescriptors(descriptors, sha256);
  return createPluginConfigurationDocument({
    schemaVersion: 1,
    configurationRef,
    plugin: "demo@catalog",
    scope,
    descriptorDigest,
    values: [
      { key: "NAME", value: { kind: "string", value: "demo" } },
      ...(includePath ? [{ key: "DATA_DIR", value: { kind: "directory" as const, value: CanonicalConfigurationPathSchema.parse("file:///trusted/missing") } }] : []),
    ],
    secrets: [
      { key: "TOKEN", locator: tokenLocator },
      ...(includeOptional ? [{ key: "OPTIONAL", locator: optionalLocator }] : []),
    ],
  }, sha256);
}
function dependencies(config: ConfigStore, secrets: Secrets) {
  return { projectTrust: { assess: async () => ({ kind: "trusted" as const }) }, configurations: config, secrets, paths, sha256 };
}

async function setup() {
  const current = candidate();
  const config = new ConfigStore();
  config.document = document(current);
  const secrets = new Secrets();
  secrets.values.set(tokenLocator, SensitiveValue.fromUnknown("CANARY_SECRET"));
  return { current, config, secrets };
}

describe("trust-gated runtime configuration resolution", () => {
  it("resolves values only inside the callback and disposes the facade", async () => {
    const { current, config, secrets } = await setup();
    let facade: import("../../src/application/resolved-configuration.js").ResolvedConfiguration | undefined;
    await withResolvedPluginConfiguration({ candidate: current, trustRecords: [grantTrust(current, sha256)], configurationRef, descriptors, pathContext }, dependencies(config, secrets), new AbortController().signal, async (value) => {
      facade = value;
      expect(value.has("TOKEN")).toBe(true);
      expect(value.substitute("Bearer ${user_config.TOKEN}")).toBe("Bearer CANARY_SECRET");
      expect(value.environment()).toMatchObject({ CLAUDE_PLUGIN_OPTION_TOKEN: "CANARY_SECRET" });
      expect(value.redact("reason CANARY_SECRET")).toBe("reason [REDACTED]");
      expect(JSON.stringify(value)).toBe('"[REDACTED]"');
      return undefined;
    });
    expect(facade?.toString()).toBe("[REDACTED]");
    expect(() => facade?.has("TOKEN")).toThrow();
    expect(JSON.stringify(config.document)).not.toContain("CANARY_SECRET");
  });

  it("discards callback completion values so plaintext cannot cross the resolver boundary", async () => {
    const { current, config, secrets } = await setup();
    const unsafeCompletion = async (resolved: import("../../src/application/resolved-configuration.js").ResolvedConfiguration) => ({
      secret: resolved.substitute("${user_config.TOKEN}"),
    });
    const result = await withResolvedPluginConfiguration({ candidate: current, trustRecords: [grantTrust(current, sha256)], configurationRef, descriptors, pathContext }, dependencies(config, secrets), new AbortController().signal, unsafeCompletion as unknown as (configuration: import("../../src/application/resolved-configuration.js").ResolvedConfiguration) => Promise<void>);
    expect(result).toBeUndefined();
  });

  it("denies absent trust, required missing secrets, and adapter failures without fallback", async () => {
    const { current, config, secrets } = await setup();
    await expect(withResolvedPluginConfiguration({ candidate: current, trustRecords: [], configurationRef, descriptors, pathContext }, dependencies(config, secrets), new AbortController().signal, async () => undefined))
      .rejects.toMatchObject({ code: "TRUST_ABSENT" });
    secrets.missing.add(tokenLocator);
    await expect(withResolvedPluginConfiguration({ candidate: current, trustRecords: [grantTrust(current, sha256)], configurationRef, descriptors, pathContext }, dependencies(config, secrets), new AbortController().signal, async () => undefined))
      .rejects.toMatchObject({ code: "CONFIG_SECRET_MISSING" });

    const failure = new Secrets();
    failure.values.set(tokenLocator, SensitiveValue.fromUnknown("CANARY_SECRET"));
    failure.get = async () => { throw new Error("CANARY_SECRET_ADAPTER_ERROR"); };
    const error = await withResolvedPluginConfiguration({ candidate: current, trustRecords: [grantTrust(current, sha256)], configurationRef, descriptors, pathContext }, dependencies(config, failure), new AbortController().signal, async () => undefined).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "ADAPTER_FAILED" });
    expect(JSON.stringify(error)).not.toContain("CANARY_SECRET");
  });

  it("fails closed on malformed adapter results without serializing their payload", async () => {
    const { current, config, secrets } = await setup();
    config.read = async () => ({ kind: "found" as const, document: { malformed: "CANARY_ADAPTER_PAYLOAD" } as never });
    const configError = await withResolvedPluginConfiguration({ candidate: current, trustRecords: [grantTrust(current, sha256)], configurationRef, descriptors, pathContext }, dependencies(config, secrets), new AbortController().signal, async () => undefined).catch((value: unknown) => value);
    expect(configError).toMatchObject({ code: "ADAPTER_FAILED" });
    expect(JSON.stringify(configError)).not.toContain("CANARY_ADAPTER_PAYLOAD");

    const { current: second, config: secondConfig, secrets: secondSecrets } = await setup();
    secondSecrets.get = async () => ({ kind: "found" as const, value: "CANARY_PLAINTEXT" as never });
    const secretError = await withResolvedPluginConfiguration({ candidate: second, trustRecords: [grantTrust(second, sha256)], configurationRef, descriptors, pathContext }, dependencies(secondConfig, secondSecrets), new AbortController().signal, async () => undefined).catch((value: unknown) => value);
    expect(secretError).toMatchObject({ code: "ADAPTER_FAILED" });
    expect(JSON.stringify(secretError)).not.toContain("CANARY_PLAINTEXT");
  });

  it("omits optional missing secrets without empty/default substitution", async () => {
    const { current, config, secrets } = await setup();
    config.document = document(current, false, true);
    await withResolvedPluginConfiguration({ candidate: current, trustRecords: [grantTrust(current, sha256)], configurationRef, descriptors, pathContext }, dependencies(config, secrets), new AbortController().signal, async (resolved) => {
      expect(resolved.has("OPTIONAL")).toBe(false);
      expect(resolved.environment()).not.toHaveProperty("CLAUDE_PLUGIN_OPTION_OPTIONAL");
      return undefined;
    });
  });

  it("rechecks paths before fetching or invoking a runtime callback", async () => {
    const { current, config, secrets } = await setup();
    config.document = document(current, true);
    const pathSecrets = new Secrets();
    pathSecrets.values.set(tokenLocator, SensitiveValue.fromUnknown("CANARY_SECRET"));
    await expect(withResolvedPluginConfiguration({ candidate: current, trustRecords: [grantTrust(current, sha256)], configurationRef, descriptors, pathContext }, dependencies(config, pathSecrets), new AbortController().signal, async () => undefined))
      .rejects.toMatchObject({ code: "CONFIG_PATH_MISSING" });
    expect(pathSecrets.values.has(tokenLocator)).toBe(true);
  });

  it("disposes on callback errors and never propagates callback plaintext", async () => {
    const { current, config, secrets } = await setup();
    let disposedFacade: import("../../src/application/resolved-configuration.js").ResolvedConfiguration | undefined;
    const error = await withResolvedPluginConfiguration({ candidate: current, trustRecords: [grantTrust(current, sha256)], configurationRef, descriptors, pathContext }, dependencies(config, secrets), new AbortController().signal, async (value) => {
      disposedFacade = value;
      throw new Error("CANARY_SECRET_CALLBACK_ERROR");
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "CONFIG_CALLBACK_FAILED" });
    expect(JSON.stringify(error)).not.toContain("CANARY_SECRET_CALLBACK_ERROR");
    expect(() => disposedFacade?.substitute("${user_config.TOKEN}")).toThrow();
  });
});
