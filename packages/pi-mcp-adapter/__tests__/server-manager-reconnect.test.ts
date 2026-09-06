import { beforeEach, describe, expect, it, vi } from "vitest";

type TransportOptions = {
  requestInit?: { headers?: Record<string, string> };
};

type HttpTransportMock = {
  url: URL;
  options: TransportOptions;
  close: () => Promise<void>;
};

const mocks = vi.hoisted(() => ({
  clients: [] as any[],
  httpTransports: [] as HttpTransportMock[],
}));

vi.mock("@modelcontextprotocol/client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Client: vi.fn().mockImplementation((info: unknown, options: unknown) => {
    const client: any = {
      info,
      options,
      onclose: undefined,
      setRequestHandler: vi.fn(),
      setNotificationHandler: vi.fn(),
      connect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({ tools: [] })),
      listResources: vi.fn(async () => ({ resources: [] })),
      close: vi.fn(async () => undefined),
    };
    mocks.clients.push(client);
    return client;
  }),
  StreamableHTTPClientTransport: vi.fn().mockImplementation((url: URL, options: TransportOptions) => {
    const transport = { url, options, close: vi.fn(async () => undefined) };
    mocks.httpTransports.push(transport);
    return transport;
  }),
  SSEClientTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: vi.fn(),
}));

vi.mock("../npx-resolver.ts", () => ({
  resolveNpxBinary: vi.fn(async () => null),
}));

