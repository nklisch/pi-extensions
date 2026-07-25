import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { deriveIdentityLine } from "./identity.js";
import {
  computeCacheKey,
  getCachedResult,
  setCachedResult,
} from "./cache.js";
import type { CacheKeyInputs } from "./cache.js";
import { resolveActiveModePlan, type ModePlan } from "./resolver.js";
import { assembleSystemPrompt } from "./assemble.js";
import {
  noStylePlan,
  resolveActiveStylePlan,
  type StylePlan,
} from "./style.js";

export type RequiredBeforeAgentStartResult = BeforeAgentStartEventResult & {
  systemPrompt: string;
};

let lastBaseSystemPrompt: string | undefined;
const warnedStyleErrors = new Set<string>();

export function getLastBaseSystemPrompt(): string | undefined {
  return lastBaseSystemPrompt;
}

/** TEST-ONLY: clear all handler-owned memo and warning state. */
export function resetHandlerForTesting(): void {
  lastBaseSystemPrompt = undefined;
  warnedStyleErrors.clear();
}

function resolveStyleGracefully(warn: boolean): StylePlan {
  try {
    return resolveActiveStylePlan();
  } catch (cause) {
    const message = (cause as Error).message;
    if (warn && !warnedStyleErrors.has(message)) {
      warnedStyleErrors.add(message);
      console.warn(
        `pi-model-modes: style unresolvable — degrading to no-style (${message})`,
      );
    }
    return noStylePlan("unset", "unset");
  }
}

/**
 * PURE two-path splice shared by the live handler and inspect assembly.
 * The explicit legacy branch preserves exact bytes only when both optional
 * layers are absent; opting into a style uses the deterministic blank-line join.
 */
function spliceSystemPrompt(
  identity: string,
  stylePlan: StylePlan,
  plan: ModePlan,
  baseSystemPrompt: string,
): string {
  if (stylePlan.content === "" && plan.mode === undefined) {
    return identity ? `${identity}\n${baseSystemPrompt}` : baseSystemPrompt;
  }
  return assembleSystemPrompt(
    identity,
    plan,
    baseSystemPrompt,
    stylePlan.content === "" ? undefined : stylePlan.content,
  );
}

/** Assemble the current mode and style against a known clean pi base. */
export function assembleForInspect(
  model: Model<any> | undefined,
  baseSystemPrompt: string,
): string {
  const plan = resolveActiveModePlan();
  const stylePlan = resolveStyleGracefully(false);
  const identity = model ? deriveIdentityLine(model) : "";
  return spliceSystemPrompt(identity, stylePlan, plan, baseSystemPrompt);
}

/** Cache-aware `before_agent_start` transform. */
export function handleBeforeAgentStart(
  e: BeforeAgentStartEvent,
  ctx: ExtensionContext,
): RequiredBeforeAgentStartResult {
  const model = ctx.model;
  lastBaseSystemPrompt = e.systemPrompt;

  const plan = resolveActiveModePlan();
  const stylePlan = resolveStyleGracefully(true);
  const inputs: CacheKeyInputs = {
    modelName: model?.name ?? "",
    modelId: model?.id ?? "",
    modelProvider: model?.provider ?? "",
    modeSignature: plan.signature,
    styleSignature: stylePlan.signature,
    baseSystemPrompt: e.systemPrompt,
  };
  const key = computeCacheKey(inputs);
  const cached = getCachedResult(key);
  if (cached !== undefined) return { systemPrompt: cached };

  const identity = model ? deriveIdentityLine(model) : "";
  const result = spliceSystemPrompt(identity, stylePlan, plan, e.systemPrompt);
  setCachedResult(key, result, inputs);
  return { systemPrompt: result };
}
