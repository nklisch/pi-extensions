import { CompatibilityPolicyRegistry } from "../../../src/domain/compatibility-policy.js";
import {
  directPlugin,
  fixtureProvenance,
  claimFixture,
  componentId,
  expectedOutcome,
  expectedRequirement,
  type PolicyFixture,
} from "./common.js";

function hook(
  event: string,
  handler: { kind: "shell" | "exec"; command: string; args?: readonly string[] },
  metadata: readonly unknown[] = [],
  token = "1",
): unknown {
  const path = "hooks/hooks.json";
  const pointer = `/hooks/${event}`;
  return {
    kind: "hook" as const,
    id: componentId("hook", token),
    event: claimFixture(event, fixtureProvenance(path, pointer, "claude", "hooks")),
    handler: claimFixture(handler, fixtureProvenance(path, `${pointer}/0/hooks/0`, "claude", "hooks")),
    metadata,
  };
}

function metadata(key: string, value: unknown, pointer: string): unknown {
  return {
    key,
    claimed: claimFixture(value, fixtureProvenance("hooks/hooks.json", pointer, "claude", "hooks")),
  };
}

const shellHook = (token = "1") => hook("SessionStart", { kind: "shell", command: "echo ready" }, [], token);
const baseline = () => directPlugin({ components: { hooks: [shellHook()] } });

