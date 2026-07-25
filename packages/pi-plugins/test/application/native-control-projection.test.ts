import { describe, expect, it } from "vitest";
import { projectNativeControlResponse } from "../../src/application/native-control-projection.js";

describe("native control response projection", () => {
  it("validates owner data before redacting path-bearing machine fields", () => {
    const result = projectNativeControlResponse("marketplace.list", { registrations: [] });
    expect(result).toMatchObject({ status: "ok", data: { registrations: [] } });
    expect(() => projectNativeControlResponse("marketplace.list", { registrations: [], extra: true })).toThrow();
  });

  it("reparses command-specific source projections without private hosts, SSH users, or local paths", () => {
    const registration = (suffix: string, source: unknown) => ({
      id: `marketplace-registration-v1:sha256:${suffix.repeat(64)}`,
      scope: { kind: "user" },
      marketplace: `market-${suffix}`,
      source,
      sourceIdentity: `sha256:${suffix.repeat(64)}`,
      origin: { kind: "native" },
      updateApplication: "manual",
      refresh: { consecutiveFailures: 0 },
      cache: { kind: "not-materialized" },
    });
    const result = projectNativeControlResponse("marketplace.list", {
      registrations: [
        registration("a", { kind: "git", url: "ssh://alice@10.0.0.8/private/repository.git" }),
        registration("b", { kind: "local-git", path: "/home/alice/private/plugins" }),
      ],
    });
    const serialized = JSON.stringify(result.data);
    expect(serialized).toContain("[redacted-private-host]");
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("10.0.0.8");
    expect(serialized).not.toContain("/home/");
    expect(result.data).toMatchObject({ registrations: [{ source: { kind: "git", endpoint: { host: { text: "[redacted-private-host]" } } } }, { source: { kind: "local-git" } }] });
  });
});
