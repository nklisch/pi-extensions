import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  removePluginConfiguration,
  savePluginConfiguration,
} from "../../src/application/configuration-service.js";
import { withSensitiveValue, SensitiveValue } from "../../src/application/sensitive-value.js";
import { derivePluginConfigurationRef } from "../../src/domain/state/references.js";
import {
  CanonicalConfigurationPathSchema,
  createPluginConfigurationDocument,
  deriveSecretLocator,
} from "../../src/domain/configured-values.js";
import type { PluginConfigurationDocument } from "../../src/domain/configured-values.js";
import type { PluginConfigurationStore } from "../../src/application/ports/plugin-configuration-store.js";
import type { SecretCreationEvidence, SecretStore } from "../../src/application/ports/secret-store.js";
import type { ConfigurationPathPort } from "../../src/application/ports/configuration-path.js";
import type { ConfigurationWriteIdPort } from "../../src/application/ports/configuration-write-id.js";
import { claimFixture } from "../fixtures/compatibility/common.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const scope = { kind: "user" as const };
const configurationRef = derivePluginConfigurationRef({ scope, plugin: "demo@catalog", content: "content", binding: "binding" }, sha256);
const descriptors = {
  options: [
    { key: "NAME", label: claimFixture("Name"), value: { kind: "string" }, required: true, sensitive: false, provenance: [claimFixture("NAME").provenance[0]!] },
    { key: "TOKEN", label: claimFixture("Token"), value: { kind: "string" }, required: true, sensitive: true, provenance: [claimFixture("TOKEN").provenance[0]!] },
    { key: "OPTIONAL", label: claimFixture("Optional"), value: { kind: "string" }, required: false, sensitive: true, provenance: [claimFixture("OPTIONAL").provenance[0]!] },
  ],
} as const;
const paths: ConfigurationPathPort = { normalizeAndInspect: async () => ({ kind: "valid", canonicalPath: CanonicalConfigurationPathSchema.parse("file:///trusted/path") }) };

class FakeConfigurationStore implements PluginConfigurationStore {
  document: PluginConfigurationDocument | undefined;
  stale = false;
  failRead = false;
  failReplace = false;
  throwAfterReplace = false;
  failReconciliationRead = false;
  malformedReconciliationRead = false;
  afterReplace?: (document: PluginConfigurationDocument) => PluginConfigurationDocument;
  replacementCount = 0;
  abortAfterReplace?: AbortController;
  removeResult: "removed" | "stale" | "missing" = "removed";
  async read() {
    if (this.failRead) throw new Error("CANARY_CONFIG_READ_FAILURE");
    if (this.replacementCount > 1 && this.failReconciliationRead) throw new Error("CANARY_CONFIG_READ_FAILURE");
    if (this.replacementCount > 1 && this.malformedReconciliationRead) {
      return { kind: "found" as const, document: {} as PluginConfigurationDocument };
    }
    return this.document === undefined ? { kind: "missing" as const } : { kind: "found" as const, document: this.document };
  }
  async replace(request: { expectedRevision: PluginConfigurationDocument["revision"] | null; document: PluginConfigurationDocument }) {
    if (this.failReplace) throw new Error("CANARY_CONFIG_REPLACE_FAILURE");
    if (this.stale) return { kind: "stale" as const, actualRevision: this.document?.revision ?? null };
    if ((this.document?.revision ?? null) !== request.expectedRevision) return { kind: "stale" as const, actualRevision: this.document?.revision ?? null };
    this.document = this.afterReplace?.(request.document) ?? request.document;
    this.replacementCount += 1;
    this.abortAfterReplace?.abort();
    if (this.throwAfterReplace) throw new Error("CANARY_COMMIT_THEN_THROW");
    return { kind: "stored" as const };
  }
  async remove() {
    const result = this.removeResult;
    if (result === "removed") this.document = undefined;
    return result;
  }
}

