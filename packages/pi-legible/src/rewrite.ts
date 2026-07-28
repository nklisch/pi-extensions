import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";

/**
 * Rewriter model invocation. Kept free of pi-coding-agent imports behind a
 * narrow registry port so tests can wire pure stubs (same seam style as
 * pi-clearance's model adapter).
 */

export interface RewriterModelRegistry {
  find(provider: string, modelId: string): Model<Api> | undefined;
  getAll(): readonly Model<Api>[];
  hasConfiguredAuth(model: Model<Api>): boolean;
  getApiKeyAndHeaders(model: Model<Api>): Promise<
    | { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
    | { ok: false; error: string }
  >;
}

export type RewriteInvoker = (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
) => Promise<{ content: { type: string; text?: string }[]; stopReason: string; errorMessage?: string }>;

/** Split "provider/modelId"; bare ids resolve against the registry by auth. */
export function parseModelSpec(spec: string): { provider?: string; modelId: string } | undefined {
  const trimmed = spec.trim();
  if (trimmed.length === 0) return undefined;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex === -1) return { modelId: trimmed };
  const provider = trimmed.slice(0, slashIndex).trim();
  const modelId = trimmed.slice(slashIndex + 1).trim();
  if (modelId.length === 0) return undefined;
  return provider.length === 0 ? { modelId } : { provider, modelId };
}

export type ResolveOutcome =
  | { kind: "resolved"; model: Model<Api> }
  | { kind: "fallback"; model: Model<Api> }
  | { kind: "unavailable"; error: string };

/**
 * Resolve the rewriter model. A configured spec that cannot be resolved
 * (unknown model, or no configured auth) is UNAVAILABLE — silently falling
 * back to the session model would route every rewrite through a model the
 * user did not choose, potentially at much higher cost. The session-model
 * fallback applies only when no spec is configured.
 */
export function resolveRewriterModel(
  registry: RewriterModelRegistry,
  spec: string | undefined,
  fallback: Model<Api> | undefined,
): ResolveOutcome {
  if (spec !== undefined) {
    const parsed = parseModelSpec(spec);
    if (parsed === undefined) {
      return { kind: "unavailable", error: `invalid rewriter model spec "${spec}" (use provider/modelId)` };
    }
    const candidates = parsed.provider !== undefined
      ? [registry.find(parsed.provider, parsed.modelId)].filter((m) => m !== undefined)
      : registry.getAll().filter((m) => m.id === parsed.modelId);
    const withAuth = candidates.find((m) => registry.hasConfiguredAuth(m));
    if (withAuth !== undefined) return { kind: "resolved", model: withAuth };
    return {
      kind: "unavailable",
      error: `configured rewriter model "${spec}" is unavailable or lacks configured auth`,
    };
  }
  return fallback !== undefined
    ? { kind: "fallback", model: fallback }
    : { kind: "unavailable", error: "no rewriter model available (no configured model and no session model)" };
}

export interface RewriteRequest {
  rules: string;
  /** Pre-formatted recent-conversation transcript; empty string when depth is 0. */
  contextTranscript: string;
  /** The assistant text to rewrite. */
  text: string;
}

const MAX_OUTPUT_TOKENS = 4096;

function buildContext(request: RewriteRequest): Context {
  const systemPrompt = [
    "You rewrite messages from an AI coding assistant so a human reader can understand them quickly.",
    "Rewrite the assistant message at the end of the user's prompt according to the rules below.",
    "Preserve the meaning exactly. Output ONLY the rewritten message text: no preamble, no explanation, no wrapping quotes.",
    "Before returning, lint your own rewrite: split any sentence over 25 words, expand contractions, and make passive voice active when the actor is known.",
    "",
    "## Rewrite rules",
    request.rules,
  ].join("\n");

  const parts: string[] = [];
  if (request.contextTranscript.length > 0) {
    parts.push(
      "## Recent conversation (context only — do NOT rewrite this part)",
      request.contextTranscript,
      "",
    );
  }
  parts.push("## Assistant message to rewrite", request.text);

  return {
    systemPrompt,
    messages: [{ role: "user", content: parts.join("\n"), timestamp: Date.now() }],
  };
}

export type RewriteResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

/** Hard cap per block rewrite so a hung rewriter cannot stall the agent loop. */
export const REWRITE_TIMEOUT_MS = 30_000;

export async function rewriteText(
  request: RewriteRequest,
  deps: {
    registry: RewriterModelRegistry;
    spec: string | undefined;
    fallback: Model<Api> | undefined;
    signal?: AbortSignal;
    timeoutMs?: number;
    invoker?: RewriteInvoker;
  },
): Promise<RewriteResult> {
  const resolved = resolveRewriterModel(deps.registry, deps.spec, deps.fallback);
  if (resolved.kind === "unavailable") {
    return { ok: false, error: resolved.error };
  }
  const model = resolved.model;

  // message_end handlers are awaited by the agent loop, so a hang anywhere
  // in this function would stall tool execution. One combined signal —
  // session abort + hard timeout — bounds BOTH auth resolution and the
  // model call below.
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? REWRITE_TIMEOUT_MS);
  const signal = deps.signal !== undefined ? AbortSignal.any([deps.signal, timeout]) : timeout;

  let auth;
  try {
    auth = await raceWithSignal(deps.registry.getApiKeyAndHeaders(model), signal);
  } catch (error) {
    return { ok: false, error: `auth resolution failed: ${errorMessage(error)}` };
  }
  if (!auth.ok) {
    return { ok: false, error: `auth not configured for ${model.provider}/${model.id}: ${auth.error}` };
  }

  const options: SimpleStreamOptions = {
    maxTokens: MAX_OUTPUT_TOKENS,
    signal,
    ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
    ...(auth.headers === undefined ? {} : { headers: auth.headers }),
    ...(auth.env === undefined ? {} : { env: auth.env }),
  };

  let response;
  try {
    response = await (deps.invoker ?? completeSimple)(model, buildContext(request), options);
  } catch (error) {
    return { ok: false, error: `rewrite call failed: ${errorMessage(error)}` };
  }

  if (response.stopReason === "error" || response.stopReason === "aborted" || response.errorMessage !== undefined) {
    return { ok: false, error: `rewrite model error: ${response.errorMessage ?? response.stopReason}` };
  }

  const text = response.content
    .filter((block) => block.type === "text" && "text" in block && typeof block.text === "string")
    .map((block) => (block as { text: string }).text)
    .join("\n")
    .trim();

  if (text.length === 0) {
    return { ok: false, error: "rewrite model returned no text" };
  }
  return { ok: true, text };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reject if the signal aborts before the promise settles; the abandoned promise is harmless. */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("timed out or aborted")), { once: true });
    }),
  ]);
}
