import { describe, expect, it, vi } from "vitest";
import { createNativeControlExecutionCoordinator, NativeControlAdmissionError } from "../../src/application/native-control-execution.js";
import { createNativeControlParser } from "../../src/application/native-control-parser.js";
import { ControlReadyStatus } from "../fixtures/native-control/control-fixture.js";

const parser = createNativeControlParser();
function command() {
  const value = parser.parseArgv(["status"]);
  if (value.kind !== "parsed") throw new Error("fixture failed");
  return value.command;
}

function fixture() {
  let number = 0;
  const ids = { issue: vi.fn(async () => `native-control-execution-v1:123e4567-e89b-42d3-a456-${String(426614174000 + number++).padStart(12, "0")}` as never) };
  const timeouts = { arm: vi.fn((_ms: number, parent: AbortSignal) => ({ signal: parent, dispose: vi.fn() })) };
  return { coordinator: createNativeControlExecutionCoordinator({ ids, timeouts }), ids, timeouts };
}

describe("native control execution admission", () => {
  it("isolates concurrent IDs/counters and preserves ordered results", async () => {
    const { coordinator, ids } = fixture();
    const sinks = [0, 1].map(() => { const frames: any[] = []; return { frames, sink: { write: async (frame: any) => { frames.push(frame); }, close: async () => undefined } }; });
    const dispatch = async (_command: any, context: any) => { await context.progress.emit({ phase: "preflight", state: "started" }); return { status: "ok", data: ControlReadyStatus, diagnostics: [], human: [] }; };
    const reports = await Promise.all(sinks.map((entry) => coordinator.execute(command(), { sink: entry.sink }, dispatch as never, new AbortController().signal)));
    expect(ids.issue).toHaveBeenCalledTimes(2);
    expect(new Set(reports.map((report) => report.envelope.executionId)).size).toBe(2);
    expect(sinks.every((entry) => entry.frames.map((frame) => frame.sequence).join() === "0,1,2")).toBe(true);
  });

  it("keeps a committed result stronger than output failure", async () => {
    const { coordinator } = fixture();
    let writes = 0;
    const sink = { write: async () => { writes += 1; if (writes === 2) throw Object.assign(new Error("closed"), { code: "EPIPE" }); }, close: async () => undefined };
    const report = await coordinator.execute(command(), { sink }, async (_command, context) => {
      await context.progress.emit({ phase: "commit", state: "completed" });
      return { status: "ok", data: ControlReadyStatus, diagnostics: [], human: [] };
    }, new AbortController().signal);
    expect(report.envelope).toMatchObject({ status: "ok", data: { status: "ready" } });
    expect(report.delivery).toBe("closed");
  });

  it("propagates injected timeout cancellation before semantic evidence", async () => {
    const ids = { issue: async () => "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never };
    const timeouts = { arm: vi.fn(() => { const controller = new AbortController(); controller.abort(new Error("timeout")); return { signal: controller.signal, dispose: vi.fn() }; }) };
    const coordinator = createNativeControlExecutionCoordinator({ ids, timeouts });
    const report = await coordinator.execute(command(), { timeoutMs: 10 }, async (_command, _context, signal) => { signal.throwIfAborted(); return { status: "ok", data: ControlReadyStatus, diagnostics: [], human: [] }; }, new AbortController().signal);
    expect(report.envelope).toMatchObject({ status: "cancelled", exit: { code: 9 } });
    expect(timeouts.arm).toHaveBeenCalledWith(10, expect.any(AbortSignal));
  });

  it("quiesces new work and drains admitted work idempotently", async () => {
    const { coordinator } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const running = coordinator.execute(command(), {}, async () => { await gate; return { status: "ok", data: ControlReadyStatus, diagnostics: [], human: [] }; }, new AbortController().signal);
    coordinator.quiesce();
    await expect(coordinator.execute(command(), {}, vi.fn(), new AbortController().signal)).rejects.toBeInstanceOf(NativeControlAdmissionError);
    const close = coordinator.close();
    expect(coordinator.activeCount()).toBe(1);
    release();
    await running;
    await close;
    await expect(coordinator.close()).resolves.toBeUndefined();
  });
});
