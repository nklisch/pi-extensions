import type { SecretStore } from "../../application/ports/secret-store.js";

export class SecretStoreUnavailableError extends Error {
  readonly code = "SECRET_STORE_UNAVAILABLE" as const;

  constructor() {
    super("operating-system credential storage is unavailable");
    this.name = "SecretStoreUnavailableError";
  }

  toJSON(): Readonly<{ code: string; message: string }> {
    return Object.freeze({ code: this.code, message: this.message });
  }
}

export function createUnavailableSecretStore(): SecretStore {
  const unavailable = async (): Promise<never> => {
    throw new SecretStoreUnavailableError();
  };
  return Object.freeze({
    put: unavailable,
    get: unavailable,
    remove: unavailable,
    removeOwned: unavailable,
  });
}
