import { describe, it, expect } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { deriveIdentityLine } from "../src/identity.js";
import {
  PROVIDER_DISPLAY_NAMES,
  providerDisplayName,
} from "../src/provider-names.js";
import { makeModel } from "./harness.js";

describe("providerDisplayName — known providers", () => {
  it.each([
    ["anthropic", "Anthropic"],
    ["openai", "OpenAI"],
    ["google-vertex", "Google Vertex AI"],
    ["github-copilot", "GitHub Copilot"],
    ["xai", "xAI"],
    ["zai", "Zhipu AI"],
    ["zai-coding-cn", "Zhipu AI"],
    ["kimi-coding", "Moonshot AI"],
    ["cloudflare-workers-ai", "Cloudflare"],
    ["openai-codex", "OpenAI"],
    ["xiaomi-token-plan-sgp", "Xiaomi"],
  ])('providerDisplayName(%j) === %j', (id, expected) => {
    expect(providerDisplayName(id)).toBe(expected);
  });
});

describe("providerDisplayName — completeness over the KnownProvider union", () => {
  // The full 35-id canonical `KnownProvider` union from
  // `@earendil-works/pi-ai` `dist/types.d.ts`. Hardcoded here as a runtime
  // mirror of the compile-time `Record<KnownProvider, string>` exhaustiveness
  // gate. If pi adds a provider, the build fails first (missing key is a type
  // error); this group surfaces an accidental map-key removal at runtime.
  const KNOWN_IDS = [
    "amazon-bedrock",
    "ant-ling",
    "anthropic",
    "google",
    "google-vertex",
    "openai",
    "azure-openai-responses",
    "openai-codex",
    "nvidia",
    "deepseek",
    "github-copilot",
    "xai",
    "groq",
    "cerebras",
    "openrouter",
    "vercel-ai-gateway",
    "zai",
    "zai-coding-cn",
    "mistral",
    "minimax",
    "minimax-cn",
    "moonshotai",
    "moonshotai-cn",
    "huggingface",
    "fireworks",
    "together",
    "opencode",
    "opencode-go",
    "kimi-coding",
    "cloudflare-workers-ai",
    "cloudflare-ai-gateway",
    "xiaomi",
    "xiaomi-token-plan-cn",
    "xiaomi-token-plan-ams",
    "xiaomi-token-plan-sgp",
  ] as const;

  it("every KnownProvider id has a non-empty display name in the map", () => {
    for (const id of KNOWN_IDS) {
      expect(typeof PROVIDER_DISPLAY_NAMES[id]).toBe("string");
      expect(PROVIDER_DISPLAY_NAMES[id].length).toBeGreaterThan(0);
    }
    expect(KNOWN_IDS.length).toBe(35);
  });

  it("providerDisplayName(id) hits the map (returns the map entry verbatim)", () => {
    // Proves the known-id dispatch path: the lookup returns exactly the map
    // entry, never the title-case fallback. (Direct equality is the correct
    // shape — the design's literal "does not equal the title-cased id"
    // phrasing breaks for ids whose map value legitimately equals their
    // title-case form, e.g. anthropic/google/groq/deepseek.)
    for (const id of KNOWN_IDS) {
      expect(providerDisplayName(id)).toBe(PROVIDER_DISPLAY_NAMES[id]);
    }
  });
});

describe("providerDisplayName — title-case fallback", () => {
  it.each([
    // all-lowercase segments -> title-cased
    ["my-custom", "My Custom"],
    ["acme-corp", "Acme Corp"],
    ["foo--bar", "Foo Bar"], // repeated separators collapse
    ["a.b.c", "A B C"],
    ["", ""], // empty -> empty, no throw
    // mixed-case / all-caps segments -> preserved AS-IS (codex-revised rule)
    ["OpenAI", "OpenAI"],
    ["NVIDIA", "NVIDIA"],
    ["gpt5-Mini", "gpt5 Mini"], // mixed segment preserved, lowercase segment title-cased
  ])('providerDisplayName(%j) === %j', (id, expected) => {
    expect(providerDisplayName(id)).toBe(expected);
  });
});

describe("deriveIdentityLine — exact format", () => {
  it("GLM-4.6 / zai -> 'You are GLM-4.6 from Zhipu AI.'", () => {
    expect(deriveIdentityLine(makeModel({ name: "GLM-4.6", provider: "zai" }))).toBe(
      "You are GLM-4.6 from Zhipu AI.",
    );
  });

  it("Claude Opus 4.7 / anthropic -> 'You are Claude Opus 4.7 from Anthropic.'", () => {
    expect(
      deriveIdentityLine(makeModel({ name: "Claude Opus 4.7", provider: "anthropic" })),
    ).toBe("You are Claude Opus 4.7 from Anthropic.");
  });
});

describe("deriveIdentityLine — provider rendered via display name", () => {
  it("uses 'OpenAI' (not 'openai') for an openai model", () => {
    const line = deriveIdentityLine(makeModel({ name: "GPT-5.5", provider: "openai" }));
    expect(line).toContain("from OpenAI.");
    expect(line).not.toContain("from openai.");
  });

  it("uses 'Google Vertex AI' for a google-vertex model", () => {
    const line = deriveIdentityLine(
      makeModel({ name: "gemini-2.5-pro", provider: "google-vertex" }),
    );
    expect(line).toContain("from Google Vertex AI.");
  });
});

describe("deriveIdentityLine — unknown provider title-cased in the line", () => {
  it("my-custom -> 'My Custom' inline", () => {
    expect(deriveIdentityLine(makeModel({ name: "X", provider: "my-custom" }))).toBe(
      "You are X from My Custom.",
    );
  });
});

describe("deriveIdentityLine — empty / edge names", () => {
  it("empty name preserves structural shape (one space each side, trailing period)", () => {
    expect(deriveIdentityLine(makeModel({ name: "", provider: "anthropic" }))).toBe(
      "You are  from Anthropic.",
    );
  });

  it("name with punctuation / parens passes through verbatim", () => {
    expect(
      deriveIdentityLine(makeModel({ name: "GPT-5.5 (codex)", provider: "openai" })),
    ).toBe("You are GPT-5.5 (codex) from OpenAI.");
  });
});

describe("deriveIdentityLine — purity / no mutation", () => {
  it("returns byte-identical output across N calls and does not mutate the input", () => {
    const model = Object.freeze(
      makeModel({ name: "GLM-4.6", provider: "zai" }),
    ) as Model<any>;
    const snapshot = structuredClone(model);
    const first = deriveIdentityLine(model);
    for (let i = 0; i < 10; i++) {
      expect(deriveIdentityLine(model)).toBe(first);
    }
    // Freeze would throw on any write attempt; the deep-equal check is
    // defense-in-depth.
    expect(model).toEqual(snapshot);
  });
});
