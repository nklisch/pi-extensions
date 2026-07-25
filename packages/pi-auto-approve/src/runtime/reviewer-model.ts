import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * Narrow read-port for reviewer model resolution. Production wires
 * ExtensionContext.modelRegistry; tests wire a pure stub.
 */
export interface ReviewerModelRegistry {
  find(provider: string, modelId: string): Model<Api> | undefined;
  getAll(): readonly Model<Api>[];
  hasConfiguredAuth(model: Model<Api>): boolean;
}

export interface ParsedModelSpec {
  readonly provider?: string;
  readonly modelId: string;
}

export type ReviewerModelSource = "configured" | "fallback" | "none";

export interface ResolvedReviewerModel {
  readonly model: Model<Api> | undefined;
  readonly source: ReviewerModelSource;
  /** Human-readable note for status/audit when resolution did not use a straightforward configured model. */
  readonly note?: string;
}

export const HIGH_COST_REVIEWER_MODEL_PATTERNS = [
  "gpt-5.5",
  "claude-opus-4-8",
  "glm-5.2",
  "kimi-k2.7-code",
] as const satisfies readonly string[];

/**
 * Split a user-facing model spec. The canonical form is provider/modelId;
 * bare ids remain accepted for convenience and are resolved against the
 * registry at runtime.
 */
export function parseModelSpec(spec: string): ParsedModelSpec | undefined {
  const trimmed = spec.trim();
  if (trimmed.length === 0) return undefined;

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex === -1) return { modelId: trimmed };

  const rawProvider = trimmed.slice(0, slashIndex).trim();
  const modelId = trimmed.slice(slashIndex + 1).trim();
  if (modelId.length === 0) return undefined;

  return rawProvider.length === 0
    ? { modelId }
    : { provider: rawProvider, modelId };
}

export function resolveReviewerModel(input: {
  readonly registry: ReviewerModelRegistry;
  readonly spec: string | null;
  readonly fallback: Model<Api> | undefined;
}): ResolvedReviewerModel {
  const parsed = input.spec === null ? undefined : parseModelSpec(input.spec);

  if (parsed !== undefined) {
    const configured = resolveConfiguredModel(input.registry, parsed);
    if (configured !== undefined) return configured;

    return resolveFallback(
      input.registry,
      input.fallback,
      `configured reviewer model ${input.spec} is unavailable or lacks configured auth`,
    );
  }

  return resolveFallback(input.registry, input.fallback);
}

export function formatReviewerModel(model: Model<Api> | undefined): string {
  return model === undefined
    ? "none configured"
    : `${model.provider}/${model.id}`;
}

export function isHighCostReviewerModel(specOrId: string): boolean {
  const modelId = modelIdPortion(specOrId).toLowerCase();
  return HIGH_COST_REVIEWER_MODEL_PATTERNS.some((pattern) =>
    modelId.includes(pattern.toLowerCase()),
  );
}

function resolveConfiguredModel(
  registry: ReviewerModelRegistry,
  parsed: ParsedModelSpec,
): ResolvedReviewerModel | undefined {
  if (parsed.provider !== undefined) {
    const model = registry.find(parsed.provider, parsed.modelId);
    if (model !== undefined && registry.hasConfiguredAuth(model)) {
      return { model, source: "configured" };
    }
    return undefined;
  }

  const matches = registry
    .getAll()
    .filter((model) => model.id.toLowerCase() === parsed.modelId.toLowerCase());
  const model = matches.find((candidate) =>
    registry.hasConfiguredAuth(candidate),
  );
  if (model === undefined) return undefined;

  const providers = [...new Set(matches.map((match) => match.provider))];
  return providers.length > 1
    ? {
        model,
        source: "configured",
        note: `bare reviewer model id matched multiple providers (${providers.join(", ")}); using ${model.provider}/${model.id}`,
      }
    : { model, source: "configured" };
}

function resolveFallback(
  registry: ReviewerModelRegistry,
  fallback: Model<Api> | undefined,
  configuredFailureNote?: string,
): ResolvedReviewerModel {
  if (fallback !== undefined && registry.hasConfiguredAuth(fallback)) {
    return configuredFailureNote === undefined
      ? { model: fallback, source: "fallback" }
      : { model: fallback, source: "fallback", note: configuredFailureNote };
  }

  return {
    model: undefined,
    source: "none",
    note: configuredFailureNote ?? "no model configured",
  };
}

function modelIdPortion(specOrId: string): string {
  const trimmed = specOrId.trim();
  const slashIndex = trimmed.lastIndexOf("/");
  return slashIndex === -1 ? trimmed : trimmed.slice(slashIndex + 1).trim();
}
