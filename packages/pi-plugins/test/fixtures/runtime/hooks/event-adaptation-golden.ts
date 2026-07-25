import type { HookComponent } from "../../../../src/domain/components.js";
import { claim } from "../../../../src/domain/provenance.js";
import { componentId } from "../../../fixtures/compatibility/common.js";

const provenance = { location: { host: "claude" as const, documentKind: "hooks" as const, path: "hooks/hooks.json", pointer: "/hooks" } };
const contextCommand = 'PYTHONDONTWRITEBYTECODE=1 python3 "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/hooks/scripts/prompt-context.py"';
const maintainerCommand = 'PYTHONDONTWRITEBYTECODE=1 python3 "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/hooks/scripts/substrate-maintainer.py"';
function component(event: string, matcher: string | undefined, command: string, token: string): HookComponent {
  return {
    kind: "hook",
    id: componentId("hook", token),
    event: claim(event, provenance),
    ...(matcher === undefined ? {} : { matcher: claim(matcher, provenance) }),
    handler: claim({ kind: "shell", command, timeoutMs: 5 }, provenance),
    metadata: [],
  };
}

export const agileWorkflowEventAdaptationGolden = {
  source: "test/fixtures/plugins/hooks/agile-workflow-hooks.json",
  hooks: [
    component("SessionStart", "startup|resume|clear|compact", contextCommand, "a"),
    component("UserPromptSubmit", undefined, contextCommand, "b"),
    component("PostCompact", "manual|auto", contextCommand, "c"),
    component("PostToolUse", "Write|Edit|apply_patch", maintainerCommand, "d"),
  ] as readonly HookComponent[],
  canaries: [contextCommand, maintainerCommand] as const,
} as const;
