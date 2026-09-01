import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig } from "#src/config/invocation-config";
import type { AgentConfig } from "#src/types";

const config: AgentConfig = {
  name: "worker",
  description: "worker",
  promptMode: "append",
  systemPrompt: "",
  mode: "joined",
  timeoutSeconds: 30,
  maxTurns: 4,
};

describe("execution configuration", () => {
  it("uses joined/detached mode and active timeout defaults", () => {
    expect(resolveAgentInvocationConfig(config, {})).toMatchObject({ mode: "joined", timeoutSeconds: 30, maxTurns: 4 });
    expect(resolveAgentInvocationConfig(undefined, { mode: "detached", timeout_seconds: 9 })).toMatchObject({ mode: "detached", timeoutSeconds: 9 });
  });

  it("does not expose removed delivery fields", () => {
    const resolved = resolveAgentInvocationConfig(undefined, {});
    expect(resolved).not.toHaveProperty("runInBackground");
    expect(resolved).not.toHaveProperty("foreground");
  });
});
