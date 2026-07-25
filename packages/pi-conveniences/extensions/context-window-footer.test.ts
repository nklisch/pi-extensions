import { describe, expect, test } from "bun:test";
import contextWindowFooterExtension from "./context-window-footer";

function load() {
  const commands = new Map<string, { description?: string }>();
  const handlers = new Map<string, unknown>();
  const pi = {
    registerCommand: (name: string, options: { description?: string }) => {
      commands.set(name, options);
    },
    on: (event: string, handler: unknown) => {
      handlers.set(event, handler);
    },
  };
  contextWindowFooterExtension(pi as never);
  return { commands, handlers };
}

describe("context-window footer", () => {
  test("registers a toggle command", () => {
    const { commands } = load();
    const names = [...commands.keys()].join(" ");
    expect(names).toMatch(/context|footer/i);
  });

  test("hooks session lifecycle to install the footer", () => {
    const { handlers } = load();
    expect(handlers.size).toBeGreaterThan(0);
  });
});
