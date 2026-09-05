import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelThinkingLevel,
  Provider,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface DistillerModelStatus {
  requestedModel: string;
  resolvedModel?: string;
  requestedReasoning: ModelThinkingLevel;
  effectiveReasoning?: string;
  error?: string;
}

export interface DistillerModelClient {
  status(): DistillerModelStatus;
  call(prompt: string, signal: AbortSignal, maxTokens: number): Promise<string>;
}

export type ModelInvoker = (
  provider: Provider,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
) => Promise<AssistantMessage>;

function parseModelSpec(spec: string): { provider: string; modelId: string } | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}

function resolveReasoning(model: Model<Api>, requested: ModelThinkingLevel): {
  request?: SimpleStreamOptions["reasoning"];
  effective: string;
} {
  const clamped = clampThinkingLevel(model, requested);
  const mapped = model.thinkingLevelMap?.[clamped];
  return {
    ...(clamped === "off" ? {} : { request: clamped }),
    effective: mapped ?? clamped,
  };
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("distiller request aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("distiller request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function extractSuccessfulText(message: AssistantMessage): string {
  if (message.stopReason !== "stop" || message.errorMessage !== undefined) {
    throw new Error(`distiller model ended with ${message.errorMessage ?? message.stopReason}`);
  }
  const text = message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (text.length === 0) throw new Error("distiller model returned no text");
  return text;
}

const defaultInvoker: ModelInvoker = async (provider, model, context, options) =>
  provider.streamSimple(model, context, options).result();

/**
 * Resolve one exact model and use Pi's registry for fresh authentication on
 * every request. Direct provider calls need these request options; invoking a
 * provider without them breaks OAuth-backed providers such as openai-codex.
 */
export function createDistillerModelClient(
  registry: Pick<ModelRegistry, "find" | "getProvider" | "getApiKeyAndHeaders">,
  requestedModel: string,
  requestedReasoning: ModelThinkingLevel,
  invoker: ModelInvoker = defaultInvoker,
): DistillerModelClient {
  const parsed = parseModelSpec(requestedModel);
  const model = parsed ? registry.find(parsed.provider, parsed.modelId) : undefined;
  const provider = parsed ? registry.getProvider(parsed.provider) : undefined;
  const reasoning = model ? resolveReasoning(model, requestedReasoning) : undefined;
  const unavailable = !parsed
    ? `invalid model "${requestedModel}"; use provider/modelId`
    : !model
      ? `model ${requestedModel} is not in the Pi model registry`
      : !provider
        ? `provider ${parsed.provider} is not available`
        : undefined;

  return {
    status: () => ({
      requestedModel,
      ...(model ? { resolvedModel: `${model.provider}/${model.id}` } : {}),
      requestedReasoning,
      ...(reasoning ? { effectiveReasoning: reasoning.effective } : {}),
      ...(unavailable ? { error: unavailable } : {}),
    }),
    async call(prompt, signal, maxTokens) {
      if (!model || !provider || !reasoning) throw new Error(unavailable ?? "distiller model unavailable");
      if (signal.aborted) throw new Error("distiller request aborted");
      const auth = await raceWithSignal(registry.getApiKeyAndHeaders(model), signal);
      if (signal.aborted) throw new Error("distiller request aborted");
      if (!auth.ok) throw new Error(`authentication failed for ${requestedModel}: ${auth.error}`);
      const options: SimpleStreamOptions = {
        signal,
        maxTokens,
        ...(reasoning.request ? { reasoning: reasoning.request } : {}),
        ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
        ...(auth.headers ? { headers: auth.headers } : {}),
        ...(auth.env ? { env: auth.env } : {}),
      };
      const message = await invoker(provider, model, {
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      }, options);
      if (signal.aborted) throw new Error("distiller request aborted");
      return extractSuccessfulText(message);
    },
  };
}
