import { describe, expect, it } from "vitest";
import { readClaudeUserConfig } from "../../../src/formats/claude/user-config-reader.js";
import { PluginKeySchema } from "../../../src/domain/identity.js";

const context = {
  plugin: PluginKeySchema.parse("demo@catalog"),
  path: ".claude-plugin/plugin.json",
  pointer: "/userConfig",
};

describe("Claude userConfig reader", () => {
  it("normalizes descriptor metadata without collecting values", () => {
    const result = readClaudeUserConfig({
      API_KEY: {
        type: "string",
        title: "API key",
        description: "Used by the remote service",
        required: true,
        sensitive: true,
        pattern: "^sk-",
      },
      RETRIES: { type: "number", default: 2, min: 0, max: 5 },
      PATHS: { type: "string", multiple: true, minItems: 1, maxItems: 3, default: ["one"] },
      CACHE: { type: "directory", mustExist: false, default: "./cache" },
    }, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.options).toMatchObject([
      { key: "API_KEY", label: { value: "API key" }, required: true, sensitive: true, value: { kind: "string", pattern: "^sk-" } },
      { key: "CACHE", value: { kind: "directory", mustExist: false, default: "./cache" } },
      { key: "PATHS", value: { kind: "strings", minItems: 1, maxItems: 3, default: ["one"] } },
      { key: "RETRIES", value: { kind: "number", default: 2, min: 0, max: 5 } },
    ]);
    expect(JSON.stringify(result.value)).not.toContain("configured");
    expect(JSON.stringify(result.value)).not.toContain("secret");
    expect(result.value.options[0]?.provenance[0]?.location).toMatchObject({
      host: "claude",
      documentKind: "manifest",
      pointer: "/userConfig/API_KEY",
    });
  });

  it("rejects unknown types and descriptor value inconsistencies", () => {
    for (const input of [
      { UNKNOWN: { type: "object" } },
      { SECRET: { type: "string", sensitive: true, default: "do-not-store" } },
      { BAD_PATTERN: { type: "string", pattern: "[" } },
      { BAD_DEFAULT: { type: "number", default: "2" } },
      { BAD_BOUNDS: { type: "number", min: 5, max: 1 } },
      { BAD_ARRAY: { type: "string", multiple: true, minItems: 2, default: ["one"] } },
      { BAD_FIELD: { type: "string", configured: "value" } },
    ]) {
      expect(readClaudeUserConfig(input, context).ok).toBe(false);
    }
  });

  it("rejects duplicate keys in the explicit descriptor-list form", () => {
    const result = readClaudeUserConfig([
      { key: "DUPLICATE", type: "string" },
      { key: "DUPLICATE", type: "boolean" },
    ], context);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("value");
  });
});
