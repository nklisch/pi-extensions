import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

/**
 * Test harness — synthetic event/context/pi builders, all typed against pi's
 * real interfaces. Shared across this feature's tests and grown by downstream
 * epics.
 */

/**
 * Build a fully-typed `BeforeAgentStartEvent` with zero casts.
 * `BuildSystemPromptOptions` requires only `cwd`; `prompt` defaults to `""`;
 * `type` is fixed to `"before_agent_start"`. Pass `opts` to override
 * `prompt` / `images` if a later epic needs them.
 */
export function makeEvent(
  systemPrompt: string,
  opts: Partial<Pick<BeforeAgentStartEvent, "prompt" | "images">> = {},
): BeforeAgentStartEvent {
  return {
    type: "before_agent_start",
    prompt: opts.prompt ?? "",
    systemPrompt,
    // Only `cwd` is required on BuildSystemPromptOptions; the rest are optional.
    systemPromptOptions: { cwd: "/test" },
    ...(opts.images ? { images: opts.images } : {}),
  };
}

/**
 * Build a `ExtensionContext` stub that FAILS FAST on unprovided property
 * access. Provided `overrides` pass through; any access to a property not in
 * `overrides` throws a clear error. This forces downstream epics that read
 * `ctx` (identity-injection needs `ctx.model`, mode-composition needs
 * `ctx.getSystemPrompt()`) to explicitly supply the fields they read, instead
 * of silently getting `undefined` from a loose cast. The no-op handler reads
 * no `ctx` field, so its tests pass without overrides.
 *
 * Symbol property access AND a small allowlist of JS-introspection string
 * keys (`then`, `toJSON`, `toPrimitive`, `constructor`, `asymmetricMatch`)
 * return `undefined` — these are not real ctx fields; they're probed by JS
 * internals (thenable check) and test frameworks (deep-equal serialization),
 * and returning `undefined` for them is correct. Fail-fast applies only to
 * real string-keyed ctx fields.
 */
const INTROSPECTION_KEYS = new Set([
  "then", // thenable probe (await / Promise.resolve)
  "toJSON", // JSON.stringify probe
  "toPrimitive", // coercion probe
  "constructor", // prototype introspection
  "asymmetricMatch", // vitest asymmetric matcher probe
]);

export function makeContext(
  overrides: Partial<ExtensionContext> = {},
): ExtensionContext {
  const target = overrides as Record<string | symbol, unknown>;
  return new Proxy(target, {
    get(t, prop: string | symbol) {
      if (prop in t) {
        return t[prop];
      }
      if (typeof prop === "symbol" || INTROSPECTION_KEYS.has(prop as string)) {
        return undefined;
      }
      throw new Error(
        `test stub: ctx.${String(prop)} not provided — add it to makeContext() overrides`,
      );
    },
  }) as unknown as ExtensionContext;
}

/**
 * Minimal `Model<any>` factory (SSOT) — only `name` and `provider` matter for
 * identity derivation; the rest are harmless defaults satisfying the required
 * `Model<any>` shape. Shared by the identity, noop, clean-base, and handler
 * tests so a single factory governs every fixture model.
 */
export function makeModel(
  overrides: Partial<Model<any>> & Pick<Model<any>, "name" | "provider">,
): Model<any> {
  return {
    id: "test-model",
    api: "openai-responses" as any,
    baseUrl: "https://api.example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    ...overrides,
  };
}

export type RecordedCall = { method: string; args: unknown[] };

export interface RecordingUi extends ExtensionUIContext {
  statusCalls: { key: string; text: string | undefined }[];
  notifyCalls: { message: string; type?: "info" | "warning" | "error" }[];
}

export function makeUi(overrides: Partial<ExtensionUIContext> = {}): RecordingUi {
  const statusCalls: RecordingUi["statusCalls"] = [];
  const notifyCalls: RecordingUi["notifyCalls"] = [];
  const identityTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
  };
  return {
    theme: identityTheme,
    ...overrides,
    statusCalls,
    notifyCalls,
    setStatus: (key: string, text: string | undefined) => {
      statusCalls.push({ key, text });
    },
    notify: (message: string, type?: "info" | "warning" | "error") => {
      notifyCalls.push({ message, type });
    },
  } as RecordingUi;
}

/**
 * Build a recording `ExtensionAPI` stub that captures every registration
 * call (`on`, `registerTool`, `registerCommand`, `registerShortcut`,
 * `registerFlag`, `registerMessageRenderer`, `registerProvider`) in order.
 * Used by `tests/registration.test.ts` to prove the factory registers the
 * handler exactly once and nothing else. Reusable by every downstream epic
 * that registers commands/keybindings/providers.
 */
export function makePi(): { pi: ExtensionAPI; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const record = (method: string) => (...args: unknown[]): void => {
    calls.push({ method, args });
  };
  const pi = {
    on: record("on"),
    registerTool: record("registerTool"),
    registerCommand: record("registerCommand"),
    registerShortcut: record("registerShortcut"),
    registerFlag: record("registerFlag"),
    registerMessageRenderer: record("registerMessageRenderer"),
    registerProvider: record("registerProvider"),
    sendMessage: record("sendMessage"),
  } as unknown as ExtensionAPI;
  return { pi, calls };
}
