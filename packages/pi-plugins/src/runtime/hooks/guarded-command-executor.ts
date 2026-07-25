import { HookEventPlanSchema, type HookEventPlan, type PlannedCommandHook, type ForeignHookInput } from "./event-contract.js";
import type { HookExecutionBinding, HookExecutionContextPort } from "../../application/ports/hook-execution-context.js";
import { HookExecutionContextError } from "../../application/ports/hook-execution-context.js";
import type { CommandRunner } from "../../application/ports/process-runner.js";
import type { HookExecutableResolverPort } from "../../application/ports/hook-executable-resolver.js";
import {
  HOOK_MAX_CONCURRENCY,
  HOOK_MAX_SELECTED_HANDLERS,
  HOOK_STDIN_MAX_BYTES,
  HOOK_STDOUT_MAX_BYTES,
  HOOK_STDERR_MAX_BYTES,
} from "../../domain/hook-runtime-limits.js";
import type { CurrentProjectRuntimeContext } from "../../application/ports/project-trust.js";
import { CurrentProjectRuntimeContextSchema } from "../../application/ports/project-trust.js";
import { parseHookHandlerOutput, type HookHandlerExecution } from "./hook-output-parser.js";
import type { ParsedHookDecision } from "../../domain/hook-output-contract.js";
import { createHookRuntimeDiagnostic, type HookRuntimeDiagnostic } from "./hook-runtime-diagnostic.js";
import { resolveHookLaunch, type HookLaunchPathValues } from "./hook-launch-contract.js";

export type HookHandlerOutcome = ParsedHookDecision | HookRuntimeDiagnostic;

export type HookPlanExecutionResult =
  | Readonly<{ kind: "completed"; handlers: readonly HookHandlerOutcome[] }>
  | Readonly<{ kind: "failed"; diagnostics: readonly HookRuntimeDiagnostic[] }>
  | Readonly<{ kind: "cancelled"; diagnostics: readonly HookRuntimeDiagnostic[] }>;

export interface GuardedCommandHookExecutor {
  execute(
    plan: HookEventPlan,
    invocation: Readonly<{
      currentProject: CurrentProjectRuntimeContext;
      runtimeSignal: AbortSignal;
    }>,
  ): Promise<HookPlanExecutionResult>;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function encodeInput(input: ForeignHookInput): Uint8Array {
  const value = new TextEncoder().encode(`${JSON.stringify(canonicalize(input))}\n`);
  if (value.byteLength > HOOK_STDIN_MAX_BYTES) throw new Error("hook input exceeds bound");
  return value;
}

function bytes(value: Uint8Array): AsyncIterable<Uint8Array> {
  return (async function* () { yield value; })();
}

function bindingOf(hook: PlannedCommandHook): HookExecutionBinding {
  return {
    scope: hook.scope,
    plugin: hook.plugin,
    revision: hook.revision,
    projectionDigest: hook.projectionDigest,
    contributionDigest: hook.contributionDigest,
    componentId: hook.component.id,
    sourceOrder: hook.sourceOrder,
  };
}

function dedupeKey(binding: HookExecutionBinding): string {
  return `${JSON.stringify(binding.scope)}\0${binding.plugin}\0${binding.revision}\0${binding.componentId}`;
}

function combineSignals(...signals: readonly AbortSignal[]): AbortSignal {
  const valid = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (valid.length === 1) return valid[0]!;
  return AbortSignal.any(valid);
}

function failureCode(error: unknown): Readonly<{ code: "HOOK_CANCELLED" | "HOOK_TIMEOUT" | "HOOK_OUTPUT_LIMIT" | "HOOK_SPAWN_FAILED" | "HOOK_AUTHORITY_REJECTED" | "HOOK_CONFIGURATION_FAILED" | "HOOK_EXECUTABLE_UNAVAILABLE"; detail?: string }> {
  if (error instanceof HookExecutionContextError) {
    if (error.code === "CONFIGURATION_FAILED") return { code: "HOOK_CONFIGURATION_FAILED" };
    // The context rejection carries the exact cause (ACTIVE_BINDING_UNAVAILABLE,
    // BINDING_MISMATCH, CURRENT_PROJECT_MISMATCH, INVALID_REQUEST); collapsing
    // it away made startup races and stale bindings indistinguishable.
    return { code: "HOOK_AUTHORITY_REJECTED", detail: error.code };
  }
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "TIMEOUT") return { code: "HOOK_TIMEOUT" };
    if (code === "OUTPUT_LIMIT") return { code: "HOOK_OUTPUT_LIMIT" };
    if (code === "CANCELLED") return { code: "HOOK_CANCELLED" };
    if (code === "SPAWN_FAILED" || code === "PIPE_FAILED" || code === "STDIN_FAILED" || code === "NULL_EXIT") return { code: "HOOK_SPAWN_FAILED" };
  }
  if (error !== null && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError") return { code: "HOOK_CANCELLED" };
  return { code: "HOOK_EXECUTABLE_UNAVAILABLE" };
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error !== null && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");
}

