import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  CompatibilityPolicyRegistry,
  CompatibilityPolicyRuleRegistry,
  RuntimeCapabilityAvailabilitySchema,
  RuntimeCapabilityIdSchema,
  RuntimeCapabilityRegistry,
  RuntimeCapabilitySnapshotSchema,
  type RuntimeCapabilitySnapshot,
} from "../../src/domain/compatibility-policy.js";
import { RuntimeRequirementStatusRegistry } from "../../src/domain/compatibility.js";

describe("compatibility policy registry", () => {
  it("has a unique, schema-valid rule for every policy rule", () => {
    const rules = Object.values(CompatibilityPolicyRuleRegistry);
    expect(rules.length).toBeGreaterThan(20);
    expect(new Set(rules.map((rule) => rule.id)).size).toBe(rules.length);
    for (const rule of rules) {
      expect(rule.requirementCapabilityIds.every((id) =>
        RuntimeCapabilityIdSchema.safeParse(id).success,
      )).toBe(true);
    }
    expect(CompatibilityPolicyRegistry.hookEvents.supported).toContain("SessionStart");
    expect(CompatibilityPolicyRegistry.mcp.keys.transport).toBe("transport");
  });

  it("keeps transport-specific MCP fields, targets, and collisions in one registry", () => {
    const groups = CompatibilityPolicyRegistry.mcp.keys.fieldGroups;
    const allowedRoots = (transport: "stdio" | "streamable-http" | "sse" | "websocket") =>
      Object.values(groups).flatMap((group) => group.transports.includes(transport as never)
        ? group.aliases.map((alias) => alias.split(".")[0]!)
        : []);
    expect(allowedRoots("stdio")).toEqual(expect.arrayContaining(["command", "args", "env", "cwd"]));
    expect(allowedRoots("stdio")).not.toEqual(expect.arrayContaining([
      "url", "headers", "bearerTokenEnv", "auth", "oauth", "authentication",
    ]));
    expect(allowedRoots("streamable-http")).toEqual(expect.arrayContaining([
      "url", "headers", "bearerTokenEnv", "auth", "oauth", "authentication",
    ]));
    expect(allowedRoots("sse")).not.toEqual(expect.arrayContaining(["command", "args", "env", "cwd"]));
    expect(allowedRoots("websocket")).not.toEqual(expect.arrayContaining(["command", "args", "env", "cwd"]));
    expect(groups.startupTimeout).toMatchObject({
      target: "options.startupTimeoutMs",
      aliases: ["startupTimeout", "timeoutMs"],
      collision: "exact-equality",
    });
  });

  it("derives capability status validation from the requirement status registry", () => {
    for (const status of Object.values(RuntimeRequirementStatusRegistry)) {
      expect(RuntimeCapabilityAvailabilitySchema.safeParse({
        status: status.tag,
        explanation: "fixture",
      }).success).toBe(true);
    }
    const capabilities = Object.fromEntries(
      Object.values(RuntimeCapabilityRegistry).map((entry) => [entry.id, {
        status: "available",
        explanation: `${entry.id} is available`,
      }]),
    );
    const snapshot = RuntimeCapabilitySnapshotSchema.parse({ capabilities, capturedBy: "test" });
    expectTypeOf<z.infer<typeof RuntimeCapabilitySnapshotSchema>>().toEqualTypeOf<RuntimeCapabilitySnapshot>();
    expect(Object.keys(snapshot.capabilities)).toHaveLength(Object.keys(RuntimeCapabilityRegistry).length);
  });

  it("rejects incomplete and unknown capability snapshots", () => {
    const capabilities = Object.fromEntries(
      Object.values(RuntimeCapabilityRegistry).map((entry) => [entry.id, {
        status: "available",
        explanation: "fixture",
      }]),
    );
    const first = Object.keys(capabilities)[0]!;
    delete capabilities[first];
    expect(RuntimeCapabilitySnapshotSchema.safeParse({ capabilities, capturedBy: "test" }).success).toBe(false);
    expect(RuntimeCapabilitySnapshotSchema.safeParse({
      capabilities: { ...capabilities, "unknown.capability": { status: "available", explanation: "fixture" } },
      capturedBy: "test",
    }).success).toBe(false);
  });
});
