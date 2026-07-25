import { describe, expect, it, vi } from "vitest";
import { createBoundedFetch, createNpmCredentialProvider, type BoundedFetchResponse, type NpmCredentialProvider } from "../../../src/infrastructure/http/bounded-fetch.js";
import { createNetworkEgressPolicy } from "../../../src/infrastructure/network/network-egress-policy.js";

const signal = (): AbortSignal => new AbortController().signal;
const egress = (options: Readonly<{
  credentials?: readonly string[];
  redirects?: readonly string[];
}> = {}) => createNetworkEgressPolicy({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  privateOrigins: [
    "https://registry.example.test",
    "https://cdn.example.test",
    "https://unapproved.example.test",
  ],
  credentialOrigins: options.credentials,
  redirectOrigins: options.redirects,
});

function credentials(seen: Headers[]): NpmCredentialProvider {
  return {
    apply(_url, headers, _signal) {
      headers.set("authorization", "Bearer test-secret");
      seen.push(new Headers(headers));
    },
  };
}

const noCredentials: NpmCredentialProvider = {
  apply(_url, _headers, _signal) {},
};

async function applyCredentials(provider: NpmCredentialProvider, url: URL, headers: Headers, signal: AbortSignal): Promise<void> {
  if (typeof provider === "function") throw new Error("test provider unexpectedly used function form");
  await provider.apply(url, headers, signal);
}

async function collect(response: BoundedFetchResponse): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) chunks.push(chunk);
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(output);
}

describe("bounded HTTPS fetch", () => {
  it("follows only HTTPS redirects and applies credentials afresh per hop", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const seen: Headers[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url === "https://registry.example.test/package") {
        return new Response(null, { status: 302, headers: { location: "https://cdn.example.test/package.tgz" } });
      }
      return new Response(new TextEncoder().encode("bytes"), { status: 200 });
    };
    const response = await createBoundedFetch({
      fetch,
      credentials: credentials(seen),
      egress: egress({
        credentials: ["https://registry.example.test", "https://cdn.example.test"],
        redirects: ["https://cdn.example.test"],
      }),
    }).request({
      url: "https://registry.example.test/package",
      maxBytes: 100,
      signal: signal(),
    });
    expect(await collect(response)).toBe("bytes");
    expect(requests.map((request) => request.url)).toEqual([
      "https://registry.example.test/package",
      "https://cdn.example.test/package.tgz",
    ]);
    expect(requests.every((request) => request.authorization === "Bearer test-secret")).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it("does not resolve credentials or contact an unapproved redirect authority", async () => {
    const apply = vi.fn(() => { throw new Error("CREDENTIAL_CANARY"); });
    const requests: string[] = [];
    const bounded = createBoundedFetch({
      fetch: async (input) => {
        requests.push(String(input));
        return new Response(null, { status: 302, headers: { location: "https://unapproved.example.test/private" } });
      },
      credentials: { apply },
      egress: egress(),
    });
    await expect(bounded.request({
      url: "https://registry.example.test/package",
      maxBytes: 100,
      signal: signal(),
    })).rejects.toMatchObject({ kind: "redirect" });
    expect(apply).not.toHaveBeenCalled();
    expect(requests).toEqual(["https://registry.example.test/package"]);
  });

  it("rejects HTTP redirects and enforces streamed byte limits without retaining the body", async () => {
    const fetch = async (): Promise<Response> => new Response(new TextEncoder().encode("too long"), { status: 200 });
    const bounded = createBoundedFetch({ fetch, credentials: noCredentials, egress: egress() });
    const response = await bounded.request({ url: "https://registry.example.test/package", maxBytes: 3, signal: signal() });
    await expect((async () => { for await (const _chunk of response.body) { /* consume */ } })()).rejects.toMatchObject({ kind: "limit" });

    const httpRedirect = createBoundedFetch({
      fetch: async () => new Response(null, { status: 302, headers: { location: "http://evil.test/package" } }),
      credentials: noCredentials,
      egress: egress(),
    });
    await expect(httpRedirect.request({ url: "https://registry.example.test/package", maxBytes: 100, signal: signal() })).rejects.toMatchObject({ kind: "redirect" });
  });

  it("matches npm token scopes including ports, longest paths, and reports unreadable config", async () => {
    const provider = createNpmCredentialProvider({
      configText: "//registry.example.test:4873/:_authToken=port-secret\n//registry.example.test/team/:_authToken=team-secret\n//registry.example.test/team/tools/:_authToken=tools-secret\n",
    });
    const portHeaders = new Headers();
    await applyCredentials(provider, new URL("https://registry.example.test:4873/package"), portHeaders, signal());
    expect(portHeaders.get("authorization")).toBe("Bearer port-secret");
    const toolsHeaders = new Headers();
    await applyCredentials(provider, new URL("https://registry.example.test/team/tools/package"), toolsHeaders, signal());
    expect(toolsHeaders.get("authorization")).toBe("Bearer tools-secret");
    const teamHeaders = new Headers();
    await applyCredentials(provider, new URL("https://registry.example.test/team/other"), teamHeaders, signal());
    expect(teamHeaders.get("authorization")).toBe("Bearer team-secret");
    const unrelatedPathHeaders = new Headers();
    await applyCredentials(provider, new URL("https://registry.example.test/teamwork/package"), unrelatedPathHeaders, signal());
    expect(unrelatedPathHeaders.get("authorization")).toBeNull();
    const defaultHeaders = new Headers();
    await applyCredentials(provider, new URL("https://registry.example.test/package"), defaultHeaders, signal());
    expect(defaultHeaders.get("authorization")).toBeNull();

    const unreadable = createNpmCredentialProvider({ configPath: process.cwd() });
    await expect(applyCredentials(unreadable, new URL("https://registry.example.test/package"), new Headers(), signal())).rejects.toMatchObject({ kind: "credential" });
  });

  it("bounds redirect hops", async () => {
    const bounded = createBoundedFetch({
      maxRedirects: 1,
      fetch: async (input) => new Response(null, { status: 302, headers: { location: `${String(input)}-next` } }),
      credentials: noCredentials,
      egress: egress(),
    });
    await expect(bounded.request({ url: "https://registry.example.test/package", maxBytes: 100, signal: signal() })).rejects.toMatchObject({ kind: "redirect" });
  });
});
