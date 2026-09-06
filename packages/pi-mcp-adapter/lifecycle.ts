import { UnauthorizedError, SdkHttpError } from "@modelcontextprotocol/client";
import { abortable } from "./abort.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import { isTerminatedSession } from "./session-recovery.ts";
import { parallelLimit } from "./utils.ts";
import { isServerDisabled, type ServerDefinition } from "./types.ts";
import type { McpServerManager } from "./server-manager.ts";
import { hasPendingAuth } from "./mcp-auth-flow.ts";
import { logger } from "./logger.ts";
import { formatTerminalError, sanitizeTerminalText } from "./utils.ts";

export type ReconnectCallback = (serverName: string) => void;
export type ReconnectFailureCallback = (serverName: string, error: unknown) => void;

export class McpLifecycleManager {
  private keepAliveServers = new Map<string, ServerDefinition>();
  private allServers = new Map<string, ServerDefinition>();
  private serverSettings = new Map<string, { idleTimeout?: number }>();
  private globalIdleTimeout = 10 * 60 * 1000;
  private healthCheckInterval: NodeJS.Timeout | undefined;
  private onReconnect: ReconnectCallback | undefined;
  private onReconnectFailure: ReconnectFailureCallback | undefined;
  private onIdleShutdown: ((serverName: string) => void) | undefined;
  private activeHealthCheck: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private stopped = false;
  private controller = new AbortController();
  private retry = new Map<string, { at: number; failures: number; connection?: object }>();
  private healthSignal: AbortSignal | undefined;
  private removeHealthAbortListener: (() => void) | undefined;

  constructor(
    private readonly manager: McpServerManager,
    private readonly hasPendingAuthForServer = hasPendingAuth,
  ) {}

  setReconnectCallback(callback: ReconnectCallback): void {
    this.onReconnect = callback;
  }

  setReconnectFailureCallback(callback: ReconnectFailureCallback): void {
    this.onReconnectFailure = callback;
  }

  markKeepAlive(name: string, definition: ServerDefinition): void {
    if (isServerDisabled(definition)) return;
    this.keepAliveServers.set(name, definition);
  }

  registerServer(name: string, definition: ServerDefinition, settings?: { idleTimeout?: number }): void {
    if (isServerDisabled(definition)) return;
    this.allServers.set(name, definition);
    if (settings?.idleTimeout !== undefined) this.serverSettings.set(name, settings);
  }

  setGlobalIdleTimeout(minutes: number): void {
    this.globalIdleTimeout = minutes * 60 * 1000;
  }

  setIdleShutdownCallback(callback: (serverName: string) => void): void {
    this.onIdleShutdown = callback;
  }

  startHealthChecks(signalOrInterval?: AbortSignal | number, maybeIntervalMs = 30000): void {
    const signal = typeof signalOrInterval === "number" ? undefined : signalOrInterval;
    const intervalMs = typeof signalOrInterval === "number" ? signalOrInterval : maybeIntervalMs;
    this.stopped = false;
    this.healthSignal = signal;
    if (signal?.aborted) {
      this.stopped = true;
      this.healthSignal = undefined;
      return;
    }
    const stop = () => {
      this.stopped = true;
      if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    };
    signal?.addEventListener("abort", stop, { once: true });
    this.removeHealthAbortListener = () => signal?.removeEventListener("abort", stop);
    this.healthCheckInterval = setInterval(() => {
      void this.ensureConverged().catch(error => console.error(`MCP: Health check failed: ${formatTerminalError(error)}`));
    }, intervalMs);
    this.healthCheckInterval.unref();
  }

  deferReconnect(name: string): void {
    const connection = this.manager.getConnection(name);
    this.retry.set(name, { ...(connection ? { connection } : {}), failures: 1, at: Date.now() + 60000 });
  }

