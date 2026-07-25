import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AutocompleteProviderFactory,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { makeContext, makePi } from "./harness.js";

const SESSION_START_EVENT: SessionStartEvent = {
  type: "session_start",
  reason: "startup",
};

function registeredSessionStartHandler(
  calls: ReturnType<typeof makePi>["calls"],
): (event: SessionStartEvent, ctx: ExtensionContext) => void {
  const registrations = calls.filter(
    (call) => call.method === "on" && call.args[0] === "session_start",
  );
  expect(registrations).toHaveLength(1);
  return registrations[0].args[1] as (
    event: SessionStartEvent,
    ctx: ExtensionContext,
  ) => void;
}

function recordingAutocompleteContext(): {
  ctx: ExtensionContext;
  factories: AutocompleteProviderFactory[];
} {
  const factories: AutocompleteProviderFactory[] = [];
  const ctx = makeContext({
    mode: "tui",
    ui: {
      addAutocompleteProvider: (factory: AutocompleteProviderFactory) => {
        factories.push(factory);
      },
    },
  } as unknown as Partial<ExtensionContext>);
  return { ctx, factories };
}

function currentProvider(): {
  current: AutocompleteProvider;
  calls: { getSuggestions: number };
} {
  const calls = { getSuggestions: 0 };
  return {
    calls,
    current: {
      async getSuggestions() {
        calls.getSuggestions += 1;
        return {
          prefix: "fallback",
          items: [{ value: "fallback", label: "fallback" }],
        };
      },
      applyCompletion(lines) {
        return { lines, cursorLine: 0, cursorCol: 0 };
      },
    },
  };
}

describe("registerModeAutocomplete defensive fallback", () => {
  afterEach(() => {
    vi.doUnmock("../src/presets.js");
    vi.resetModules();
  });

  it("delegates suggestions when the pure helper throws", async () => {
    vi.resetModules();
    vi.doMock("../src/presets.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/presets.js")>();
      return {
        ...actual,
        loadPresets: () => {
          throw new Error("bad presets");
        },
      };
    });
    const { registerModeAutocomplete } = await import("../src/autocomplete.js");
    const { pi, calls } = makePi();
    registerModeAutocomplete(pi);
    const handler = registeredSessionStartHandler(calls);
    const { ctx, factories } = recordingAutocompleteContext();
    handler(SESSION_START_EVENT, ctx);
    const { current, calls: providerCalls } = currentProvider();
    const provider = factories[0](current);

    const result = await provider.getSuggestions(["/mode fl"], 0, 8, {
      signal: new AbortController().signal,
    });

    expect(providerCalls.getSuggestions).toBe(1);
    expect(result).toEqual({
      prefix: "fallback",
      items: [{ value: "fallback", label: "fallback" }],
    });
  });
});
