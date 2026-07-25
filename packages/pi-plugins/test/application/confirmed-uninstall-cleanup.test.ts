import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { derivePluginDataRef } from "../../src/domain/state/references.js";
import { createConfirmedUninstallCleanup } from "../../src/application/confirmed-uninstall-cleanup.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const dataRef = derivePluginDataRef({ scope: { kind: "user" }, plugin: "demo@community", purpose: "persistent-plugin-data" }, sha256);

describe("confirmed uninstall cleanup", () => {
  it("makes keep structurally skip configuration and data removal", async () => {
    let calls = 0;
    const service = createConfirmedUninstallCleanup({
      async removeConfiguration() { calls += 1; return "removed"; },
      data: { async remove() { calls += 1; return "removed"; } },
    });
    await expect(service.cleanup({ scope: { kind: "user" }, plugin: "demo@community" as never, retainedData: "keep", terminalUninstall: true, noLiveOrUnknownLease: true, graceElapsed: true, dataRef }, new AbortController().signal)).resolves.toEqual({ kind: "skipped", reason: "KEEP" });
    expect(calls).toBe(0);
  });

  it("retains data when explicit configuration cleanup fails", async () => {
    let dataCalls = 0;
    const service = createConfirmedUninstallCleanup({
      async removeConfiguration() { return "partial-failure"; },
      data: { async remove() { dataCalls += 1; return "removed"; } },
    });
    await expect(service.cleanup({ scope: { kind: "user" }, plugin: "demo@community" as never, retainedData: "delete-confirmed", terminalUninstall: true, noLiveOrUnknownLease: true, graceElapsed: true, dataRef, configurationRef: "plugin-configuration-v1:sha256:" + "a".repeat(64) as never }, new AbortController().signal)).resolves.toEqual({ kind: "partial-failure", reason: "CONFIGURATION", retained: true });
    expect(dataCalls).toBe(0);
  });
});
