import type { SecretStore } from "../../application/ports/secret-store.js";
import { createUnavailableSecretStore } from "./unavailable-secret-store.js";

export type PlatformSecretStoreResult = Readonly<{
  store: SecretStore;
  availability: Readonly<{
    status: "unavailable";
    provider: "unsupported-platform" | "missing-provider";
    explanation: string;
  }>;
  close(): Promise<void>;
}>;

/**
 * Secret Service's CreateItem(replace=false) does not provide uniqueness for
 * an attribute set, so it cannot implement this host's atomic no-replace
 * ownership contract. Production therefore remains fail-closed until an OS
 * backend can prove a stable winner and stale-safe deletion.
 */
export async function createPlatformSecretStore(input: Readonly<{
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
}> = {}): Promise<PlatformSecretStoreResult> {
  input.signal?.throwIfAborted();
  const supportedPlatform = (input.platform ?? process.platform) === "linux";
  return Object.freeze({
    store: createUnavailableSecretStore(),
    availability: Object.freeze({
      status: "unavailable",
      provider: supportedPlatform ? "missing-provider" : "unsupported-platform",
      explanation: supportedPlatform
        ? "Secret Service cannot prove atomic no-replace ownership; credential custody is fail-closed"
        : "no safe operating-system credential adapter is available on this platform",
    }),
    async close() {},
  });
}
