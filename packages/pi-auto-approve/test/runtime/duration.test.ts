import { describe, expect, it } from "vitest";

import { parseDurationToMs } from "../../src/runtime/duration.ts";

describe("parseDurationToMs", () => {
  it("parses hour, minute, second, and combined duration strings", () => {
    expect(parseDurationToMs("10m")).toBe(600_000);
    expect(parseDurationToMs("2h")).toBe(7_200_000);
    expect(parseDurationToMs("1h30m")).toBe(5_400_000);
    expect(parseDurationToMs("45s")).toBe(45_000);
  });

  it("is case-insensitive and tolerates whitespace between units", () => {
    expect(parseDurationToMs("1H 30M 5S")).toBe(5_405_000);
  });

  it("returns undefined for unparseable or empty input", () => {
    expect(parseDurationToMs("bogus")).toBeUndefined();
    expect(parseDurationToMs("")).toBeUndefined();
    expect(parseDurationToMs("10")).toBeUndefined();
    expect(parseDurationToMs("1m later")).toBeUndefined();
  });
});
