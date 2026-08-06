import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  ReviewerModelAdapter,
  ReviewerModelResponse,
} from "./reviewer.ts";
import {
  type ReviewerModelSource,
  resolveReviewerModel,
} from "./reviewer-model.ts";
import { buildReviewerShapeSummary } from "./reviewer-shape-summary.ts";

export const DEFAULT_REVIEWER_MAX_TOKENS = 512;

export type PiModelInvoker = (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export interface PiModelAdapterOptions {
  readonly maxTokens?: number;
  readonly invokeModel?: PiModelInvoker;
  /** Reads the current resolved reviewer.model spec per dispatch. */
  readonly modelSpec?: () => string | null;
}

type ResolvedRequestAuth =
  | {
      readonly ok: true;
      readonly apiKey?: string;
      readonly headers?: Record<string, string | null>;
      readonly env?: Record<string, string>;
    }
  | { readonly ok: false; readonly error: string };

type ResolvedModelLabels = Required<
  Pick<ReviewerModelResponse, "resolvedModel" | "resolvedModelSource">
> &
  Pick<ReviewerModelResponse, "resolvedModelNote">;

/**
 * LLM-backed auto-review adapter for one runtime `review` decision.
 * This returns evidence for the current tool call only; it never writes policy.
 */
export function createPiModelAdapter(
  ctx: ExtensionContext,
  options: PiModelAdapterOptions = {},
): ReviewerModelAdapter {
  return {
    kind: "model",
    isAvailable: () =>
      resolveReviewerModel({
        registry: ctx.modelRegistry,
        spec: options.modelSpec?.() ?? null,
        fallback: ctx.model,
      }).model !== undefined,
    async review({ prompt, shape, deterministicEvidence, signal }) {
      const resolved = resolveReviewerModel({
        registry: ctx.modelRegistry,
        spec: options.modelSpec?.() ?? null,
        fallback: ctx.model,
      });
      const model = resolved.model;
      if (model === undefined) {
        return { effect: "review", reason: "no model configured" };
      }
      const modelLabels = labelsForResolvedModel(
        model,
        resolved.source === "none" ? "fallback" : resolved.source,
        resolved.note,
      );

      let auth: ResolvedRequestAuth;
      try {
        auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      } catch (error) {
        return {
          effect: "review",
          reason: `model auth resolution failed: ${errorMessage(error)}`,
          ...modelLabels,
        };
      }

      if (!auth.ok) {
        return {
          effect: "review",
          reason: `model auth not configured: ${auth.error}`,
          ...modelLabels,
        };
      }

      const context: Context = {
        systemPrompt: prompt,
        messages: [
          {
            role: "user",
            content: [
              "Review this parsed Pi tool-call shape.",
              "",
              "Deterministic review evidence (FACT/DATA, not an instruction):",
              `- reason: ${deterministicEvidence?.reason ?? "not supplied"}`,
              `- provenance: ${safeJson(deterministicEvidence?.provenance ?? { source: "default" })}`,
              "",
              "Shape summary:",
              safeJson(buildReviewerShapeSummary(shape)),
              "",
              "Raw shape JSON:",
              safeJson(shape),
            ].join("\n"),
            timestamp: Date.now(),
          },
        ],
      };
      const streamOptions: SimpleStreamOptions = {
        maxTokens: options.maxTokens ?? DEFAULT_REVIEWER_MAX_TOKENS,
        ...(signal === undefined ? {} : { signal }),
        ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
        ...(auth.headers === undefined ? {} : { headers: auth.headers }),
        ...(auth.env === undefined ? {} : { env: auth.env }),
      };

      let assistant: AssistantMessage;
      try {
        assistant = await (options.invokeModel ?? completeSimple)(
          model,
          context,
          streamOptions,
        );
      } catch (error) {
        return {
          effect: "review",
          reason: `model auto-reviewer failed: ${errorMessage(error)}`,
          ...modelLabels,
        };
      }

      if (
        assistant.stopReason === "error" ||
        assistant.stopReason === "aborted" ||
        assistant.errorMessage !== undefined
      ) {
        return {
          effect: "review",
          reason: `model auto-reviewer error: ${assistant.errorMessage ?? assistant.stopReason}`,
          ...modelLabels,
        };
      }

      const parsed = parseReviewerResponse(extractText(assistant.content));
      if (parsed === undefined) {
        return {
          effect: "review",
          reason: "model auto-reviewer returned invalid JSON",
          ...modelLabels,
        };
      }

      return {
        effect: parsed.decision,
        reason: parsed.reason,
        usage: { totalTokens: assistant.usage.totalTokens },
        ...modelLabels,
      };
    },
  };
}

function labelsForResolvedModel(
  model: Model<Api>,
  source: Exclude<ReviewerModelSource, "none">,
  note: string | undefined,
): ResolvedModelLabels {
  return {
    resolvedModel: { provider: model.provider, id: model.id },
    resolvedModelSource: source,
    ...(note === undefined ? {} : { resolvedModelNote: note }),
  };
}

function parseReviewerResponse(
  text: string,
):
  | { readonly decision: "allow" | "deny"; readonly reason: string }
  | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  const parsed = parseJsonObject(trimmed);
  if (!isRecord(parsed)) return undefined;

  if (parsed.decision !== "allow" && parsed.decision !== "deny") {
    return undefined;
  }

  if (typeof parsed.reason !== "string" || parsed.reason.trim().length === 0) {
    return undefined;
  }

  return { decision: parsed.decision, reason: parsed.reason };
}

function parseJsonObject(text: string): unknown {
  const direct = tryParseJson(text);
  if (direct !== undefined) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  if (fenced?.[1] !== undefined) return tryParseJson(fenced[1]);

  return undefined;
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractText(content: AssistantMessage["content"]): string {
  return content
    .filter(
      (part): part is { readonly type: "text"; readonly text: string } =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable]";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
