import { describe, expect, it } from "vitest";
import {
  NativeControlEnvelopeSchema,
  NativeControlExitRegistry,
  NativeControlExecutionIdSchema,
  createNativeControlEnvelope,
} from "../../src/application/native-control-contract.js";
import { createNativeControlHelp } from "../../src/application/native-control-help.js";

const executionId = NativeControlExecutionIdSchema.parse("native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000");

describe("native control envelopes", () => {
  it("keeps exits unique and portable", () => {
    const values = Object.values(NativeControlExitRegistry);
    expect(new Set(values.map((entry) => entry.code)).size).toBe(values.length);
    expect(new Set(values.map((entry) => entry.classification)).size).toBe(values.length);
    expect(values.every((entry) => entry.code >= 0 && entry.code <= 125)).toBe(true);
  });

  it("rejects impossible status/exit and arbitrary fields", () => {
    const envelope = createNativeControlEnvelope({ executionId, command: "help", status: "ok", data: createNativeControlHelp() as never });
    expect(NativeControlEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(() => NativeControlEnvelopeSchema.parse({ ...envelope, exit: NativeControlExitRegistry.cancelled })).toThrow();
    expect(() => NativeControlEnvelopeSchema.parse({ ...envelope, stack: "secret" })).toThrow();
  });

  it("accepts usage as the one failed-status phase classification", () => {
    expect(createNativeControlEnvelope({ executionId, command: "presentation", status: "failed", usageFailure: true, diagnostics: [{ code: "CONTROL_USAGE", severity: "error", action: "reparse" }] }).exit).toEqual(NativeControlExitRegistry.usage);
  });
});
