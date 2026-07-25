import { z } from "zod";
import { NativeControlEnvelopeSchema, NativeControlExecutionIdSchema, type NativeControlExecutionId } from "./native-control-contract.js";
import { NativeControlCommandIdSchema, type NativeControlCommandId } from "./native-control-registry.js";
import { NativeLifecycleProgressEventSchema, type NativeLifecycleProgressEvent } from "./native-lifecycle-operation-contract.js";
import { TrustedInstallProgressEventSchema, type TrustedInstallProgressEvent } from "./trusted-install-contract.js";

export const NativeControlFrameSchema = z.discriminatedUnion("type", [
  z.object({
    schemaVersion: z.literal(1),
    type: z.literal("accepted"),
    executionId: NativeControlExecutionIdSchema,
    sequence: z.literal(0),
    command: NativeControlCommandIdSchema,
  }).strict().readonly(),
  z.object({
    schemaVersion: z.literal(1),
    type: z.literal("progress"),
    executionId: NativeControlExecutionIdSchema,
    sequence: z.number().int().positive(),
    phase: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    state: z.enum(["started", "completed", "skipped", "retained", "failed"]),
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
    operationSequence: z.number().int().nonnegative().optional(),
    safe: z.array(z.object({ text: z.string().max(8192), escaped: z.boolean(), truncated: z.boolean() }).strict().readonly()).readonly(),
  }).strict().readonly(),
  z.object({
    schemaVersion: z.literal(1),
    type: z.literal("result"),
    executionId: NativeControlExecutionIdSchema,
    sequence: z.number().int().positive(),
    result: NativeControlEnvelopeSchema,
  }).strict().readonly(),
]);
export type NativeControlFrame = z.infer<typeof NativeControlFrameSchema>;
export type NativeControlProgressSink = Readonly<{
  trusted(event: unknown): Promise<void>;
  lifecycle(event: unknown): Promise<void>;
  emit(input: Readonly<{
    phase: string;
    state: "started" | "completed" | "skipped" | "retained" | "failed";
    code?: string;
    operationSequence?: number;
  }>): Promise<void>;
}>;

type NativeControlFrameWriter = Readonly<{
  write(frame: NativeControlFrame, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}>;

export class NativeControlDeliveryClosedError extends Error {
  constructor() {
    super("native control output is closed");
    this.name = "NativeControlDeliveryClosedError";
  }
}

export type NativeControlProgressController = Readonly<{
  accepted(): Promise<void>;
  progress: NativeControlProgressSink;
  result(envelope: z.infer<typeof NativeControlEnvelopeSchema>): Promise<void>;
  close(): Promise<void>;
  delivery(): "complete" | "closed" | "failed";
  deliveredThrough(): number;
}>;

function deliveryKind(error: unknown): "closed" | "failed" {
  if (error instanceof NativeControlDeliveryClosedError) return "closed";
  if (error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EPIPE") return "closed";
  return "failed";
}

export function createNativeControlProgressController(input: Readonly<{
  executionId: NativeControlExecutionId;
  command: NativeControlCommandId;
  sink?: NativeControlFrameWriter;
  signal: AbortSignal;
  abortDelivery(): void;
}>): NativeControlProgressController {
  let sequence = 0;
  let deliveredThrough = -1;
  let delivery: "complete" | "closed" | "failed" = "complete";
  let writeTail = Promise.resolve();

  function write(frameInput: unknown): Promise<void> {
    const frame = NativeControlFrameSchema.parse(frameInput);
    const scheduled = writeTail.then(async () => {
      if (delivery !== "complete") return;
      try {
        if (input.sink !== undefined) await input.sink.write(frame, input.signal);
        deliveredThrough = frame.sequence;
      } catch (error) {
        delivery = deliveryKind(error);
        input.abortDelivery();
      }
    });
    // Producers may report adjacent lifecycle phases without awaiting their
    // observer callbacks. Serialize at the output authority so backpressure
    // cannot turn valid concurrent reports into owner cancellation.
    writeTail = scheduled.catch(() => undefined);
    return scheduled;
  }

  const progress: NativeControlProgressSink = Object.freeze({
    async trusted(eventInput: unknown): Promise<void> {
      const event: TrustedInstallProgressEvent = TrustedInstallProgressEventSchema.parse(eventInput);
      await progress.emit({ phase: event.phase, state: event.state, ...(event.code === undefined ? {} : { code: event.code }), operationSequence: event.sequence });
    },
    async lifecycle(eventInput: unknown): Promise<void> {
      const event: NativeLifecycleProgressEvent = NativeLifecycleProgressEventSchema.parse(eventInput);
      await progress.emit({ phase: event.phase, state: event.state, ...(event.code === undefined ? {} : { code: event.code }), operationSequence: event.sequence });
    },
    async emit(event): Promise<void> {
      sequence += 1;
      await write({ schemaVersion: 1, type: "progress", executionId: input.executionId, sequence, ...event, safe: [] });
    },
  });

  return Object.freeze({
    accepted: () => write({ schemaVersion: 1, type: "accepted", executionId: input.executionId, sequence: 0, command: input.command }),
    progress,
    async result(envelope) {
      sequence += 1;
      await write({ schemaVersion: 1, type: "result", executionId: input.executionId, sequence, result: envelope });
    },
    async close() {
      await writeTail;
      try { await input.sink?.close(); }
      catch (error) {
        if (delivery === "complete") delivery = deliveryKind(error);
      }
    },
    delivery: () => delivery,
    deliveredThrough: () => deliveredThrough,
  });
}
