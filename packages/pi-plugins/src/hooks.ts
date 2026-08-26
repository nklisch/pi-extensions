import { spawn } from "node:child_process";
import type {
  AgentEndEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { HookExecutionResult, HookOutput, PluginHookCommand, RuntimeSnapshot, SupportedHookEvent } from "./types.js";

const MAX_OUTPUT_BYTES = 1_000_000;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedAppend(current: string, chunk: Buffer | string): string {
  if (current.length >= MAX_OUTPUT_BYTES) return current;
  return `${current}${chunk.toString()}`.slice(0, MAX_OUTPUT_BYTES);
}

function abortError(reason: unknown): Error {
  const error = new Error(reason instanceof Error ? reason.message : "hook execution cancelled");
  error.name = "AbortError";
  return error;
}

/** Execute the foreign format's intentional shell-command boundary with bounded lifetime and output. */
export function executeHookCommand(input: Readonly<{
  command: string;
  cwd: string;
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
  signal?: AbortSignal;
  stdin: unknown;
}>): Promise<HookExecutionResult> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || "/bin/sh";
    const child = spawn(shell, ["-c", input.command], {
      cwd: input.cwd,
      env: { ...process.env, ...input.environment },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      child.kill("SIGTERM");
      forceTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 500);
      forceTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMs);
    timer.unref();
    const cancel = () => terminate();
    input.signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk: Buffer | string) => { stdout = boundedAppend(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr = boundedAppend(stderr, chunk); });
    const finish = (result: HookExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      input.signal?.removeEventListener("abort", cancel);
      resolve(result);
    };
    child.on("error", (error) => finish({ ok: false, stdout, stderr, error }));
    child.on("close", (code, signal) => {
      if (input.signal?.aborted) {
        finish({ ok: false, stdout, stderr, error: abortError(input.signal.reason) });
        return;
      }
      if (timedOut) {
        finish({ ok: false, stdout, stderr, error: new Error(`hook timed out after ${input.timeoutMs}ms`) });
        return;
      }
      if (code !== 0) {
        finish({ ok: false, stdout, stderr, error: new Error(`hook exited with ${code ?? signal ?? "unknown status"}`) });
        return;
      }
      finish({ ok: true, stdout, stderr });
    });
    // A guard-style hook may exit before consuming a large payload. Swallow
    // the resulting pipe error here; process exit still settles the hook.
    child.stdin.on("error", () => undefined);
    child.stdin.end(`${JSON.stringify(input.stdin)}\n`);
    if (input.signal?.aborted) child.kill("SIGTERM");
  });
}

function parseOutput(text: string, event: SupportedHookEvent): HookOutput | undefined {
  const candidates = text.trim().length === 0 ? [] : [text.trim(), ...text.trim().split("\n").reverse()];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (!record(value)) continue;
      const nested = record(value.hookSpecificOutput) ? value.hookSpecificOutput : undefined;
      if (nested !== undefined && nested.hookEventName !== undefined && nested.hookEventName !== event) continue;
      const additionalContext = typeof nested?.additionalContext === "string"
        ? nested.additionalContext
        : typeof value.additionalContext === "string" ? value.additionalContext : undefined;
      const decision = nested?.permissionDecision ?? nested?.decision ?? value.decision;
      const continueValue = nested?.continue ?? value.continue;
      return Object.freeze({
        ...(additionalContext === undefined ? {} : { additionalContext }),
        ...(decision === "block" || decision === "deny" || continueValue === false ? { block: true } : {}),
        ...(typeof value.reason === "string" ? { reason: value.reason } : typeof nested?.reason === "string" ? { reason: nested.reason } : {}),
        ...(typeof continueValue === "boolean" ? { continue: continueValue } : {}),
      });
    } catch {
      // Claude hooks are allowed to be silent. Non-JSON diagnostic text is not
      // treated as an instruction, because doing so would make stderr/logging
      // accidentally alter agent behavior.
    }
  }
  return undefined;
}

function matcherValue(event: SupportedHookEvent, input: JsonRecord): string {
  if (event === "SessionStart" || event === "SessionEnd" || event === "PreCompact" || event === "PostCompact") return String(input.reason ?? "");
  if (event === "PreToolUse" || event === "PostToolUse" || event === "PostToolUseFailure") return String(input.tool_name ?? "");
  return "";
}

function matches(command: PluginHookCommand, input: JsonRecord): boolean {
  if (command.matcher === undefined || command.matcher.length === 0) return true;
  try { return new RegExp(command.matcher, "u").test(matcherValue(command.event, input)); } catch { return false; }
}

