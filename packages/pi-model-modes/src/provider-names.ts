import type { KnownProvider } from "@earendil-works/pi-ai";

/**
 * Plugin-owned source of truth for provider id -> display name.
 * Typed `Readonly<Record<KnownProvider, string>>` so completeness is a
 * compile-time invariant: adding a provider to pi's `KnownProvider` union
 * without adding an entry here is a type error, not a silent fallback.
 */
export const PROVIDER_DISPLAY_NAMES: Readonly<Record<KnownProvider, string>> = {
  "amazon-bedrock":          "Amazon Bedrock",
  "ant-ling":                "Ant Group",
  "anthropic":               "Anthropic",
  "google":                  "Google",
  "google-vertex":           "Google Vertex AI",
  "openai":                  "OpenAI",
  "azure-openai-responses":  "Azure OpenAI",
  "openai-codex":            "OpenAI",
  "nvidia":                  "NVIDIA",
  "deepseek":                "DeepSeek",
  "github-copilot":          "GitHub Copilot",
  "xai":                     "xAI",
  "groq":                    "Groq",
  "cerebras":                "Cerebras",
  "openrouter":              "OpenRouter",
  "vercel-ai-gateway":       "Vercel",
  "zai":                     "Zhipu AI",
  "zai-coding-cn":           "Zhipu AI",
  "mistral":                 "Mistral AI",
  "minimax":                 "MiniMax",
  "minimax-cn":              "MiniMax",
  "moonshotai":              "Moonshot AI",
  "moonshotai-cn":           "Moonshot AI",
  "huggingface":             "Hugging Face",
  "fireworks":               "Fireworks AI",
  "together":                "Together AI",
  "opencode":                "OpenCode",
  "opencode-go":             "OpenCode",
  "kimi-coding":             "Moonshot AI",
  "cloudflare-workers-ai":   "Cloudflare",
  "cloudflare-ai-gateway":   "Cloudflare",
  "xiaomi":                  "Xiaomi",
  "xiaomi-token-plan-cn":    "Xiaomi",
  "xiaomi-token-plan-ams":   "Xiaomi",
  "xiaomi-token-plan-sgp":   "Xiaomi",
  "qwen-token-plan":         "Alibaba",
  "qwen-token-plan-cn":      "Alibaba",
  "radius":                  "Radius",
};

/**
 * Title-case an unknown/custom provider id so it renders sensibly in the
 * identity line. Splits on whitespace, dash, underscore, and dot; drops
 * empty segments (collapsing repeated separators).
 *
 * Per-segment casing rule (revised per codex consult — the original
 * `toUpperCase()+toLowerCase()` mangled already-mixed-case ids like
 * `"OpenAI"` -> `"Openai"` and all-caps `"NVIDIA"` -> `"Nvidia"`):
 *   - segment is all-lowercase ASCII letters only (e.g. "openai",
 *     "my-custom" -> ["my","custom"]) -> title-cased (first char upper,
 *     tail lower);
 *   - segment is anything else — contains an uppercase letter OR a digit
 *     (e.g. "OpenAI", "NVIDIA", "gpt5", "Mini") -> preserved AS-IS (assume
 *     the id author chose the casing deliberately).
 * `""` -> `""`.
 *
 * Note: the codex-consult originally phrased the preservation test as
 * "contains an uppercase letter", which silently title-cased all-lowercase
 * alphanumeric segments like `"gpt5"` -> `"Gpt5"` (caught by the
 * `providerDisplayName("gpt5-Mini") === "gpt5 Mini"` test). The corrected
 * rule preserves any segment that is not pure `[a-z]`, which also matches
 * the codex list's own `"gpt5"` -> preserved example.
 */
function titleCaseId(id: string): string {
  return id
    .split(/[\s\-_.]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) =>
      /[^a-z]/.test(segment)
        ? segment // preserve mixed-case / all-caps / alphanumeric segments
        : segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase(),
    )
    .join(" ");
}

/**
 * Resolve a provider id (pi's `Provider`, a bare string) to a display name.
 * Known ids hit the map; unknown/custom ids fall back to title-case so the
 * identity line is always well-formed.
 */
export function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider as KnownProvider] ?? titleCaseId(provider);
}
