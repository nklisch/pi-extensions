import { SensitiveValue, withSensitiveValue } from "../../src/application/sensitive-value.js";
import { SecretLocatorSchema } from "../../src/domain/configured-values.js";
import type { SecretStore } from "../../src/application/ports/secret-store.js";
import { SecretStoreCreateResultSchema } from "../../src/application/ports/secret-store.js";

/** Shared adapter-neutral contract; concrete OS adapters can reuse this suite. */
export async function assertSecretStoreContract(create: () => SecretStore): Promise<void> {
  const store = create();
  const locator = SecretLocatorSchema.parse(`secret-v1:sha256:${"1".repeat(64)}`);
  const signal = new AbortController().signal;
  expectResult(await store.get(locator, signal), "missing");
  const secret = SensitiveValue.fromUnknown("CANARY_SECRET");
  const created = SecretStoreCreateResultSchema.parse(await store.put(locator, secret, signal));
  if (created.kind !== "created") throw new Error("secret store must create a missing locator");
  const collision = SecretStoreCreateResultSchema.parse(await store.put(locator, SensitiveValue.fromUnknown("OVERWRITE_CANARY"), signal));
  if (collision.kind !== "collision") throw new Error("secret store must report a typed collision");
  const found = await store.get(locator, signal);
  if (found.kind !== "found" || withSensitiveValue(found.value, (value) => value) !== "CANARY_SECRET") {
    throw new Error("secret store create-only behavior must preserve the winner");
  }
  if (JSON.stringify(found).includes("CANARY_SECRET")) throw new Error("secret store result leaked plaintext");
  let forgedRejected = false;
  try {
    await store.removeOwned(Object.freeze({}), signal);
  } catch {
    forgedRejected = true;
  }
  if (!forgedRejected) throw new Error("secret store must reject forged creation evidence");
  if (await store.removeOwned(created.evidence, signal) !== "removed") throw new Error("secret store must remove owned value");
  if (await store.remove(locator, signal) !== "missing") throw new Error("secret store must distinguish missing removal");
}

function expectResult(value: unknown, kind: string): void {
  if (value === null || typeof value !== "object" || (value as { kind?: unknown }).kind !== kind) {
    throw new Error(`expected secret store result ${kind}`);
  }
}
