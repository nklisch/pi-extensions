import type { AgentConfig, SubagentMode, ThinkingLevel } from "#src/types";

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
  mode?: SubagentMode;
  timeout_seconds?: number;
  inherit_context?: boolean;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
): {
  modelInput?: string;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  mode: SubagentMode;
  timeoutSeconds?: number;
  inheritContext: boolean;
} {
  return {
    modelInput: agentConfig?.model ?? params.model,
    modelFromParams: agentConfig?.model == null && params.model != null,
    thinking: (agentConfig?.thinking ?? params.thinking) as ThinkingLevel | undefined,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    mode: agentConfig?.mode ?? params.mode ?? "detached",
    timeoutSeconds: agentConfig?.timeoutSeconds ?? params.timeout_seconds,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
  };
}
