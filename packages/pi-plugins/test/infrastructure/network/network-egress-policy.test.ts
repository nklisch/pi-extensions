import { describe, expect, it, vi } from "vitest";
import {
  NetworkEgressPolicyError,
  createNetworkEgressPolicy,
  networkEgressPolicyOptionsFromEnvironment,
  type NetworkLookup,
} from "../../../src/infrastructure/network/network-egress-policy.js";

const publicLookup: NetworkLookup = async () => [{ address: "93.184.216.34", family: 4 }];

describe("network egress policy", () => {
  it.each([
    "https://127.0.0.1/repo.git",
    "https://127.1/repo.git",
    "https://2130706433/repo.git",
    "https://0x7f000001/repo.git",
    "https://169.254.169.254/latest/meta-data",
    "https://10.0.0.1/repo.git",
    "https://172.16.1.1/repo.git",
    "https://192.168.1.1/repo.git",
    "https://[::1]/repo.git",
    "https://[fe80::1]/repo.git",
    "https://[fc00::1]/repo.git",
    "https://[::ffff:127.0.0.1]/repo.git",
    "https://[::ffff:10.0.0.1]/repo.git",
    "https://[2001:db8::1]/repo.git",
    "https://localhost/repo.git",
    "https://metadata.internal/repo.git",
  ])("rejects private and special destination %s before lookup", async (url) => {
    const lookup = vi.fn(publicLookup);
    const policy = createNetworkEgressPolicy({ lookup });
    await expect(policy.authorize(url, "https:")).rejects.toBeInstanceOf(NetworkEgressPolicyError);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    "https://192.0.3.1/repo.git",
    "https://198.51.101.1/repo.git",
    "https://203.0.114.1/repo.git",
  ])("does not over-block adjacent globally routable IPv4 space %s", async (url) => {
    await expect(createNetworkEgressPolicy().authorize(url)).resolves.toMatchObject({ family: 4 });
  });

  it("rejects mixed DNS answers and pins one stable public address", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "10.0.0.2", family: 4 as const },
    ]);
    const policy = createNetworkEgressPolicy({ lookup });
    await expect(policy.authorize("https://packages.example.org/repo.git"))
      .rejects.toMatchObject({ kind: "policy" });

    lookup.mockResolvedValueOnce([{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]);
    const target = await policy.authorize("https://packages.example.org/repo.git");
    expect(target).toMatchObject({
      origin: "https://packages.example.org:443",
      address: "2606:2800:220:1:248:1893:25c8:1946",
      family: 6,
    });
  });

  it("permits only an exact explicitly approved private or loopback origin", async () => {
    const policy = createNetworkEgressPolicy({ privateOrigins: ["https://127.0.0.1:8443"] });
    await expect(policy.authorize("https://127.0.0.1:8443/repo.git")).resolves.toMatchObject({
      address: "127.0.0.1",
      credentialsApproved: false,
    });
    await expect(policy.authorize("https://127.0.0.1/repo.git")).rejects.toMatchObject({ kind: "policy" });
  });

  it("detects DNS changes on each acquisition while the approved target remains pinned", async () => {
    let call = 0;
    const policy = createNetworkEgressPolicy({
      lookup: async () => call++ === 0
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "192.168.1.20", family: 4 }],
    });
    const first = await policy.authorize("https://packages.example.org/repo.git");
    expect(first.address).toBe("93.184.216.34");
    await expect(policy.authorize("https://packages.example.org/repo.git"))
      .rejects.toMatchObject({ kind: "policy" });
  });

  it("keeps private, credential, and redirect authorities exact and independent", async () => {
    const policy = createNetworkEgressPolicy({
      lookup: async () => [{ address: "10.20.30.40", family: 4 }],
      privateOrigins: ["https://git.enterprise.example:8443", "ssh://git@git.enterprise.example:22"],
      credentialOrigins: ["https://git.enterprise.example:8443"],
      redirectOrigins: ["https://cdn.enterprise.example:443"],
    });
    await expect(policy.authorize("https://git.enterprise.example/repo.git"))
      .rejects.toMatchObject({ kind: "policy" });
    const https = await policy.authorize("https://git.enterprise.example:8443/repo.git");
    expect(https).toMatchObject({ credentialsApproved: true });
    const ssh = await policy.authorize("git@git.enterprise.example:repo.git", "ssh:");
    expect(ssh).toMatchObject({ credentialsApproved: false });
    expect(policy.redirectAllowed(https.origin, https.origin)).toBe(true);
    expect(policy.redirectAllowed(https.origin, "https://cdn.enterprise.example:443")).toBe(true);
    expect(policy.redirectAllowed(https.origin, "https://evil.example:443")).toBe(false);
  });

  it("parses deterministic exact environment approvals and rejects malformed input", () => {
    expect(networkEgressPolicyOptionsFromEnvironment({
      PI_PLUGIN_HOST_PRIVATE_ORIGINS: '["https://z.example.org","https://a.example.org"]',
      PI_PLUGIN_HOST_CREDENTIAL_ORIGINS: '["ssh://git@git.example.org"]',
    })).toEqual({
      privateOrigins: ["https://a.example.org", "https://z.example.org"],
      credentialOrigins: ["ssh://git@git.example.org"],
    });
    expect(() => networkEgressPolicyOptionsFromEnvironment({
      PI_PLUGIN_HOST_PRIVATE_ORIGINS: "https://example.org",
    })).toThrow(TypeError);
  });

  it("rejects malformed approval entries instead of widening authority", () => {
    expect(() => createNetworkEgressPolicy({
      credentialOrigins: ["https://user:secret@example.org/path"],
    })).toThrow(TypeError);
  });
});
