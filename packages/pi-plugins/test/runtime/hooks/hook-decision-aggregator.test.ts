import { describe, expect, it } from "vitest";
import { buildPreToolUseInput } from "../../../src/runtime/hooks/tool-event-input.js";
import { buildSessionStartInput, buildUserPromptSubmitInput } from "../../../src/runtime/hooks/event-input.js";
import type { ParsedHookDecision } from "../../../src/domain/hook-output-contract.js";
import { aggregateHookDecisions } from "../../../src/runtime/hooks/hook-decision-aggregator.js";
import { createHookRuntimeDiagnostic } from "../../../src/runtime/hooks/hook-runtime-diagnostic.js";
import { project, session } from "./fixtures.js";
import { ContentDigestSchema } from "../../../src/domain/content-manifest.js";
import { ComponentIdSchema } from "../../../src/domain/components.js";
import { PluginKeySchema } from "../../../src/domain/identity.js";
import type { HookExecutionBinding } from "../../../src/application/ports/hook-execution-context.js";

function binding(order: number): HookExecutionBinding {
  return {
    scope: { kind: "user" },
    plugin: PluginKeySchema.parse("demo@catalog"),
    revision: ContentDigestSchema.parse(`sha256:${"1".repeat(64)}`),
    projectionDigest: ContentDigestSchema.parse(`sha256:${"2".repeat(64)}`),
    contributionDigest: ContentDigestSchema.parse(`sha256:${"3".repeat(64)}`),
    componentId: ComponentIdSchema.parse(`component-v1:hook:${String(order + 1).repeat(64).slice(0, 64)}`),
    sourceOrder: { snapshotOrdinal: order, hookOrdinal: 0 },
  };
}

function decision(order: number, values: Omit<ParsedHookDecision, "binding" | "contexts" | "systemMessages"> & Partial<Pick<ParsedHookDecision, "contexts" | "systemMessages">>): ParsedHookDecision {
  return {
    binding: binding(order),
    contexts: values.contexts ?? [],
    systemMessages: values.systemMessages ?? [],
    ...values,
  };
}

describe("ordered hook decision aggregation", () => {
  it("uses declaration order for context, reasons, patches, output, and title", () => {
    const input = buildPreToolUseInput(session(), { toolName: "write", toolCallId: "tool", input: { old: true } });
    const result = aggregateHookDecisions({
      event: "PreToolUse",
      originalInput: input,
      decisions: [
        decision(1, { contexts: ["later"], block: { reason: "later reason" }, permission: { kind: "allow", reason: "later allow reason" }, updatedInput: { value: "later" }, title: "later" }),
        decision(0, { contexts: ["first"], systemMessages: ["notice"], block: { reason: "first reason" }, permission: { kind: "ask", reason: "first ask reason" }, updatedInput: { value: "first", keep: 1 }, title: "first" }),
      ],
    });
    expect(result.contexts).toEqual(["first", "later"]);
    expect(result.systemMessages).toEqual(["notice"]);
    expect(result.block).toEqual({ reason: "first reason" });
    expect(result.permission).toEqual({ kind: "ask", reason: "first ask reason" });
    expect(result.updatedInput).toEqual({ old: true, value: "later", keep: 1 });
    expect(result.title).toBe("later");
  });

  it("gives deny precedence over ask and allow and keeps healthy decisions alongside an error", () => {
    const input = buildUserPromptSubmitInput(session(), "hello", "interactive", undefined);
    const deny = decision(1, { permission: { kind: "deny", reason: "deny" }, contexts: ["unsafe"] });
    const ask = decision(0, { permission: { kind: "ask", reason: "ask" }, contexts: ["safe"] });
    const result = aggregateHookDecisions({ event: "UserPromptSubmit", originalInput: input, decisions: [deny, ask] });
    expect(result.permission).toEqual({ kind: "deny", reason: "deny" });
    expect(result.contexts).toEqual(["safe", "unsafe"]);

    // One broken hook no longer suppresses the healthy hook's decisions;
    // the diagnostic rides alongside so callers can warn and log.
    const diagnostic = createHookRuntimeDiagnostic(binding(1), "UserPromptSubmit", "HOOK_INVALID_OUTPUT");
    const failed = aggregateHookDecisions({ event: "UserPromptSubmit", originalInput: input, decisions: [ask, diagnostic] });
    expect(failed.contexts).toEqual(["safe"]);
    expect(failed.permission).toEqual({ kind: "ask", reason: "ask" });
    expect(failed.diagnostics).toEqual([diagnostic]);
  });

  it("aggregates empty-session input without using cleanup aliases", () => {
    const input = buildSessionStartInput(session(), "startup");
    const result = aggregateHookDecisions({ event: "SessionStart", originalInput: input, decisions: [] });
    expect(result).toMatchObject({ event: "SessionStart", contexts: [], diagnostics: [] });
  });
});
