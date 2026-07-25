import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createNativeInspectionReadiness } from "../../src/composition/native-inspection-readiness.js";
import { createPluginConfigurationDocument, digestConfigurationDescriptors } from "../../src/domain/configured-values.js";
import { directPlugin, claimFixture, sha256 as fixtureSha } from "../fixtures/compatibility/common.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const configurationRef = `plugin-configuration-v1:sha256:${"11".repeat(32)}` as never;

function descriptor() {
  return directPlugin({ configuration: { options: [
    { key: "PLAIN", label: claimFixture("Plain\u001b[2J"), value: { kind: "string" }, required: true, sensitive: false, provenance: [claimFixture("x").provenance[0]] },
    { key: "TOKEN", label: claimFixture("Token"), value: { kind: "string" }, required: true, sensitive: true, provenance: [claimFixture("x").provenance[0]] },
  ] } }).configuration;
}

describe("native inspection readiness", () => {
  it("projects configuration presence without values or secret locators", async () => {
    const descriptors = descriptor();
    const document = createPluginConfigurationDocument({
      schemaVersion: 1,
      configurationRef,
      plugin: "fixture@compatibility",
      scope: { kind: "user" },
      descriptorDigest: digestConfigurationDescriptors(descriptors, fixtureSha),
      values: [{ key: "PLAIN", value: { kind: "string", value: "VALUE_CANARY" } }],
      secrets: [{ key: "TOKEN", locator: `secret-v1:sha256:${"22".repeat(32)}` }],
    }, fixtureSha);
    const readiness = createNativeInspectionReadiness({
      state: { read: async () => { throw new Error("unused"); }, commit: async () => { throw new Error("mutating"); } } as never,
      configurations: { read: async () => ({ kind: "found", document }), replace: async () => { throw new Error("mutating"); }, remove: async () => { throw new Error("mutating"); } },
      projectTrust: { assess: async () => ({ kind: "trusted" }) },
      secretCustody: { status: "available", explanation: "ready" },
      sha256: fixtureSha,
    });
    const result = await readiness.configuration({ plugin: "fixture@compatibility" as never, scope: { kind: "user" }, descriptors, configurationRef }, new AbortController().signal);
    expect(result.map((item) => item.state)).toEqual(["configured", "configured"]);
    expect(result[0]?.label.escaped).toBe(true);
    const json = JSON.stringify(result);
    expect(json).not.toContain("VALUE_CANARY");
    expect(json).not.toContain("secret-v1");
  });

  it("reports sensitive presence unavailable when custody is absent", async () => {
    const descriptors = descriptor();
    const document = createPluginConfigurationDocument({
      schemaVersion: 1,
      configurationRef,
      plugin: "fixture@compatibility",
      scope: { kind: "user" },
      descriptorDigest: digestConfigurationDescriptors(descriptors, fixtureSha),
      values: [{ key: "PLAIN", value: { kind: "string", value: "VALUE_CANARY" } }],
      secrets: [{ key: "TOKEN", locator: `secret-v1:sha256:${"22".repeat(32)}` }],
    }, fixtureSha);
    const readiness = createNativeInspectionReadiness({
      state: {} as never,
      configurations: { read: async () => ({ kind: "found", document }), replace: async () => { throw new Error("mutating"); }, remove: async () => { throw new Error("mutating"); } },
      projectTrust: { assess: async () => ({ kind: "trusted" }) },
      secretCustody: { status: "unavailable", explanation: "none" },
      sha256,
    });
    const result = await readiness.configuration({ plugin: "fixture@compatibility" as never, scope: { kind: "user" }, descriptors, configurationRef }, new AbortController().signal);
    expect(result.find((item) => item.key === "PLAIN")?.state).toBe("configured");
    expect(result.find((item) => item.key === "TOKEN")?.state).toBe("unavailable");

    const missing = await readiness.configuration({ plugin: "fixture@compatibility" as never, scope: { kind: "user" }, descriptors }, new AbortController().signal);
    expect(missing.find((item) => item.key === "PLAIN")?.state).toBe("missing");
    expect(missing.find((item) => item.key === "TOKEN")?.state).toBe("unavailable");
  });
});
