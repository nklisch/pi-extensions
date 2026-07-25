import { describe, expect, it } from "vitest";
import { SensitiveValue } from "../../../src/application/sensitive-value.js";
import { SecretLocatorSchema } from "../../../src/domain/configured-values.js";
import { createPlatformSecretStore } from "../../../src/infrastructure/secrets/create-platform-secret-store.js";

const locator = SecretLocatorSchema.parse(`secret-v1:sha256:${"3".repeat(64)}`);

describe("platform secret store", () => {
  it("fails closed on Linux because Secret Service cannot prove atomic no-replace ownership", async () => {
    const platform = await createPlatformSecretStore({ platform: "linux" });
    expect(platform.availability).toMatchObject({ status: "unavailable", provider: "missing-provider" });
    await expect(platform.store.put(locator, SensitiveValue.fromUnknown("CANARY_SECRET"), new AbortController().signal))
      .rejects.toMatchObject({ code: "SECRET_STORE_UNAVAILABLE" });
    expect(JSON.stringify(platform)).not.toContain("CANARY_SECRET");
    await platform.close();
  });

  it("reports unsupported platforms without attempting a fallback", async () => {
    const platform = await createPlatformSecretStore({ platform: "darwin" });
    expect(platform.availability).toMatchObject({ status: "unavailable", provider: "unsupported-platform" });
    await platform.close();
  });
});
