import { describe, expect, it } from "vitest";
import { readCodexHooks } from "../../../src/formats/codex/hook-reader.js";
import type { Provenance } from "../../../src/domain/provenance.js";
import { PluginKeySchema } from "../../../src/domain/identity.js";

const provenance: Provenance = {
  location: {
    host: "codex",
    documentKind: "hooks",
    path: "hooks/hooks.json",
    pointer: "",
  },
};
const context = {
  plugin: PluginKeySchema.parse("demo@catalog"),
  nativeHost: "codex" as const,
  provenance,
};

describe("Codex hook reader", () => {
  it("uses the same structural normalization while retaining Codex provenance", () => {
    const result = readCodexHooks({
      hooks: {
        SessionStart: [{
          matcher: "startup",
          hooks: [{ type: "exec", command: "python3", args: ["start.py"], timeoutMs: 2000 }],
        }],
      },
    }, context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    const component = result.value[0];
    expect(component).toMatchObject({
      kind: "hook",
      event: { value: "SessionStart", provenance: [{ location: { host: "codex", documentKind: "hooks" } }] },
      matcher: { value: "startup" },
      handler: { value: { kind: "exec", command: "python3", args: ["start.py"], timeoutMs: 2000 } },
    });
  });

  it("rejects malformed group and timeout structure instead of inventorying it", () => {
    const badGroup = readCodexHooks({ hooks: { SessionStart: [{ hooks: {} }] } }, context);
    expect(badGroup.ok).toBe(false);
    const badTimeout = readCodexHooks({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo", timeout: "fast" }] }] },
    }, context);
    expect(badTimeout.ok).toBe(false);
    expect(badTimeout).toMatchObject({ diagnostics: [{ location: { pointer: "/hooks/SessionStart/0/hooks/0/timeout" } }] });
  });
});
