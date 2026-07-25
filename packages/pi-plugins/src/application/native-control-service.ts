import {
  createNativeControlEnvelope,
  NativeControlExitRegistry,
  NativeControlOperationHandleSchema,
  type NativeControlEnvelope,
  type NativeControlOperationHandle,
} from "./native-control-contract.js";
import { createNativeControlExecutionCoordinator } from "./native-control-execution.js";
import { createNativeControlParser, type NativeControlParseResult } from "./native-control-parser.js";
import { createNativeControlReadDispatcher } from "./native-control-read-dispatch.js";
import { createNativeControlMutationDispatcher } from "./native-control-mutation-dispatch.js";
import { createNativeControlSelectionService } from "./native-control-selection.js";
import {
  NativeControlCommandRegistry,
  NativeControlCommandSchema,
  type NativeControlCommand,
} from "./native-control-registry.js";
import {
  createNativeControlHandlerMap,
  dispatchNativeControlCommand,
} from "./native-control-dispatcher.js";
import { unavailableNativeControlInput } from "./native-control-input.js";
import type { NativeControlApplicationDependencies } from "./ports/native-control-applications.js";
import type { NativeControlInputPort } from "./ports/native-control-input.js";
import type {
  NativeControlExecutionIdPort,
  NativeControlExecutionReport,
  NativeControlFrameSink,
  NativeControlTimeoutPort,
} from "./ports/native-control-execution.js";
import type { NativeControlCompletionRequest, NativeControlCompletionResult, NativeControlHelp } from "./native-control-help.js";

export type NativeControlExecutionOptions = Readonly<{
  mode: "tui" | "rpc" | "json" | "print" | "headless" | "direct";
  output: "json" | "human";
  input?: NativeControlInputPort;
  sink?: NativeControlFrameSink;
  timeoutMs?: number;
}>;

export interface NativePluginControlService {
  readonly grammarVersion: "plugin-control/v1";
  parseArgv(argv: readonly string[]): NativeControlParseResult;
  parseText(text: string, mode?: "execute" | "complete"): NativeControlParseResult;
  help(path?: readonly string[]): NativeControlHelp;
  complete(request: NativeControlCompletionRequest): NativeControlCompletionResult;
  execute(command: NativeControlCommand, options: NativeControlExecutionOptions, signal: AbortSignal): Promise<NativeControlExecutionReport>;
  runArgv(argv: readonly string[], options: NativeControlExecutionOptions, signal: AbortSignal): Promise<NativeControlExecutionReport>;
  runText(text: string, options: NativeControlExecutionOptions, signal: AbortSignal): Promise<NativeControlExecutionReport>;
  poll(handle: NativeControlOperationHandle, signal: AbortSignal): Promise<NativeControlEnvelope>;
  cancel(handle: NativeControlOperationHandle, signal: AbortSignal): Promise<NativeControlEnvelope>;
}

export type ManagedNativePluginControlService = NativePluginControlService & Readonly<{
  quiesce(): void;
  close(): Promise<void>;
}>;

const PARSE_EXECUTION_ID = "native-control-execution-v1:00000000-0000-4000-8000-000000000000" as const;

function preExecutionReport(result: Exclude<NativeControlParseResult, { kind: "parsed" }>): NativeControlExecutionReport {
  const help = result.kind === "help" ? result.help : undefined;
  const diagnostics = result.kind === "invalid" || result.kind === "incomplete" ? result.diagnostics : [];
  const envelope = createNativeControlEnvelope({
    executionId: PARSE_EXECUTION_ID as never,
    command: result.kind === "help" ? "help" : "presentation",
    status: result.kind === "help" ? "ok" : "failed",
    ...(help === undefined ? {} : { data: help as never }),
    diagnostics,
    usageFailure: result.kind !== "help",
  });
  return Object.freeze({ envelope, delivery: "complete" as const, deliveredThrough: -1 });
}