class FakeSecretStore implements SecretStore {
  values = new Map<string, SensitiveValue>();
  private readonly owned = new WeakMap<object, string>();
  failPut = false;
  failRemove = new Set<string>();
  abortAfterPut?: AbortController;
  beforePut?: () => Promise<void>;
  removeOwnedCalls: string[] = [];
  async put(locator: string, value: SensitiveValue, _signal?: AbortSignal) {
    if (this.failPut) throw new Error("CANARY_SECRET_ADAPTER_FAILURE");
    await this.beforePut?.();
    if (this.values.has(locator)) return { kind: "collision" as const };
    this.values.set(locator, value);
    const evidence = Object.freeze({}) as SecretCreationEvidence;
    this.owned.set(evidence, locator);
    this.abortAfterPut?.abort();
    return { kind: "created" as const, locator, evidence };
  }
  async get(locator: string) { return this.values.has(locator) ? { kind: "found" as const, value: this.values.get(locator)! } : { kind: "missing" as const }; }
  async remove(locator: string) {
    if (this.failRemove.has(locator)) throw new Error("CANARY_SECRET_REMOVE_FAILURE");
    if (!this.values.delete(locator)) return "missing" as const;
    return "removed" as const;
  }
  async removeOwned(evidence: object) {
    const locator = this.owned.get(evidence);
    if (locator === undefined) throw new Error("unowned evidence");
    this.owned.delete(evidence);
    this.removeOwnedCalls.push(locator);
    return this.remove(locator);
  }
}

let nextWriteId = 0;
const writeIds: ConfigurationWriteIdPort = {
  create: async () => `config-write-v1:${"x".repeat(21)}${(nextWriteId++).toString(36)}`,
};
function request(values: Record<string, unknown>) {
  return { configurationRef, plugin: "demo@catalog" as const, scope, descriptors, values, pathContext: { scope, trustedBaseDirectory: "/trusted" } };
}
function deps(configurations: FakeConfigurationStore, secrets: FakeSecretStore, ids: ConfigurationWriteIdPort = writeIds) {
  return { configurations, secrets, paths, writeIds: ids, sha256 };
}

