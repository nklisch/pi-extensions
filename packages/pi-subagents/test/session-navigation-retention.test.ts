import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { listNavigableAgents } from "#src/ui/session-navigation";
import { makeNavigable } from "#test/helpers/make-navigable";

const registry = new AgentTypeRegistry(() => new Map());

describe("session navigation after retention release", () => {
  it("sources a released record from its persisted transcript", () => {
    const entries = listNavigableAgents([
      makeNavigable({
        isSessionReady: () => false,
        outputFile: "/sessions/child.jsonl",
      }),
    ], registry);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "evicted",
      outputFile: "/sessions/child.jsonl",
    });
    expect(entries[0].label).toContain("released (snapshot)");
  });
});
