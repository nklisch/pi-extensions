import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Writable } from "node:stream";
import { NativeControlFrameSchema, type NativeControlFrame } from "../application/native-control-progress.js";
import type {
  NativeControlExecutionReport,
  NativeControlFrameSink,
} from "../application/ports/native-control-execution.js";
import { nativeControlHumanLines } from "./native-control-human.js";

const CONTROL_REPORT_ENTRY = "plugin-host:control-report-v1";
const CONTROL_FRAME_ENTRY = "plugin-host:control-frame-v1";
const MAX_PRINT_LINES = 512;
const MAX_PRINT_LINE_SCALARS = 1_024;
const MAX_PRINT_SCALARS = 65_536;

export interface PiControlChannel {
  createSink(context: ExtensionCommandContext, mode: ExtensionContext["mode"]): NativeControlFrameSink;
  publishReport(context: ExtensionContext, report: NativeControlExecutionReport): Promise<void>;
  publishCollision(context: ExtensionContext, invocationName: string): void;
  takeFrames(context: ExtensionCommandContext): readonly NativeControlFrame[];
}

function boundedLine(value: string): string {
  let result = "";
  let count = 0;
  for (const scalar of value) {
    const code = scalar.codePointAt(0)!;
    const unsafe = code === 0x1b || code <= 0x1f || (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    result += unsafe ? "�" : scalar;
    count += 1;
    if (count >= MAX_PRINT_LINE_SCALARS) break;
  }
  return result;
}

function frameLines(frame: NativeControlFrame): readonly string[] {
  if (frame.type === "accepted") return [];
  if (frame.type === "progress") {
    return [`${frame.phase} ${frame.state}${frame.code === undefined ? "" : ` ${frame.code}`}`];
  }
  return nativeControlHumanLines(frame.result);
}

async function write(output: Writable, text: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      output.write(text, (error?: Error | null) => {
        signal.removeEventListener("abort", abort);
        if (error === undefined || error === null) resolve();
        else reject(error);
      });
    } catch (error) {
      signal.removeEventListener("abort", abort);
      reject(error);
    }
  });
}

/** Pi-safe delivery for the one application control facade. */
export function createPiControlChannel(options: Readonly<{
  pi: ExtensionAPI;
  output?: Writable;
}>): PiControlChannel {
  const output = options.output ?? process.stdout;
  const frames = new WeakMap<object, NativeControlFrame[]>();

  const channel: PiControlChannel = {
    createSink(context: ExtensionCommandContext, mode: ExtensionContext["mode"]): NativeControlFrameSink {
      let printedScalars = 0;
      let printedLines = 0;
      let closed = false;
      return Object.freeze({
        async write(frameInput: NativeControlFrame, signal: AbortSignal): Promise<void> {
          if (closed) throw new Error("Pi control output is closed");
          const frame = NativeControlFrameSchema.parse(frameInput);
          const retained = frames.get(context) ?? [];
          if (retained.length < MAX_PRINT_LINES) retained.push(frame);
          frames.set(context, retained);
          if (mode === "rpc" || mode === "json") {
            options.pi.appendEntry(CONTROL_FRAME_ENTRY, frame);
            return;
          }
          if (mode !== "print") return;
          for (const raw of frameLines(frame)) {
            if (printedLines >= MAX_PRINT_LINES || printedScalars >= MAX_PRINT_SCALARS) break;
            const line = boundedLine(raw).slice(0, Math.max(0, MAX_PRINT_SCALARS - printedScalars));
            printedLines += 1;
            printedScalars += line.length;
            await write(output, `${line}\n`, signal);
          }
        },
        async close(): Promise<void> { closed = true; },
      });
    },
    async publishReport(context: ExtensionContext, report: NativeControlExecutionReport): Promise<void> {
      if (context.mode === "print") {
        // Parse/help/presentation failures are produced before a frame sink is
        // admitted. Print mode still owes the caller a useful terminal result,
        // while admitted reports were already delivered through their sink.
        if (report.deliveredThrough >= 0) return;
        const signal = context.signal ?? new AbortController().signal;
        const lines = nativeControlHumanLines(report.envelope).slice(0, MAX_PRINT_LINES);
        let scalars = 0;
        for (const raw of lines) {
          if (scalars >= MAX_PRINT_SCALARS) break;
          const line = boundedLine(raw).slice(0, Math.min(MAX_PRINT_LINE_SCALARS, MAX_PRINT_SCALARS - scalars));
          scalars += line.length;
          await write(output, `${line}\n`, signal);
        }
        return;
      }
      if (context.mode === "rpc" || context.mode === "json") {
        // appendEntry is Pi's structured protocol/session channel. The envelope
        // has already crossed the facade's redaction and JSON-schema boundary.
        options.pi.appendEntry(CONTROL_REPORT_ENTRY, {
          schemaVersion: 1,
          envelope: report.envelope,
          delivery: report.delivery,
          deliveredThrough: report.deliveredThrough,
        });
        return;
      }
      const kind = report.envelope.exit.code === 0 ? "info" : report.envelope.exit.code < 6 ? "warning" : "error";
      context.ui.notify(
        `${report.envelope.command.path.join(" ") || "plugin manager"}: ${report.envelope.status}`,
        kind,
      );
    },
    publishCollision(context: ExtensionContext, invocationName: string): void {
      if (!context.hasUI) return;
      context.ui.notify(
        `Plugin Host command collision: use /${boundedLine(invocationName)} for this package.`,
        "warning",
      );
    },
    takeFrames(context: ExtensionCommandContext): readonly NativeControlFrame[] {
      const retained = Object.freeze([...(frames.get(context) ?? [])]);
      frames.delete(context);
      return retained;
    },
  };
  return Object.freeze(channel);
}