describe("configuration replacement service", () => {
  it("writes fresh secrets before CAS and returns a document containing only locators", async () => {
    const configurations = new FakeConfigurationStore();
    const secrets = new FakeSecretStore();
    const result = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "CANARY_SECRET" }), deps(configurations, secrets), new AbortController().signal);
    expect(result.kind).toBe("stored");
    if (result.kind !== "stored") return;
    expect(result.document).not.toHaveProperty("CANARY_SECRET");
    expect(JSON.stringify(result.document)).not.toContain("CANARY_SECRET");
    expect(secrets.values.size).toBe(1);
    const value = [...secrets.values.values()][0]!;
    expect(String(value)).toBe("[REDACTED]");
    expect(withSensitiveValue(value, (plaintext) => plaintext)).toBe("CANARY_SECRET");
  });

  it("redacts configuration and secret adapter failures", async () => {
    const canary = "CANARY_ADAPTER /private/config/credential";
    const readFailure = new FakeConfigurationStore();
    readFailure.failRead = true;
    const readError = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "secret" }), deps(readFailure, new FakeSecretStore()), new AbortController().signal)
      .catch((value: unknown) => value);
    expect(readError).toMatchObject({ code: "ADAPTER_FAILED", operation: "readPluginConfiguration" });
    expect((readError as Error).message).not.toContain(canary);
    expect((readError as { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(readError)).not.toContain("CANARY_CONFIG_READ_FAILURE");

    const replaceFailure = new FakeConfigurationStore();
    replaceFailure.failReplace = true;
    const replaceError = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "secret" }), deps(replaceFailure, new FakeSecretStore()), new AbortController().signal)
      .catch((value: unknown) => value);
    expect(replaceError).toMatchObject({ code: "ADAPTER_FAILED", operation: "replacePluginConfiguration" });
    expect(JSON.stringify(replaceError)).not.toContain("CANARY_CONFIG_REPLACE_FAILURE");

    const secretFailure = new FakeSecretStore();
    secretFailure.failPut = true;
    const secretError = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "CANARY_SECRET" }), deps(new FakeConfigurationStore(), secretFailure), new AbortController().signal)
      .catch((value: unknown) => value);
    expect(secretError).toMatchObject({ code: "ADAPTER_FAILED", operation: "putConfigurationSecret" });
    expect(JSON.stringify(secretError)).not.toContain("CANARY_SECRET");
  });

  it("preserves omitted secrets, replaces supplied secrets, and cleans superseded locators after CAS", async () => {
    const configurations = new FakeConfigurationStore();
    const secrets = new FakeSecretStore();
    const first = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "first" }), deps(configurations, secrets), new AbortController().signal);
    if (first.kind !== "stored") throw new Error("expected stored");
    const oldLocator = first.document.secrets[0]!.locator;
    const preserved = await savePluginConfiguration(request({ NAME: "changed" }), deps(configurations, secrets), new AbortController().signal);
    expect(preserved.kind).toBe("stored");
    expect(secrets.values.has(oldLocator)).toBe(true);
    const replaced = await savePluginConfiguration(request({ NAME: "changed", TOKEN: "second" }), deps(configurations, secrets), new AbortController().signal);
    expect(replaced.kind).toBe("stored");
    if (replaced.kind !== "stored") return;
    expect(replaced.document.secrets[0]!.locator).not.toBe(oldLocator);
    expect(secrets.values.has(oldLocator)).toBe(false);
  });

  it("leaves old authority intact on stale CAS and cleans fresh locators", async () => {
    const configurations = new FakeConfigurationStore();
    const secrets = new FakeSecretStore();
    const initial = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "first" }), deps(configurations, secrets), new AbortController().signal);
    if (initial.kind !== "stored") throw new Error("expected stored");
    const oldLocator = initial.document.secrets[0]!.locator;
    configurations.stale = true;
    const stale = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "second" }), deps(configurations, secrets), new AbortController().signal);
    expect(stale.kind).toBe("stale");
    expect(configurations.document?.secrets[0]?.locator).toBe(oldLocator);
    expect([...secrets.values.keys()]).toEqual([oldLocator]);
  });

  it("retires the document before deleting credentials and preserves active data on stale CAS", async () => {
    const configurations = new FakeConfigurationStore();
    const secrets = new FakeSecretStore();
    await savePluginConfiguration(request({ NAME: "demo", TOKEN: "first" }), deps(configurations, secrets), new AbortController().signal);
    const locator = [...secrets.values.keys()][0]!;
    configurations.removeResult = "stale";
    const result = await removePluginConfiguration({ configurationRef, plugin: "demo@catalog", scope, descriptors, confirmedSecretDeletion: true }, deps(configurations, secrets), new AbortController().signal);
    expect(result).toEqual({ kind: "stale", removedLocators: [] });
    expect(configurations.document?.secrets[0]?.locator).toBe(locator);
    expect(secrets.values.has(locator)).toBe(true);
  });

  it("returns typed cleanup evidence when cancellation follows a secret write", async () => {
    const configurations = new FakeConfigurationStore();
    const secrets = new FakeSecretStore();
    const controller = new AbortController();
    secrets.abortAfterPut = controller;
    const error = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "first" }), deps(configurations, secrets), controller.signal)
      .then(() => undefined, (value: unknown) => value);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(secrets.values.size).toBe(0);
    expect(configurations.document).toBeUndefined();
  });

  it("uses a create-only collision barrier for duplicate write IDs", async () => {
    const configurations = new FakeConfigurationStore();
    const secrets = new FakeSecretStore();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    secrets.beforePut = async () => {
      entered += 1;
      if (entered === 2) release();
      await barrier;
    };
    const duplicateIds: ConfigurationWriteIdPort = {
      create: async () => `config-write-v1:${"z".repeat(22)}`,
    };

    const [first, second] = await Promise.all([
      savePluginConfiguration(request({ NAME: "first", TOKEN: "FIRST_SECRET" }), deps(configurations, secrets, duplicateIds), new AbortController().signal),
      savePluginConfiguration(request({ NAME: "second", TOKEN: "SECOND_SECRET" }), deps(configurations, secrets, duplicateIds), new AbortController().signal),
    ]);
    const results = [first, second];
    expect(results.filter((result) => result.kind === "stored")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "secret-collision")).toHaveLength(1);
    const winner = results.find((result) => result.kind === "stored");
    if (winner?.kind !== "stored") throw new Error("expected one winning configuration");
    expect(secrets.values.size).toBe(1);
    expect(secrets.removeOwnedCalls).toEqual([]);
    const locator = winner.document.secrets[0]!.locator;
    const stored = await secrets.get(locator, new AbortController().signal);
    expect(stored.kind).toBe("found");
    if (stored.kind === "found") {
      expect(withSensitiveValue(stored.value, (value) => value)).toBe(
        winner.document.values.find((entry) => entry.key === "NAME")?.value.value === "first"
          ? "FIRST_SECRET"
          : "SECOND_SECRET",
      );
    }
  });

  it("retains fresh credentials when CAS commits before throwing", async () => {
    const configurations = new FakeConfigurationStore();
    const secrets = new FakeSecretStore();
    const initial = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "first" }), deps(configurations, secrets), new AbortController().signal);
    if (initial.kind !== "stored") throw new Error("expected stored");
    const oldLocator = initial.document.secrets[0]!.locator;
    configurations.throwAfterReplace = true;

    const result = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "second" }), deps(configurations, secrets), new AbortController().signal);
    expect(result.kind).toBe("stored");
    expect(configurations.document?.secrets[0]?.locator).not.toBe(oldLocator);
    expect(secrets.values.has(oldLocator)).toBe(false);
    expect(secrets.values.size).toBe(1);
  });

  it("retains every fresh locator when a descendant preserves the candidate credentials", async () => {
    const configurations = new FakeConfigurationStore();
    const secrets = new FakeSecretStore();
    const initial = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "first" }), deps(configurations, secrets), new AbortController().signal);
    if (initial.kind !== "stored") throw new Error("expected stored");
    const oldLocator = initial.document.secrets[0]!.locator;
    let candidate: PluginConfigurationDocument | undefined;
    configurations.throwAfterReplace = true;
    configurations.afterReplace = (document) => {
      candidate = document;
      return createPluginConfigurationDocument({
        schemaVersion: 1,
        configurationRef: document.configurationRef,
        plugin: document.plugin,
        scope: document.scope,
        descriptorDigest: document.descriptorDigest,
        values: [{ key: "NAME", value: { kind: "string", value: "descendant" } }],
        secrets: document.secrets,
      }, sha256);
    };

    const result = await savePluginConfiguration(
      request({ NAME: "demo", TOKEN: "second", OPTIONAL: "optional" }),
      deps(configurations, secrets),
      new AbortController().signal,
    );

    expect(result.kind).toBe("stored");
    expect(candidate).toBeDefined();
    for (const entry of candidate?.secrets ?? []) expect(secrets.values.has(entry.locator)).toBe(true);
    expect(secrets.values.has(oldLocator)).toBe(false);
    expect(configurations.document?.values[0]?.value).toEqual({ kind: "string", value: "descendant" });
  });

  it("cleans only fresh locators replaced by a descendant", async () => {
    const configurations = new FakeConfigurationStore();
    const secrets = new FakeSecretStore();
    const initial = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "first" }), deps(configurations, secrets), new AbortController().signal);
    if (initial.kind !== "stored") throw new Error("expected stored");
    const oldLocator = initial.document.secrets[0]!.locator;
    let replacedOptionalLocator: string | undefined;
    let candidateOptionalLocator: string | undefined;
    let candidateTokenLocator: string | undefined;
    configurations.throwAfterReplace = true;
    configurations.afterReplace = (document) => {
      candidateTokenLocator = document.secrets.find((entry) => entry.key === "TOKEN")?.locator;
      candidateOptionalLocator = document.secrets.find((entry) => entry.key === "OPTIONAL")?.locator;
      replacedOptionalLocator = deriveSecretLocator({
        scope,
        plugin: "demo@catalog",
        configurationRef,
        key: "OPTIONAL",
        writeId: `config-write-v1:${"d".repeat(22)}`,
      }, sha256);
      secrets.values.set(replacedOptionalLocator, SensitiveValue.fromUnknown("descendant-optional"));
      return createPluginConfigurationDocument({
        schemaVersion: 1,
        configurationRef: document.configurationRef,
        plugin: document.plugin,
        scope: document.scope,
        descriptorDigest: document.descriptorDigest,
        values: document.values,
        secrets: [
          { key: "TOKEN", locator: candidateTokenLocator },
          { key: "OPTIONAL", locator: replacedOptionalLocator },
        ],
      }, sha256);
    };

    const result = await savePluginConfiguration(
      request({ NAME: "demo", TOKEN: "second", OPTIONAL: "optional" }),
      deps(configurations, secrets),
      new AbortController().signal,
    );

    expect(result.kind).toBe("stored");
    expect(candidateTokenLocator).toBeDefined();
    expect(candidateOptionalLocator).toBeDefined();
    expect(replacedOptionalLocator).toBeDefined();
    expect(secrets.values.has(candidateTokenLocator!)).toBe(true);
    expect(secrets.values.has(candidateOptionalLocator!)).toBe(false);
    expect(secrets.values.has(replacedOptionalLocator!)).toBe(true);
    expect(secrets.values.has(oldLocator)).toBe(false);
  });

  it("cleans fresh locators when authority proves the candidate inactive", async () => {
    const configurations = new FakeConfigurationStore();
    const secrets = new FakeSecretStore();
    const initial = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "first" }), deps(configurations, secrets), new AbortController().signal);
    if (initial.kind !== "stored") throw new Error("expected stored");
    const oldLocator = initial.document.secrets[0]!.locator;
    configurations.throwAfterReplace = true;
    configurations.afterReplace = () => initial.document!;

    const error = await savePluginConfiguration(
      request({ NAME: "demo", TOKEN: "second" }),
      deps(configurations, secrets),
      new AbortController().signal,
    ).then(() => undefined, (value: unknown) => value);

    expect(error).toMatchObject({ code: "ADAPTER_FAILED" });
    expect(secrets.values.size).toBe(1);
    expect(secrets.values.has(oldLocator)).toBe(true);
  });

  it("retains fresh credentials and returns locator-only evidence when reconciliation is unavailable", async () => {
    const configurations = new FakeConfigurationStore();
    const secrets = new FakeSecretStore();
    const initial = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "first" }), deps(configurations, secrets), new AbortController().signal);
    if (initial.kind !== "stored") throw new Error("expected stored");
    configurations.throwAfterReplace = true;
    configurations.failReconciliationRead = true;

    const result = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "second" }), deps(configurations, secrets), new AbortController().signal);
    expect(result.kind).toBe("ambiguous-with-recovery-required");
    if (result.kind !== "ambiguous-with-recovery-required") return;
    expect(result.recovery.code).toBe("CONFIGURATION_RECONCILIATION_REQUIRED");
    expect(JSON.stringify(result)).not.toContain("secret-v1:");
    expect(JSON.stringify(result)).not.toContain("second");
    expect(secrets.values.size).toBe(2);
    configurations.failReconciliationRead = false;
    await expect(result.recovery.recovery.settle(new AbortController().signal))
      .resolves.toMatchObject({ kind: "stored", document: { revision: configurations.document?.revision } });
    expect(secrets.values.size).toBe(1);
  });

  it("retains fresh credentials and returns safe evidence for malformed authority", async () => {
    const configurations = new FakeConfigurationStore();
    const secrets = new FakeSecretStore();
    const initial = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "first" }), deps(configurations, secrets), new AbortController().signal);
    if (initial.kind !== "stored") throw new Error("expected stored");
    configurations.throwAfterReplace = true;
    configurations.malformedReconciliationRead = true;

    const result = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "second" }), deps(configurations, secrets), new AbortController().signal);

    expect(result.kind).toBe("ambiguous-with-recovery-required");
    expect(JSON.stringify(result)).not.toContain("second");
    expect(JSON.stringify(result)).not.toContain("CANARY_CONFIG_READ_FAILURE");
    expect(secrets.values.size).toBe(2);
  });

  it("reconciles a commit followed by abort without deleting the active credential", async () => {
    const configurations = new FakeConfigurationStore();
    const secrets = new FakeSecretStore();
    const initial = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "first" }), deps(configurations, secrets), new AbortController().signal);
    if (initial.kind !== "stored") throw new Error("expected stored");
    const controller = new AbortController();
    configurations.throwAfterReplace = true;
    configurations.abortAfterReplace = controller;

    const result = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "second" }), deps(configurations, secrets), controller.signal);
    expect(result.kind).toBe("stored");
    expect(secrets.values.size).toBe(1);
    expect(configurations.document?.secrets).toHaveLength(1);
  });

  it("reports post-CAS cleanup failure without invalidating the active new document", async () => {
    const configurations = new FakeConfigurationStore();
    const secrets = new FakeSecretStore();
    const initial = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "first" }), deps(configurations, secrets), new AbortController().signal);
    if (initial.kind !== "stored") throw new Error("expected stored");
    const oldLocator = initial.document.secrets[0]!.locator;
    secrets.failRemove.add(oldLocator);
    const result = await savePluginConfiguration(request({ NAME: "demo", TOKEN: "second" }), deps(configurations, secrets), new AbortController().signal);
    expect(result.kind).toBe("stored-with-cleanup-required");
    expect(configurations.document?.secrets[0]?.locator).not.toBe(oldLocator);
    if (result.kind !== "stored-with-cleanup-required") return;
    expect(JSON.stringify(result)).not.toContain(oldLocator);
    await expect(result.cleanup.recovery.settle(new AbortController().signal))
      .resolves.toEqual({ kind: "recovery-required" });
    secrets.failRemove.delete(oldLocator);
    await expect(result.cleanup.recovery.settle(new AbortController().signal))
      .resolves.toEqual({ kind: "settled" });
    expect(secrets.values.has(oldLocator)).toBe(false);
  });

  it("requires literal deletion confirmation and exposes partial removal safely", async () => {
    const configurations = new FakeConfigurationStore();
    const secrets = new FakeSecretStore();
    await savePluginConfiguration(request({ NAME: "demo", TOKEN: "first" }), deps(configurations, secrets), new AbortController().signal);
    await expect(removePluginConfiguration({ configurationRef, plugin: "demo@catalog", scope, descriptors, confirmedSecretDeletion: false as false }, deps(configurations, secrets), new AbortController().signal)).rejects.toThrow();
    const locator = [...secrets.values.keys()][0]!;
    secrets.failRemove.add(locator);
    const partial = await removePluginConfiguration({ configurationRef, plugin: "demo@catalog", scope, descriptors, confirmedSecretDeletion: true }, deps(configurations, secrets), new AbortController().signal);
    expect(partial.kind).toBe("partial-failure");
    expect(JSON.stringify(partial)).not.toContain("first");
  });
});
