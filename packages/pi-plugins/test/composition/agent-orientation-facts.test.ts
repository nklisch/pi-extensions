import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { HostStartupResult } from "../../src/application/host-observation-contract.js";
import type { LifecycleStateStore } from "../../src/application/ports/lifecycle-state-store.js";
import { createAgentOrientationFactsCollector } from "../../src/composition/agent-orientation-facts.js";
import type { PluginHostPathPlan } from "../../src/composition/plugin-host-paths.js";
import type { PiProjectContextAdapters } from "../../src/pi/pi-project-context.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const user = { kind: "user" } as const;
const project = {
  kind: "project",
  identity: {} as never,
  projectKey: "project-v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as never,
};

const startup = {
  status: "ready",
  blocked: [],
  capabilities: {
    mcp: { status: "available", explanation: "available" },
    subagents: { status: "available", explanation: "available" },
    piReload: { status: "available", explanation: "available" },
    secrets: { status: "available", explanation: "available" },
  },
} as unknown as HostStartupResult;

describe("agent orientation authoritative facts", () => {
  it("refreshes by authoritative generation and rechecks before publication", async () => {
    let generation = 1;
    const state = {
      read: vi.fn(async () => ({
        ok: true,
        snapshot: {
          scope: user,
          generation,
          installed: { plugins: [] },
        },
      })),
    } as unknown as LifecycleStateStore;
    const projectAdapters = {
      scope: project,
      revalidate: vi.fn(async () => ({ identity: {}, projectKey: project.projectKey, trust: { kind: "untrusted" } })),
    } as unknown as PiProjectContextAdapters;
    const collector = createAgentOrientationFactsCollector({
      paths: { orientationBrief: () => "/brief.md" } as unknown as PluginHostPathPlan,
      packageVersion: "0.3.9",
      state,
      project: projectAdapters,
      installed: {} as never,
      content: {} as never,
      contentReader: {} as never,
      selections: { snapshot: () => ({ selections: [] }) } as never,
      startup,
      latestDesired: () => undefined,
      sha256,
    });

    const first = await collector.collect(new AbortController().signal);
    expect(await collector.isCurrent(first, new AbortController().signal)).toBe(true);
    generation = 2;
    expect(await collector.isCurrent(first, new AbortController().signal)).toBe(false);
    const second = await collector.collect(new AbortController().signal);
    expect(second).not.toBe(first);
    expect(second.generationKey).toBe("user::2");
  });
});
