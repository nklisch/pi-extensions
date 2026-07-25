import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createNativeControlEnvelope } from "../../../src/application/native-control-contract.js";
import { createNodeJsonLinesSink } from "../../../src/infrastructure/control/node-json-lines-sink.js";
import { ControlReadyStatus } from "../../fixtures/native-control/control-fixture.js";

const executionId = "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never;
const frame = { schemaVersion: 1 as const, type: "result" as const, executionId, sequence: 1, result: createNativeControlEnvelope({ executionId, command: "status", status: "ok", data: ControlReadyStatus }) };

describe("node JSON-lines sink", () => {
  it("writes byte-stable canonical JSON plus one newline", async () => {
    const chunks: Buffer[] = [];
    const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    await createNodeJsonLinesSink({ output }).write(frame, new AbortController().signal);
    const text = Buffer.concat(chunks).toString("utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf('"blocked"')).toBeLessThan(text.indexOf('"capabilities"'));
    expect(JSON.parse(text)).toMatchObject({ type: "result", result: { status: "ok" } });
  });

  it("settles only after callback success and drain backpressure", async () => {
    let complete!: () => void;
    const slow = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) { complete = callback; },
    });
    const sink = createNodeJsonLinesSink({ output: slow });
    let settled = false;
    const pending = sink.write(frame, new AbortController().signal).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    complete();
    await pending;
    await sink.close();
  });

  it("maps callback and late event EPIPE to closed delivery", async () => {
    const broken = new Writable({ write(_chunk, _encoding, callback) { const error = Object.assign(new Error("secret"), { code: "EPIPE" }); callback(error); } });
    const callbackSink = createNodeJsonLinesSink({ output: broken });
    await expect(callbackSink.write(frame, new AbortController().signal)).rejects.toMatchObject({ name: "NativeControlDeliveryClosedError" });
    await expect(callbackSink.close()).rejects.toMatchObject({ name: "NativeControlDeliveryClosedError" });

    const late = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
        setImmediate(() => late.emit("error", Object.assign(new Error("late"), { code: "EPIPE" })));
      },
    });
    const lateSink = createNodeJsonLinesSink({ output: late });
    await expect(lateSink.write(frame, new AbortController().signal)).rejects.toMatchObject({ name: "NativeControlDeliveryClosedError" });
    await expect(lateSink.close()).rejects.toMatchObject({ name: "NativeControlDeliveryClosedError" });
  });

  it("does not end the supplied output on close", async () => {
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const sink = createNodeJsonLinesSink({ output });
    await sink.close();
    expect(output.writableEnded).toBe(false);
  });
});