export const hookPolicyFixtures: readonly PolicyFixture[] = [
  {
    id: "hook-command",
    ruleId: "hook.command",
    positive: baseline,
    negative: () => directPlugin(),
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true, {
      requirements: [
        expectedRequirement("hook", "1", "pi.hooks.command"),
        expectedRequirement("hook", "1", "platform.shell.bash"),
      ],
    }),
    negativeExpected: expectedOutcome([], true),
  },
  {
    id: "hook-status-message",
    ruleId: "hook.status-message",
    positive: () => directPlugin({ components: { hooks: [hook("SessionStart", { kind: "shell", command: "echo ready" }, [
      metadata("claude.hook.statusMessage", "starting", "/hooks/SessionStart/0/statusMessage"),
    ], "2")] } }),
    negative: baseline,
    positiveVerdict: "supported",
    diagnosticRuleId: "hook.status-message",
    positiveExpected: expectedOutcome(["supported"], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["hook.status-message"],
      diagnosticSourcePointers: ["/hooks/SessionStart/0/statusMessage"],
      requirements: [
        expectedRequirement("hook", "2", "pi.hooks.command"),
        expectedRequirement("hook", "2", "platform.shell.bash"),
      ],
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: [
        expectedRequirement("hook", "1", "pi.hooks.command"),
        expectedRequirement("hook", "1", "platform.shell.bash"),
      ],
    }),
  },
  {
    id: "hook-shell-bash",
    ruleId: "hook.shell.bash",
    positive: () => directPlugin({ components: { hooks: [shellHook("3")] } }),
    negative: () => directPlugin({ components: { hooks: [hook("SessionStart", { kind: "exec", command: "bash", args: [] }, [], "4")] } }),
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true, {
      requirements: [
        expectedRequirement("hook", "3", "pi.hooks.command"),
        expectedRequirement("hook", "3", "platform.shell.bash"),
      ],
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: [expectedRequirement("hook", "4", "pi.hooks.command")],
    }),
  },
  {
    id: "hook-shell-powershell",
    ruleId: "hook.shell.powershell",
    positive: () => directPlugin({ components: { hooks: [hook("SessionStart", { kind: "shell", command: "Write-Output ready" }, [
      metadata("claude.hook.shell", "powershell", "/hooks/SessionStart/0/shell"),
    ], "5")] } }),
    negative: baseline,
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true, {
      requirements: [
        expectedRequirement("hook", "5", "pi.hooks.command"),
        expectedRequirement("hook", "5", "platform.shell.powershell"),
      ],
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: [
        expectedRequirement("hook", "1", "pi.hooks.command"),
        expectedRequirement("hook", "1", "platform.shell.bash"),
      ],
    }),
  },
  {
    id: "hook-if-rule",
    ruleId: "hook.if-rule",
    positive: () => directPlugin({ components: { hooks: [hook("PreToolUse", { kind: "exec", command: "check", args: [] }, [
      metadata("claude.hook.if", { field: "tool_name", operator: "equals", value: "bash" }, "/hooks/PreToolUse/0/if"),
    ], "6")] } }),
    negative: () => directPlugin({ components: { hooks: [hook("PreToolUse", { kind: "exec", command: "check", args: [] }, [
      metadata("claude.hook.if", "arbitrary condition syntax", "/hooks/PreToolUse/0/if"),
    ], "7")] } }),
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true, {
      requirements: [expectedRequirement("hook", "6", "pi.hooks.command")],
    }),
    negativeExpected: expectedOutcome(["metadata-only"], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["hook.event.default-deny"],
      diagnosticSourcePointers: ["/hooks/PreToolUse/0/if"],
    }),
  },
  {
    id: "hook-async",
    ruleId: "hook.async",
    positive: () => directPlugin({ components: { hooks: [
      hook("SessionStart", { kind: "shell", command: "echo ready" }, [
        metadata("claude.hook.async", true, "/hooks/SessionStart/0/async"),
      ], "8"),
      hook("SessionEnd", { kind: "shell", command: "echo ready" }, [
        metadata("claude.hook.asyncRewake", true, "/hooks/SessionEnd/0/asyncRewake"),
      ], "9"),
    ] } }),
    negative: baseline,
    positiveVerdict: "metadata-only",
    diagnosticRuleId: "hook.async",
    positiveExpected: expectedOutcome(["metadata-only", "metadata-only"], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION", "UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["hook.async", "hook.async"],
      diagnosticSourcePointers: ["/hooks/SessionStart/0/async", "/hooks/SessionEnd/0/asyncRewake"],
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: [
        expectedRequirement("hook", "1", "pi.hooks.command"),
        expectedRequirement("hook", "1", "platform.shell.bash"),
      ],
    }),
  },
  {
    id: "hook-handler-unsupported",
    ruleId: "hook.handler.unsupported",
    positive: () => directPlugin({ components: { foreign: [{
      kind: "foreign",
      id: componentId("foreign", "9"),
      nativeHost: "claude",
      nativeKind: claimFixture("hook-handler", fixtureProvenance("hooks/hooks.json", "/hooks/SessionStart/0/hooks/0/type", "claude", "hooks")),
      declarationSubkey: "event:SessionStart/handler-type",
      declaration: claimFixture({ type: "http", url: "https://example.invalid/CANARY" }, fixtureProvenance("hooks/hooks.json", "/hooks/SessionStart/0/hooks/0", "claude", "hooks")),
    }] } }),
    negative: baseline,
    positiveVerdict: "metadata-only",
    diagnosticRuleId: "hook.handler.unsupported",
    positiveExpected: expectedOutcome(["metadata-only"], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["hook.handler.unsupported"],
      diagnosticSourcePointers: ["/hooks/SessionStart/0/hooks/0/type", "/hooks/SessionStart/0/hooks/0"],
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: [
        expectedRequirement("hook", "1", "pi.hooks.command"),
        expectedRequirement("hook", "1", "platform.shell.bash"),
      ],
    }),
  },
  {
    id: "hook-event-supported",
    ruleId: "hook.event.supported",
    positive: () => directPlugin({ components: { hooks: CompatibilityPolicyRegistry.hookEvents.supported.map((event, index) =>
      hook(event, { kind: "exec", command: "check", args: [] }, [], `d${(index + 1).toString(16)}`),
    ) } }),
    negative: () => directPlugin({ components: { hooks: [hook("PermissionRequest", { kind: "exec", command: "check", args: [] }, [], "11")] } }),
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(CompatibilityPolicyRegistry.hookEvents.supported.map(() => "supported"), true, {
      requirements: CompatibilityPolicyRegistry.hookEvents.supported.map((_, index) =>
        expectedRequirement("hook", `d${(index + 1).toString(16)}`, "pi.hooks.command")),
    }),
    negativeExpected: expectedOutcome(["metadata-only"], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["hook.event.incompatible"],
      diagnosticSourcePointers: ["/hooks/PermissionRequest"],
    }),
  },
  {
    id: "hook-event-subagent",
    ruleId: "hook.event.subagent",
    positive: () => directPlugin({ components: { hooks: [hook("SubagentStart", { kind: "exec", command: "check", args: [] }, [], "12")] } }),
    negative: baseline,
    positiveVerdict: "supported",
    positiveExpected: expectedOutcome(["supported"], true, {
      requirements: [
        expectedRequirement("hook", "12", "pi.hooks.command"),
        expectedRequirement("hook", "12", "pi.subagents.lifecycle-interception"),
      ],
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: [
        expectedRequirement("hook", "1", "pi.hooks.command"),
        expectedRequirement("hook", "1", "platform.shell.bash"),
      ],
    }),
  },
  {
    id: "hook-event-incompatible",
    ruleId: "hook.event.incompatible",
    positive: () => directPlugin({ components: { hooks: CompatibilityPolicyRegistry.hookEvents.incompatible.map((event, index) =>
      hook(event, { kind: "exec", command: "check", args: [] }, [], `a${(index + 1).toString(16)}`),
    ) } }),
    negative: baseline,
    positiveVerdict: "metadata-only",
    diagnosticRuleId: "hook.event.incompatible",
    positiveExpected: expectedOutcome(CompatibilityPolicyRegistry.hookEvents.incompatible.map(() => "metadata-only"), true, {
      diagnosticCodes: CompatibilityPolicyRegistry.hookEvents.incompatible.map(() => "UNSUPPORTED_DECLARATION"),
      diagnosticRuleIds: CompatibilityPolicyRegistry.hookEvents.incompatible.map(() => "hook.event.incompatible"),
      diagnosticSourcePointers: CompatibilityPolicyRegistry.hookEvents.incompatible.map((event) => `/hooks/${event}`),
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: [
        expectedRequirement("hook", "1", "pi.hooks.command"),
        expectedRequirement("hook", "1", "platform.shell.bash"),
      ],
    }),
  },
  {
    id: "hook-event-default-deny",
    ruleId: "hook.event.default-deny",
    positive: () => directPlugin({ components: { hooks: [hook("FutureLifecycleEvent", { kind: "exec", command: "check", args: [] }, [], "b")] } }),
    negative: baseline,
    positiveVerdict: "metadata-only",
    diagnosticRuleId: "hook.event.default-deny",
    positiveExpected: expectedOutcome(["metadata-only"], true, {
      diagnosticCodes: ["UNSUPPORTED_DECLARATION"],
      diagnosticRuleIds: ["hook.event.default-deny"],
      diagnosticSourcePointers: ["/hooks/FutureLifecycleEvent"],
    }),
    negativeExpected: expectedOutcome(["supported"], true, {
      requirements: [
        expectedRequirement("hook", "1", "pi.hooks.command"),
        expectedRequirement("hook", "1", "platform.shell.bash"),
      ],
    }),
  },
];

export const hookIngestionFixtures = {
  supported: {
    hooks: {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "echo start", timeout: 1, statusMessage: "starting" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "exec", command: "check", args: ["prompt"] }] }],
      PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "exec", command: "check", args: ["tool"], conditions: { field: "tool_name", operator: "equals", value: "write" } }] }],
      SubagentStart: [{ hooks: [{ type: "exec", command: "check", args: ["subagent"] }] }],
        SubagentStop: [{ hooks: [{ type: "exec", command: "check", args: ["subagent-stop"] }] }],
      },
    },
  },
  unknowns: {
    hooks: {
      hooks: {
        FutureLifecycleEvent: [{ hooks: [{ type: "command", command: "echo unknown" }] }],
        PermissionRequest: [{ hooks: [{ type: "command", command: "echo permission" }] }],
        SessionEnd: [{ hooks: [{ type: "http", url: "https://example.invalid/CANARY_HANDLER" }] }],
      },
    },
  },
} as const;
