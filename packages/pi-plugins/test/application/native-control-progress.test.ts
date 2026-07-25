import { describe, expect, it, vi } from "vitest";
import { createNativeControlEnvelope, NativeControlExecutionIdSchema } from "../../src/application/native-control-contract.js";
import { createNativeControlProgressController, NativeControlDeliveryClosedError } from "../../src/application/native-control-progress.js";
import { ControlReadyStatus } from "../fixtures/native-control/control-fixture.js";

const executionId = NativeControlExecutionIdSchema.parse("native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000");

describe("native control progress", () => {
  it("awaits each ordered frame with bounded backpressure", async () => {
    const frames: any[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sink = { write: vi.fn(async (frame: any) => { frames.push(frame); if (frame.type === "progress") await gate; }), close: vi.fn(async () => undefined) };
    const progress = createNativeControlProgressController({ executionId, command: "status", sink, signal: new AbortController().signal, abortDelivery: vi.fn() });
    await progress.accepted();
    let settled = false;
    const pending = progress.progress.emit({ phase: "preflight", state: "started", operationSequence: 0 }).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(frames.map((frame) => frame.sequence)).toEqual([0, 1]);
    release(); await pending;
    const envelope = createNativeControlEnvelope({ executionId, command: "status", status: "ok", data: ControlReadyStatus });
    await progress.result(envelope);
    expect(frames.map((frame) => frame.sequence)).toEqual([0, 1, 2]);
  });

  it("serializes concurrent producer reports instead of cancelling owner work", async () => {
    const frames: any[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sink = {
      write: vi.fn(async (frame: any) => {
        frames.push(frame);
        if (frame.sequence === 1) await gate;
      }),
      close: vi.fn(async () => undefined),
    };
    const abort = vi.fn();
    const progress = createNativeControlProgressController({ executionId, command: "status", sink, signal: new AbortController().signal, abortDelivery: abort });
    await progress.accepted();
    const first = progress.progress.emit({ phase: "preflight", state: "started", operationSequence: 0 });
    const second = progress.progress.emit({ phase: "preflight", state: "completed", operationSequence: 1 });
    await Promise.resolve();
    expect(frames.map((frame) => frame.sequence)).toEqual([0, 1]);
    expect(progress.delivery()).toBe("complete");
    release();
    await Promise.all([first, second]);
    expect(frames.map((frame) => frame.sequence)).toEqual([0, 1, 2]);
    expect(abort).not.toHaveBeenCalled();
  });

  it("classifies EPIPE without throwing or rewriting semantic truth", async () => {
    const abort = vi.fn();
    const sink = { write: vi.fn(async () => { throw new NativeControlDeliveryClosedError(); }), close: vi.fn(async () => undefined) };
    const progress = createNativeControlProgressController({ executionId, command: "status", sink, signal: new AbortController().signal, abortDelivery: abort });
    await expect(progress.accepted()).resolves.toBeUndefined();
    await expect(progress.progress.emit({ phase: "preflight", state: "started" })).resolves.toBeUndefined();
    expect(progress.delivery()).toBe("closed");
    expect(progress.deliveredThrough()).toBe(-1);
    expect(sink.write).toHaveBeenCalledOnce();
    expect(abort).toHaveBeenCalledOnce();
  });
});
