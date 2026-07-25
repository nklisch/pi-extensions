import { StringDecoder } from "node:string_decoder";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { E2E_CONTROL_REPORT, E2E_TIMEOUTS, scaleE2ETimeout } from "./constants.js";
import type { CleanE2ESandbox } from "./environment.js";
import { ManagedProcess, waitForCondition } from "./process.js";

type RpcResponse = Readonly<{
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: any;
  error?: string;
}>;

type UiRequest = Readonly<{
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: readonly string[];
}>;

export type ControlReport = Readonly<{
  schemaVersion: 1;
  envelope: Readonly<{
    executionId: string;
    command: Readonly<{ id: string; path: readonly string[] }>;
    status: string;
    data?: any;
    operation?: any;
    page?: any;
    diagnostics: readonly any[];
    human: readonly any[];
    exit: Readonly<{ code: number; classification: string }>;
  }>;
  delivery: string;
  deliveredThrough: number;
}>;

export type PiRpcUiResponder = (request: UiRequest) =>
  | Readonly<{ value?: string; confirmed?: boolean; cancelled?: boolean }>
  | Promise<Readonly<{ value?: string; confirmed?: boolean; cancelled?: boolean }>>;

export type PiRpcStartOptions = Readonly<{
  sandbox: CleanE2ESandbox;
  project?: string;
  env?: NodeJS.ProcessEnv;
  ui?: PiRpcUiResponder;
  approve?: boolean;
  extraArgs?: readonly string[];
}>;

function defaultUi(request: UiRequest): Readonly<{ value?: string; confirmed?: boolean; cancelled?: boolean }> {
  if (request.method === "confirm") return Object.freeze({ confirmed: true });
  if (request.method === "select") return request.options?.[0] === undefined ? Object.freeze({ cancelled: true }) : Object.freeze({ value: request.options[0] });
  if (request.method === "input" || request.method === "editor") return Object.freeze({ value: "e2e-value" });
  return Object.freeze({ cancelled: true });
}

function entries(response: RpcResponse): readonly any[] {
  return Array.isArray(response.data?.entries) ? response.data.entries : [];
}

export function controlReports(response: RpcResponse): readonly ControlReport[] {
  return entries(response)
    .filter((entry) => entry?.type === "custom" && entry.customType === E2E_CONTROL_REPORT)
    .map((entry) => entry.data)
    .filter((data): data is ControlReport => data?.schemaVersion === 1 && data.envelope !== undefined);
}

export class PiRpcProcess {
  readonly process: ManagedProcess;
  readonly events: any[] = [];
  readonly sandbox: CleanE2ESandbox;
  commandName = "plugin";
  private readonly pending = new Map<string, { resolve(value: RpcResponse): void; reject(error: unknown): void }>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private sequence = 0;
  private protocolError: Error | undefined;
  private readonly ui: PiRpcUiResponder;

  private constructor(process: ManagedProcess, sandbox: CleanE2ESandbox, ui: PiRpcUiResponder) {
    this.process = process;
    this.sandbox = sandbox;
    this.ui = ui;
    process.child.stdout.on("data", (chunk: Buffer) => this.consume(this.decoder.write(chunk)));
    process.child.stdout.on("end", () => {
      this.consume(this.decoder.end());
      if (this.buffer.length > 0) this.failProtocol(new Error(`Pi RPC ended with a partial LF record: ${JSON.stringify(this.buffer)}`));
    });
    process.child.once("exit", () => {
      const error = this.protocolError ?? new Error(`Pi RPC exited\n${process.output()}`);
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    });
  }

  static async start(options: PiRpcStartOptions): Promise<PiRpcProcess> {
    const args = [
      options.sandbox.piCli,
      "--offline", options.approve === false ? "--no-approve" : "--approve",
      "--no-prompt-templates", "--no-themes", "--no-context-files",
      ...(options.extraArgs ?? []),
      "--mode", "rpc", "--no-session", "--session-dir", options.sandbox.sessionDir,
    ];
    const child = ManagedProcess.start(options.sandbox.capabilities.node, args, {
      cwd: options.project ?? options.sandbox.project,
      env: options.env ?? options.sandbox.env,
      label: `Pi RPC ${options.sandbox.id}`,
    });
    const rpc = new PiRpcProcess(child, options.sandbox, options.ui ?? defaultUi);
    options.sandbox.diagnostics.push({
      name: `rpc-${options.sandbox.diagnostics.length + 1}`,
      capture: () => ({ output: child.output(), events: rpc.events }),
    });
    options.sandbox.cleanups.push(async () => { await rpc.shutdown(); });
    const commands = await rpc.request({ type: "get_commands" }, E2E_TIMEOUTS.startup);
    const extension = await realpath(options.sandbox.extensionPath);
    const owned = (commands.data?.commands ?? []).filter((command: any) => {
      const path = command.path ?? command.sourceInfo?.path;
      return command.source === "extension" && typeof path === "string" && resolve(path) === resolve(extension);
    });
    if (owned.length !== 1) throw new Error(`expected one packed extension command, got ${JSON.stringify(owned)}\n${child.output()}`);
    rpc.commandName = owned[0]!.name;
    return rpc;
  }

