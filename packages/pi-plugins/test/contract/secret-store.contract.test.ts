import { describe, it } from "vitest";
import { assertSecretStoreContract } from "./secret-store.contract.js";
import type { SecretCreationEvidence, SecretStore } from "../../src/application/ports/secret-store.js";

class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, import("../../src/application/sensitive-value.js").SensitiveValue>();
  private readonly owned = new WeakMap<object, string>();
  async put(locator: string, value: import("../../src/application/sensitive-value.js").SensitiveValue) {
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

describe("secret store port contract", () => {
  it("distinguishes missing/found/removal without plaintext result shapes", async () => {
    await assertSecretStoreContract(() => new InMemorySecretStore());
  });
});
