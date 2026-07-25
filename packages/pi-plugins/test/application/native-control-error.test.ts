import { describe, expect, it } from "vitest";
import { z } from "zod";
import { classifyNativeControlError } from "../../src/application/native-control-error.js";

describe("native control error classification", () => {
  it("maps stable known codes without native messages", () => {
    expect(classifyNativeControlError(Object.assign(new Error("/private secret"), { code: "CURSOR_STALE" }))).toEqual({ status: "stale", code: "CURSOR_STALE", action: "reinspect" });
    expect(classifyNativeControlError(Object.assign(new Error("secret"), { code: "PROJECT_UNTRUSTED" }))).toEqual({ status: "rejected", code: "PROJECT_UNTRUSTED", action: "none" });
    expect(JSON.stringify(classifyNativeControlError(new Error("secret canary")))).toBe('{"status":"failed","code":"CONTROL_INTERNAL","action":"none"}');
  });

  it("classifies contract and abort failures deterministically", () => {
    const failure = z.string().safeParse(1);
    if (failure.success) throw new Error("fixture failed");
    expect(classifyNativeControlError(failure.error)).toMatchObject({ status: "failed", code: "CONTROL_CONTRACT_INVALID" });
    expect(classifyNativeControlError(new DOMException("secret", "AbortError"))).toMatchObject({ status: "cancelled", code: "CONTROL_CANCELLED" });
  });
});