  async ensureConverged(signal?: AbortSignal): Promise<void> {
    if (this.stopped || this.healthSignal?.aborted) return;
    if (!this.activeHealthCheck) {
      const owned = combineAbortSignals(this.healthSignal, this.controller.signal);
      const check = this.checkConnections(owned).finally(() => { if (this.activeHealthCheck === check) this.activeHealthCheck = undefined; });
      this.activeHealthCheck = check;
    }
    return abortable(this.activeHealthCheck, signal);
  }

  private async checkConnections(signal?: AbortSignal): Promise<void> {
    if (this.stopped || signal?.aborted) return;
    await parallelLimit([...this.keepAliveServers], 10, async ([name, definition]) => {
      if (isServerDisabled(definition) || this.stopped || signal?.aborted) return;
      const connection = this.manager.getConnection(name);
      if (connection?.status === "needs-auth" || this.hasPendingAuthForServer(name)) return;
      const retry = this.retry.get(name);
      if (retry && retry.connection === connection && retry.at > Date.now()) return;
      try {
        if (!connection || connection.status !== "connected") {
          const fresh = await this.manager.connect(name, definition, signal);
          if (this.stopped || signal?.aborted) return;
          this.retry.delete(name);
          this.onReconnect?.(name);
          if (fresh.status === "needs-auth") return;
        } else if (definition.url) {
          const hadSessionId = (connection.transport as { sessionId?: string })?.sessionId != null;
          try {
            const result = await this.manager.refreshTools(name, connection, signal);
            if (result === "deferred") {
              const failures = retry?.connection === connection ? retry.failures + 1 : 1;
              this.retry.set(name, { connection, failures, at: Date.now() + Math.min(300000, 30000 * 2 ** Math.min(failures - 1, 4)) });
            } else this.retry.delete(name);
          } catch (error) {
            if (signal?.aborted) return;
            if (isTerminatedSession(error, hadSessionId)) {
              await this.manager.reconnect(name, definition, connection, signal);
              this.retry.delete(name); this.onReconnect?.(name);
            } else if (error instanceof UnauthorizedError || error instanceof SdkHttpError && error.status === 401) {
              connection.status = "needs-auth";
              this.onReconnect?.(name);
            } else throw error;
          }
        }
      } catch (error) {
        if (this.stopped || signal?.aborted) return;
        this.retry.set(name, { ...(connection ? { connection } : {}), failures: 1, at: Date.now() + 60000 });
        this.onReconnectFailure?.(name, error);
        console.error(`MCP: Failed to reconnect to ${sanitizeTerminalText(name)}: ${formatTerminalError(error)}`);
      }
    });
    for (const [name] of this.allServers) {
      if (this.stopped || signal?.aborted) return;
      if (this.keepAliveServers.has(name)) continue;
      const timeout = this.getIdleTimeout(name);
      if (timeout > 0 && this.manager.isIdle(name, timeout)) {
        await this.manager.close(name);
        if (this.stopped || signal?.aborted) return;
        this.onIdleShutdown?.(name);
      }
    }
  }

  private getIdleTimeout(name: string): number {
    const perServer = this.serverSettings.get(name)?.idleTimeout;
    if (perServer !== undefined) return perServer * 60 * 1000;
    return this.globalIdleTimeout;
  }

  async gracefulShutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.shutdownOnce();
    return this.shutdownPromise;
  }

  private async shutdownOnce(): Promise<void> {
    this.stopped = true;
    this.controller.abort(new Error("MCP lifecycle stopped"));
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    this.healthCheckInterval = undefined;
    this.removeHealthAbortListener?.();
    this.removeHealthAbortListener = undefined;
    this.healthSignal = undefined;
    await this.activeHealthCheck;
    this.activeHealthCheck = undefined;
    this.onReconnect = undefined;
    this.onReconnectFailure = undefined;
    this.onIdleShutdown = undefined;
    if (typeof this.manager.closeAll === "function") {
      await this.manager.closeAll();
    }
  }
}
