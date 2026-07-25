/**
 * Model List Extension
 *
 * Exposes Pi's currently configured model registry to the agent so it can pick
 * valid model identifiers for subagent calls instead of guessing.
 */

import { Type, type Static } from "@earendil-works/pi-ai";
import { defineTool, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type RegistryModel = ReturnType<ExtensionContext["modelRegistry"]["getAll"]>[number];

const listSubagentModelsSchema = Type.Object({
  provider: Type.Optional(Type.String({
    description: "Optional case-insensitive provider filter, e.g. 'zai' or 'openai-codex'.",
  })),
  model: Type.Optional(Type.String({
    description: "Optional case-insensitive model id/name filter, e.g. 'gpt-5.5', 'g55', or 'glm5'.",
  })),
  fuzzy: Type.Optional(Type.Boolean({
    description: "When true, filters also match fuzzy subsequences after punctuation is ignored. Defaults to true.",
  })),
  available: Type.Optional(Type.Boolean({
    description:
      "When true (default), list only models available for subagents: auth configured and within the configured model scope when one exists. When false, include every configured model.",
  })),
});

type ListSubagentModelsInput = Static<typeof listSubagentModelsSchema>;

type ListedModel = {
  id: string;
  name: string;
  provider: string;
  subagentModel: string;
  available: boolean;
  reasoning: boolean;
  images: boolean;
  contextWindow: number;
  maxTokens: number;
};

type ScopedModelRef = {
  model: RegistryModel;
};

type ModelSelection = {
  models: RegistryModel[];
  label: string;
  hasConfiguredScope: boolean;
};

function normalizeFilter(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || undefined;
}

function normalizeForFuzzy(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function fuzzySubsequenceMatch(value: string, filter: string): boolean {
  const haystack = normalizeForFuzzy(value);
  const needle = normalizeForFuzzy(filter);
  if (!needle) return true;

  let haystackIndex = 0;
  for (const char of needle) {
    haystackIndex = haystack.indexOf(char, haystackIndex);
    if (haystackIndex === -1) return false;
    haystackIndex += 1;
  }
  return true;
}

function matchesFilter(value: string, filter: string | undefined, fuzzy: boolean): boolean {
  if (filter === undefined) return true;
  return value.toLowerCase().includes(filter) || (fuzzy && fuzzySubsequenceMatch(value, filter));
}

function modelKey(model: Pick<RegistryModel, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function stripThinkingSuffix(pattern: string): string {
  const colonIndex = pattern.lastIndexOf(":");
  if (colonIndex === -1) return pattern;

  const suffix = pattern.slice(colonIndex + 1).toLowerCase();
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(suffix)
    ? pattern.slice(0, colonIndex)
    : pattern;
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") {
      source += ".*";
    } else if (char === "?") {
      source += ".";
    } else {
      source += char.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "i");
}

function patternMatchesModel(pattern: string, model: RegistryModel): boolean {
  const normalizedPattern = stripThinkingSuffix(pattern.trim());
  if (!normalizedPattern) return false;

  const fullId = modelKey(model);
  if (/[*?]/.test(normalizedPattern)) {
    const regex = globToRegExp(normalizedPattern);
    return regex.test(fullId) || regex.test(model.id);
  }

  const lowered = normalizedPattern.toLowerCase();
  return fullId.toLowerCase() === lowered || model.id.toLowerCase() === lowered;
}

function getContextScopedModels(ctx: ExtensionContext): RegistryModel[] | undefined {
  const contextWithOptionalScope = ctx as ExtensionContext & {
    scopedModels?: ReadonlyArray<ScopedModelRef>;
    session?: { scopedModels?: ReadonlyArray<ScopedModelRef> };
  };
  const scoped = contextWithOptionalScope.scopedModels ?? contextWithOptionalScope.session?.scopedModels;
  return scoped?.map((entry) => entry.model);
}

function getConfiguredScopedModels(ctx: ExtensionContext): RegistryModel[] {
  const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
  const patterns = settings.getEnabledModels();
  if (!patterns || patterns.length === 0) return [];

  const allModels = ctx.modelRegistry.getAll();
  const scoped: RegistryModel[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    for (const model of allModels) {
      if (!patternMatchesModel(pattern, model)) continue;
      const key = modelKey(model);
      if (seen.has(key)) continue;
      seen.add(key);
      scoped.push(model);
    }
  }

  return scoped;
}

function getScopedModels(ctx: ExtensionContext): RegistryModel[] {
  return getContextScopedModels(ctx) ?? getConfiguredScopedModels(ctx);
}

function wantsAvailableModels(params: ListSubagentModelsInput): boolean {
  return params.available !== false;
}

function selectSourceModels(ctx: ExtensionContext, params: ListSubagentModelsInput): ModelSelection {
  const scopedModels = getScopedModels(ctx);
  const hasConfiguredScope = scopedModels.length > 0;

  if (!wantsAvailableModels(params)) {
    return { models: ctx.modelRegistry.getAll(), label: "configured", hasConfiguredScope };
  }

  if (hasConfiguredScope) {
    return {
      models: scopedModels.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model)),
      label: "available",
      hasConfiguredScope,
    };
  }

  return { models: ctx.modelRegistry.getAvailable(), label: "available", hasConfiguredScope };
}

