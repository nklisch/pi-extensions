import type {
  AutocompleteItem,
} from "@earendil-works/pi-tui";
import { normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { createNativeControlParser } from "../application/native-control-parser.js";
import type { NativeControlDynamicCandidate } from "../application/native-control-help.js";
import type { NativeControlInputPort } from "../application/ports/native-control-input.js";
import type { NativeControlExecutionReport, NativeControlFrameSink } from "../application/ports/native-control-execution.js";
import type { NativeControlFrame } from "../application/native-control-progress.js";
import type { PackagedPluginHost } from "../composition/packaged-plugin-host-contract.js";
import type { PiControlChannel } from "./pi-control-channel.js";
import type { PiInlinePresenter } from "./manager/pi-control-input.js";
import type { PiManagerHandoffTicket, PiManagerReloadHandoff, PluginManagerDestination } from "./pi-manager-reload-handoff.js";

export type PluginManagerLiveOperation = Readonly<{
  signal?: AbortSignal;
  reloadSafe: boolean;
  run(sink: NativeControlFrameSink, signal: AbortSignal): Promise<NativeControlExecutionReport>;
  settle(report: NativeControlExecutionReport): "local" | "successor";
}>;

export interface PluginManagerPresentation {
  open(context: ExtensionCommandContext): Promise<void>;
  presentOperation(context: ExtensionCommandContext, operation: PluginManagerLiveOperation): Promise<void>;
  presentReport(
    context: ExtensionCommandContext,
    report: NativeControlExecutionReport,
    frames: readonly NativeControlFrame[],
  ): Promise<void>;
  dynamicCompletions(): readonly NativeControlDynamicCandidate[];
  /** The surface that can mount mid-operation input custody inline, if one is presented. */
  inlinePresenter?(): PiInlinePresenter | undefined;
  close(reason: SessionShutdownEvent["reason"]): Promise<void>;
}

export type PluginCommandAdapter = Readonly<{
  register(): void;
  bindSession(context: ExtensionContext): void;
  unbindSession(reason: SessionShutdownEvent["reason"]): void;
  close(): Promise<void>;
}>;

function linkedAbort(parent: AbortSignal | undefined): Readonly<{ controller: AbortController; dispose(): void }> {
  const controller = new AbortController();
  if (parent === undefined) return { controller, dispose() {} };
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort(); else parent.addEventListener("abort", abort, { once: true });
  return Object.freeze({ controller, dispose: () => parent.removeEventListener("abort", abort) });
}

function ownInvocationName(pi: ExtensionAPI, sourceUrl: string): string | undefined {
  const ownPath = normalize(resolve(fileURLToPath(sourceUrl)));
  const commands = pi.getCommands().filter((command) => {
    if (command.source !== "extension") return false;
    return normalize(resolve(command.sourceInfo.path)) === ownPath;
  });
  return commands.length === 1 ? commands[0]!.name : undefined;
}

function reloadDestination(command: string): PluginManagerDestination | undefined {
  if (command === "install.run" || command === "install.apply" || command === "install.recover") return "install-result";
  if (command.startsWith("lifecycle.") || command === "project.sync" || command === "updates.automatic.run") return "operation-result";
  return undefined;
}

/** Register the sole Pi management command without interpreting its grammar. */
export function createPluginCommandAdapter(input: Readonly<{
  pi: ExtensionAPI;
  sourceUrl: string;
  host: PackagedPluginHost;
  manager: PluginManagerPresentation;
  channel: PiControlChannel;
  handoff?: Pick<PiManagerReloadHandoff, "open" | "publish" | "fail">;
  createInput?: (context: ExtensionCommandContext, mode: ExtensionContext["mode"]) => NativeControlInputPort;
}>): PluginCommandAdapter {
  const staticParser = createNativeControlParser();
  let registered = false;
  let closed = false;

  async function handler(args: string, context: ExtensionCommandContext): Promise<void> {
    if (closed) {
      context.ui.notify("Plugin Host presentation is closed.", "error");
      return;
    }
    const current = input.host.current();
    if (current === undefined) {
      context.ui.notify("Plugin Host is still starting; retry /plugin.", "warning");
      return;
    }
    const parsed = current.application.control.parseText(args);
    if (parsed.kind === "parsed" && parsed.command.command === "presentation" && context.mode === "tui") {
      await context.waitForIdle();
      await input.manager.open(context);
      return;
    }

    const destination = parsed.kind === "parsed" ? reloadDestination(parsed.command.command) : undefined;
    // Pi aborts the predecessor command context as part of a successful
    // extension reload. Activation commands must survive that boundary long
    // enough to consume successor observation and settle the durable
    // transition; their operation registry still owns explicit cancellation.
    const abort = linkedAbort(destination === undefined ? context.signal : undefined);
    let handoffTicket: PiManagerHandoffTicket | undefined;
    if (destination !== undefined && input.handoff !== undefined) {
      handoffTicket = input.handoff.open({ sessionId: context.sessionManager.getSessionId(), cwd: context.cwd, destination });
    }
    const executionInput = parsed.kind === "parsed" && !parsed.command.invocation.nonInteractive && input.createInput !== undefined
      ? input.createInput(context, context.mode)
      : undefined;
    try {
      const output = parsed.kind === "parsed" ? parsed.command.invocation.output : "human";
      if (context.mode === "tui") {
        await input.manager.presentOperation(context, {
          signal: abort.controller.signal,
          reloadSafe: destination !== undefined,
          async run(viewSink, signal) {
            // The live TUI owns these frames directly. Retaining them in the
            // Pi channel would require touching the predecessor command context
            // after a reload, when only the plain-data handoff remains valid.
            return input.host.runWithPiOperationContext(context, signal, (application) =>
              application.control.runText(args, {
                mode: context.mode,
                output,
                sink: viewSink,
                ...(executionInput === undefined ? {} : { input: executionInput }),
              }, signal));
          },
          settle(report) {
            return handoffTicket === undefined || input.handoff === undefined
              ? "local"
              : input.handoff.publish(handoffTicket, report);
          },
        });
      } else {
        const report = await input.host.runWithPiOperationContext(context, abort.controller.signal, (application) =>
          application.control.runText(args, {
            mode: context.mode,
            output,
            sink: input.channel.createSink(context, context.mode),
            ...(executionInput === undefined ? {} : { input: executionInput }),
          }, abort.controller.signal));
        const presentation = handoffTicket === undefined || input.handoff === undefined
          ? "local" as const
          : input.handoff.publish(handoffTicket, report);
        if (presentation === "successor") return;
        await input.channel.publishReport(context, report);
      }
    } catch {
      if (handoffTicket !== undefined && input.handoff !== undefined) {
        try { input.handoff.fail(handoffTicket); } catch { /* retain the original command failure */ }
      }
      // Native errors and causes are deliberately not reflected into UI/protocol
      // channels. The facade envelope is the only detailed management result.
      context.ui.notify("Plugin Host command could not complete.", "error");
    } finally {
      abort.dispose();
      const disposable = executionInput as NativeControlInputPort & { dispose?: () => void } | undefined;
      disposable?.dispose?.();
    }
  }

  return Object.freeze({
    register(): void {
      if (registered) return;
      registered = true;
      input.pi.registerCommand("plugin", {
        description: "Manage Pi plugins",
        getArgumentCompletions(argumentPrefix): AutocompleteItem[] | null {
          const control = input.host.current()?.application.control;
          const completion = (control ?? staticParser).complete({
            text: argumentPrefix,
            dynamic: input.manager.dynamicCompletions(),
          });
          if (completion.candidates.length === 0) return null;
          return completion.candidates.map((candidate) => ({
            value: candidate.value,
            label: candidate.safe.text,
          }));
        },
        handler,
      });
    },
    bindSession(context): void {
      const invocationName = ownInvocationName(input.pi, input.sourceUrl);
      if (invocationName !== undefined && invocationName !== "plugin") {
        input.channel.publishCollision(context, invocationName);
      }
    },
    unbindSession(_reason): void {
      // Command registration is process-owned by Pi. Session-scoped objects are
      // closed by the presentation lifecycle rather than unregistered here.
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await input.manager.close("quit");
    },
  });
}
