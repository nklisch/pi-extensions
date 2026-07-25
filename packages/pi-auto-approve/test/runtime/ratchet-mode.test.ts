import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import {
  createRatchetModeManager,
  type RatchetModeManager,
  type RatchetToolDefinition,
} from "../../src/runtime/ratchet-mode.ts";

type RatchetPi = Parameters<RatchetModeManager["enterRatchetMode"]>[0];

class FakePi {
  activeTools: string[];
  readonly preExistingToolNames: string[];
  readonly registeredTools: ToolDefinition[] = [];
  readonly registerToolCalls: ToolDefinition[] = [];
  readonly setActiveToolsCalls: string[][] = [];

  constructor(
    activeTools: readonly string[] = [],
    preExistingToolNames: readonly string[] = [],
  ) {
    this.activeTools = [...activeTools];
    this.preExistingToolNames = [...preExistingToolNames];
  }

  getActiveTools(): string[] {
    return [...this.activeTools];
  }

  setActiveTools(toolNames: string[]): void {
    this.setActiveToolsCalls.push([...toolNames]);
    this.activeTools = [...toolNames];
  }

  registerTool(tool: ToolDefinition): void {
    this.registerToolCalls.push(tool);
    this.registeredTools.push(tool);
  }

  getAllTools(): ReturnType<RatchetPi["getAllTools"]> {
    return [
      ...this.preExistingToolNames.map((name) => ({
        name,
        description: `${name} pre-existing`,
        parameters: Type.Object({}),
      })),
      ...this.registeredTools,
    ] as unknown as ReturnType<RatchetPi["getAllTools"]>;
  }
}

function fakePi(
  activeTools: readonly string[] = [],
  preExistingToolNames: readonly string[] = [],
): FakePi & RatchetPi {
  return new FakePi(activeTools, preExistingToolNames) as FakePi & RatchetPi;
}

function ratchetTool(
  name: string,
  overrides: Partial<Omit<RatchetToolDefinition, "name">> = {},
): RatchetToolDefinition {
  return {
    name,
    label: name,
    description: `${name} description`,
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: "text", text: `${name} result` }],
        details: {},
      };
    },
    ...overrides,
  };
}

