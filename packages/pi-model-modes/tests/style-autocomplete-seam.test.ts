import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AutocompleteProviderFactory,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { makeContext, makePi } from "./harness.js";

const EVENT: SessionStartEvent = { type: "session_start", reason: "startup" };

afterEach(() => {
  vi.doUnmock("../src/style.js");
  vi.resetModules();
});

describe("style autocomplete discovery failure", () => {
  it("delegates when live catalog discovery throws", async () => {
    vi.resetModules();
    vi.doMock("../src/style.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/style.js")>();
      return { ...actual, listAvailableStyles: () => { throw new Error("catalog unavailable"); } };
    });
    const { registerStyleAutocomplete } = await import("../src/style-autocomplete.js");
    const { pi, calls } = makePi();
    registerStyleAutocomplete(pi);
    const registration = calls.find((call) => call.method === "on")!;
    const factories: AutocompleteProviderFactory[] = [];
    const ctx = makeContext({
      mode: "tui",
      ui: { addAutocompleteProvider: (factory: AutocompleteProviderFactory) => factories.push(factory) },
    } as unknown as Partial<ExtensionContext>);
    (registration.args[1] as (event: SessionStartEvent, ctx: ExtensionContext) => void)(EVENT, ctx);

    let delegated = 0;
    const current: AutocompleteProvider = {
      async getSuggestions() {
        delegated += 1;
        return { prefix: "fallback", items: [{ value: "fallback", label: "fallback" }] };
      },
      applyCompletion(lines) { return { lines, cursorLine: 0, cursorCol: 0 }; },
    };
    const result = await factories[0](current).getSuggestions(
      ["/style cl"], 0, 9, { signal: new AbortController().signal },
    );
    expect(delegated).toBe(1);
    expect(result).toEqual({ prefix: "fallback", items: [{ value: "fallback", label: "fallback" }] });
  });
});