export function createNativePluginControlService(dependencies: Readonly<{
  applications: NativeControlApplicationDependencies;
  ids: NativeControlExecutionIdPort;
  timeouts: NativeControlTimeoutPort;
}>): ManagedNativePluginControlService {
  const parser = createNativeControlParser();
  const selection = createNativeControlSelectionService({ inspection: dependencies.applications.inspection, currentProject: dependencies.applications.currentProject });
  const read = createNativeControlReadDispatcher({
    marketplace: dependencies.applications.marketplace,
    inspection: dependencies.applications.inspection,
    trustedInstallation: dependencies.applications.trustedInstallation,
    operations: dependencies.applications.operations,
    updates: dependencies.applications.updates,
    status: dependencies.applications.status,
    selection,
  });
  const mutation = createNativeControlMutationDispatcher(dependencies.applications);
  const handlers = createNativeControlHandlerMap({ read, mutation });
  const executions = createNativeControlExecutionCoordinator({ ids: dependencies.ids, timeouts: dependencies.timeouts });

  async function execute(commandInput: NativeControlCommand, options: NativeControlExecutionOptions, signal: AbortSignal): Promise<NativeControlExecutionReport> {
    // Direct callers receive the same strict boundary as parsed callers before
    // ID/timer/input/output/service effects are admitted.
    const parsedCommand = NativeControlCommandSchema.parse(commandInput);
    const command = options.input !== undefined && parsedCommand.invocation.input.kind === "none"
      ? NativeControlCommandSchema.parse({ ...parsedCommand, invocation: { ...parsedCommand.invocation, input: { kind: "provided" } } })
      : parsedCommand;
    return executions.execute(command, {
      ...(options.sink === undefined ? {} : { sink: options.sink }),
      ...(options.timeoutMs === undefined ? command.invocation.timeoutMs === undefined ? {} : { timeoutMs: command.invocation.timeoutMs } : { timeoutMs: options.timeoutMs }),
    }, async (owned, execution, operationSignal) => {
      const definition = NativeControlCommandRegistry[owned.command];
      const result = await dispatchNativeControlCommand(handlers, owned, {
        executionId: execution.executionId,
        input: options.input ?? unavailableNativeControlInput,
        progress: execution.progress,
        ...(definition.safety === "mutation" ? { readiness: dependencies.applications.status.snapshot() } : {}),
      }, operationSignal);
      if (owned.command === "presentation" && options.mode !== "tui") {
        return Object.freeze({ ...result, exitOverride: NativeControlExitRegistry.inputRequired });
      }
      return result;
    }, signal);
  }

  async function runParsed(parsed: NativeControlParseResult, options: NativeControlExecutionOptions, signal: AbortSignal): Promise<NativeControlExecutionReport> {
    if (parsed.kind !== "parsed") return preExecutionReport(parsed);
    return execute(parsed.command, options, signal);
  }

  const service: ManagedNativePluginControlService = {
    grammarVersion: "plugin-control/v1",
    parseArgv: parser.parseArgv,
    parseText: parser.parseText,
    help: parser.help,
    complete: parser.complete,
    execute,
    runArgv: (argv, options, signal) => runParsed(parser.parseArgv(argv), options, signal),
    runText: (text, options, signal) => runParsed(parser.parseText(text), options, signal),
    async poll(handleInput, signal) {
      const handle = NativeControlOperationHandleSchema.parse(handleInput);
      const command = NativeControlCommandSchema.parse({ command: "operation.status", request: { token: handle.token }, invocation: { grammarVersion: "plugin-control/v1", output: "json", nonInteractive: true, input: { kind: "none" } } });
      return (await execute(command, { mode: "direct", output: "json" }, signal)).envelope;
    },
    async cancel(handleInput, signal) {
      const handle = NativeControlOperationHandleSchema.parse(handleInput);
      const command = NativeControlCommandSchema.parse({ command: "operation.cancel", request: { token: handle.token }, invocation: { grammarVersion: "plugin-control/v1", output: "json", nonInteractive: true, input: { kind: "none" } } });
      return (await execute(command, { mode: "direct", output: "json" }, signal)).envelope;
    },
    quiesce: executions.quiesce,
    close: executions.close,
  };
  return Object.freeze(service);
}