function shellExecutable(handler: PlannedCommandHook["component"]["handler"]["value"]): string {
  if (handler.kind !== "shell") throw new Error("exec handler cannot select a shell");
  const shell = handler.shell ?? "bash";
  return shell === "powershell" ? (process.platform === "win32" ? "powershell.exe" : "pwsh") : (process.platform === "win32" ? "bash.exe" : "bash");
}

export function createGuardedCommandHookExecutor(dependencies: Readonly<{
  context: HookExecutionContextPort;
  command: CommandRunner;
  executables: HookExecutableResolverPort;
}>): GuardedCommandHookExecutor {
  if (dependencies === null || typeof dependencies !== "object" ||
      dependencies.context === undefined || dependencies.command === undefined || dependencies.executables === undefined) {
    throw new TypeError("guarded hook executor dependencies are required");
  }

  async function execute(planInput: HookEventPlan, invocation: Readonly<{
    currentProject: CurrentProjectRuntimeContext;
    runtimeSignal: AbortSignal;
  }>): Promise<HookPlanExecutionResult> {
    let plan: HookEventPlan;
    let currentProject: CurrentProjectRuntimeContext;
    try {
      plan = HookEventPlanSchema.parse(planInput);
      currentProject = CurrentProjectRuntimeContextSchema.parse(invocation.currentProject);
      if (plan.event !== plan.input.hook_event_name) throw new Error("plan event does not match input");
    } catch {
      const first = planInput?.hooks?.[0];
      if (first === undefined) return { kind: "failed", diagnostics: [] };
      const binding = bindingOf(first);
      return { kind: "failed", diagnostics: [createHookRuntimeDiagnostic(binding, planInput.event, "HOOK_INVALID_PLAN")] };
    }

    if (plan.hooks.length > HOOK_MAX_SELECTED_HANDLERS) {
      const first = plan.hooks[0];
      if (first === undefined) return { kind: "failed", diagnostics: [] };
      return { kind: "failed", diagnostics: [createHookRuntimeDiagnostic(bindingOf(first), plan.event, "HOOK_SELECTED_LIMIT")] };
    }
    if (plan.cancellation.kind === "available" && plan.cancellation.abortedAtPlanning) {
      const first = plan.hooks[0];
      if (first === undefined) return { kind: "cancelled", diagnostics: [] };
      return { kind: "cancelled", diagnostics: [createHookRuntimeDiagnostic(bindingOf(first), plan.event, "HOOK_CANCELLED")] };
    }
    if (invocation.runtimeSignal.aborted) {
      const first = plan.hooks[0];
      if (first === undefined) return { kind: "cancelled", diagnostics: [] };
      return { kind: "cancelled", diagnostics: [createHookRuntimeDiagnostic(bindingOf(first), plan.event, "HOOK_CANCELLED")] };
    }

    const ordered = [...plan.hooks].sort((left, right) =>
      left.sourceOrder.snapshotOrdinal - right.sourceOrder.snapshotOrdinal || left.sourceOrder.hookOrdinal - right.sourceOrder.hookOrdinal,
    );
    const unique: PlannedCommandHook[] = [];
    const seen = new Set<string>();
    for (const hook of ordered) {
      const key = dedupeKey(bindingOf(hook));
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(hook);
      }
    }
    if (unique.length === 0) return { kind: "completed", handlers: Object.freeze([]) };
    let stdin: Uint8Array;
    try {
      stdin = encodeInput(plan.input);
    } catch {
      const first = unique[0]!;
      return { kind: "failed", diagnostics: [createHookRuntimeDiagnostic(bindingOf(first), plan.event, "HOOK_INVALID_PLAN")] };
    }
    const outcomes: Array<HookHandlerOutcome | undefined> = new Array(unique.length);
    const callerSignal = plan.cancellation.kind === "available"
      ? combineSignals(plan.cancellation.signal, invocation.runtimeSignal)
      : invocation.runtimeSignal;
    let next = 0;
    let cancelled = false;

    async function work(): Promise<void> {
      while (true) {
        const index = next++;
        const hook = unique[index];
        if (hook === undefined) return;
        const binding = bindingOf(hook);
        try {
          if (callerSignal.aborted) {
            cancelled = true;
            outcomes[index] = createHookRuntimeDiagnostic(binding, plan.event, "HOOK_CANCELLED");
            continue;
          }
          await dependencies.context.withContext({
            binding,
            sessionCwd: plan.input.cwd,
            plannedPluginRoot: hook.pluginRoot,
            plannedPluginDataRoot: hook.pluginDataRoot,
            currentProject,
          }, callerSignal, async (context) => {
            const paths: HookLaunchPathValues = {
              CLAUDE_PLUGIN_ROOT: context.pluginRoot,
              PLUGIN_ROOT: context.pluginRoot,
              CLAUDE_PLUGIN_DATA: context.pluginDataRoot,
              PLUGIN_DATA: context.pluginDataRoot,
              CLAUDE_PROJECT_DIR: context.projectRoot,
            };
            const environment = {
              ...paths,
              ...context.configuration.environment(),
            };
            const launch = resolveHookLaunch(hook.component.handler.value, {
              paths,
              configuration: context.configuration,
              shellForm: hook.component.handler.value.kind === "shell",
            }, environment);
            const command = launch.kind === "shell" ? shellExecutable(hook.component.handler.value) : launch.command;
            const executable = await dependencies.executables.resolve({
              command,
              cwd: context.cwd,
              environment: { inherit: "host", values: launch.environment },
            }, callerSignal);
            const args = launch.kind === "shell"
              ? launch.shell === "powershell"
                ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", launch.command]
                : ["-c", launch.command]
              : [...launch.args];
            const result = await dependencies.command.run({
              executable: executable.executable,
              args,
              cwd: context.cwd,
              environment: { inherit: "host", values: launch.environment },
              stdin: bytes(stdin),
              timeoutMs: launch.timeoutMs,
              capture: {
                stdout: { mode: "capture", maxBytes: HOOK_STDOUT_MAX_BYTES, overflow: "error" },
                stderr: { maxBytes: HOOK_STDERR_MAX_BYTES, overflow: "error" },
              },
            }, callerSignal);
            const execution: HookHandlerExecution = {
              binding,
              exitCode: result.exitCode,
              stdout: result.stdout instanceof Uint8Array ? result.stdout : new Uint8Array(),
              stderr: result.stderr,
              stderrTruncated: result.stderrTruncated,
            };
            outcomes[index] = parseHookHandlerOutput({ event: plan.event, execution, redact: (text) => context.configuration.redact(text) });
          });
        } catch (error) {
          if (isAbort(error, callerSignal)) cancelled = true;
          const failure = isAbort(error, callerSignal) ? { code: "HOOK_CANCELLED" as const } : failureCode(error);
          outcomes[index] = createHookRuntimeDiagnostic(binding, plan.event, failure.code, "error", failure.detail);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(HOOK_MAX_CONCURRENCY, unique.length) }, () => work()));
    const complete = outcomes.filter((value): value is HookHandlerOutcome => value !== undefined);
    if (cancelled) return { kind: "cancelled", diagnostics: complete.filter((value): value is HookRuntimeDiagnostic => "code" in value) };
    return { kind: "completed", handlers: Object.freeze(complete) };
  }

  return Object.freeze({ execute });
}