function baseEnvironment(plugin: RuntimeSnapshot["plugins"][number], cwd: string): Readonly<Record<string, string>> {
  return Object.freeze({
    PLUGIN_ROOT: plugin.info.root,
    CLAUDE_PLUGIN_ROOT: plugin.info.root,
    PLUGIN_DATA: plugin.info.data,
    CLAUDE_PLUGIN_DATA: plugin.info.data,
    CLAUDE_PROJECT_DIR: cwd,
  });
}

function hookInput(event: SupportedHookEvent, ctx: ExtensionContext, values: JsonRecord = {}): JsonRecord {
  return { hook_event_name: event, cwd: ctx.cwd, ...values };
}

function sessionStartReason(reason: SessionStartEvent["reason"]): "startup" | "resume" | "clear" {
  if (reason === "new") return "clear";
  if (reason === "resume" || reason === "fork") return "resume";
  return "startup";
}

interface HookAggregate {
  readonly contexts: readonly string[];
  readonly blocked: boolean;
  readonly reason?: string;
}

function emptyAggregate(): HookAggregate { return { contexts: [], blocked: false }; }

function mergeAggregate(left: HookAggregate, output: HookOutput | undefined): HookAggregate {
  return {
    contexts: [...left.contexts, ...(output?.additionalContext === undefined ? [] : [output.additionalContext])],
    blocked: left.blocked || output?.block === true,
    ...(output?.reason === undefined ? (left.reason === undefined ? {} : { reason: left.reason }) : { reason: output.reason }),
  };
}

export function registerPluginHooks(pi: ExtensionAPI, snapshot: RuntimeSnapshot): void {
  let pendingContext: string[] = [];

  const invoke = async (event: SupportedHookEvent, input: JsonRecord, ctx: ExtensionContext): Promise<HookAggregate> => {
    let aggregate = emptyAggregate();
    for (const plugin of snapshot.plugins.filter((item) => item.info.enabled)) {
      for (const command of plugin.hooks.filter((item) => item.event === event && matches(item, input))) {
        const result = await executeHookCommand({
          command: command.command,
          cwd: ctx.cwd,
          environment: baseEnvironment(plugin, ctx.cwd),
          timeoutMs: command.timeoutMs,
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
          stdin: input,
        });
        if (!result.ok) {
          if (ctx.hasUI) ctx.ui.notify(`${plugin.info.name}@${plugin.info.marketplace} ${event} hook failed: ${result.error instanceof Error ? result.error.message : "unknown error"}`, "warning");
          continue;
        }
        aggregate = mergeAggregate(aggregate, parseOutput(result.stdout, event));
      }
    }
    pendingContext.push(...aggregate.contexts);
    return aggregate;
  };

  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
    await invoke("SessionStart", hookInput("SessionStart", ctx, { reason: sessionStartReason(event.reason), pi_reason: event.reason }), ctx);
  });
  pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx: ExtensionContext) => {
    await invoke("SessionEnd", hookInput("SessionEnd", ctx, { reason: event.reason }), ctx);
  });
  pi.on("input", async (event: InputEvent, ctx: ExtensionContext) => {
    const result = await invoke("UserPromptSubmit", hookInput("UserPromptSubmit", ctx, { prompt: event.text }), ctx);
    if (result.blocked) return { action: "handled" };
    return { action: "continue" };
  });
  pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
    const result = await invoke("PreToolUse", hookInput("PreToolUse", ctx, { tool_name: event.toolName, tool_input: event.input }), ctx);
    if (!result.blocked) return undefined;
    return result.reason === undefined ? { block: true } : { block: true, reason: result.reason };
  });
  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    const hookEvent: SupportedHookEvent = event.isError ? "PostToolUseFailure" : "PostToolUse";
    await invoke(hookEvent, hookInput(hookEvent, ctx, { tool_name: event.toolName, tool_input: event.input, tool_output: event.content, is_error: event.isError }), ctx);
  });
  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
    const result = await invoke("PreCompact", hookInput("PreCompact", ctx, { reason: event.reason }), ctx);
    return result.blocked ? { cancel: true } : undefined;
  });
  pi.on("session_compact", async (event: SessionCompactEvent, ctx: ExtensionContext) => {
    await invoke("PostCompact", hookInput("PostCompact", ctx, { reason: event.reason }), ctx);
  });
  pi.on("agent_end", async (_event: AgentEndEvent, ctx: ExtensionContext) => {
    await invoke("Stop", hookInput("Stop", ctx), ctx);
  });
  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, _ctx: ExtensionContext) => {
    if (pendingContext.length === 0) return undefined;
    const context = pendingContext.join("\n\n");
    pendingContext = [];
    return { systemPrompt: `${event.systemPrompt}\n\n${context}` };
  });
}
