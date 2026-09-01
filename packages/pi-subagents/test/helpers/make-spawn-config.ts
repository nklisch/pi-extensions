import type { ResolvedSpawnConfig } from "#src/tools/spawn-config";

export interface ResolvedSpawnConfigOptions {
  subagentType?: string; rawType?: string; fellBack?: boolean; displayName?: string;
  prompt?: string; description?: string; model?: string; mode?: "joined" | "detached";
}

export function createResolvedSpawnConfig(options: ResolvedSpawnConfigOptions = {}): ResolvedSpawnConfig {
  const subagentType = options.subagentType ?? "general-purpose";
  const displayName = options.displayName ?? "Agent";
  const description = options.description ?? "task";
  const mode = options.mode ?? "detached";
  const modelName = options.model ?? "unknown model";
  const invocation = { modelName, thinking: undefined, maxTurns: undefined, inheritContext: false, mode, timeoutSeconds: undefined };
  return {
    identity: { subagentType, rawType: options.rawType ?? subagentType, fellBack: options.fellBack ?? false, displayName },
    execution: {
      prompt: options.prompt ?? "do the task", description, model: undefined, effectiveMaxTurns: undefined,
      thinking: undefined, effectiveThinkingLevel: "off", inheritContext: false, mode, timeoutSeconds: undefined,
      agentInvocation: invocation,
    },
    presentation: { modelName, agentTags: [`mode: ${mode}`], detailBase: { displayName, description, subagentType, modelName, thinkingLevel: "off", tags: [`mode: ${mode}`] } },
  };
}
