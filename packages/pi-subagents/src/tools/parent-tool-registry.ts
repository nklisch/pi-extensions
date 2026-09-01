/**
 * The single source of truth for tools that belong to the parent orchestrator.
 * Children inherit ordinary extension registrations, but these controls are
 * removed to prevent recursive orchestration.
 */
export const PARENT_ONLY_TOOL_NAMES = [
  "subagent",
  "resume_subagent",
  "stop_subagent",
  "steer_subagent",
  "list_subagents",
  "get_subagent_result",
  "query_subagent_session",
] as const;

export type ParentOnlyToolName = typeof PARENT_ONLY_TOOL_NAMES[number];
export const PARENT_ONLY_TOOL_SET: ReadonlySet<string> = new Set(PARENT_ONLY_TOOL_NAMES);