function modelMatches(
  model: RegistryModel,
  providerFilter: string | undefined,
  modelFilter: string | undefined,
  fuzzy: boolean,
): boolean {
  return matchesFilter(model.provider, providerFilter, fuzzy)
    && (matchesFilter(model.id, modelFilter, fuzzy) || matchesFilter(model.name, modelFilter, fuzzy));
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "?";
  if (value >= 1_000_000) return `${Number(value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`;
  if (value >= 1_000) return `${Number(value / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}K`;
  return `${Math.round(value)}`;
}

function markdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function toListedModel(ctx: ExtensionContext, model: RegistryModel, scopedKeys: Set<string>, hasConfiguredScope: boolean): ListedModel {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    subagentModel: modelKey(model),
    available: ctx.modelRegistry.hasConfiguredAuth(model) && (!hasConfiguredScope || scopedKeys.has(modelKey(model))),
    reasoning: model.reasoning,
    images: model.input.includes("image"),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function formatModels(models: ListedModel[], params: ListSubagentModelsInput, selection: ModelSelection): string {
  const filters = [
    params.available === false ? "available=false" : undefined,
    params.provider?.trim() ? `provider=${JSON.stringify(params.provider.trim())}` : undefined,
    params.model?.trim() ? `model=${JSON.stringify(params.model.trim())}` : undefined,
    params.fuzzy === false ? "fuzzy=false" : undefined,
  ].filter(Boolean);

  if (models.length === 0) {
    return `No ${selection.label} Pi models matched${filters.length ? ` (${filters.join(", ")})` : ""}.`;
  }

  const lines = [
    `${models.length} ${selection.label} Pi model${models.length === 1 ? "" : "s"} matched${filters.length ? ` (${filters.join(", ")})` : ""}.`,
    "",
    "Use the `subagentModel` value as the `model` field when spawning a Pi subagent.",
    "",
    "| subagentModel | name | ctx | max out | thinking | images | available |",
    "|---|---|---:|---:|:---:|:---:|:---:|",
  ];

  for (const model of models) {
    lines.push([
      `| \`${model.subagentModel}\``,
      markdownTableCell(model.name === model.id ? model.id : model.name),
      compactNumber(model.contextWindow),
      compactNumber(model.maxTokens),
      model.reasoning ? "yes" : "no",
      model.images ? "yes" : "no",
      model.available ? "yes" : "no",
    ].join(" | ") + " |");
  }

  return lines.join("\n");
}

const listSubagentModelsTool = defineTool({
  name: "list_subagent_models",
  label: "List Subagent Models",
  description:
    "List Pi models for subagents. By default, returns available models: auth configured and within the configured model scope when one exists.",
  promptSnippet:
    "List Pi subagent model IDs. Defaults to available models; pass available=false to include every configured model.",
  promptGuidelines: [
    "Use list_subagent_models when you need to know what models are available to use subagents with; do not guess subagent model identifiers.",
    "By default, the tool returns available models: auth configured and within the configured model scope when one exists. Pass available=false only when you need every configured model.",
    "Use the `subagentModel` values returned by list_subagent_models as the `model` argument for the subagent tool.",
  ],
  parameters: listSubagentModelsSchema,

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const providerFilter = normalizeFilter(params.provider);
    const modelFilter = normalizeFilter(params.model);
    const fuzzy = params.fuzzy !== false;
    const selection = selectSourceModels(ctx, params);
    const scopedKeys = new Set(getScopedModels(ctx).map(modelKey));

    const models = selection.models
      .filter((model) => modelMatches(model, providerFilter, modelFilter, fuzzy))
      .map((model) => toListedModel(ctx, model, scopedKeys, selection.hasConfiguredScope))
      .sort((left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id));

    return {
      content: [{ type: "text", text: formatModels(models, params, selection) }],
      details: {
        filters: {
          provider: params.provider?.trim() || null,
          model: params.model?.trim() || null,
          fuzzy,
          available: wantsAvailableModels(params),
        },
        hasConfiguredScope: selection.hasConfiguredScope,
        count: models.length,
        models,
      },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(listSubagentModelsTool);
}
