import { describe, expect, it } from "vitest";
import { ContentDigestSchema } from "../../../src/domain/content-manifest.js";
import { ComponentIdSchema } from "../../../src/domain/components.js";
import { PluginKeySchema } from "../../../src/domain/identity.js";
import type { HookExecutionBinding } from "../../../src/application/ports/hook-execution-context.js";
import { parseHookHandlerOutput, type HookHandlerExecution } from "../../../src/runtime/hooks/hook-output-parser.js";

const binding = (order = 0): HookExecutionBinding => ({
  scope: { kind: "user" },
  plugin: PluginKeySchema.parse("demo@catalog"),
  revision: ContentDigestSchema.parse(`sha256:${"1".repeat(64)}`),
  projectionDigest: ContentDigestSchema.parse(`sha256:${"2".repeat(64)}`),
  contributionDigest: ContentDigestSchema.parse(`sha256:${"3".repeat(64)}`),
  componentId: ComponentIdSchema.parse(`component-v1:hook:${String(order + 1).repeat(64).slice(0, 64)}`),
  sourceOrder: { snapshotOrdinal: order, hookOrdinal: 0 },
});

function execution(stdout: string | Uint8Array, exitCode = 0, order = 0): HookHandlerExecution {
  return {
    binding: binding(order),
    exitCode,
    stdout: typeof stdout === "string" ? new TextEncoder().encode(stdout) : stdout,
    stderr: new Uint8Array(),
    stderrTruncated: false,
  };
}

describe("strict hook output parser", () => {
  it("accepts only event-appropriate JSON and redacts accepted text and rewrites", () => {
    const result = parseHookHandlerOutput({
      event: "PreToolUse",
      execution: execution(JSON.stringify({
        permissionDecision: "deny",
        permissionDecisionReason: "token-CANARY",
        additionalContext: "context-CANARY",
        updatedInput: { value: "CANARY" },
      })),
      redact: (value) => value.replaceAll("CANARY", "[REDACTED]"),
    });
    expect(result).toMatchObject({
      permission: { kind: "deny", reason: "token-[REDACTED]" },
      contexts: ["context-[REDACTED]"],
      updatedInput: { value: "[REDACTED]" },
    });
    expect(JSON.stringify(result)).not.toContain("CANARY");
    if ("code" in result) return;
    expect(Object.isFrozen(result.updatedInput)).toBe(true);
  });

  it("supports plain context only for start and prompt events", () => {
    expect(parseHookHandlerOutput({ event: "SessionStart", execution: execution("plain context"), redact: (value) => value })).toMatchObject({ contexts: ["plain context"] });
    expect(parseHookHandlerOutput({ event: "PostToolUse", execution: execution("plain context"), redact: (value) => value })).toMatchObject({ code: "HOOK_INVALID_OUTPUT" });
  });

  it("rejects unknown, wrong-event, scalar, multiple-value, and invalid UTF-8 output", () => {
    expect(parseHookHandlerOutput({ event: "PreToolUse", execution: execution('{"defer":true}'), redact: (value) => value })).toMatchObject({ code: "HOOK_INVALID_OUTPUT" });
    expect(parseHookHandlerOutput({ event: "PostToolUse", execution: execution('{"updatedInput":{}}'), redact: (value) => value })).toMatchObject({ code: "HOOK_UNSUPPORTED_OUTPUT" });
    expect(parseHookHandlerOutput({ event: "PreToolUse", execution: execution("[]"), redact: (value) => value })).toMatchObject({ code: "HOOK_INVALID_OUTPUT" });
    expect(parseHookHandlerOutput({ event: "PreToolUse", execution: execution('{}{}'), redact: (value) => value })).toMatchObject({ code: "HOOK_INVALID_OUTPUT" });
    expect(parseHookHandlerOutput({ event: "PreToolUse", execution: execution(Uint8Array.of(0xc3, 0x28)), redact: (value) => value })).toMatchObject({ code: "HOOK_INVALID_UTF8" });
    expect(parseHookHandlerOutput({ event: "PreToolUse", execution: execution('{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"bad"}}'), redact: (value) => value })).toMatchObject({ code: "HOOK_UNSUPPORTED_OUTPUT" });
  });

  it("maps exit two only where the event contract can preserve it", () => {
    expect(parseHookHandlerOutput({ event: "PreToolUse", execution: execution("", 2), redact: (value) => value })).toMatchObject({ block: {} });
    expect(parseHookHandlerOutput({ event: "Stop", execution: execution('{"stopReason":"keep going"}', 2), redact: (value) => value })).toMatchObject({ continuation: { reason: "keep going" } });
    expect(parseHookHandlerOutput({ event: "Stop", execution: execution("", 2), redact: (value) => value })).toMatchObject({ continuation: {} });
    expect(parseHookHandlerOutput({ event: "SessionEnd", execution: execution("", 2), redact: (value) => value })).toMatchObject({ code: "HOOK_EXIT_STATUS" });
    expect(parseHookHandlerOutput({ event: "PreToolUse", execution: execution("failure", 1), redact: (value) => value })).toMatchObject({ code: "HOOK_EXIT_STATUS" });
  });

  it("maps only faithful subagent context and boundary-control outputs", () => {
    expect(parseHookHandlerOutput({
      event: "SubagentStart",
      execution: execution('{"additionalContext":"append","continue":false,"stopReason":"blocked"}'),
      redact: (value) => value,
    })).toMatchObject({ contexts: ["append"], stop: { reason: "blocked" } });
    expect(parseHookHandlerOutput({
      event: "SubagentStop",
      execution: execution('{"additionalContext":"retry","decision":"block","reason":"inspect again"}'),
      redact: (value) => value,
    })).toMatchObject({ contexts: ["retry"], continuation: { reason: "inspect again" } });
    expect(parseHookHandlerOutput({
      event: "SubagentStop",
      execution: execution("", 2),
      redact: (value) => value,
    })).toMatchObject({ continuation: {} });
    expect(parseHookHandlerOutput({
      event: "SubagentStart",
      execution: execution('{"updatedInput":{"prompt":"forbidden"}}'),
      redact: (value) => value,
    })).toMatchObject({ code: "HOOK_UNSUPPORTED_OUTPUT" });
    expect(parseHookHandlerOutput({
      event: "SubagentStop",
      execution: execution('{"systemMessage":"unsupported"}'),
      redact: (value) => value,
    })).toMatchObject({ code: "HOOK_UNSUPPORTED_OUTPUT" });
  });

  it("never reports raw stderr, native output, or canary values", () => {
    const result = parseHookHandlerOutput({
      event: "PreToolUse",
      execution: { ...execution("{bad-CANARY", 1), stderr: new TextEncoder().encode("native-CANARY") },
      redact: (value) => value.replaceAll("CANARY", "[REDACTED]"),
    });
    expect(JSON.stringify(result)).not.toContain("CANARY");
    expect(JSON.stringify(result)).not.toContain("native-");
  });
});