describe("McpServerManager.reconnect", () => {
  beforeEach(() => {
    mocks.clients.length = 0;
    mocks.httpTransports.length = 0;
  });

  // Each HTTP connection uses one client and one Streamable HTTP transport.
  const def = { url: "https://example.test/mcp" };

  it("is single-flight: concurrent reconnects for the same server share one underlying reconnect", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    mocks.clients.length = 0;
    mocks.httpTransports.length = 0;

    const [c1, c2] = await Promise.all([
      manager.reconnect("remote", def, stale),
      manager.reconnect("remote", def, stale),
    ]);

    expect(c1).toBe(c2);
    // Exactly one new connection was established, not one per caller.
    expect(mocks.clients.length).toBe(1);
    expect(manager.getConnection("remote")).toBe(c1);
  });

  it("identity guard: never tears down a connection it did not prove stale", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    await manager.close("remote");
    const fresh = await manager.connect("remote", def);

    mocks.clients.length = 0;
    mocks.httpTransports.length = 0;

    // A caller that captured `stale` before the close/reconnect cycle above
    // (e.g. a concurrent tool call that lost the race) asks to reconnect
    // from that now-superseded connection.
    const result = await manager.reconnect("remote", def, stale);

    expect(result).toBe(fresh);
    expect(fresh.client.close).not.toHaveBeenCalled();
    expect(mocks.clients.length).toBe(0); // no new connection attempted
    expect(manager.getConnection("remote")).toBe(fresh);
  });

  it("keeps a shared reconnect alive when one caller aborts waiting", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    let releaseClose!: () => void;
    stale.client.close = vi.fn(() => new Promise<void>((resolve) => {
      releaseClose = resolve;
    }));
    const reason = new Error("stop waiting");
    const controller = new AbortController();

    const first = manager.reconnect("remote", def, stale, controller.signal);
    controller.abort(reason);
    await expect(first).rejects.toBe(reason);

    const second = manager.reconnect("remote", def, stale);
    releaseClose();
    await expect(second).rejects.toBe(reason);

    const fresh = await manager.reconnect("remote", def, stale);
    expect(fresh).not.toBe(stale);
    expect(manager.getConnection("remote")).toBe(fresh);
  });

  it("carries in-flight work from the stale connection to the fresh connection", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    stale.inFlight = 2;

    const fresh = await manager.reconnect("remote", def, stale);

    expect(fresh).not.toBe(stale);
    expect(fresh.inFlight).toBe(2);
    expect(manager.getConnection("remote")).toBe(fresh);
  });

  it("identity guard: a stale connection's late onclose does not clobber the fresh connection's status", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();

    const stale = await manager.connect("remote", def);
    const staleClient = mocks.clients[0];

    mocks.clients.length = 0;
    mocks.httpTransports.length = 0;

    const fresh = await manager.reconnect("remote", def, stale);
    const freshClient = mocks.clients[0];

    expect(fresh).not.toBe(stale);
    expect(manager.getConnection("remote")).toBe(fresh);

    // Late close event from the old (already-replaced) client/transport.
    staleClient.onclose?.();
    expect(fresh.status).toBe("connected");
    expect(manager.getConnection("remote")).toBe(fresh);

    // A close on the current connection's own client still works normally.
    freshClient.onclose?.();
    expect(fresh.status).toBe("closed");
  });
  it("retains a healthy catalog when a refresh exceeds its request budget", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connection = await manager.connect("slow", { ...def, auth: false, requestTimeoutMs: 20 });
    connection.tools = [{ name: "old", inputSchema: { type: "object" } }];
    connection.client.getServerCapabilities = () => ({ tools: {} });
    connection.client.listTools = vi.fn(() => new Promise(() => {}));
    expect(await manager.refreshTools("slow", connection)).toBe("deferred");
    expect(connection.status).toBe("connected");
    expect(connection.tools[0]?.name).toBe("old");
    await manager.closeAll();
  });

  it("does not overwrite a newer notification with a slow catalog result", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connection = await manager.connect("revision", { ...def, auth: false });
    connection.client.getServerCapabilities = () => ({ tools: {} });
    let resolve!: (value: any) => void;
    connection.client.listTools = vi.fn(() => new Promise(res => { resolve = res; }));
    const refresh = manager.refreshTools("revision", connection);
    await Promise.resolve(); await Promise.resolve();
    connection.catalogRevision = (connection.catalogRevision ?? 0) + 1;
    connection.tools = [{ name: "notification", inputSchema: { type: "object" } }];
    resolve({ tools: [{ name: "stale", inputSchema: { type: "object" } }] });
    expect(await refresh).toBe("superseded");
    expect(connection.tools[0]?.name).toBe("notification");
    await manager.closeAll();
  });

  it("retries failed surface publication even when the next catalog is unchanged", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connection = await manager.connect("publication", { ...def, auth: false });
    connection.client.getServerCapabilities = () => ({ tools: {} });
    connection.client.listTools = vi.fn(async () => ({ tools: [{ name: "new", inputSchema: { type: "object" } }], ttlMs: 0 }));
    const publish = vi.fn().mockRejectedValueOnce(new Error("host sync failed")).mockResolvedValue(undefined);
    manager.setMetadataListChangedListener(publish);
    expect(await manager.refreshTools("publication", connection)).toBe("updated");
    expect(connection.publicationPending).toBe(true);
    expect(connection.toolListHints).toEqual({ ttlMs: 0 });
    expect(await manager.refreshTools("publication", connection)).toBe("unchanged");
    expect(connection.publicationPending).toBe(false);
    expect(publish).toHaveBeenCalledTimes(2);
    await manager.closeAll();
  });

  it("does not adopt a refresh from a replaced connection", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connection = await manager.connect("replaced", { ...def, auth: false });
    connection.client.getServerCapabilities = () => ({ tools: {} });
    let resolve!: (value: any) => void;
    connection.client.listTools = vi.fn(() => new Promise(res => { resolve = res; }));
    const refresh = manager.refreshTools("replaced", connection);
    await Promise.resolve(); await Promise.resolve();
    const replacement = await manager.reconnect("replaced", { ...def, auth: false }, connection);
    resolve({ tools: [{ name: "stale", inputSchema: { type: "object" } }] });
    expect(await refresh).toBe("superseded");
    expect(replacement.tools).toEqual([]);
    await manager.closeAll();
  });

  it("repairs a dropped modern catalog stream without timing out the adopted stream", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connection = await manager.connect("listen", { ...def, auth: false });
    connection.client.getProtocolEra = () => "modern";
    connection.client.getServerCapabilities = () => ({ tools: { listChanged: true } });
    connection.listenState = "dropped";
    connection.listenCatalogStale = true;
    const subscription = { closed: new Promise(() => {}), close: vi.fn(async () => {}) };
    connection.client.listen = vi.fn(async () => subscription) as any;
    vi.useFakeTimers();
    try {
      await manager.ensureListen("listen", connection);
      expect(connection.listenState).toBe("active");
      expect(connection.listenCatalogStale).toBe(false);
      const signal = (connection.client.listen as any).mock.calls[0][1].signal as AbortSignal;
      await vi.advanceTimersByTimeAsync(6000);
      expect(signal.aborted).toBe(false);
      expect(subscription.close).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); await manager.closeAll(); }
  });

  it("closes a late subscription after its repair deadline", async () => {
    const { McpServerManager } = await import("../server-manager.ts");
    const manager = new McpServerManager();
    const connection = await manager.connect("late-listen", { ...def, auth: false });
    connection.client.getProtocolEra = () => "modern";
    connection.client.getServerCapabilities = () => ({ tools: { listChanged: true } });
    connection.listenState = "dropped";
    let resolve!: (subscription: any) => void;
    connection.client.listen = vi.fn(() => new Promise(res => { resolve = res; })) as any;
    vi.useFakeTimers();
    try {
      const repair = manager.ensureListen("late-listen", connection);
      await vi.advanceTimersByTimeAsync(5001);
      await repair;
      const subscription = { closed: new Promise(() => {}), close: vi.fn(async () => {}) };
      resolve(subscription);
      await Promise.resolve(); await Promise.resolve();
      expect(subscription.close).toHaveBeenCalledTimes(1);
      expect(connection.listenState).toBe("dropped");
    } finally { vi.useRealTimers(); await manager.closeAll(); }
  });

});
