import type { NativeControlEnvelope, NativeControlExecutionId } from "../native-control-contract.js";
import type { NativeControlCommandId } from "../native-control-registry.js";
import type { NativeControlFrame, NativeControlProgressSink } from "../native-control-progress.js";

export interface NativeControlFrameSink {
  write(frame: NativeControlFrame, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface NativeControlExecutionIdPort {
  issue(signal: AbortSignal): Promise<NativeControlExecutionId>;
}

export interface NativeControlTimeoutPort {
  arm(timeoutMs: number, parent: AbortSignal): Readonly<{ signal: AbortSignal; dispose(): void }>;
}

export type NativeControlExecutionReport = Readonly<{
  envelope: NativeControlEnvelope;
  delivery: "complete" | "closed" | "failed";
  deliveredThrough: number;
}>;

export type NativeControlExecutionCoreOptions = Readonly<{
  sink?: NativeControlFrameSink;
  timeoutMs?: number;
}>;

export type { NativeControlProgressSink } from "../native-control-progress.js";

export type NativeControlDispatchExecutionContext = Readonly<{
  executionId: NativeControlExecutionId;
  command: NativeControlCommandId;
  progress: NativeControlProgressSink;
}>;
