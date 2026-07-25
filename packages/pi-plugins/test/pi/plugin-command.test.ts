import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { NativePluginControlService } from "../../src/application/native-control-service.js";
import type { NativeControlExecutionReport } from "../../src/application/ports/native-control-execution.js";
import type { PackagedPluginHost } from "../../src/composition/packaged-plugin-host-contract.js";
import { createNativeControlEnvelope } from "../../src/application/native-control-contract.js";
import { createPluginCommandAdapter, type PluginManagerPresentation } from "../../src/pi/plugin-command.js";
import { createPiControlChannel } from "../../src/pi/pi-control-channel.js";

const executionId = "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never;
const sourcePath = "/pkg/dist/pi/extension.js";
const sourceUrl = pathToFileURL(sourcePath).href;

function report(command: "presentation" | "status" = "status"): NativeControlExecutionReport {
  return {
    envelope: createNativeControlEnvelope({ executionId, command, status: command === "presentation" ? "presentation-required" : "ok" }),
    delivery: "complete",
    deliveredThrough: -1,
  };
}

function harness(mode: ExtensionContext["mode"] = "tui", commandPath: string | readonly string[] = sourcePath) {
  const commands: Array<{ name: string; options: any }> = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const notifications: string[] = [];
  const pi = {
    registerCommand(name: string, options: any) { commands.push({ name, options }); },
    getCommands: () => (typeof commandPath === "string" ? [commandPath] : commandPath).map((path, index) => ({
      name: index === 0 ? "plugin" : "plugin:1",
      source: "extension" as const,
      sourceInfo: { path, source: "pkg", scope: "user" as const, origin: "package" as const },
    })),
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
  } as unknown as ExtensionAPI;
  const context = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: "/workspace",
    signal: undefined,
    waitForIdle: vi.fn(async () => undefined),
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined },
  } as unknown as ExtensionCommandContext;
  return { pi, context, commands, entries, notifications };
}

function control(runText = vi.fn(async () => report())): NativePluginControlService {
  const parseText = vi.fn((text: string) => text.length === 0
    ? { kind: "parsed", command: { command: "presentation", request: {}, invocation: { grammarVersion: "plugin-control/v1", output: "human", nonInteractive: false, input: { kind: "none" } } } }
    : { kind: "parsed", command: { command: "status", request: {}, invocation: { grammarVersion: "plugin-control/v1", output: "human", nonInteractive: false, input: { kind: "none" } } } });
  return {
    grammarVersion: "plugin-control/v1",
    parseText,
    parseArgv: vi.fn(),
    help: vi.fn(),
    complete: vi.fn(() => ({ grammarVersion: "plugin-control/v1", candidates: [], incomplete: false })),
    execute: vi.fn(),
    runArgv: vi.fn(),
    runText,
    poll: vi.fn(),
    cancel: vi.fn(),
  } as unknown as NativePluginControlService;
}

function host(controlService: NativePluginControlService): PackagedPluginHost {
  return {
    current: () => ({ application: { control: controlService }, startup: {} as never, close: vi.fn() }),
    start: vi.fn(),
    dispose: vi.fn(),
    runWithPiOperationContext: vi.fn(async (_ctx, _signal, use) => use({ control: controlService })),
  };
}

