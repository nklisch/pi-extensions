/**
 * Plain-language projection for user-facing failure text.
 *
 * Internal codes (HOOK_*, planning codes, lifecycle codes) are the failure
 * log's vocabulary. Notifications and screens speak in the user's frame of
 * reference: the plugin they added, the message they typed, and the one
 * action they can take. Every phrase here leads with what happened and what
 * to do; codes never appear in UI text.
 */

/** Hook event names → the moment the user recognizes. */
export function plainHookMoment(event: string): string {
  switch (event) {
    case "SessionStart": return "at session start";
    case "SessionEnd": return "at session end";
    case "UserPromptSubmit": return "on your message";
    case "PreToolUse": return "before a tool call";
    case "PostToolUse":
    case "PostToolUseFailure": return "after a tool call";
    case "PreCompact":
    case "PostCompact": return "during compaction";
    case "Stop": return "at turn end";
    case "SubagentStart": return "starting a subagent";
    case "SubagentStop": return "finishing a subagent";
    default: return "";
  }
}

const PLAIN_HOOK_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  HOOK_TIMEOUT: "it took too long",
  HOOK_SPAWN_FAILED: "it couldn't start",
  HOOK_EXECUTABLE_UNAVAILABLE: "it couldn't start",
  HOOK_OUTPUT_LIMIT: "its output was too large",
  HOOK_INVALID_OUTPUT: "it gave an unexpected response",
  HOOK_UNSUPPORTED_OUTPUT: "it asked for something unsupported",
  HOOK_INVALID_UTF8: "it gave an unreadable response",
  HOOK_INVALID_PLAN: "its setup was invalid",
  HOOK_SELECTED_LIMIT: "too many hooks ran at once",
  HOOK_AUTHORITY_REJECTED: "the plugin runtime wasn't ready yet",
  HOOK_CONFIGURATION_FAILED: "its configuration couldn't be read",
  HOOK_CANCELLED: "it was cancelled",
  HOOK_AGGREGATE_LIMIT: "the combined hook output was too large",
  HOOK_CONTINUATION_EXHAUSTED: "it asked to continue too many times",
  HOOK_PERMISSION_UNAVAILABLE: "its permission question couldn't be shown",
  CURRENT_PROJECT_MISMATCH: "the project changed underneath it",
  PROJECT_SCOPE_MISMATCH: "the project changed underneath it",
  PROJECT_UNTRUSTED: "this project isn't trusted",
  PI_PROJECT_UNTRUSTED: "this project isn't trusted",
  PROJECTION_MISMATCH: "the plugin changed since it was loaded",
  SELECTOR_RECOMPILATION_MISMATCH: "the plugin changed since it was loaded",
  CATALOG_UNAVAILABLE: "the plugin catalog isn't ready yet",
  CATALOG_UNINITIALIZED: "the plugin catalog isn't ready yet",
  INVALID_REQUEST: "it got a request it didn't understand",
  UNSUPPORTED_EVENT: "it doesn't support that moment",
  CANCELLED: "it was cancelled",
});

/** Internal hook failure code → a short plain reason. */
export function plainHookFailure(code: string): string {
  return PLAIN_HOOK_FAILURES[code] ?? "it hit an internal error";
}

/** One simple sentence for a hook that didn't run. */
export function plainHookWarning(input: Readonly<{ event: string; code: string; plugin?: string }>): string {
  const who = input.plugin ?? "A plugin";
  const when = plainHookMoment(input.event);
  return `${who}'s hook ${when === "" ? "didn't run" : `didn't run ${when}`} — ${plainHookFailure(input.code)}. Continuing without it.`;
}

const PLAIN_LIFECYCLE_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  "reload-rejected": "Pi couldn't reload with the plugin",
  "observation-mismatch": "it didn't come up as expected",
  "adapter-error": "an internal error interrupted it",
  ADAPTER_FAILED: "an internal error interrupted it",
  PROGRESS_DELIVERY_FAILED: "progress reporting broke",
  PROJECT_INTENT_WRITE_FAILED: "the project's plugin list couldn't be written",
  CLEANUP_FAILED: "cleanup didn't finish",
  DISPOSED: "the plugin runtime was shut down",
  CONFIG_REQUIRED: "a required setting is missing",
  CONSENT_REQUIRED: "the executable disclosure needs a decision",
});

/** Lifecycle failure code → a short plain reason. */
export function plainLifecycleFailure(code: string): string {
  return PLAIN_LIFECYCLE_FAILURES[code] ?? "an internal error interrupted it";
}

/** Kebab-case machine phase ("activation-observation") → words the user recognizes. */
export function plainLifecyclePhase(phase: string): string {
  const words = phase.replaceAll("-", " ");
  switch (phase) {
    case "activation-observation": return "the post-install check";
    case "activation-transaction": return "the install itself";
    case "candidate-acquisition": return "downloading the plugin";
    case "input-validation": return "checking your configuration";
    case "configuration-custody": return "storing your configuration";
    case "trust-decision": return "the trust decision";
    case "uninstall-cleanup": return "cleanup after removal";
    case "project-reconciliation": return "syncing the project";
    case "completed": return "the final step";
    default: return words;
  }
}
