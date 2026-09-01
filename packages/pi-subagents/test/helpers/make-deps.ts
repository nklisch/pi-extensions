import { vi } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import type { AgentToolManager, AgentToolRuntime, AgentToolSettings } from "#src/tools/agent-tool";
import type { DeliveryOutcome } from "#src/lifecycle/subagent-manager";
import { makeModel } from "./make-model";
import { createTestSubagent } from "./make-subagent";
import { STUB_SNAPSHOT } from "./stub-ctx";

const defaultRegistry = new AgentTypeRegistry(() => new Map());

export type AgentToolFixture = {
  manager: AgentToolManager;
  runtime: AgentToolRuntime;
  settings: AgentToolSettings;
  registry: AgentTypeRegistry;
  agentDir: string;
};

export function createToolDeps(overrides: Partial<AgentToolFixture> = {}): AgentToolFixture {
  const record = createTestSubagent({ mode: "detached" });
  const runtime: AgentToolRuntime = {
    buildSnapshot: vi.fn((_inheritContext: boolean): ParentSnapshot => STUB_SNAPSHOT),
    getModelInfo: vi.fn(() => ({
      parentModel: makeModel({ id: "claude-sonnet", name: "Claude Sonnet" }),
      modelRegistry: { find: () => undefined, getAll: () => [], getAvailable: () => [] },
    })),
    getSessionInfo: vi.fn(() => ({
      parentSessionFile: "/sessions/parent.jsonl",
      parentSessionId: "session-1",
    })),
  };
  const manager: AgentToolManager = {
    launch: vi.fn(async (): Promise<DeliveryOutcome> => ({ kind: "detached", agentId: record.id, runId: record.runId })),
    getRecord: vi.fn().mockReturnValue(record),
  };
  return {
    manager,
    runtime,
    settings: { defaultMaxTurns: undefined },
    registry: defaultRegistry,
    agentDir: "/home/user/.pi",
    ...overrides,
  };
}

export function createToolDepsWithDisabledBuiltInAgents(...names: string[]): AgentToolFixture {
  const registry = new AgentTypeRegistry(() => new Map(
    names.map((name) => [name, {
      name,
      description: "disabled built-in agent",
      promptMode: "append" as const,
      systemPrompt: "",
      isDefault: true,
      enabled: false,
    }]),
  ));
  return createToolDeps({ registry });
}
