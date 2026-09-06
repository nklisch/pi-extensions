import { describe, expect, it } from "vitest";
import extension from "../src/index.js";

describe("@nklisch/pi-ollama-cloud", () => {
  it("exports an extension factory", () => {
    expect(extension).toBeTypeOf("function");
  });
});
