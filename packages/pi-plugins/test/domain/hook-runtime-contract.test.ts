import { describe, expect, it } from "vitest";
import {
  HookConditionFieldRegistry,
  HookConditionOperatorRegistry,
  HookRuntimeEventDefinitionRegistry,
  HookToolAliasDefinitionRegistry,
  compileHookSelector,
  matchesHookSelector,
  validateHookToolAliasDefinitions,
} from "../../src/domain/hook-runtime-contract.js";
import { CompatibilityPolicyRegistry } from "../../src/domain/compatibility-policy.js";
import type { HookComponent } from "../../src/domain/components.js";

const provenance = [{ location: { host: "claude" as const, documentKind: "hooks" as const, path: "hooks.json", pointer: "/hooks" } }];
const claim = <T>(value: T) => ({ value, provenance });
const id = "component-v1:hook:" + "a".repeat(64);
function hook(event: string, matcher?: string, conditions?: unknown): HookComponent {
  return {
    kind: "hook",
    id: id as HookComponent["id"],
    event: claim(event),
    ...(matcher === undefined ? {} : { matcher: claim(matcher) }),
    handler: claim({ kind: "exec", command: "canary", args: [] }),
    metadata: conditions === undefined ? [] : [{ key: "claude.hook.if", claimed: claim(conditions) }],
  } as HookComponent;
}

describe("hook runtime contract registry", () => {
  it("derives compatibility event partitions from the one registry", () => {
    const entries = Object.entries(HookRuntimeEventDefinitionRegistry);
    expect(CompatibilityPolicyRegistry.hookEvents.supported).toEqual(entries.filter(([, v]) => v.owner === "ordinary").map(([k]) => k));
    expect(CompatibilityPolicyRegistry.hookEvents.subagent).toEqual(entries.filter(([, v]) => v.owner === "subagent").map(([k]) => k));
    expect(CompatibilityPolicyRegistry.hookEvents.incompatible).toEqual(entries.filter(([, v]) => v.owner === "incompatible").map(([k]) => k));
    expect(new Set(CompatibilityPolicyRegistry.hookEvents.supported).size).toBe(9);
  });

  it.each([
    [undefined, true], ["", true], ["*", true], ["Write|Edit", true], ["Write,Edit", true], ["write", true], ["[", false], ["x".repeat(1025), false],
  ])("compiles matcher %j as %s", (matcher, valid) => {
    expect(compileHookSelector(hook("PreToolUse", matcher)).kind === "valid").toBe(valid);
  });

  it("keeps matcher matching case-aware and alias-candidate based", () => {
    const compiled = compileHookSelector(hook("PreToolUse", "Write|Edit"));
    if (compiled.kind !== "valid") throw new Error("expected selector");
    expect(matchesHookSelector(compiled.selector, { event: "PreToolUse", matcherCandidates: ["write", "Write", "apply_patch"], toolNameAliases: ["Write", "write", "apply_patch"] })).toBe(true);
    expect(matchesHookSelector(compiled.selector, { event: "PreToolUse", matcherCandidates: ["write"], toolNameAliases: ["write"] })).toBe(false);
  });

  it.each([
    [{ field: "tool_name", operator: "equals", value: "write" }, true],
    [{ field: "tool_input", operator: "contains", value: "needle" }, true],
    [{ field: "tool_response", operator: "equals", value: "ready" }, false],
    [{ field: "tool_name", operator: "regex", value: "[" }, false],
    [{ field: "tool_name", operator: "in", value: [] }, false],
    [{ field: "unknown", operator: "equals", value: "x" }, false],
  ])("validates event-specific condition grammar %#", (condition, valid) => {
    expect(compileHookSelector(hook("PreToolUse", undefined, condition)).kind === "valid").toBe(valid);
  });

  it("accepts wrappers and AND arrays while bounding canonical subjects", () => {
    const compiled = compileHookSelector(hook("PostToolUse", undefined, { if: [
      { field: "tool_name", operator: "in", value: ["Write", "write"] },
      { field: "tool_input", operator: "contains", value: "needle" },
    ] }));
    expect(compiled.kind).toBe("valid");
    expect(HookConditionFieldRegistry).toContain("tool_response");
    expect(HookConditionOperatorRegistry).toEqual(["equals", "contains", "matches", "regex", "in"]);
  });

  it("checks static identities before accepting dynamic rows", () => {
    expect(validateHookToolAliasDefinitions()).toHaveLength(Object.keys(HookToolAliasDefinitionRegistry).length);
    expect(() => validateHookToolAliasDefinitions([{ preferred: "Bash", piNames: ["custom"], aliases: ["custom"], rank: 1 }])).toThrow();
    expect(validateHookToolAliasDefinitions([{ preferred: "Agent", piNames: ["agent"], aliases: ["Agent", "agent"], rank: 100 }])).toHaveLength(8);
  });

  it("does not permit matcher declarations on boundaries without a subject", () => {
    expect(compileHookSelector(hook("SessionEnd", "anything"))).toMatchObject({ kind: "incompatible", code: "matcher-not-applicable" });
  });
});
