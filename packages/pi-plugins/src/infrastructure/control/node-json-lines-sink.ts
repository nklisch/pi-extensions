import type { Writable } from "node:stream";
import { canonicalJson } from "../../domain/canonical-json.js";
import { NativeControlFrameSchema, NativeControlDeliveryClosedError, type NativeControlFrame } from "../../application/native-control-progress.js";
import type { NativeControlFrameSink } from "../../application/ports/native-control-execution.js";

export type NodeJsonLinesSinkOptions = Readonly<{
  output?: Writable;
}>;

function outputClosed(output: Writable): boolean {
  return output.destroyed || output.writableEnded || output.writableFinished;
}

function deliveryError(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "EPIPE"
    ? new NativeControlDeliveryClosedError()
    : error;
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Canonical JSON-lines output. close() removes owned listeners but never ends stdout. */
export function createNodeJsonLinesSink(options: NodeJsonLinesSinkOptions = {}): NativeControlFrameSink {
  const output = options.output ?? process.stdout;
  let terminal: unknown;
  let pendingFailure: ((error: unknown) => void) | undefined;
  let sinkClosed = false;
  let closePromise: Promise<void> | undefined;

  // Writable implementations are allowed to report an asynchronous EPIPE
  // after write() returned and even after its callback ran. Keep one sink-level
  // listener through close so that error is classified rather than becoming an
  // unhandled process event.
  const recordTerminal = (error: unknown) => {
    terminal ??= deliveryError(error);
    pendingFailure?.(terminal);
  };
  const recordClose = () => {
    terminal ??= new NativeControlDeliveryClosedError();
    pendingFailure?.(terminal);
  };
  output.on("error", recordTerminal);
  output.on("close", recordClose);

  async function writeChunk(chunk: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (sinkClosed || outputClosed(output) || terminal !== undefined) {
      throw terminal ?? new NativeControlDeliveryClosedError();
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let callbackComplete = false;
      let drainComplete = false;
      let returnKnown = false;
      let completionScheduled = false;

      const cleanup = () => {
        output.off("drain", onDrain);
        signal.removeEventListener("abort", onAbort);
        if (pendingFailure === fail) pendingFailure = undefined;
      };
      const settle = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error === undefined) resolve();
        else reject(error);
      };
      const fail = (error: unknown) => settle(deliveryError(error));
      const maybeComplete = () => {
        if (!returnKnown || !callbackComplete || !drainComplete || completionScheduled || settled) return;
        completionScheduled = true;
        // Preserve the error/close listeners for one complete event-loop turn;
        // this catches the common late-EPIPE ordering after callback success.
        setImmediate(() => {
          completionScheduled = false;
          if (terminal !== undefined) fail(terminal);
          else settle();
        });
      };
      const onDrain = () => {
        drainComplete = true;
        maybeComplete();
      };
      const onAbort = () => fail(signal.reason ?? new DOMException("aborted", "AbortError"));
      const onWrite = (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          recordTerminal(error);
          return;
        }
        callbackComplete = true;
        maybeComplete();
      };

      pendingFailure = fail;
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const ready = output.write(chunk, onWrite);
        returnKnown = true;
        drainComplete = ready;
        if (!ready) output.once("drain", onDrain);
        maybeComplete();
      } catch (error) {
        recordTerminal(error);
      }
      if (signal.aborted) onAbort();
    });
  }

  return Object.freeze({
    async write(frameInput: NativeControlFrame, signal: AbortSignal): Promise<void> {
      const frame = NativeControlFrameSchema.parse(frameInput);
      await writeChunk(`${canonicalJson(frame)}\n`, signal);
    },
    close() {
      sinkClosed = true;
      closePromise ??= (async () => {
        // Give write-callback and stream error queues a chance to converge
        // before removing the listener that prevents late EPIPE from escaping.
        await nextTurn();
        await nextTurn();
        output.off("error", recordTerminal);
        output.off("close", recordClose);
        if (terminal !== undefined) throw terminal;
      })();
      return closePromise;
    },
  });
}
