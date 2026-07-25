import type { Readable, Writable } from "node:stream";
import type { NativePluginControlService } from "../../application/native-control-service.js";
import { createNativeControlHumanProjector } from "../../application/native-control-human.js";
import { NativeControlExitRegistry, type NativeControlEnvelope } from "../../application/native-control-contract.js";
import {
  NativeControlDeliveryClosedError,
  NativeControlFrameSchema,
  type NativeControlFrame,
} from "../../application/native-control-progress.js";
import type { NativeControlFrameSink } from "../../application/ports/native-control-execution.js";
import { createNodeControlInput } from "./node-control-input.js";
import { createNodeJsonLinesSink } from "./node-json-lines-sink.js";

export type NodeControlSignalSource = Pick<NodeJS.Process, "on" | "off">;

export type NodeControlHeadlessRunnerOptions = Readonly<{
  control: NativePluginControlService;
  argv: readonly string[];
  stdin?: Readable;
  stdout?: Writable;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  signals?: NodeControlSignalSource;
  timeoutMs?: number;
  setProcessExitCode?: boolean;
}>;

function requestedOutput(control: NativePluginControlService, argv: readonly string[]): "json" | "human" {
  const parsed = control.parseArgv(argv);
  if (parsed.kind === "parsed") return parsed.command.invocation.output;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--output") {
      const value = argv[index + 1];
      if (value === "json" || value === "human") return value;
    }
    if (token === "--output=json") return "json";
    if (token === "--output=human") return "human";
    if (!token.startsWith("--")) break;
  }
  return "human";
}

function inputRequested(control: NativePluginControlService, argv: readonly string[]): boolean {
  const parsed = control.parseArgv(argv);
  return parsed.kind === "parsed" && parsed.command.invocation.input.kind !== "none";
}

function deliveryError(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "EPIPE"
    ? new NativeControlDeliveryClosedError()
    : error;
}

async function writeHumanBytes(output: Writable, bytes: string, signal: AbortSignal): Promise<void> {
  if (bytes.length === 0) throw new TypeError("native control human delivery must contain bytes");
  signal.throwIfAborted();
  if (output.destroyed || output.writableEnded || output.writableFinished) throw new NativeControlDeliveryClosedError();
  await new Promise<void>((resolve, reject) => {
    let callbackDone = false;
    let drainDone = false;
    let returnKnown = false;
    let settled = false;
    const cleanup = () => {
      output.off("error", onError);
      output.off("close", onClose);
      output.off("drain", onDrain);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve(); else reject(deliveryError(error));
    };
    const maybe = () => {
      if (!returnKnown || !callbackDone || !drainDone || settled) return;
      setImmediate(() => settle());
    };
    const onError = (error: unknown) => settle(error);
    const onClose = () => settle(new NativeControlDeliveryClosedError());
    const onDrain = () => { drainDone = true; maybe(); };
    const onAbort = () => settle(signal.reason ?? new DOMException("aborted", "AbortError"));
    output.once("error", onError);
    output.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const ready = output.write(bytes, (error?: Error | null) => {
        if (error !== undefined && error !== null) settle(error);
        else { callbackDone = true; maybe(); }
      });
      returnKnown = true;
      drainDone = ready;
      if (!ready) output.once("drain", onDrain);
      maybe();
    } catch (error) {
      settle(error);
    }
    if (signal.aborted) onAbort();
  });
}

function humanEnvelopeBytes(control: NativePluginControlService, envelope: NativeControlEnvelope): string {
  const fields = createNativeControlHumanProjector().render(envelope);
  if (fields.length > 0) return `${fields.map((field) => field.text).join("\n")}\n`;
  if (envelope.exit.classification === "usage" || envelope.status === "presentation-required") {
    const commands = control.help().commands
      .filter((command) => command.path.length > 0)
      .map((command) => command.path.join(" "));
    return `Usage: plugin <command>\n${commands.join("\n")}\n`;
  }
  const diagnostics = envelope.diagnostics.map((diagnostic) => diagnostic.code);
  return `${diagnostics.length > 0 ? diagnostics.join("\n") : `CONTROL_${envelope.status.toUpperCase().replaceAll("-", "_")}`}\n`;
}

function createNodeHumanFrameSink(control: NativePluginControlService, output: Writable): NativeControlFrameSink {
  return Object.freeze({
    async write(frameInput: NativeControlFrame, signal: AbortSignal): Promise<void> {
      const frame = NativeControlFrameSchema.parse(frameInput);
      if (frame.type === "accepted") return;
      if (frame.type === "progress") {
        await writeHumanBytes(output, `${frame.phase} ${frame.state}\n`, signal);
        return;
      }
      await writeHumanBytes(output, humanEnvelopeBytes(control, frame.result), signal);
    },
    async close() {
      // stdout is process-owned.
    },
  });
}

function linkAbort(parent: AbortSignal | undefined): Readonly<{ controller: AbortController; dispose(): void }> {
  const controller = new AbortController();
  if (parent === undefined) return { controller, dispose() {} };
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort(); else parent.addEventListener("abort", abort, { once: true });
  return { controller, dispose: () => parent.removeEventListener("abort", abort) };
}

/**
 * Thin process adapter for the application control facade. It owns only Node
 * streams/signals and numeric process status; grammar, input policy, dispatch,
 * cancellation precedence, and semantic exits remain application contracts.
 */
export async function runNodeNativeControlHeadless(options: NodeControlHeadlessRunnerOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const signals = options.signals ?? process;
  const linked = linkAbort(options.signal);
  const onSigint = () => linked.controller.abort(new DOMException("interrupted", "AbortError"));
  signals.on("SIGINT", onSigint);

  const output = requestedOutput(options.control, options.argv);
  const sink = output === "json"
    ? createNodeJsonLinesSink({ output: stdout })
    : createNodeHumanFrameSink(options.control, stdout);
  let exitCode: number = NativeControlExitRegistry.internal.code;
  try {
    const report = await options.control.runArgv(options.argv, {
      mode: "headless",
      output,
      sink,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(inputRequested(options.control, options.argv)
        ? { input: createNodeControlInput({ stdin: options.stdin ?? process.stdin, environment: options.environment ?? process.env }) }
        : {}),
    }, linked.controller.signal);

    let delivery = report.delivery;
    if (report.deliveredThrough < 0) {
      // Parse/help/presentation reports are intentionally created before an
      // execution ID or sink exists; the Node boundary still owes callers the
      // same output guarantee as admitted executions.
      try {
        if (output === "json") {
          await sink.write({
            schemaVersion: 1,
            type: "result",
            executionId: report.envelope.executionId,
            sequence: 1,
            result: report.envelope,
          }, linked.controller.signal);
        } else {
          await writeHumanBytes(stdout, humanEnvelopeBytes(options.control, report.envelope), linked.controller.signal);
        }
        await sink.close();
      } catch {
        delivery = "failed";
      }
    }
    exitCode = delivery === "complete" ? report.envelope.exit.code : NativeControlExitRegistry.delivery.code;
  } catch (error) {
    // Pre-admission caller abort has no semantic envelope to deliver. It still
    // receives the stable cancellation process status rather than a thrown
    // native error or stack.
    exitCode = linked.controller.signal.aborted
      ? NativeControlExitRegistry.cancelled.code
      : NativeControlExitRegistry.internal.code;
  } finally {
    signals.off("SIGINT", onSigint);
    linked.dispose();
  }
  if (options.setProcessExitCode === true) process.exitCode = exitCode;
  return exitCode;
}
