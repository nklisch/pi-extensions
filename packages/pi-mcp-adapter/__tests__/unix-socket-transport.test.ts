import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeMessage } from "@modelcontextprotocol/client";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.ts";
import { UnixSocketClientTransport } from "../unix-socket-transport.ts";

const servers: Server[] = [];
const serverSockets: Socket[] = [];
const transports: UnixSocketClientTransport[] = [];
const temporaryDirectories: string[] = [];

async function startSocketServer(): Promise<{ socketPath: string; sockets: Socket[] }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-mcp-transport-"));
  temporaryDirectories.push(directory);
  const socketPath = join(directory, "test.sock");
  const sockets: Socket[] = [];
  const server = createServer(socket => {
    sockets.push(socket);
    serverSockets.push(socket);
    // Complete the close handshake so client-side close() settles promptly.
    socket.on("end", () => socket.end());
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { socketPath, sockets };
}

async function connectTransport(socketPath: string): Promise<UnixSocketClientTransport> {
  const transport = new UnixSocketClientTransport(socketPath);
  transports.push(transport);
  await transport.start();
  return transport;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(transports.map(transport => transport.close().catch(() => {})));
  // Destroy server-side sockets explicitly: server.close() only calls back
  // once every accepted connection is fully closed.
  for (const socket of serverSockets) socket.destroy();
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.map(directory => rm(directory, { recursive: true, force: true })));
  servers.length = 0;
  serverSockets.length = 0;
  transports.length = 0;
  temporaryDirectories.length = 0;
});

describe("UnixSocketClientTransport callback containment", () => {
  it("contains a throwing onmessage listener and keeps delivering messages", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { socketPath, sockets } = await startSocketServer();
    const transport = await connectTransport(socketPath);

    const received: string[] = [];
    let calls = 0;
    transport.onmessage = message => {
      calls += 1;
      if (calls === 1) throw new Error("listener exploded");
      received.push((message as { method?: string }).method ?? "");
    };

    const socket = sockets[0]!;
    socket.write(serializeMessage({ jsonrpc: "2.0", method: "notifications/first" } as JSONRPCMessage));
    socket.write(serializeMessage({ jsonrpc: "2.0", method: "notifications/second" } as JSONRPCMessage));

    await vi.waitFor(() => expect(received).toEqual(["notifications/second"]));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("onmessage"));
    // The transport survived the throwing listener.
    await transport.send({ jsonrpc: "2.0", method: "notifications/ping" } as JSONRPCMessage);
  });

  it("contains a throwing onerror listener on malformed input and still closes", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { socketPath, sockets } = await startSocketServer();
    const transport = await connectTransport(socketPath);

    const closed = new Promise<void>(resolve => {
      transport.onclose = () => resolve();
    });
    transport.onerror = () => {
      throw new Error("error listener exploded");
    };

    // Valid JSON that fails JSONRPCMessage schema validation: JSON.parse
    // SyntaxErrors are skipped by ReadBuffer, so the onerror path needs a
    // schema (ZodError) failure instead.
    sockets[0]!.write("{\"not\":\"json-rpc\"}\n");

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("onerror"));
    });
    // The parse-failure path still runs close() after the contained onerror throw.
    await closed;
    await expect(transport.send({ jsonrpc: "2.0", method: "notifications/ping" } as JSONRPCMessage))
      .rejects.toThrow("not connected");
  });
});
