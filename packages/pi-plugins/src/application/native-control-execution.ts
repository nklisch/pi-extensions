import { NativeControlCommandSchema, type NativeControlCommand } from "./native-control-registry.js";
import { createNativeControlProgressController } from "./native-control-progress.js";
import type {
  NativeControlDispatchExecutionContext,
  NativeControlExecutionCoreOptions,
  NativeControlExecutionIdPort,
  NativeControlExecutionReport,
  NativeControlTimeoutPort,
} from "./ports/native-control-execution.js";
import type { NativeControlDispatchResult } from "./native-control-projection.js";
import { createNativeControlResultProjector, type NativeControlResultProjector } from "./native-control-result.js";

export class NativeControlAdmissionError extends Error {
  readonly code = "CONTROL_QUIESCED";
  constructor() {
    super("native control service is quiesced");
    this.name = "NativeControlAdmissionError";
  }
}

export type NativeControlDispatchFunction = (
  command: NativeControlCommand,
  context: NativeControlDispatchExecutionContext,
  signal: AbortSignal,
) => Promise<NativeControlDispatchResult>;

export interface NativeControlExecutionCoordinator {
  execute(
    command: NativeControlCommand,
    options: NativeControlExecutionCoreOptions,
    dispatch: NativeControlDispatchFunction,
    signal: AbortSignal,
  ): Promise<NativeControlExecutionReport>;
  quiesce(): void;
  close(): Promise<void>;
  activeCount(): number;
}

function operationSignal(parent: AbortSignal): Readonly<{ controller: AbortController; dispose(): void }> {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return Object.freeze({ controller, dispose: () => parent.removeEventListener("abort", abort) });
}

export function createNativeControlExecutionCoordinator(dependencies: Readonly<{
  ids: NativeControlExecutionIdPort;
  timeouts: NativeControlTimeoutPort;
  results?: NativeControlResultProjector;
}>): NativeControlExecutionCoordinator {
  const results = dependencies.results ?? createNativeControlResultProjector();
  let accepting = true;
  let closePromise: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();

  async function executeAdmitted(
    commandInput: NativeControlCommand,
    options: NativeControlExecutionCoreOptions,
    dispatch: NativeControlDispatchFunction,
    callerSignal: AbortSignal,
  ): Promise<NativeControlExecutionReport> {
    const command = NativeControlCommandSchema.parse(commandInput);
    callerSignal.throwIfAborted();
    const executionId = await dependencies.ids.issue(callerSignal);
    const timeout = options.timeoutMs === undefined ? undefined : dependencies.timeouts.arm(options.timeoutMs, callerSignal);
    const linked = operationSignal(timeout?.signal ?? callerSignal);
    // Operation cancellation and output delivery are separate concerns. A
    // timeout/SIGINT aborts owner work but must not pre-abort the terminal
    // cancelled envelope that explains the numeric exit to the caller.
    const delivery = new AbortController();
    const progress = createNativeControlProgressController({
      executionId,
      command: command.command,
      ...(options.sink === undefined ? {} : { sink: options.sink }),
      signal: delivery.signal,
      abortDelivery: () => linked.controller.abort(new Error("native control output delivery failed")),
    });
    let envelope;
    try {
      await progress.accepted();
      try {
        const result = await dispatch(command, { executionId, command: command.command, progress: progress.progress }, linked.controller.signal);
        envelope = results.project(command, result, executionId);
      } catch (error) {
        const classified = linked.controller.signal.aborted || callerSignal.aborted || timeout?.signal.aborted === true
          ? new DOMException("native control execution cancelled", "AbortError")
          : error;
        envelope = results.classifyError(command, classified, executionId);
      }
      await progress.result(envelope);
    } finally {
      timeout?.dispose();
      linked.dispose();
      await progress.close();
    }
    return Object.freeze({ envelope, delivery: progress.delivery(), deliveredThrough: progress.deliveredThrough() });
  }

  const coordinator: NativeControlExecutionCoordinator = {
    execute(command, options, dispatch, signal) {
      if (!accepting) return Promise.reject(new NativeControlAdmissionError());
      const promise = executeAdmitted(command, options, dispatch, signal);
      active.add(promise);
      void promise.finally(() => active.delete(promise)).catch(() => undefined);
      return promise;
    },
    quiesce() { accepting = false; },
    close() {
      accepting = false;
      closePromise ??= Promise.allSettled([...active]).then(() => undefined);
      return closePromise;
    },
    activeCount: () => active.size,
  };
  return Object.freeze(coordinator);
}
