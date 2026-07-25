import { describe, expect, it, vi } from "vitest";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createNativeControlEnvelope } from "../../../src/application/native-control-contract.js";
import type { NativeControlExecutionReport } from "../../../src/application/ports/native-control-execution.js";
import type { PluginManagerLiveOperation } from "../../../src/pi/plugin-command.js";
import { createPluginManagerSession } from "../../../src/pi/manager/plugin-manager-session.js";

const executionId = "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never;
function report(status: "ok" | "cancelled" = "ok"): NativeControlExecutionReport {
  return {
    envelope: createNativeControlEnvelope({ executionId, command: "status", status }),
    delivery: "complete",
    deliveredThrough: 1,
  };
}

function harness(host: any = {}) {
  let component: any;
  let finish: ((value?: unknown) => void) | undefined;
  const done = vi.fn((value?: unknown) => finish?.(value));
  const tui = { terminal: { rows: 12 }, requestRender: vi.fn() } as any;
  const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text } as any;
  const keybindings = {
    getKeys: () => ["enter"],
    matches: (data: string, id: string) =>
      id === "tui.select.cancel" || id === "app.interrupt" ? matchesKey(data, Key.escape) :
        id === "tui.select.up" ? matchesKey(data, Key.up) :
          id === "tui.select.down" ? matchesKey(data, Key.down) : false,
  } as any;
  const context = {
    mode: "tui",
    hasUI: true,
    cwd: "/workspace",
    signal: undefined,
    sessionManager: { getSessionId: () => "session-1" },
    ui: {
      custom: vi.fn(async (factory: any) => await new Promise((resolve) => {
        finish = resolve;
        component = factory(tui, theme, keybindings, done);
      })),
      notify: vi.fn(),
    },
  } as unknown as ExtensionCommandContext;
  const session = createPluginManagerSession({ host, handoff: {} as any });
  return { context, session, done, tui, get component() { return component; } };
}

describe("plugin manager live command presentation", () => {
  it("mounts the catalog before background reads settle", async () => {
    const reads: Array<{ reject(error: unknown): void }> = [];
    const host = {
      runWithPiOperationContext(_context: unknown, _signal: AbortSignal, run: (application: unknown) => Promise<unknown>) {
        return run({ control: { runArgv: () => new Promise((_resolve, reject) => reads.push({ reject })) } });
      },
    };
    const h = harness(host);
    const pending = h.session.open(h.context);
    await vi.waitFor(() => expect(h.component).toBeDefined());
    expect(reads).toHaveLength(5);
    expect(h.component.render(60).join("\n")).toContain("loading current state");
    for (const read of reads) read.reject(new Error("offline"));
    h.component.requestClose();
    await pending;
  });

  it("renders a progress frame before completion and aborts exactly once on repeated Escape", async () => {
    const h = harness();
    let aborts = 0;
    const settle = vi.fn(() => "local" as const);
    const operation: PluginManagerLiveOperation = {
      reloadSafe: false,
      async run(sink, signal) {
        await sink.write({ schemaVersion: 1, type: "progress", executionId, sequence: 1, phase: "working", state: "started", safe: [] }, signal);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborts += 1; resolve(); }, { once: true }));
        return report("cancelled");
      },
      settle,
    };

    const pending = h.session.presentOperation(h.context, operation);
    await vi.waitFor(() => expect(h.component).toBeDefined());
    await vi.waitFor(() => expect(h.component.render(60).join("\n")).toContain("working started"));
    expect(settle).not.toHaveBeenCalled();
    h.component.handleInput("\u001b");
    h.component.handleInput("\u001b");
    await vi.waitFor(() => expect(h.component.render(60).join("\n")).toContain("Result"));
    expect(aborts).toBe(1);
    h.component.handleInput("\u001b");
    await pending;
    expect(settle).toHaveBeenCalledOnce();
  });

  it("detaches a reload-safe admitted operation without aborting or reusing predecessor UI", async () => {
    const h = harness();
    let release!: () => void;
    let operationSignal!: AbortSignal;
    const settle = vi.fn(() => "successor" as const);
    const operation: PluginManagerLiveOperation = {
      reloadSafe: true,
      async run(_sink, signal) {
        operationSignal = signal;
        await new Promise<void>((resolve) => { release = resolve; });
        return report();
      },
      settle,
    };

    const pending = h.session.presentOperation(h.context, operation);
    await vi.waitFor(() => expect(h.component).toBeDefined());
    await h.session.close("reload");
    expect(operationSignal.aborted).toBe(false);
    expect(h.done).toHaveBeenCalledOnce();
    release();
    await pending;
    expect(settle).toHaveBeenCalledOnce();
    expect(operationSignal.aborted).toBe(false);
    expect(h.done).toHaveBeenCalledOnce();
  });
});
