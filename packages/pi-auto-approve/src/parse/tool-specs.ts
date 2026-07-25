import type { PiBuiltinToolOperation, PiBuiltinToolSpec } from "./shape.ts";

export const SUPPORTED_PI_BUILTIN_TOOL_SPECS = [
  {
    toolName: "read",
    operation: "read-file",
    pathKey: "path",
    pathOptional: false,
  },
  {
    toolName: "ls",
    operation: "list-directory",
    pathKey: "path",
    pathOptional: true,
  },
  {
    toolName: "find",
    operation: "find-files",
    pathKey: "path",
    pathOptional: true,
  },
  {
    toolName: "grep",
    operation: "search-file-contents",
    pathKey: "path",
    pathOptional: true,
  },
  {
    toolName: "fffind",
    operation: "find-files",
    pathKey: "path",
    pathOptional: true,
  },
  {
    toolName: "ffgrep",
    operation: "search-file-contents",
    pathKey: "path",
    pathOptional: true,
  },
] as const satisfies readonly PiBuiltinToolSpec[];

export const SUPPORTED_PI_MUTATION_TOOL_SPECS = [
  {
    toolName: "edit",
    operation: "mutation",
    pathKey: "path",
    pathOptional: false,
  },
  {
    toolName: "write",
    operation: "mutation",
    pathKey: "path",
    pathOptional: false,
  },
] as const satisfies readonly PiBuiltinToolSpec[];

export const SUPPORTED_PI_EXTENSION_TOOL_SPECS = [
  { toolName: "multi_grep", operation: "workspace-search" },
  { toolName: "jobs", operation: "status-read" },
  { toolName: "get_goal", operation: "state-read" },
  { toolName: "list_goal_templates", operation: "state-read" },
  { toolName: "list_goal_queue", operation: "state-read" },
  { toolName: "get_subagent_result", operation: "status-read" },
  { toolName: "list_subagent_models", operation: "status-read" },
  { toolName: "todo", operation: "mutation" },
  { toolName: "ask_user_question", operation: "interactive" },
  { toolName: "create_goal", operation: "mutation" },
  { toolName: "create_goal_from_template", operation: "mutation" },
  { toolName: "update_goal", operation: "mutation" },
  { toolName: "clear_goal", operation: "mutation" },
  { toolName: "enqueue_goal", operation: "mutation" },
  { toolName: "start_queued_goal", operation: "mutation" },
  { toolName: "dequeue_goal", operation: "mutation" },
  { toolName: "remove_queued_goal", operation: "mutation" },
  { toolName: "zai_web_search", operation: "network-read" },
  { toolName: "fetch_content", operation: "network-read" },
  { toolName: "search_repo_docs", operation: "network-read" },
  { toolName: "get_repo_structure", operation: "network-read" },
  { toolName: "read_repo_file", operation: "network-read" },
  { toolName: "umans_web_search", operation: "network-read" },
  { toolName: "umans_vision", operation: "network-read" },
  { toolName: "background", operation: "embedded-shell" },
  { toolName: "monitor", operation: "embedded-shell" },
  { toolName: "subagent", operation: "agent-dispatch" },
  { toolName: "steer_subagent", operation: "agent-dispatch" },
] as const satisfies readonly PiBuiltinToolSpec[];

export const SUPPORTED_PI_TOOL_SPECS = [
  ...SUPPORTED_PI_BUILTIN_TOOL_SPECS,
  ...SUPPORTED_PI_MUTATION_TOOL_SPECS,
  ...SUPPORTED_PI_EXTENSION_TOOL_SPECS,
] as const satisfies readonly PiBuiltinToolSpec[];

export type SupportedPiBuiltinToolName =
  (typeof SUPPORTED_PI_BUILTIN_TOOL_SPECS)[number]["toolName"];
export type SupportedPiMutationToolName =
  (typeof SUPPORTED_PI_MUTATION_TOOL_SPECS)[number]["toolName"];
export type SupportedPiToolName =
  (typeof SUPPORTED_PI_TOOL_SPECS)[number]["toolName"];

export type EffectOperation = PiBuiltinToolOperation;
