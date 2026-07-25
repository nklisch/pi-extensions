import { describe, expect, it } from "vitest";
import { resolveConfigPaths } from "../../src/config/paths.ts";

describe("config paths", () => {
  it("does not expose reviewer consent storage", () => {
    expect("reviewerConsentFile" in resolveConfigPaths("/repo")).toBe(false);
  });
});
