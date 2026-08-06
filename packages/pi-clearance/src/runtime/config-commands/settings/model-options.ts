import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { ReviewerModelRegistry } from "../../reviewer-model.ts";

export interface ReviewerModelOption {
  /** Canonical provider/modelId spec written to config. */
  readonly spec: string;
  /** Human-facing label shown by Pi's selector. */
  readonly label: string;
}

export const ACTIVE_SESSION_MODEL_LABEL = "Use active session model" as const;
export const REVIEWER_MODEL_OPTION_LIMIT = 12;

/**
 * Return the same capped, auth-filtered model catalog for both read models and
 * selector dispatch. Keeping the spec beside its label avoids rebuilding a
 * potentially different provider/model mapping at the point of selection.
 */
export function availableReviewerModels(
  ctx: ExtensionCommandContext,
): readonly ReviewerModelOption[] {
  const registry = (ctx as { readonly modelRegistry?: unknown })
    .modelRegistry as ReviewerModelRegistry | undefined;
  if (
    registry === undefined ||
    typeof registry.getAll !== "function" ||
    typeof registry.hasConfiguredAuth !== "function"
  ) {
    return [];
  }

  try {
    return registry
      .getAll()
      .filter((model) => registry.hasConfiguredAuth(model))
      .map((model) => {
        const spec = `${model.provider}/${model.id}`;
        return {
          spec,
          label:
            typeof model.name === "string" && model.name.length > 0
              ? `${model.name} (${spec})`
              : spec,
        };
      })
      .sort((a, b) => a.spec.localeCompare(b.spec))
      .slice(0, REVIEWER_MODEL_OPTION_LIMIT);
  } catch {
    return [];
  }
}
