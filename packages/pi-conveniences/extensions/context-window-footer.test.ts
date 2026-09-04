import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import contextWindowFooterExtension from "./context-window-footer";

function load(overrides: Record<string, unknown> = {}) {
  const commands = new Map<string, { description?: string }>();
  const handlers = new Map<string, unknown>();
  const pi = {
    registerCommand: (name: string, options: { description?: string }) => {
      commands.set(name, options);
    },
    on: (event: string, handler: unknown) => {
      handlers.set(event, handler);
    },
    ...overrides,
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

  test("contains failures from detached footer reapply timers", async () => {
    const { handlers } = load();
    const sessionStart = handlers.get("session_start") as (
      event: unknown,
      ctx: unknown,
    ) => Promise<void>;
    const notifications: string[] = [];
    const diagnostics: string[] = [];
    const priorConsoleError = console.error;
    console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(" "));

    try {
      await sessionStart({}, {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
          setFooter: () => { throw new Error("footer renderer unavailable"); },
          notify: (message: string) => notifications.push(message),
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(diagnostics.some((line) => line.includes("install failed: footer renderer unavailable"))).toBe(true);
      expect(notifications).toEqual([
        "Context footer could not be installed: footer renderer unavailable",
      ]);
    } finally {
      console.error = priorConsoleError;
    }
  });

  test("degrades a footer render that races session invalidation", async () => {
    let footerFactory: ((tui: unknown, theme: unknown, data: unknown) => { render(width: number): string[] }) | undefined;
    const { handlers } = load({ getThinkingLevel: () => "high" });
    const sessionStart = handlers.get("session_start") as (
      event: unknown,
      ctx: unknown,
    ) => Promise<void>;
    const ctx: Record<string, unknown> = {
      cwd: process.cwd(),
      hasUI: true,
      model: { id: "test-model", contextWindow: 1000 },
      getContextUsage: () => ({ percent: 10, contextWindow: 1000 }),
      ui: {
        setFooter: (factory: typeof footerFactory) => { footerFactory = factory; },
        notify: () => {},
      },
    };
    const priorConsoleError = console.error;
    console.error = () => {};

    try {
      await sessionStart({}, ctx);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(footerFactory).toBeDefined();
      const component = footerFactory!(
        { requestRender: () => {} },
        { fg: (_name: string, text: string) => text },
        {
          onBranchChange: () => () => {},
          getGitBranch: () => undefined,
          getExtensionStatuses: () => new Map(),
        },
      );
      Object.defineProperty(ctx, "model", {
        configurable: true,
        get: () => { throw new Error("stale footer context"); },
      });
      expect(component.render(80)).toEqual(["context footer unavailable"]);
    } finally {
      console.error = priorConsoleError;
    }
  });

  test("renders Codex usage before context and compacts it at narrower widths", async () => {
    let footerFactory: ((tui: unknown, theme: unknown, data: unknown) => { render(width: number): string[] }) | undefined;
    const { handlers } = load({ getThinkingLevel: () => "high" });
    const sessionStart = handlers.get("session_start") as (event: unknown, ctx: unknown) => Promise<void>;
    await sessionStart({}, {
      cwd: process.cwd(),
      hasUI: true,
      model: { id: "test-model", contextWindow: 1000 },
      getContextUsage: () => ({ percent: 10, contextWindow: 1000 }),
      ui: { setFooter: (factory: typeof footerFactory) => { if (factory) footerFactory = factory; }, notify: () => {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const component = footerFactory!(
      { requestRender: () => {} },
      { fg: (_name: string, text: string) => text },
      {
        onBranchChange: () => () => {},
        getGitBranch: () => "main",
        getExtensionStatuses: () => new Map([
          ["mode", "mode default"],
          ["codex-pool", "codex work · 5h 82% · 7d 64%"],
        ]),
      },
    );
    const full = component.render(220)[0];
    expect(full.indexOf("codex work")).toBeLessThan(full.indexOf("ctx"));
    expect(full).toContain("codex work · 5h 82% · 7d 64%");
    const medium = component.render(150)[0];
    expect(medium).toContain("codex work");
    expect(medium).toContain("ctx");
    const compact = component.render(80)[0];
    expect(compact).toContain("codex work 82%/64%");
    expect(compact).toContain("ctx");
    const tooNarrow = component.render(20)[0];
    expect(visibleWidth(tooNarrow)).toBeLessThanOrEqual(20);
  });

  test("contains a failure in the timer's diagnostic channel", async () => {
    const { handlers } = load();
    const sessionStart = handlers.get("session_start") as (
      event: unknown,
      ctx: unknown,
    ) => Promise<void>;
    const diagnostics: string[] = [];
    const priorConsoleError = console.error;
    console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(" "));

    try {
      await sessionStart({}, {
        cwd: process.cwd(),
        hasUI: true,
        ui: {
          setFooter: () => { throw new Error("footer failed"); },
          notify: () => { throw new Error("notification failed"); },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(diagnostics).toEqual([
        "[context-window-footer] install failed: footer failed",
        "[context-window-footer] error notification failed: notification failed",
      ]);
    } finally {
      console.error = priorConsoleError;
    }
  });
});
