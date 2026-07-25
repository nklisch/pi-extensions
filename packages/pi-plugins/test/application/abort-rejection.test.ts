import { describe, expect, it } from "vitest";
import { isAbortRejection } from "../../src/application/abort-rejection.js";

describe("application abort-rejection classification", () => {
  it("recognizes only the two adapter rejection shapes on objects", () => {
    expect(isAbortRejection({ name: "AbortError" })).toBe(true);
    expect(isAbortRejection({ code: "ABORT_ERR" })).toBe(true);

    for (const value of [
      null,
      undefined,
      "AbortError",
      { name: "TimeoutError" },
      { code: "ERR_ABORTED" },
      { message: "AbortError" },
    ]) {
      expect(isAbortRejection(value)).toBe(false);
    }
  });
});
