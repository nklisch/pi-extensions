import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { PocketConfig } from "./config.js";

export const ASTRA_PROVIDER = "openai-codex";
export const ASTRA_MODEL_ID = "gpt-6-astra";
export const POCKET_TOOLS = ["pocket_note", "pocket_recall"] as const;

/** Mutable activation flag shared by tools, the /pocket command, and the
 * before_agent_start injector. Module-level because the extension factory has
 * no ctx — the first reliable model read is in session_start. */
export interface ActivationState {
  active: boolean;
}

export function isAstraModel(model: { id?: string; provider?: string } | undefined | null): boolean {
  return model?.provider === ASTRA_PROVIDER && model?.id === ASTRA_MODEL_ID;
}

export function isActive(state: ActivationState, ctx: ExtensionContext, config: PocketConfig): boolean {
  return config.enabled && isAstraModel(ctx.model);
}

/** Recompute activation from the current model + config and sync pi's active
 * tool set. Call from session_start and model_select handlers — never from
 * the factory body (pi forbids active-set mutation during load). */
export function recomputeActivation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: ActivationState,
  config: PocketConfig,
): boolean {
  const active = isActive(state, ctx, config);
  const current = pi.getActiveTools();
  const hasPocket = POCKET_TOOLS.every((t) => current.includes(t));
  if (active && !hasPocket) {
    pi.setActiveTools([...new Set([...current, ...POCKET_TOOLS])]);
  } else if (!active && hasPocket) {
    pi.setActiveTools(current.filter((t) => !(POCKET_TOOLS as readonly string[]).includes(t)));
  }
  const becameActive = active && !state.active;
  state.active = active;
  return becameActive;
}
