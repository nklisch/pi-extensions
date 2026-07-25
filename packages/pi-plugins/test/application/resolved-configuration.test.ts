import { describe, expect, it } from "vitest";
import { createResolvedConfiguration } from "../../src/application/resolved-configuration.js";

describe("resolved configuration environment", () => {
  it("builds null-prototype environment maps for hostile but valid keys", () => {
    const resolved = createResolvedConfiguration([
      { key: "__proto__", value: { kind: "string", value: "safe-prototype-value" } },
      { key: "constructor", value: { kind: "string", value: "safe-constructor-value" } },
    ]);
    const environment = resolved.environment();
    expect(Object.getPrototypeOf(environment)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(environment, "CLAUDE_PLUGIN_OPTION___proto__")).toBe(true);
    expect(environment.CLAUDE_PLUGIN_OPTION___proto__).toBe("safe-prototype-value");
    expect(environment.CLAUDE_PLUGIN_OPTION_constructor).toBe("safe-constructor-value");
    resolved.dispose();
  });
});
