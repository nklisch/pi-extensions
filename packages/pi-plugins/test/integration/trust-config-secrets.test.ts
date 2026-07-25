import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { savePluginConfiguration } from "../../src/application/configuration-service.js";
import { withResolvedPluginConfiguration } from "../../src/application/configuration-resolver.js";
import { SensitiveValue, withSensitiveValue } from "../../src/application/sensitive-value.js";
import { derivePluginConfigurationRef } from "../../src/domain/state/references.js";
import { createResolvedMarketplaceSource } from "../../src/domain/source.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { createCompatibilityReport } from "../../src/domain/compatibility.js";
import { createTrustCandidate, grantTrust } from "../../src/domain/trust-policy.js";
import { CanonicalConfigurationPathSchema } from "../../src/domain/configured-values.js";
import { directPlugin, claimFixture } from "../fixtures/compatibility/common.js";
import { configurationCanaries } from "../fixtures/configuration/adversarial.js";
import type { PluginConfigurationStore } from "../../src/application/ports/plugin-configuration-store.js";
import type { SecretCreationEvidence, SecretStore } from "../../src/application/ports/secret-store.js";
import type { ConfigurationPathPort } from "../../src/application/ports/configuration-path.js";
import type { PluginConfigurationDocument, SecretLocator } from "../../src/domain/configured-values.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const scope = { kind: "user" as const };
const pathContext = { scope, trustedBaseDirectory: "/trusted" };
const descriptors = {
  options: [
    { key: "NAME", label: claimFixture("Name"), value: { kind: "string" }, required: true, sensitive: false, provenance: [claimFixture("NAME").provenance[0]!] },
    { key: "TOKEN", label: claimFixture("Token"), value: { kind: "string" }, required: true, sensitive: true, provenance: [claimFixture("TOKEN").provenance[0]!] },
  ],
} as const;
const plugin = directPlugin({ identity: { key: "demo@catalog", marketplaceName: "catalog", marketplaceEntryName: "demo" }, configuration: descriptors });
const configurationRef = derivePluginConfigurationRef({ scope, plugin: "demo@catalog", content: "content", binding: "binding" }, sha256);
const candidate = createTrustCandidate({
  scope,
  marketplaceSource: createResolvedMarketplaceSource({ declared: { kind: "github", repository: "example/marketplace" }, revision: "b".repeat(40) }, sha256),
  plugin,
  compatibility: createCompatibilityReport({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] }),
  content: createContentManifest([], sha256),
}, sha256);

class ConfigStore implements PluginConfigurationStore {
  document: PluginConfigurationDocument | undefined;
  async read() { return this.document === undefined ? { kind: "missing" as const } : { kind: "found" as const, document: this.document }; }
  async replace(request: { document: PluginConfigurationDocument }) { this.document = request.document; return { kind: "stored" as const }; }
  async remove() { return "removed" as const; }
}
class SecretStoreFake implements SecretStore {
  values = new Map<string, SensitiveValue>();
  private readonly owned = new WeakMap<object, string>();
  async put(locator: string, value: SensitiveValue) {
    if (this.values.has(locator)) return { kind: "collision" as const };
    this.values.set(locator, value);
    const evidence = Object.freeze({}) as SecretCreationEvidence;
    this.owned.set(evidence, locator);
    return { kind: "created" as const, locator, evidence };
  }
  async get(locator: string) { return this.values.has(locator) ? { kind: "found" as const, value: this.values.get(locator)! } : { kind: "missing" as const }; }
  async remove(locator: string) { return this.values.delete(locator) ? "removed" as const : "missing" as const; }
  async removeOwned(evidence: object) {
    const locator = this.owned.get(evidence);
    if (locator === undefined) throw new Error("unowned evidence");
    this.owned.delete(evidence);
    return this.remove(locator);
  }
}
const paths: ConfigurationPathPort = { normalizeAndInspect: async () => ({ kind: "valid" as const, canonicalPath: CanonicalConfigurationPathSchema.parse("file:///trusted/path") }) };

it("integrates validated non-secret state, opaque secret custody, exact trust, and runtime-only resolution", async () => {
  const configurations = new ConfigStore();
  const secrets = new SecretStoreFake();
  const result = await savePluginConfiguration({
    configurationRef,
    plugin: "demo@catalog",
    scope,
    descriptors,
    values: { NAME: "demo", TOKEN: configurationCanaries.secret },
    pathContext,
  }, {
    configurations,
    secrets,
    paths,
    writeIds: { create: async () => `config-write-v1:${"i".repeat(22)}` },
    sha256,
  }, new AbortController().signal);
  expect(result.kind).toBe("stored");
  expect(JSON.stringify(configurations.document)).not.toContain("CANARY_INTEGRATION_SECRET");
  expect(JSON.stringify(result)).not.toContain("CANARY_INTEGRATION_SECRET");
  const stored = [...secrets.values.values()][0]!;
  expect(withSensitiveValue(stored, (value) => value)).toBe(configurationCanaries.secret);

  let callbackSecret = "";
  await withResolvedPluginConfiguration({ candidate, trustRecords: [grantTrust(candidate, sha256)], configurationRef, descriptors, pathContext }, {
    projectTrust: { assess: async () => ({ kind: "trusted" as const }) },
    configurations,
    secrets,
    paths,
    sha256,
  }, new AbortController().signal, async (resolved) => {
    callbackSecret = resolved.substitute("${user_config.TOKEN}");
    expect(resolved.environment()).toMatchObject({ CLAUDE_PLUGIN_OPTION_NAME: "demo" });
    expect(resolved.toString()).toBe("[REDACTED]");
    return undefined;
  });
  expect(callbackSecret).toBe(configurationCanaries.secret);

  const locator = [...secrets.values.keys()][0] as SecretLocator;
  await secrets.remove(locator, new AbortController().signal);
  await expect(withResolvedPluginConfiguration({ candidate, trustRecords: [grantTrust(candidate, sha256)], configurationRef, descriptors, pathContext }, {
    projectTrust: { assess: async () => ({ kind: "trusted" as const }) }, configurations, secrets, paths, sha256,
  }, new AbortController().signal, async () => undefined)).rejects.toMatchObject({ code: "CONFIG_SECRET_MISSING" });
});