function manager(overrides: Partial<PluginManagerPresentation> = {}): PluginManagerPresentation {
  return {
    open: vi.fn(async () => undefined),
    presentOperation: vi.fn(async (_context, operation) => {
      const sink = { write: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
      const value = await operation.run(sink, new AbortController().signal);
      operation.settle(value);
    }),
    presentReport: vi.fn(async () => undefined),
    dynamicCompletions: () => [] as const,
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

function adapter(input: Readonly<{
  pi: ExtensionAPI;
  host: PackagedPluginHost;
  manager: PluginManagerPresentation;
  channel?: ReturnType<typeof createPiControlChannel>;
  handoff?: any;
}>) {
  return createPluginCommandAdapter({
    pi: input.pi,
    sourceUrl,
    host: input.host,
    manager: input.manager,
    channel: input.channel ?? createPiControlChannel({ pi: input.pi }),
    ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
  });
}

describe("Pi /plugin command adapter", () => {
  it("opens the live operation presentation before preserving raw argv text byte-for-byte", async () => {
    const h = harness();
    const order: string[] = [];
    const runText = vi.fn(async () => { order.push("facade"); return report("status"); });
    const service = control(runText);
    const presentation = manager({
      presentOperation: vi.fn(async (_context, operation) => {
        order.push("view");
        const value = await operation.run({ write: async () => undefined, close: async () => undefined }, new AbortController().signal);
        operation.settle(value);
      }),
    });
    const value = adapter({ pi: h.pi, host: host(service), manager: presentation });

    value.register();
    expect(h.commands.map((entry) => entry.name)).toEqual(["plugin"]);
    const raw = "browse  'α beta'\t--scope=all-current";
    await h.commands[0]!.options.handler(raw, h.context);
    expect(order).toEqual(["view", "facade"]);
    expect(runText).toHaveBeenCalledWith(raw, expect.objectContaining({ mode: "tui" }), expect.any(AbortSignal));
    expect(presentation.open).not.toHaveBeenCalled();
    expect(presentation.presentReport).not.toHaveBeenCalled();
  });

  it("opens only the TUI manager for empty text and keeps headless empty dispatch on the facade", async () => {
    const tui = harness("tui");
    const tuiControl = control();
    const presentation = manager();
    const value = adapter({ pi: tui.pi, host: host(tuiControl), manager: presentation });
    value.register();
    await tui.commands[0]!.options.handler("", tui.context);
    expect(tui.context.waitForIdle).toHaveBeenCalledOnce();
    expect(presentation.open).toHaveBeenCalledOnce();
    expect(tuiControl.runText).not.toHaveBeenCalled();

    const rpc = harness("rpc");
    const rpcRun = vi.fn(async () => report("presentation"));
    const rpcControl = control(rpcRun);
    adapter({ pi: rpc.pi, host: host(rpcControl), manager: presentation }).register();
    await rpc.commands[0]!.options.handler("", rpc.context);
    expect(presentation.open).toHaveBeenCalledOnce();
    expect(rpcRun).toHaveBeenCalledWith("", expect.objectContaining({ mode: "rpc" }), expect.any(AbortSignal));
    expect(rpc.entries.at(-1)).toMatchObject({ type: "plugin-host:control-report-v1" });
  });

  it("identifies only its exact normalized import.meta.url among same-suffix package paths", () => {
    const h = harness("tui", [`/other${sourcePath}`, sourcePath]);
    const value = adapter({ pi: h.pi, host: host(control()), manager: manager() });
    value.register();
    value.bindSession(h.context);
    expect(h.notifications).toEqual([expect.stringContaining("/plugin:1")]);
    expect(h.commands).toHaveLength(1);

    const lookalikeOnly = harness("tui", `/other${sourcePath}`);
    const other = adapter({ pi: lookalikeOnly.pi, host: host(control()), manager: manager() });
    other.register();
    other.bindSession(lookalikeOnly.context);
    expect(lookalikeOnly.notifications).toEqual([]);
  });

  it("hands reload-causing live results to the successor without replaying predecessor UI", async () => {
    const h = harness("tui");
    const envelope = createNativeControlEnvelope({ executionId, command: "lifecycle.enable", status: "ok" });
    const service = control(vi.fn(async () => ({ envelope, delivery: "complete", deliveredThrough: -1 })));
    vi.mocked(service.parseText).mockReturnValue({
      kind: "parsed",
      command: { command: "lifecycle.enable", request: {} as never, invocation: { grammarVersion: "plugin-control/v1", output: "human", nonInteractive: false, input: { kind: "none" } } },
      warnings: [],
    });
    const presentation = manager();
    const handoff = { open: vi.fn(() => ({ id: "ticket" })), publish: vi.fn(() => "successor"), fail: vi.fn() } as any;
    const predecessor = new AbortController();
    (h.context as unknown as { signal: AbortSignal }).signal = predecessor.signal;
    const reloadHost = host(service);
    vi.mocked(reloadHost.runWithPiOperationContext).mockImplementation(async (_context, operationSignal, use) => {
      predecessor.abort(new Error("Pi disposed the predecessor during reload"));
      expect(operationSignal.aborted).toBe(false);
      return use({ control: service } as never);
    });
    adapter({ pi: h.pi, host: reloadHost, manager: presentation, handoff }).register();
    await h.commands[0]!.options.handler("enable demo@market --scope user --yes", h.context);
    expect(handoff.open).toHaveBeenCalledWith({ sessionId: "session-1", cwd: "/workspace", destination: "operation-result" });
    expect(handoff.publish).toHaveBeenCalledWith({ id: "ticket" }, { envelope, delivery: "complete", deliveredThrough: -1 });
    expect(presentation.presentReport).not.toHaveBeenCalled();
    expect(h.notifications).toEqual([]);
  });

  it("derives completion from the facade and safe cached dynamic candidates", () => {
    const h = harness();
    const service = control();
    vi.mocked(service.complete).mockReturnValue({
      grammarVersion: "plugin-control/v1",
      candidates: [{ value: "demo@market", kind: "dynamic", canonical: true, safe: { text: "demo", escaped: false, truncated: false } }],
      incomplete: false,
    });
    const value = adapter({
      pi: h.pi,
      host: host(service),
      manager: manager({ dynamicCompletions: () => [{ category: "plugin", value: "demo@market", safe: { text: "demo", escaped: false, truncated: false } }] as const }),
    });
    value.register();
    expect(h.commands[0]!.options.getArgumentCompletions("show d")).toEqual([{ value: "demo@market", label: "demo" }]);
    expect(service.complete).toHaveBeenCalledWith(expect.objectContaining({ text: "show d", dynamic: expect.any(Array) }));
  });

  it("writes bounded facade-derived print frames and no ANSI", async () => {
    let bytes = "";
    const output = new Writable({ write(chunk, _encoding, callback) { bytes += String(chunk); callback(); } });
    const h = harness("print");
    const channel = createPiControlChannel({ pi: h.pi, output });
    const sink = channel.createSink(h.context, "print");
    await sink.write({ schemaVersion: 1, type: "accepted", executionId, sequence: 0, command: "status" }, new AbortController().signal);
    await sink.write({ schemaVersion: 1, type: "progress", executionId, sequence: 1, phase: "loading", state: "started", safe: [] }, new AbortController().signal);
    await sink.write({ schemaVersion: 1, type: "result", executionId, sequence: 2, result: report("status").envelope }, new AbortController().signal);
    expect(bytes).toContain("loading started");
    expect(bytes).not.toContain("\u001b");
    expect(h.entries).toEqual([]);
  });
});
