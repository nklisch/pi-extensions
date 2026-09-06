import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { McpOAuthProvider } from "../mcp-oauth-provider.ts";
import { getAuthForUrl, saveAuthEntry } from "../mcp-auth.ts";
import { authFetch } from "../mcp-auth-flow.ts";
import { computeServerHash, isServerCacheValid } from "../metadata-cache.ts";

beforeEach(() => vi.stubEnv("PI_MCP_ADAPTER_TEST_AUTH_STORE", "memory"));
afterEach(() => vi.unstubAllEnvs());

describe("OAuth attempt ownership", () => {
  it.each(["tokens", "client", "all"] as const)("keeps another process's replacement during %s invalidation", async (kind) => {
    const name = `invalidation-${kind}`;
    const url = "https://example.test/mcp";
    saveAuthEntry(name, { tokens: { accessToken: "old" }, clientInfo: { clientId: "old-client", clientSecret: "old-secret" } }, url);
    const provider = new McpOAuthProvider(name, url, {}, { onRedirect: async () => {} });
    await provider.tokens(); await provider.clientInformation();
    saveAuthEntry(name, { tokens: { accessToken: "replacement" }, clientInfo: { clientId: "new-client", clientSecret: "new-secret" } }, url);
    await provider.invalidateCredentials(kind);
    expect(getAuthForUrl(name, url)?.tokens?.accessToken).toBe("replacement");
    expect((await provider.tokens())?.access_token).toBe("replacement");
    expect((await provider.clientInformation())?.client_id).toBe("new-client");
  });

  it("suppresses only the rejected credential, without deleting it", async () => {
    const url = "https://example.test/mcp";
    saveAuthEntry("local-invalidation", { tokens: { accessToken: "rejected" } }, url);
    const provider = new McpOAuthProvider("local-invalidation", url, {}, { onRedirect: async () => {} });
    await provider.tokens();
    await provider.invalidateCredentials("tokens");
    expect(await provider.tokens()).toBeUndefined();
    expect(getAuthForUrl("local-invalidation", url)?.tokens?.accessToken).toBe("rejected");
  });

  it("adopts a replacement after invalidating an issuer-pinned stale redirect client", async () => {
    const url = "https://example.test/mcp";
    const issuer = "https://issuer.example.test";
    saveAuthEntry("pinned-client", { clientInfo: { clientId: "old", clientSecret: "old-secret", redirectUris: ["http://localhost:1/callback"] }, tokens: { accessToken: "old-token" } }, url);
    const provider = new McpOAuthProvider("pinned-client", url, { redirectUri: "http://localhost:2/callback" }, { onRedirect: async () => {} });
    await provider.saveDiscoveryState({ authorizationServerUrl: issuer, authorizationServerMetadata: { issuer } } as any);
    await provider.clientInformation(); await provider.tokens();
    saveAuthEntry("pinned-client", { clientInfo: { clientId: "replacement", clientSecret: "new-secret", issuer, redirectUris: ["http://localhost:2/callback"] }, tokens: { accessToken: "replacement-token", issuer } }, url);
    await provider.invalidateCredentials("tokens");
    expect((await provider.clientInformation())?.client_id).toBe("replacement");
    expect((await provider.tokens())?.access_token).toBe("replacement-token");
  });

  it("bounds OAuth response bodies as well as response headers", async () => {
    vi.stubEnv("PI_MCP_OAUTH_REQUEST_TIMEOUT_MS", "40");
    const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"unfinished":'); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
      const response = await authFetch()(`http://127.0.0.1:${address.port}/token`);
      await expect(response.json()).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe("catalog TTL hints", () => {
  const definition = { command: "fixture" };
  const entry = () => ({ configHash: computeServerHash(definition), cachedAt: Date.now(), tools: [], resources: [] });
  it("does not reuse zero-TTL catalogs from disk", () => expect(isServerCacheValid({ ...entry(), ttlMs: 0 }, definition)).toBe(false));
  it("expires positive TTL without rejecting unknown hints", () => {
    expect(isServerCacheValid({ ...entry(), cachedAt: Date.now() - 100, ttlMs: 10 }, definition)).toBe(false);
    expect(isServerCacheValid({ ...entry(), ttlMs: -1 }, definition)).toBe(true);
  });
});
