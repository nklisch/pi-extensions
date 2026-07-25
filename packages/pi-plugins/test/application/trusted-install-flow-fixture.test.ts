import { describe, expect, it } from "vitest";
import { NativeInspectionDetailSchema } from "../../src/application/native-inspection-contract.js";
import {
  TrustedInstallActivationResultSchema,
  TrustedInstallConfigurationFieldSchema,
  TrustedInstallConsentDisclosureSchema,
} from "../../src/application/trusted-install-contract.js";
import { trustedInstallFlowFixture } from "../fixtures/trusted-install/plugin-install-flow.js";

describe("trusted installation signed flow data", () => {
  it("keeps all three mock steps schema-valid without UI behavior", () => {
    const inspected = NativeInspectionDetailSchema.parse(trustedInstallFlowFixture.chooseInspect);
    expect(inspected.compatibility.components.counts).toEqual({ skills: 1, hooks: 1, mcpServers: 1, foreign: 0 });
    expect(trustedInstallFlowFixture.configureTrust.fields.map((field) =>
      TrustedInstallConfigurationFieldSchema.parse(field).key)).toEqual(["NAME", "ROOT", "TOKEN"]);
    expect(TrustedInstallConsentDisclosureSchema.parse(trustedInstallFlowFixture.configureTrust.consent))
      .toMatchObject({ remoteMcpDiscovery: "not-performed", subagentInterception: "available" });
    expect(TrustedInstallActivationResultSchema.parse(trustedInstallFlowFixture.activationResult))
      .toMatchObject({ kind: "succeeded", components: { skills: 1, hooks: 1, mcpServers: 1 } });
    expect(JSON.stringify(trustedInstallFlowFixture)).not.toMatch(/<html|keybinding|terminalWidget|render\(/i);
  });
});
