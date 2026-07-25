import { NativeControlFrameSchema, type NativeControlFrame } from "../../application/native-control-progress.js";
import type { NativeControlFrameSink } from "../../application/ports/native-control-execution.js";

/** Observe exact facade frames while preserving sink ordering/backpressure. */
export function createPiManagerFrameSink(input: Readonly<{
  onFrame?(frame: NativeControlFrame): void;
  delegate?: NativeControlFrameSink;
}> = {}): NativeControlFrameSink {
  let closed = false;
  return Object.freeze({
    async write(frameInput: NativeControlFrame, signal: AbortSignal): Promise<void> {
      if (closed) throw new Error("manager frame sink is closed");
      signal.throwIfAborted();
      const frame = NativeControlFrameSchema.parse(frameInput);
      input.onFrame?.(frame);
      await input.delegate?.write(frame, signal);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await input.delegate?.close();
    },
  });
}
