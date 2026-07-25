import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import {
  ConfigurationOptionSchema,
  ConfigurationValueKindRegistry,
  ConfigurationValueSchema,
  PluginConfigurationSchema,
  isSafeConfigurationPattern,
  type ConfigurationOption,
  type ConfigurationValue,
  type PluginConfiguration,
} from "../../src/domain/configuration.js";
import { claim, type Provenance } from "../../src/domain/provenance.js";

const source: Provenance = {
  location: {
    host: "claude",
    documentKind: "manifest",
    path: ".claude-plugin/plugin.json",
    pointer: "/userConfig/API_KEY",
  },
};

const label = claim("Option label", source);

function option(
  key: string,
  value: ConfigurationValue,
  overrides: Partial<z.input<typeof ConfigurationOptionSchema>> = {},
): z.input<typeof ConfigurationOptionSchema> {
  return {
    key,
    label,
    value,
    required: false,
    sensitive: false,
    provenance: [source],
    ...overrides,
  };
}

describe("configuration value schemas", () => {
  const samples: Record<ConfigurationValue["kind"], ConfigurationValue> = {
    string: { kind: "string", default: "value", pattern: "^[a-z]+$" },
    number: { kind: "number", default: 2, min: 1, max: 3 },
    boolean: { kind: "boolean", default: true },
    directory: { kind: "directory", default: "./data", mustExist: false },
    file: { kind: "file", default: "./config", mustExist: true },
    strings: { kind: "strings", default: ["one", "two"], minItems: 1, maxItems: 3 },
  };

  it("parses every registry-owned value variant", () => {
    for (const [name, entry] of Object.entries(ConfigurationValueKindRegistry)) {
      const sample = samples[name as ConfigurationValue["kind"]];
      expect(ConfigurationValueSchema.safeParse(sample).success).toBe(true);
      expect(entry.tag).toBe(sample.kind);
    }
  });

  it("derives public values from the discriminated schema", () => {
    expectTypeOf<z.infer<typeof ConfigurationValueSchema>>().toEqualTypeOf<ConfigurationValue>();
    expectTypeOf<ConfigurationValue["kind"]>().toEqualTypeOf<
      "string" | "number" | "boolean" | "directory" | "file" | "strings"
    >();
  });

  it.each([
    [{ kind: "number", min: 4, max: 2 }, "number bounds"],
    [{ kind: "number", min: 2, default: 1 }, "number default below min"],
    [{ kind: "number", max: 2, default: 3 }, "number default above max"],
    [{ kind: "strings", minItems: 3, maxItems: 1 }, "string-array bounds"],
    [{ kind: "strings", minItems: 2, default: ["one"] }, "string-array default below min"],
    [{ kind: "strings", maxItems: 1, default: ["one", "two"] }, "string-array default above max"],
    [{ kind: "string", pattern: "[" }, "invalid pattern"],
    [{ kind: "string", pattern: "^(a+)+$" }, "catastrophic backtracking pattern"],
    [{ kind: "string", pattern: ".*" }, "unbounded wildcard pattern"],
    [{ kind: "string", pattern: "a{0,}" }, "unbounded bounded-quantifier spelling"],
    [{ kind: "string", pattern: "a{0,32}a{0,32}a{0,32}a{0,32}a{0,32}a{0,32}a{0,32}a{0,32}" }, "bounded quantifier chain"],
  ])("rejects inconsistent value descriptors (%s)", (value, _label) => {
    expect(ConfigurationValueSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    [{ kind: "string", configured: "secret" }, "configured string"],
    [{ kind: "number", secret: 4 }, "secret number"],
    [{ kind: "boolean", currentValue: true }, "configured boolean"],
  ])("rejects value-bearing fields in descriptors (%s)", (value, _label) => {
    expect(ConfigurationValueSchema.safeParse(value).success).toBe(false);
  });
});

describe("configuration options", () => {
  it("accepts descriptor metadata without storing a configured value", () => {
    const parsed = PluginConfigurationSchema.parse({
      options: [
        option("API_KEY", { kind: "string", pattern: "^sk-" }, { sensitive: true }),
        option("RETRIES", { kind: "number", default: 2, min: 0, max: 5 }, { required: true }),
        option("PATHS", { kind: "strings", minItems: 1, maxItems: 4 }),
      ],
    });

    expect(parsed.options.map(({ key }) => key)).toEqual(["API_KEY", "RETRIES", "PATHS"]);
    expect(parsed.options[0]).not.toHaveProperty("configured");
    expect(parsed.options[0]).not.toHaveProperty("secret");
  });

  it.each([
    "1INVALID",
    "has-dash",
    "has space",
    "",
  ])("rejects invalid option key %s", (key) => {
    expect(ConfigurationOptionSchema.safeParse(option(key, { kind: "string" })).success).toBe(false);
  });

  it("rejects duplicate keys across the complete configuration", () => {
    const result = PluginConfigurationSchema.safeParse({
      options: [
        option("DUPLICATE", { kind: "string" }),
        option("DUPLICATE", { kind: "boolean" }),
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.join(".") === "options.1.key")).toBe(true);
    }
  });

  it("requires source provenance on labels, options, and descriptions", () => {
    expect(
      ConfigurationOptionSchema.safeParse({
        ...option("NAME", { kind: "string" }),
        label: { value: "without provenance", provenance: [] },
      }).success,
    ).toBe(false);
    expect(
      ConfigurationOptionSchema.safeParse({
        ...option("NAME", { kind: "string" }),
        provenance: [],
      }).success,
    ).toBe(false);
  });

  it("does not permit a sensitive descriptor to carry a default value", () => {
    expect(
      ConfigurationOptionSchema.safeParse(
        option("TOKEN", { kind: "string", default: "secret" }, { sensitive: true }),
      ).success,
    ).toBe(false);
  });

  it("rejects configured and secret state at the option boundary", () => {
    expect(
      ConfigurationOptionSchema.safeParse({
        ...option("TOKEN", { kind: "string" }),
        configuredValue: "secret",
      }).success,
    ).toBe(false);
    expect(
      ConfigurationOptionSchema.safeParse({
        ...option("TOKEN", { kind: "string" }),
        secret: "secret",
      }).success,
    ).toBe(false);
    expect(
      ConfigurationOptionSchema.safeParse({
        ...option("TOKEN", { kind: "string" }),
        label: { ...label, secret: "secret" },
      }).success,
    ).toBe(false);
  });

  it("rejects the bounded-quantifier chain before dynamic regexp compilation", () => {
    const pattern = "a{0,32}".repeat(8);
    const compile = vi.spyOn(globalThis, "RegExp");
    try {
      expect(isSafeConfigurationPattern(pattern)).toBe(false);
      expect(compile).not.toHaveBeenCalled();
    } finally {
      compile.mockRestore();
    }
  });

  it("derives the option and plugin configuration types from schemas", () => {
    expectTypeOf<z.infer<typeof ConfigurationOptionSchema>>().toEqualTypeOf<ConfigurationOption>();
    expectTypeOf<z.infer<typeof PluginConfigurationSchema>>().toEqualTypeOf<PluginConfiguration>();
  });
});
