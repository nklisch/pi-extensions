import { describe, expect, it } from "vitest";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { openSettingsNativeUi } from "../../../../src/runtime/config-commands/settings/native-ui.ts";
import type { SettingsReadModel } from "../../../../src/runtime/config-commands/settings/read-model.ts";

function model(): SettingsReadModel {
  return {
    modes: [],
    currentMode: { mode: "ask", label: "Ask", description: "Review" },
    status: {
      mode: "ask",
      reviewer: {
        promptPosture: "reviewer.default",
        configuredModel: null,
        resolvedModel: null,
        resolvedModelSource: "none",
        modelHighCost: false,
        path: "human",
        consequence: "review uncertain calls",
        contextMode: "recentContext",
      },
      packs: { enabled: 0, total: 0 },
      ratchet: {
        active: false,
        previousActiveTools: [],
        ratchetToolNames: [],
      },
      project: { trusted: false, cwd: "/repo" },
      warnings: [],
      customizations: [],
    },
    projectScope: {} as SettingsReadModel["projectScope"],
    briefing: {
      mode: "reason+accent",
      showModelLabel: true,
      accent: true,
      configurable: true,
      fallbackSurface: "unknown",
      note: "note",
    },
    packs: [],
    reviewerModels: [],
    gatedTools: {
      names: [],
      activeToolNames: [],
      allToolNames: [],
      addableToolNames: [],
    },
    panels: [],
  };
}

describe("native settings callback containment", () => {
  it("contains render and input refresh failures while preserving close recovery", async () => {
    type Surface = {
      readonly render: (width: number) => string[];
      readonly handleInput: (data: string) => void;
    };
    const custom = async (
      factory: (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (result: unknown) => void,
      ) => Surface,
    ) => {
      let completed: unknown;
      const surface = factory(
        { requestRender: () => { throw new Error("refresh failed"); } },
        { fg: () => { throw new Error("render failed"); } },
        {},
        (result: unknown) => {
          completed = result;
        },
      );

      expect(() => surface.render(80)).not.toThrow();
      expect(surface.render(80).join("\n")).toContain("encountered an error");
      expect(() => surface.handleInput("j")).not.toThrow();
      expect(() => surface.handleInput("q")).not.toThrow();
      return completed;
    };
    const ctx = {
      hasUI: true,
      ui: { custom },
    } as unknown as ExtensionCommandContext;

    const result = await openSettingsNativeUi({
      ctx,
      deps: {} as never,
      initialModel: model(),
      reload: async () => ({ ok: true, model: model() }),
    });

    expect(result).toMatchObject({ ok: true, details: { reason: "native-ui" } });
  });
});
