import { describe, expect, it } from "vitest";
import { detailCommand, hostStatusCommand, nativeControlArgv, pageCommand, updateNoticesCommand, updatePolicySetCommand } from "../../../src/pi/manager/plugin-manager-commands.js";

describe("plugin manager command projection", () => {
  it("maps user-facing sections through registry-owned facade paths", () => {
    expect(pageCommand({ view: "installed", query: "" }).slice(0, 1)).toEqual(["list"]);
    expect(pageCommand({ view: "browse", query: "" }).slice(0, 1)).toEqual(["browse"]);
    expect(pageCommand({ view: "marketplaces", query: "" }).slice(0, 2)).toEqual(["marketplace", "list"]);
    expect(updateNoticesCommand().slice(0, 3)).toEqual(["updates", "notices", "list"]);
    expect(hostStatusCommand()).toEqual(["status"]);
  });

  it("uses concise canonical product paths while preserving exact evidence", () => {
    expect(nativeControlArgv("install.run", ["demo@market"], { scope: "user" })).toEqual(["add", "demo@market", "--scope", "user"]);
    expect(nativeControlArgv("lifecycle.uninstall", ["demo@market"], { scope: "user", keepData: true })).toEqual(["remove", "demo@market", "--scope", "user", "--keep-data"]);
    expect(detailCommand({ key: { subject: "notice", key: "notice-1" }, title: "demo@market", subtitle: "", status: "manual-required", plugin: "demo@market", completion: { category: "notice", value: "notice-1", safe: { text: "demo@market", escaped: false, truncated: false } }, data: {} })).toBeUndefined();
  });

  it("serializes global update policy changes and their exact consent round trip", () => {
    expect(updatePolicySetCommand({ policyKind: "application", policyMode: "automatic" })).toEqual([
      "updates", "policy", "set", "--kind", "application", "--target", "global", "--mode", "automatic",
    ]);
    expect(updatePolicySetCommand({ policyKind: "cadence", cadence: "conservative" }, { previewId: "preview-1", consentId: "consent-1" })).toEqual([
      "updates", "policy", "set", "--kind", "cadence", "--target", "global", "--cadence", "conservative", "--preview-id", "preview-1", "--consent-id", "consent-1",
    ]);
    expect(updatePolicySetCommand({ policyKind: "application", policyMode: "manual" })).not.toContain("--consent-id");
  });
});
