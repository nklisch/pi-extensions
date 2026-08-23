import { createConnection, type Socket } from "node:net";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import { logger } from "./logger.ts";
import { formatTerminalError, invokeContainedCallback, truncateAtWord } from "./utils.ts";

/** MCP JSONL transport for an explicitly configured Unix-domain socket. */
export class UnixSocketClientTransport implements Transport {
  private socket: Socket | undefined;
  private readonly readBuffer = new ReadBuffer();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly socketPath: string) {}

  private invokeCallback(
    callback: ((...args: any[]) => unknown) | undefined,
    args: unknown[],
    name: "onmessage" | "onerror" | "onclose",
  ): void {
    invokeContainedCallback(callback, args, error => this.reportCallbackFailure(name, error));
  }

  private reportCallbackFailure(name: string, error: unknown): void {
    const message = truncateAtWord(formatTerminalError(error), 1_024);
    logger.error(`MCP Unix socket ${name} callback failed: ${message || "unknown error"}`);
  }

  async start(): Promise<void> {
    if (this.socket) {
      throw new Error("UnixSocketClientTransport already started");
    }

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      this.socket = socket;
      let connected = false;

      socket.once("connect", () => {
        connected = true;
        resolve();
      });
      socket.on("data", chunk => {
        try {
          this.readBuffer.append(chunk);
          while (true) {
            const message = this.readBuffer.readMessage();
            if (message === null) break;
            this.invokeCallback(this.onmessage, [message], "onmessage");
          }
        } catch (error) {
          const cause = error instanceof Error ? error : new Error(String(error));
          this.invokeCallback(this.onerror, [cause], "onerror");
          void this.close().catch(closeError => this.reportCallbackFailure("close", closeError));
        }
      });
      socket.on("error", error => {
        if (!connected) reject(error);
        this.invokeCallback(this.onerror, [error], "onerror");
      });
      socket.on("close", () => {
        if (this.socket === socket) this.socket = undefined;
        this.readBuffer.clear();
        this.invokeCallback(this.onclose, [], "onclose");
      });
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    this.readBuffer.clear();
    if (!socket || socket.destroyed) return;

    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => socket.destroy(), 2_000);
      timeout.unref();
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.end();
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Unix socket is not connected");

    await new Promise<void>((resolve, reject) => {
      socket.write(serializeMessage(message), error => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}
