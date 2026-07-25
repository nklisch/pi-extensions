import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createNativeControlEnvelope } from "../../src/application/native-control-contract.js";
import { createNativeControlHelp } from "../../src/application/native-control-help.js";
import { createPiControlChannel } from "../../src/pi/pi-control-channel.js";

const executionId = "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never;

function capture(stream: PassThrough): string {
  return Buffer.concat(stream.readableLength === 0 ? [] : [stream.read() as Buffer]).toString("utf8");
}

describe("Pi control channel", () => {
  it("prints pre-admission help reports once and leaves admitted reports to their frame sink", async () => {
    const output = new PassThrough();
    const channel = createPiControlChannel({ pi: { appendEntry: vi.fn() } as never, output });
    const report = {
      envelope: createNativeControlEnvelope({ executionId, command: "help", status: "ok", data: createNativeControlHelp() as never }),
      delivery: "complete" as const,
      deliveredThrough: -1,
    };
    await channel.publishReport({ mode: "print", signal: undefined } as never, report);
    const text = capture(output);
    expect(text).toContain("add <plugin-key> — Add a plugin");
    expect(text).not.toContain("install open");

    const admitted = new PassThrough();
    const admittedChannel = createPiControlChannel({ pi: { appendEntry: vi.fn() } as never, output: admitted });
    await admittedChannel.publishReport({ mode: "print", signal: undefined } as never, { ...report, deliveredThrough: 1 });
    expect(capture(admitted)).toBe("");
  });
});
