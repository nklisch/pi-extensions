import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isAstraModel, POCKET_TOOLS, recomputeActivation, type ActivationState } from "../src/activation.js";
import { DEFAULT_CONFIG, type PocketConfig } from "../src/config.js";

const ASTRA = { provider: "openai-codex", id: "gpt-6-astra" };
const TERRA = { provider: "openai-codex", id: "gpt-5.6-terra" };

function fakePi(initial: string[]) {
  const calls: string[][] = [];
  let active = [...initial];
  const pi = {
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = [...names];
      calls.push([...names]);
    },
  } as unknown as ExtensionAPI;
  return { pi, calls, getActive: () => active };
}

function fakeCtx(model: { provider: string; id: string }): ExtensionContext {
  return { model } as unknown as ExtensionContext;
}

function configWith(enabled: boolean): PocketConfig {
  return { ...structuredClone(DEFAULT_CONFIG), enabled };
}

describe("isAstraModel", () => {
  it("requires both provider and id to match", () => {
    expect(isAstraModel(ASTRA)).toBe(true);
    expect(isAstraModel(TERRA)).toBe(false);
    expect(isAstraModel({ provider: "other", id: "gpt-6-astra" })).toBe(false);
    expect(isAstraModel(undefined)).toBe(false);
  });
});

describe("recomputeActivation", () => {
  it("adds pocket tools for astra sessions and reports becoming active", () => {
    const { pi, getActive } = fakePi(["read", "bash"]);
    const state: ActivationState = { active: false };
    const becameActive = recomputeActivation(pi, fakeCtx(ASTRA), state, configWith(true));
    expect(becameActive).toBe(true);
    expect(state.active).toBe(true);
    expect(getActive()).toEqual(expect.arrayContaining([...POCKET_TOOLS, "read", "bash"]));
  });

  it("removes pocket tools for non-astra sessions", () => {
    const { pi, getActive } = fakePi(["read", "bash", ...POCKET_TOOLS]);
    const state: ActivationState = { active: true };
    const becameActive = recomputeActivation(pi, fakeCtx(TERRA), state, configWith(true));
    expect(becameActive).toBe(false);
    expect(state.active).toBe(false);
    expect(getActive()).toEqual(["read", "bash"]);
  });

  it("stays inactive for astra when the pocket is disabled", () => {
    const { pi, getActive } = fakePi(["read"]);
    const state: ActivationState = { active: false };
    recomputeActivation(pi, fakeCtx(ASTRA), state, configWith(false));
    expect(state.active).toBe(false);
    expect(getActive()).toEqual(["read"]);
  });

  it("is idempotent when nothing changed", () => {
    const { pi, calls } = fakePi(["read", ...POCKET_TOOLS]);
    const state: ActivationState = { active: true };
    const becameActive = recomputeActivation(pi, fakeCtx(ASTRA), state, configWith(true));
    expect(becameActive).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
