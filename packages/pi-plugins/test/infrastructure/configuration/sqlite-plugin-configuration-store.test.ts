import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginConfigurationDocument } from "../../../src/domain/configured-values.js";
import { derivePluginConfigurationRef } from "../../../src/domain/state/references.js";
import { createSqlitePluginConfigurationStore } from "../../../src/infrastructure/configuration/sqlite-plugin-configuration-store.js";

const roots: string[] = [];
const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "plugin-host-config-"));
  roots.push(root);
  const store = await createSqlitePluginConfigurationStore({ root, verifyLocalFilesystem: async () => {} });
  const configurationRef = derivePluginConfigurationRef({ scope: { kind: "user" }, plugin: "demo@catalog", purpose: "test" }, sha256);
  const document = createPluginConfigurationDocument({
    schemaVersion: 1,
    configurationRef,
    plugin: "demo@catalog",
    scope: { kind: "user" },
    descriptorDigest: `sha256:${"1".repeat(64)}`,
    values: [{ key: "NAME", value: { kind: "string", value: "demo" } }],
    secrets: [],
  }, sha256);
  return { root, store, configurationRef, document };
}

describe("SQLite plugin configuration store", () => {
  it("uses process-safe exact revision CAS without storing plaintext secrets", async () => {
    const { store, configurationRef, document } = await fixture();
    const signal = new AbortController().signal;
    expect(await store.read(configurationRef, signal)).toEqual({ kind: "missing" });
    const [first, second] = await Promise.all([
      store.replace({ expectedRevision: null, document }, signal),
      store.replace({ expectedRevision: null, document }, signal),
    ]);
    expect([first.kind, second.kind].sort()).toEqual(["stale", "stored"]);
    expect(await store.read(configurationRef, signal)).toEqual({ kind: "found", document });
    expect(await store.remove({ ref: configurationRef, expectedRevision: `sha256:${"0".repeat(64)}`, confirmedSecretDeletion: true }, signal)).toBe("stale");
    expect(await store.remove({ ref: configurationRef, expectedRevision: document.revision, confirmedSecretDeletion: true }, signal)).toBe("removed");
    await store[Symbol.asyncDispose]();
    await store[Symbol.asyncDispose]();
  });

  it("rejects malformed documents before opening a transaction", async () => {
    const { store, document } = await fixture();
    await expect(store.replace({ expectedRevision: null, document: { ...document, plaintext: "CANARY_SECRET" } as never }, new AbortController().signal)).rejects.toThrow();
    await store[Symbol.asyncDispose]();
  });
});
