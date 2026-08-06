import { afterEach, describe, expect, it, vi } from "vitest";
import { probeMcpEndpoint } from "../mcp-probe.ts";

const fetchMock = vi.fn();

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function mockFetch(...responses: Response[]): void {
  fetchMock.mockResolvedValueOnce(responses[0]);
  for (const response of responses.slice(1)) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetchMock);
}

describe("MCP endpoint shape probe", () => {
  it("classifies an HTML 200 response as not MCP", async () => {
    mockFetch(new Response("<html>Welcome</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));

    await expect(probeMcpEndpoint("https://example.test/mcp")).resolves.toMatchObject({
      isMcp: false,
      classification: expect.stringContaining("HTML (200)"),
    });
  });

  it("classifies a GraphQL-style JSON error as not MCP", async () => {
    mockFetch(new Response(JSON.stringify({ errors: [{ message: "Cannot query field" }] }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));

    await expect(probeMcpEndpoint("https://example.test/graphql")).resolves.toMatchObject({
      isMcp: false,
      classification: expect.stringContaining("application/json (400)"),
    });
  });

  it("recognizes a Bearer JSON-RPC authentication error", async () => {
    mockFetch(new Response(JSON.stringify({
      jsonrpc: "2.0", id: 1, error: { code: -32001, message: "Unauthorized" },
    }), {
      status: 401,
      headers: { "www-authenticate": "Bearer" },
    }));

    await expect(probeMcpEndpoint("https://example.test/mcp")).resolves.toMatchObject({ isMcp: true });
  });

  it("recognizes an SSE response", async () => {
    mockFetch(new Response("event: message\ndata: {}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    await expect(probeMcpEndpoint("https://example.test/mcp")).resolves.toMatchObject({ isMcp: true });
  });

  it("retries GET after a POST 405", async () => {
    mockFetch(
      new Response("Method Not Allowed", { status: 405 }),
      new Response("event: message\ndata: {}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );

    await expect(probeMcpEndpoint("https://example.test/mcp")).resolves.toMatchObject({ isMcp: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: { Accept: "text/event-stream" } });
    expect(fetchMock.mock.calls[1]?.[1]?.signal).not.toBe(fetchMock.mock.calls[0]?.[1]?.signal);
  });
});
