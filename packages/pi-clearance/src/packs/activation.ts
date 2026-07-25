import type { PolicyPack } from "../policy/core.ts";
import {
  PI_EXTENSION_INSPECT_TOOLS,
  PI_EXTENSION_NETWORK_RESEARCH_TOOLS,
  PI_EXTENSION_REVIEW_BOUNDARY_TOOLS,
  PI_EXTENSION_WORKFLOW_TOOLS,
} from "./pi.extension.inspect.ts";

export interface ShippedPackActivationCondition {
  readonly kind: "any-tool-registered";
  readonly toolNames: readonly string[];
}

const SHIPPED_PACK_ACTIVATION_CONDITIONS: Readonly<
  Record<string, ShippedPackActivationCondition>
> = {
  "pi.extension.inspect": {
    kind: "any-tool-registered",
    toolNames: PI_EXTENSION_INSPECT_TOOLS,
  },
  "pi.extension.workflow": {
    kind: "any-tool-registered",
    toolNames: PI_EXTENSION_WORKFLOW_TOOLS,
  },
  "pi.extension.network-research": {
    kind: "any-tool-registered",
    toolNames: PI_EXTENSION_NETWORK_RESEARCH_TOOLS,
  },
  "pi.extension.review-boundaries": {
    kind: "any-tool-registered",
    toolNames: PI_EXTENSION_REVIEW_BOUNDARY_TOOLS,
  },
};

export function shippedPackActivationCondition(
  packId: string,
): ShippedPackActivationCondition | undefined {
  return SHIPPED_PACK_ACTIVATION_CONDITIONS[packId];
}

export function isShippedPackActivationSatisfied(
  packId: string,
  registeredToolNames: readonly string[] | undefined,
): boolean {
  const condition = shippedPackActivationCondition(packId);
  if (condition === undefined) {
    return true;
  }

  if (registeredToolNames === undefined || registeredToolNames.length === 0) {
    return false;
  }

  const registered = new Set(registeredToolNames);
  return condition.toolNames.some((toolName) => registered.has(toolName));
}

export function filterActiveShippedPacksByActivation(
  packs: readonly PolicyPack[],
  registeredToolNames: readonly string[] | undefined,
): readonly PolicyPack[] {
  return packs.filter((pack) =>
    isShippedPackActivationSatisfied(pack.id, registeredToolNames),
  );
}