describe("createRatchetModeManager", () => {
  it("snapshots active tools and activates the stable union", () => {
    const manager = createRatchetModeManager();
    const pi = fakePi(["bash", "read"]);
    const queryTool = ratchetTool("clearance_list_history_families");
    const replayTool = ratchetTool("clearance_replay_proposal");

    manager.registerRatchetTool(queryTool);
    manager.registerRatchetTool(replayTool);

    const result = manager.enterRatchetMode(pi);

    expect(result.ok).toBe(true);
    expect(result.status).toEqual({
      active: true,
      previousActiveTools: ["bash", "read"],
      ratchetToolNames: [
        "clearance_list_history_families",
        "clearance_replay_proposal",
      ],
    });
    expect(pi.activeTools).toEqual([
      "bash",
      "read",
      "clearance_list_history_families",
      "clearance_replay_proposal",
    ]);
    expect(pi.setActiveToolsCalls).toEqual([
      [
        "bash",
        "read",
        "clearance_list_history_families",
        "clearance_replay_proposal",
      ],
    ]);
    expect(pi.registerToolCalls).toEqual([queryTool, replayTool]);
  });

  it("filters stale ratchet tools from the entry snapshot before restoring", () => {
    const manager = createRatchetModeManager();
    const pi = fakePi(["bash", "clearance_replay_proposal"]);
    const ratchet = ratchetTool("clearance_replay_proposal");

    manager.registerRatchetTool(ratchet);

    const enterResult = manager.enterRatchetMode(pi);
    expect(enterResult.status.previousActiveTools).toEqual(["bash"]);
    expect(pi.activeTools).toEqual(["bash", "clearance_replay_proposal"]);

    const exitResult = manager.exitRatchetMode(pi);

    expect(exitResult.fallback).toBeUndefined();
    expect(pi.activeTools).toEqual(["bash"]);
  });

  it("skips a non-prefixed ratchet tool and reports it", () => {
    const manager = createRatchetModeManager();
    const pi = fakePi(["bash"]);

    manager.registerRatchetTool(ratchetTool("unsafe_status"));
    const result = manager.enterRatchetMode(pi);

    expect(result.message).toContain(
      "Warning: skipped ratchet tools: unsafe_status",
    );
    expect(pi.registerToolCalls).toEqual([]);
    expect(pi.activeTools).toEqual(["bash"]);
  });

  it("skips a pre-existing colliding tool name and reports it", () => {
    const manager = createRatchetModeManager();
    const pi = fakePi(["bash"], ["clearance_status"]);
    const collidingTool = ratchetTool("clearance_status");
    const validTool = ratchetTool("clearance_list_packs");

    manager.registerRatchetTool(collidingTool);
    manager.registerRatchetTool(validTool);

    const result = manager.enterRatchetMode(pi);

    expect(result.message).toContain(
      "Warning: skipped ratchet tools: clearance_status",
    );
    expect(pi.registerToolCalls).toEqual([validTool]);
    expect(pi.activeTools).toEqual(["bash", "clearance_list_packs"]);
  });

  it("restores the exact previous tools when active tools are otherwise unchanged", () => {
    const manager = createRatchetModeManager();
    const pi = fakePi(["bash", "read"]);
    const ratchet = ratchetTool("clearance_replay_proposal");

    manager.registerRatchetTool(ratchet);
    manager.enterRatchetMode(pi);

    pi.activeTools = ["clearance_replay_proposal", "read", "bash"];
    const result = manager.exitRatchetMode(pi);

    expect(result.ok).toBe(true);
    expect(result.fallback).toBeUndefined();
    expect(result.status).toEqual({
      active: false,
      previousActiveTools: [],
      ratchetToolNames: ["clearance_replay_proposal"],
    });
    expect(pi.activeTools).toEqual(["bash", "read"]);
    expect(pi.setActiveToolsCalls.at(-1)).toEqual(["bash", "read"]);
  });

  it("falls back and preserves a non-ratchet tool added while mode is active", () => {
    const manager = createRatchetModeManager();
    const pi = fakePi(["bash"]);

    manager.registerRatchetTool(ratchetTool("clearance_replay_proposal"));
    manager.enterRatchetMode(pi);

    pi.activeTools = ["bash", "clearance_replay_proposal", "edit"];
    const result = manager.exitRatchetMode(pi);

    expect(result.ok).toBe(true);
    expect(result.fallback).toEqual({
      kind: "tools-changed",
      restored: ["bash", "edit"],
      expected: ["bash", "clearance_replay_proposal"],
      actual: ["bash", "clearance_replay_proposal", "edit"],
      message: expect.stringContaining("Active tools changed"),
    });
    expect(pi.activeTools).toEqual(["bash", "edit"]);
  });

  it("falls back without re-adding a previous tool removed while mode is active", () => {
    const manager = createRatchetModeManager();
    const pi = fakePi(["bash", "read"]);

    manager.registerRatchetTool(ratchetTool("clearance_replay_proposal"));
    manager.enterRatchetMode(pi);

    pi.activeTools = ["read", "clearance_replay_proposal"];
    const result = manager.exitRatchetMode(pi);

    expect(result.fallback).toMatchObject({
      kind: "tools-changed",
      restored: ["read"],
      expected: ["bash", "read", "clearance_replay_proposal"],
      actual: ["read", "clearance_replay_proposal"],
    });
    expect(pi.activeTools).toEqual(["read"]);
  });

  it("always removes ratchet-only tool names on exit", () => {
    const manager = createRatchetModeManager();
    const pi = fakePi(["bash"]);

    manager.registerRatchetTool(ratchetTool("clearance_generate_proposals"));
    manager.registerRatchetTool(ratchetTool("clearance_replay_proposal"));
    manager.enterRatchetMode(pi);

    pi.activeTools = [
      "clearance_generate_proposals",
      "edit",
      "clearance_replay_proposal",
    ];
    manager.exitRatchetMode(pi);

    expect(pi.activeTools).toEqual(["edit"]);
    expect(pi.activeTools).not.toContain("clearance_generate_proposals");
    expect(pi.activeTools).not.toContain("clearance_replay_proposal");
  });

  it("deduplicates registered ratchet tools by name and keeps the latest definition", () => {
    const manager = createRatchetModeManager();
    const pi = fakePi(["bash"]);
    const first = ratchetTool("clearance_status", { label: "old" });
    const latest = ratchetTool("clearance_status", { label: "latest" });

    manager.registerRatchetTool(first);
    manager.registerRatchetTool(latest);

    expect(manager.getStatus().ratchetToolNames).toEqual(["clearance_status"]);

    manager.enterRatchetMode(pi);

    expect(pi.registerToolCalls).toEqual([latest]);
    expect(pi.activeTools).toEqual(["bash", "clearance_status"]);
  });

  it("treats re-entry while active as a no-op", () => {
    const manager = createRatchetModeManager();
    const pi = fakePi(["bash"]);

    manager.registerRatchetTool(ratchetTool("clearance_status"));
    manager.enterRatchetMode(pi);

    pi.activeTools = ["bash", "clearance_status"];
    const result = manager.enterRatchetMode(pi);

    expect(result.status.active).toBe(true);
    expect(pi.registerToolCalls).toHaveLength(1);
    expect(pi.setActiveToolsCalls).toHaveLength(1);
    expect(pi.activeTools).toEqual(["bash", "clearance_status"]);
  });

  it("treats exit while inactive as a no-op", () => {
    const manager = createRatchetModeManager();
    const pi = fakePi(["bash"]);

    manager.registerRatchetTool(ratchetTool("clearance_status"));
    const result = manager.exitRatchetMode(pi);

    expect(result).toEqual({
      ok: true,
      status: {
        active: false,
        previousActiveTools: [],
        ratchetToolNames: ["clearance_status"],
      },
      message: "Ratchet mode is already off.",
    });
    expect(pi.activeTools).toEqual(["bash"]);
    expect(pi.setActiveToolsCalls).toEqual([]);
  });
});
