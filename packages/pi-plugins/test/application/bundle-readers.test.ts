import { describe, expect, it } from "vitest";
import type { BundleReaderSet } from "../../src/application/ports/bundle-readers.js";
import type { ReadResult } from "../../src/domain/errors.js";

type AnyReadResult = ReadResult<never>;
const unsupported = (): AnyReadResult => ({
  ok: false,
  diagnostics: [{
    code: "SCHEMA_INVALID",
    severity: "error",
    operation: "test.reader",
    message: "test reader",
  }],
});

describe("bundle reader injection port", () => {
  it("accepts pure reader implementations without exposing filesystem methods", () => {
    const readers: BundleReaderSet = {
      claudeManifest: unsupported,
      codexManifest: unsupported,
      claudeHooks: unsupported,
      codexHooks: unsupported,
      claudeMcp: unsupported,
      codexMcp: unsupported,
      agentSkill: unsupported,
    };

    expect(Object.keys(readers)).toEqual([
      "claudeManifest",
      "codexManifest",
      "claudeHooks",
      "codexHooks",
      "claudeMcp",
      "codexMcp",
      "agentSkill",
    ]);
    expect(readers).not.toHaveProperty("root");
    expect(readers).not.toHaveProperty("readFile");
  });
});
