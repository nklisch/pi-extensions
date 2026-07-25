import { describe, expect, it } from "vitest";
import { collectTrustedInstallSubmission } from "../../src/application/native-control-install.js";
import { unavailableNativeControlInput } from "../../src/application/native-control-input.js";

describe("native control trusted install bridge", () => {
  it("returns deterministic input unavailability before activation", async () => {
    const session = {
      version: 0,
      fields: [],
      consent: { consentId: `trusted-install-consent-v1:sha256:${"a".repeat(64)}` },
      binding: { plugin: "demo@market", scope: { kind: "user" }, immutableRevision: `sha256:${"b".repeat(64)}`, executableSurfaceDigest: `sha256:${"c".repeat(64)}` },
    };
    await expect(collectTrustedInstallSubmission({
      executionId: "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never,
      input: unavailableNativeControlInput,
      channel: { kind: "none" },
      purpose: "trusted-install",
      session: session as never,
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: "unavailable", code: "NO_INPUT_CHANNEL" });
  });
});
