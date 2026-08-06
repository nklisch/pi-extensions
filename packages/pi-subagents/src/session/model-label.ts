import type { Model } from "@earendil-works/pi-ai";

/**
 * Return the exact display identity for a resolved model.
 *
 * Pi identifies models by provider and id. The human-readable `name` is not
 * unique across providers, so operator status surfaces use `provider/id`.
 */
export function formatModelLabel(model: unknown): string {
  if (isModelIdentity(model)) return `${model.provider}/${model.id}`;
  return "unknown model";
}

function isModelIdentity(value: unknown): value is Pick<Model<any>, "provider" | "id"> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { provider?: unknown; id?: unknown };
  return typeof candidate.provider === "string" && candidate.provider.length > 0
    && typeof candidate.id === "string" && candidate.id.length > 0;
}
