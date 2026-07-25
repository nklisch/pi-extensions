import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ComponentLogicalIdentitySchema,
  ComponentIdVersionRegistry,
  deriveComponentId,
  verifyComponentId,
  type ComponentLogicalIdentity,
} from "../../src/domain/component-identity.js";
import { PluginKeySchema } from "../../src/domain/identity.js";
import { ComponentIdSchema } from "../../src/domain/components.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const plugin = PluginKeySchema.parse("demo@community");

describe("component-id-v1", () => {
  it("derives stable golden ids for every component kind", () => {
    const vectors: readonly [ComponentLogicalIdentity, string][] = [
      [
        { kind: "skill", root: "./skills/demo" },
        "component-v1:skill:5fe7313fede4e74d38f741c9c0456863e989179bd65d37f61db8fedfd67eabc7",
      ],
      [
        { kind: "hook", event: "SessionStart", handler: { kind: "shell", command: "./hooks/start.sh" } },
        "component-v1:hook:1445279463a8c36b50e62cef9e3e99afa10561cf0700473200b940f4a4ed5546",
      ],
      [
        { kind: "mcp-server", nativeKey: "search" },
        "component-v1:mcp-server:2cf9cd5184d8b48679f23d9aebf6b34ba223193762bb6384de361394925c8e5e",
      ],
      [
        { kind: "foreign", nativeHost: "codex", nativeKind: "apps", declarationSubkey: "key:remote" },
        "component-v1:foreign:4ca3ce9b65351ff20e67936758c905e0786f348d0ead488b384519bb0d997cf8",
      ],
    ];

    expect(ComponentIdVersionRegistry.v1).toBe("component-v1");
    for (const [identity, expected] of vectors) {
      expect(ComponentLogicalIdentitySchema.safeParse(identity).success).toBe(true);
      expect(deriveComponentId(plugin, identity, sha256)).toBe(expected);
      expect(verifyComponentId(expected, plugin, identity, sha256)).toBe(expected);
      expect(ComponentIdSchema.safeParse(expected).success).toBe(true);
    }
  });

  it("makes equivalent identities independent of provenance and object order", () => {
    const first = deriveComponentId(
      plugin,
      {
        kind: "hook",
        event: "PostToolUse",
        matcher: "Write|Edit",
        handler: { kind: "exec", command: "node", args: ["hook.js"], timeoutMs: 5000 },
      },
      sha256,
    );
    const second = deriveComponentId(
      plugin,
      {
        kind: "hook",
        handler: { timeoutMs: 5000, args: ["hook.js"], command: "node", kind: "exec" },
        matcher: "Write|Edit",
        event: "PostToolUse",
      },
      sha256,
    );
    expect(second).toBe(first);

    expect(deriveComponentId(PluginKeySchema.parse("other@community"), { kind: "skill", root: "./skills/demo" }, sha256)).not.toBe(
      deriveComponentId(plugin, { kind: "skill", root: "./skills/demo" }, sha256),
    );
    expect(deriveComponentId(plugin, { kind: "skill", root: "./skills/demo" }, sha256)).not.toBe(
      deriveComponentId(plugin, { kind: "foreign", nativeHost: "codex", nativeKind: "skill", declarationSubkey: "default" }, sha256),
    );
    expect(deriveComponentId(plugin, { kind: "skill", root: "./skills/demo" }, sha256)).not.toBe(
      deriveComponentId(plugin, { kind: "skill", root: "./skills/other" }, sha256),
    );
  });

  it("distinguishes absent and empty optional hook matchers", () => {
    const handler = { kind: "shell" as const, command: "./hook.sh" };
    const absent = deriveComponentId(plugin, { kind: "hook", event: "SessionStart", handler }, sha256);
    const empty = deriveComponentId(plugin, { kind: "hook", event: "SessionStart", matcher: "", handler }, sha256);
    expect(absent).not.toBe(empty);
  });

  it("rejects forged ids and malformed hash functions", () => {
    const identity = { kind: "skill" as const, root: "./skills/demo" };
    const expected = deriveComponentId(plugin, identity, sha256);
    expect(() => verifyComponentId(`${expected.slice(0, -1)}0`, plugin, identity, sha256)).toThrow();
    expect(() => deriveComponentId(plugin, identity, () => new Uint8Array(31))).toThrow();
    expect(ComponentIdSchema.safeParse("component-v2:skill:" + "0".repeat(64)).success).toBe(false);
  });
});
