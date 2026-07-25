import { z } from "zod";
import {
  ordinaryHookEvents,
  subagentHookEvents,
  type ExecutableHookEvent,
} from "./hook-runtime-contract.js";
import { JsonValueSchema, type JsonValue } from "./schema.js";
import type { HookExecutionBinding } from "./hook-execution-binding.js";

const permissionValues = ["allow", "deny", "ask"] as const;

export const HookSpecificOutputSchema = z.object({
  hookEventName: z.string().min(1),
  additionalContext: z.string().optional(),
  permissionDecision: z.enum(permissionValues).optional(),
  permissionDecisionReason: z.string().optional(),
  updatedInput: z.record(z.string(), JsonValueSchema).optional(),
  updatedToolOutput: JsonValueSchema.optional(),
}).strict().readonly();
export type HookSpecificOutput = z.infer<typeof HookSpecificOutputSchema>;

export const CommandHookJsonOutputSchema = z.object({
  continue: z.boolean().optional(),
  stopReason: z.string().optional(),
  systemMessage: z.string().optional(),
  decision: z.literal("block").optional(),
  reason: z.string().optional(),
  permissionDecision: z.enum(permissionValues).optional(),
  permissionDecisionReason: z.string().optional(),
  additionalContext: z.string().optional(),
  updatedInput: z.record(z.string(), JsonValueSchema).optional(),
  updatedToolOutput: JsonValueSchema.optional(),
  title: z.string().min(1).optional(),
  hookSpecificOutput: HookSpecificOutputSchema.optional(),
}).strict().readonly();
export type CommandHookJsonOutput = z.infer<typeof CommandHookJsonOutputSchema>;

export const HookOutputFieldRegistry = Object.freeze({
  continue: { nested: false, events: [...ordinaryHookEvents, ...subagentHookEvents] },
  stopReason: { nested: false, events: ["UserPromptSubmit", "PreToolUse", "PreCompact", "Stop", "SubagentStart", "SubagentStop"] as const },
  systemMessage: { nested: false, events: ordinaryHookEvents },
  decision: { nested: false, events: ["UserPromptSubmit", "PreToolUse", "PreCompact", "Stop", "SubagentStart", "SubagentStop"] as const },
  reason: { nested: false, events: ["UserPromptSubmit", "PreToolUse", "PreCompact", "Stop", "SubagentStart", "SubagentStop"] as const },
  permissionDecision: { nested: true, events: ["PreToolUse"] as const },
  permissionDecisionReason: { nested: true, events: ["PreToolUse"] as const },
  additionalContext: { nested: true, events: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PreCompact", "PostCompact", "Stop", "SubagentStart", "SubagentStop"] as const },
  updatedInput: { nested: true, events: ["PreToolUse"] as const },
  updatedToolOutput: { nested: true, events: ["PostToolUse"] as const },
  title: { nested: false, events: ordinaryHookEvents },
} as const);

export type HookOutputField = keyof typeof HookOutputFieldRegistry;
export type HookOutputExitTwoMeaning = "block" | "continuation" | "unsupported";

const executableHookEvents = [...ordinaryHookEvents, ...subagentHookEvents] as const;
export const HookOutputEventPolicyRegistry = Object.freeze(
  Object.fromEntries(executableHookEvents.map((event) => [event, {
    plain: event === "SessionStart" || event === "UserPromptSubmit",
    exitTwo: event === "Stop" || event === "SubagentStop"
      ? "continuation"
      : ["UserPromptSubmit", "PreToolUse", "PreCompact", "SubagentStart"].includes(event)
        ? "block"
        : "unsupported",
    // Every boundary fails OPEN on infrastructure failure: a broken hook is
    // observability noise, never a reason to eat a prompt, block a tool call,
    // cancel compaction, or abort a subagent. Explicit hook decisions (exit 2,
    // decision:block, permission deny) remain fully enforced; only planning
    // errors, timeouts, spawn failures, and invalid output downgrade to a
    // warning plus a failure-log record.
  }])) as Readonly<Record<ExecutableHookEvent, Readonly<{
    plain: boolean;
    exitTwo: HookOutputExitTwoMeaning;
  }>>>,
);

export type ParsedHookDecision = Readonly<{
  binding: HookExecutionBinding;
  contexts: readonly string[];
  systemMessages: readonly string[];
  block?: Readonly<{ reason?: string }>;
  permission?: Readonly<{ kind: "allow" | "deny" | "ask"; reason?: string }>;
  updatedInput?: Readonly<Record<string, JsonValue>>;
  updatedToolOutput?: JsonValue;
  stop?: Readonly<{ reason?: string }>;
  title?: string;
  continuation?: Readonly<{ reason?: string }>;
}>;

export type AggregatedHookDecision = Readonly<{
  event: ExecutableHookEvent;
  contexts: readonly string[];
  systemMessages: readonly string[];
  block?: Readonly<{ reason?: string }>;
  permission?: Readonly<{ kind: "allow" | "deny" | "ask"; reason?: string }>;
  updatedInput?: Readonly<Record<string, JsonValue>>;
  updatedToolOutput?: JsonValue;
  stop?: Readonly<{ reason?: string }>;
  title?: string;
  continuation?: Readonly<{ reason?: string }>;
  diagnostics: readonly {
    readonly code: string;
    readonly severity: "warning" | "error";
    readonly event: string;
    readonly plugin: string;
    readonly componentId: string;
    readonly sourceOrder: Readonly<{ snapshotOrdinal: number; hookOrdinal: number }>;
    readonly message: string;
  }[];
}>;