  private consume(text: string): void {
    this.buffer += text;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      let event: any;
      try { event = JSON.parse(line); }
      catch (cause) {
        this.failProtocol(new Error(`Pi RPC emitted non-JSON LF record ${JSON.stringify(line)}`, { cause }));
        continue;
      }
      this.events.push(event);
      if (event?.type === "response" && typeof event.id === "string") {
        const waiter = this.pending.get(event.id);
        if (waiter !== undefined) {
          this.pending.delete(event.id);
          waiter.resolve(event as RpcResponse);
        }
      } else if (event?.type === "extension_ui_request" && typeof event.id === "string") {
        void this.answerUi(event as UiRequest);
      }
    }
  }

  private failProtocol(error: Error): void {
    this.protocolError ??= error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.process.signal("SIGKILL");
  }

  private async answerUi(request: UiRequest): Promise<void> {
    if (!["select", "confirm", "input", "editor"].includes(request.method)) return;
    try {
      const response = await this.ui(request);
      this.process.write(`${JSON.stringify({ type: "extension_ui_response", id: request.id, ...response })}\n`);
    } catch (cause) {
      this.failProtocol(new Error(`Pi RPC UI responder failed for ${request.method}`, { cause }));
    }
  }

  async request(command: Readonly<Record<string, unknown>>, timeoutMs: number = E2E_TIMEOUTS.rpc): Promise<RpcResponse> {
    if (this.protocolError !== undefined) throw this.protocolError;
    const id = `e2e-${++this.sequence}`;
    const response = new Promise<RpcResponse>((resolvePromise, reject) => this.pending.set(id, { resolve: resolvePromise, reject }));
    this.process.write(`${JSON.stringify({ id, ...command })}\n`);
    let timer: NodeJS.Timeout | undefined;
    let result: RpcResponse;
    try {
      result = await Promise.race([
        response,
        new Promise<never>((_, reject) => {
          const budget = scaleE2ETimeout(timeoutMs);
          timer = setTimeout(() => reject(new Error(`Pi RPC ${String(command.type)} timed out after ${budget}ms\n${this.process.output()}`)), budget);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.pending.delete(id);
    }
    if (!result.success) throw new Error(`Pi RPC ${String(command.type)} failed: ${result.error ?? JSON.stringify(result)}\n${this.process.output()}`);
    return result;
  }

  async getEntries(): Promise<RpcResponse> { return this.request({ type: "get_entries" }); }

  async plugin(
    args: string,
    expectedCommand?: string,
    timeoutMs: number = E2E_TIMEOUTS.lifecycle,
  ): Promise<ControlReport> {
    const before = await this.getEntries();
    const leaf = before.data?.leafId as string | null | undefined;
    await this.request({ type: "prompt", message: `/${this.commandName}${args.length === 0 ? "" : ` ${args}`}` }, timeoutMs);
    const response = await waitForCondition(
      `Pi control report for ${args || "presentation"}`,
      async () => {
        const observed = leaf === null || leaf === undefined
          ? await this.getEntries()
          : await this.request({ type: "get_entries", since: leaf });
        const allReports = controlReports(observed);
        const reports = allReports.filter((report) => expectedCommand === undefined || report.envelope.command.id === expectedCommand);
        if (reports.length > 1) throw new Error(`Pi emitted duplicate control reports for ${args}: ${JSON.stringify(reports)}`);
        return reports[0];
      },
      timeoutMs,
    );
    return response;
  }

  async abort(): Promise<void> { await this.request({ type: "abort" }); }

  async shutdown(): Promise<void> {
    if (this.process.exited() !== undefined) return;
    this.process.endInput();
    try {
      const exit = await this.process.waitForExit(E2E_TIMEOUTS.shutdown);
      if (exit.code !== 0) throw new Error(`Pi RPC shutdown failed: ${JSON.stringify(exit)}\n${this.process.output()}`);
    } catch (error) {
      await this.process.terminate();
      throw error;
    } finally {
      this.process.assertGroupReleased();
    }
  }
}
