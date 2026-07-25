import type {
  BeforeAgentStartEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createRatchetModePromptInjector } from "../../src/runtime/mode-prompt.ts";
import type {
  RatchetModeManager,
  RatchetModeResult,
  RatchetModeStatus,
  RatchetToolDefinition,
} from "../../src/runtime/ratchet-mode.ts";

const inactiveStatus: RatchetModeStatus = {
  active: false,
  previousActiveTools: [],
  ratchetToolNames: [],
};

class FakeRatchetModeManager implements RatchetModeManager {
  active = false;
  ratchetToolNames: readonly string[] = [];

  isRatchetActive(): boolean {
    return this.active;
  }

  getStatus(): RatchetModeStatus {
    return {
      ...inactiveStatus,
      active: this.active,
      ratchetToolNames: [...this.ratchetToolNames],
    };
  }

  registerRatchetTool(_tool: RatchetToolDefinition): void {}

  enterRatchetMode(): RatchetModeResult {
    throw new Error("enterRatchetMode should not be called by prompt injector");
  }

  exitRatchetMode(): RatchetModeResult {
    throw new Error("exitRatchetMode should not be called by prompt injector");
  }
}

function fakeManager(options: {
  readonly active: boolean;
  readonly ratchetToolNames?: readonly string[];
}): FakeRatchetModeManager {
  const manager = new FakeRatchetModeManager();
  manager.active = options.active;
  manager.ratchetToolNames = options.ratchetToolNames ?? [];
  return manager;
}

function beforeAgentStartEvent(
  overrides: Partial<BeforeAgentStartEvent> = {},
): BeforeAgentStartEvent {
  return {
    type: "before_agent_start",
    prompt: "Tune the policy from recent history.",
    systemPrompt: "Base system prompt.",
    images: [],
    systemPromptOptions: {
      cwd: "/tmp/project",
      selectedTools: ["bash", "read"],
      toolSnippets: { bash: "run shell commands" },
      promptGuidelines: ["Use read before editing."],
    },
    ...overrides,
  };
}

function fakeContext(): ExtensionContext {
  return {} as ExtensionContext;
}

describe("createRatchetModePromptInjector", () => {
  it("always appends proposal guidance while mode is inactive", async () => {
    const manager = fakeManager({ active: false });
    const event = beforeAgentStartEvent();
    const originalPrompt = event.systemPrompt;
    const handler = createRatchetModePromptInjector(manager);

    const result = await handler(event, fakeContext());

    expect(result?.systemPrompt).toContain(originalPrompt);
    expect(result?.systemPrompt).toContain("clearance_propose");
    expect(result?.systemPrompt).toContain("clearance_present");
    expect(result?.systemPrompt).not.toContain("## Ratchet mode guidance");
  });

  it("appends ratchet guidance to the existing prompt while mode is active", async () => {
    const manager = fakeManager({
      active: true,
      ratchetToolNames: ["clearance_status"],
    });
    const event = beforeAgentStartEvent({ systemPrompt: "Existing prompt" });
    const handler = createRatchetModePromptInjector(manager);

    const result = await handler(event, fakeContext());

    expect(result).toEqual({
      systemPrompt: expect.stringContaining(
        "Existing prompt\n\n## Ratchet mode guidance",
      ),
    });
    expect(result?.systemPrompt).toContain("Ratchet mode is active");
    expect(result?.systemPrompt).toContain(
      "ratchet-only analysis tools are temporarily available",
    );
    expect(result?.systemPrompt).toContain(
      "Prefer structured corpus, replay, and proposal tools over reading raw logs directly",
    );
    expect(result?.systemPrompt).toContain(
      "Replay candidate changes across the full corpus before recommending them",
    );
    expect(result?.systemPrompt).toContain("docs/PACK_AUTHORING.md");
    expect(result?.systemPrompt).toContain(
      "Proposal writes require explicit Pi UI approval",
    );
    expect(result?.systemPrompt).toContain(
      "do not write config or policy files directly as a substitute for proposal approval",
    );
  });

  it("names registered ratchet tools in the guidance", async () => {
    const manager = fakeManager({
      active: true,
      ratchetToolNames: [
        "clearance_list_history_families",
        "clearance_replay_proposal",
      ],
    });
    const handler = createRatchetModePromptInjector(manager);

    const result = await handler(beforeAgentStartEvent(), fakeContext());

    expect(result?.systemPrompt).toContain(
      "Registered ratchet tools: clearance_list_history_families, clearance_replay_proposal.",
    );
  });

  it("mentions when no ratchet tools are registered", async () => {
    const manager = fakeManager({ active: true, ratchetToolNames: [] });
    const handler = createRatchetModePromptInjector(manager);

    const result = await handler(beforeAgentStartEvent(), fakeContext());

    expect(result?.systemPrompt).toContain(
      "No ratchet tools are registered yet.",
    );
  });

  it("does not mutate the incoming event object or nested prompt data", async () => {
    const manager = fakeManager({
      active: true,
      ratchetToolNames: ["clearance_generate_proposals"],
    });
    const event = beforeAgentStartEvent();
    const eventBefore = structuredClone(event);
    const handler = createRatchetModePromptInjector(manager);

    await handler(event, fakeContext());

    expect(event).toEqual(eventBefore);
  });
});
