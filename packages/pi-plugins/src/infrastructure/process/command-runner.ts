import { spawn, type ChildProcess } from "node:child_process";
import { redactCommand } from "../logging/redaction.js";
import type {
  CommandCapturePolicy,
  CommandEnvironment,
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../../application/ports/process-runner.js";

export type {
  CommandCapturePolicy,
  CommandEnvironment,
  CommandRequest,
  CommandResult,
  CommandRunner,
} from "../../application/ports/process-runner.js";

export type CommandRunnerErrorCode =
  | "INVALID_REQUEST"
  | "SPAWN_FAILED"
  | "PIPE_FAILED"
  | "OUTPUT_LIMIT"
  | "TIMEOUT"
  | "CANCELLED"
  | "STDIN_FAILED"
  | "NULL_EXIT";

export class CommandRunnerError extends Error {
  readonly command: ReturnType<typeof redactCommand>;

  constructor(
    message: string,
    executable: string,
    args: readonly string[],
    readonly code: CommandRunnerErrorCode = "SPAWN_FAILED",
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "CommandRunnerError";
    this.command = redactCommand(executable, args);
  }
}

type RunnerOptions = Readonly<{ killGraceMs?: number }>;
const ABORT_ERROR = (): DOMException => new DOMException("The operation was aborted", "AbortError");

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? ABORT_ERROR();
}

function validateEnvironment(value: CommandEnvironment): void {
  if (value === null || typeof value !== "object" || (value.inherit !== "host" && value.inherit !== "none") ||
      value.values === null || typeof value.values !== "object" || Array.isArray(value.values) ||
      Object.entries(value.values).some(([key, item]) => key.length === 0 || typeof item !== "string" && item !== undefined)) {
    throw new TypeError("command environment policy is invalid");
  }
}

function validateCapture(value: CommandCapturePolicy): void {
  if (value === null || typeof value !== "object" || value.stdout === undefined || value.stderr === undefined ||
      (value.stdout.mode !== "capture" && value.stdout.mode !== "stream") ||
      value.stdout.overflow !== "error" || !Number.isSafeInteger(value.stdout.maxBytes) || value.stdout.maxBytes <= 0 ||
      !Number.isSafeInteger(value.stderr.maxBytes) || value.stderr.maxBytes <= 0 ||
      (value.stderr.overflow !== "error" && value.stderr.overflow !== "truncate")) {
    throw new TypeError("command capture policy is invalid");
  }
}

function validateRequest(request: CommandRequest): void {
  if (request === null || typeof request !== "object") throw new TypeError("command request is required");
  if (typeof request.executable !== "string" || request.executable.length === 0 || request.executable.includes("\0")) {
    throw new TypeError("command executable must be a non-empty string");
  }
  if (!Array.isArray(request.args) || request.args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("command arguments must be an array of strings");
  }
  if (typeof request.cwd !== "string" || request.cwd.length === 0 || request.cwd.includes("\0")) {
    throw new TypeError("command cwd must be non-empty");
  }
  validateEnvironment(request.environment);
  validateCapture(request.capture);
  if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)) {
    throw new TypeError("command timeout must be a positive safe integer");
  }
  if (request.stdin !== undefined && (request.stdin === null || typeof request.stdin[Symbol.asyncIterator] !== "function")) {
    throw new TypeError("command stdin must be async iterable");
  }
}

function mergedEnvironment(input: CommandEnvironment): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = input.inherit === "host" ? { ...process.env } : {};
  for (const [key, value] of Object.entries(input.values)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

async function writeStdin(
  child: ChildProcess,
  input: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  fail: (error: unknown) => void,
): Promise<void> {
  try {
    for await (const chunk of input) {
      throwIfAborted(signal);
      if (!(chunk instanceof Uint8Array)) throw new TypeError("command stdin yielded a non-byte value");
      if (!child.stdin || !child.stdin.writable) throw new Error("command stdin is not writable");
      if (!child.stdin.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          const input = child.stdin!;
          const cleanup = (): void => {
            input.removeListener("drain", onDrain);
            input.removeListener("error", onError);
            input.removeListener("close", onClose);
            signal.removeEventListener("abort", onAbort);
          };
          const onDrain = (): void => { cleanup(); resolve(); };
          const onError = (error: unknown): void => { cleanup(); reject(error); };
          const onClose = (): void => { cleanup(); reject(new Error("command stdin closed")); };
          const onAbort = (): void => { cleanup(); reject(signal.reason ?? ABORT_ERROR()); };
          input.once("drain", onDrain);
          input.once("error", onError);
          input.once("close", onClose);
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
    child.stdin?.end();
  } catch (error) {
    fail(error);
  }
}

function chunksToBytes(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/**
 * The single Node process primitive. Both source acquisition and hook runtime
 * callers use this adapter, so tree termination and pipe draining cannot drift.
 */
export function createNodeCommandRunner(options: RunnerOptions = {}): CommandRunner {
  const killGraceMs = options.killGraceMs ?? 5_000;
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 0) throw new TypeError("killGraceMs must be a nonnegative safe integer");

  return {
    async run(request, signal) {
      validateRequest(request);
      if (signal === null || typeof signal.aborted !== "boolean") throw new TypeError("command runner requires an AbortSignal");
      throwIfAborted(signal);

      let child: ChildProcess;
      try {
        child = spawn(request.executable, [...request.args], {
          cwd: request.cwd,
          env: mergedEnvironment(request.environment),
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
        });
      } catch (error) {
        throw new CommandRunnerError("command process failed to start", request.executable, request.args, "SPAWN_FAILED", error);
      }
      const stdout = child.stdout;
      const stderr = child.stderr;
      if (stdout === null || stderr === null) {
        try { child.kill(); } catch { /* close still reports the failure */ }
        throw new CommandRunnerError("command pipes were not created", request.executable, request.args, "PIPE_FAILED");
      }

      const stdoutChunks: Uint8Array[] = [];
      const stderrChunks: Uint8Array[] = [];
      const streamQueue: Uint8Array[] = [];
      const streamWaiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
      let streamDone = false;
      const pushStream = (chunk: Uint8Array): void => {
        const waiter = streamWaiters.shift();
        if (waiter !== undefined) waiter({ done: false, value: chunk });
        else streamQueue.push(chunk);
      };
      const endStream = (): void => {
        streamDone = true;
        while (streamWaiters.length > 0) streamWaiters.shift()!({ done: true, value: undefined });
      };
      const stream = (): AsyncIterable<Uint8Array> => ({
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<Uint8Array>> => {
            const chunk = streamQueue.shift();
            if (chunk !== undefined) return { done: false, value: chunk };
            if (streamDone) return { done: true, value: undefined };
            return new Promise((resolve) => streamWaiters.push(resolve));
          },
        }),
      });
      let stdoutLength = 0;
      let stderrLength = 0;
      let stderrTruncated = false;
      let failure: { code: CommandRunnerErrorCode; cause?: unknown } | undefined;
      let abortReason: unknown;
      let timedOut = false;
      let closeCode: number | null = null;
      let settled = false;
      let terminationStarted = false;
      let escalationTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

      const killTree = (kind: "graceful" | "force"): void => {
        const signalName = kind === "graceful" ? "SIGTERM" : "SIGKILL";
        try {
          if (process.platform !== "win32" && child.pid !== undefined) {
            process.kill(-child.pid, signalName);
          } else if (process.platform === "win32" && child.pid !== undefined) {
            spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              shell: false,
              stdio: "ignore",
              windowsHide: true,
            });
          } else {
            child.kill(signalName);
          }
        } catch {
          try { child.kill(signalName); } catch { /* the close event still drains the pipes */ }
        }
      };

      const terminate = (): void => {
        if (terminationStarted || settled) return;
        terminationStarted = true;
        killTree("graceful");
        if (killGraceMs === 0) killTree("force");
        else {
          escalationTimer = setTimeout(() => killTree("force"), killGraceMs);
          escalationTimer.unref?.();
        }
      };

      const fail = (error: unknown, code: CommandRunnerErrorCode = "STDIN_FAILED"): void => {
        if (failure === undefined) failure = { code, cause: error };
        terminate();
      };
      const onAbort = (): void => {
        abortReason = signal.reason ?? ABORT_ERROR();
        terminate();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error) => fail(error, "SPAWN_FAILED"));
      child.stdin?.on("error", (error) => fail(error, "STDIN_FAILED"));

      stdout.on("data", (value: Buffer) => {
        if (failure?.code === "OUTPUT_LIMIT") return;
        const bytes = new Uint8Array(value);
        const remaining = request.capture.stdout.maxBytes - stdoutLength;
        if (bytes.byteLength > remaining) {
          failure = { code: "OUTPUT_LIMIT" };
          terminate();
          return;
        }
        stdoutChunks.push(bytes);
        stdoutLength += bytes.byteLength;
        if (request.capture.stdout.mode === "stream") pushStream(bytes);
      });
      stderr.on("data", (value: Buffer) => {
        const bytes = new Uint8Array(value);
        const remaining = Math.max(0, request.capture.stderr.maxBytes - stderrLength);
        if (bytes.byteLength > remaining) {
          if (request.capture.stderr.overflow === "error") {
            failure = { code: "OUTPUT_LIMIT" };
            terminate();
            return;
          }
          if (remaining > 0) {
            stderrChunks.push(new Uint8Array(bytes.subarray(0, remaining)));
            stderrLength += remaining;
          }
          stderrTruncated = true;
          return;
        }
        if (bytes.byteLength > 0) {
          stderrChunks.push(bytes);
          stderrLength += bytes.byteLength;
        }
      });

      const inputPromise = request.stdin === undefined
        ? (child.stdin?.end(), Promise.resolve())
        : writeStdin(child, request.stdin, signal, (error) => fail(error));
      if (request.timeoutMs !== undefined) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          terminate();
        }, request.timeoutMs);
        timeoutTimer.unref?.();
      }

      const finish = async (resolve: (value: CommandResult) => void, reject: (reason?: unknown) => void): Promise<void> => {
        try { await inputPromise; } catch (error) { if (failure === undefined) failure = { code: "STDIN_FAILED", cause: error }; }
        settled = true;
        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
        if (escalationTimer !== undefined) clearTimeout(escalationTimer);
        signal.removeEventListener("abort", onAbort);
        if (abortReason !== undefined) return reject(abortReason);
        if (timedOut) return reject(new CommandRunnerError("command timed out", request.executable, request.args, "TIMEOUT"));
        if (failure !== undefined) return reject(new CommandRunnerError(
          failure.code === "OUTPUT_LIMIT" ? "command output exceeded the configured limit" : "command process failed",
          request.executable,
          request.args,
          failure.code,
          failure.cause,
        ));
        if (closeCode === null) return reject(new CommandRunnerError("command exited without a status", request.executable, request.args, "NULL_EXIT"));
        resolve({
          exitCode: closeCode,
          stdout: request.capture.stdout.mode === "capture" ? chunksToBytes(stdoutChunks, stdoutLength) : stream(),
          stderr: chunksToBytes(stderrChunks, stderrLength),
          stderrTruncated,
        });
      };

      if (request.capture.stdout.mode === "stream") {
        const completion = new Promise<number>((resolve, reject) => {
          child.once("close", (code) => {
            closeCode = code;
            endStream();
            void finish(
              (result) => resolve(result.exitCode),
              reject,
            );
          });
        });
        return {
          exitCode: -1,
          stdout: stream(),
          stderr: new Uint8Array(),
          stderrTruncated: false,
          completion,
        };
      }

      return await new Promise<CommandResult>((resolve, reject) => {
        child.once("close", (code) => {
          closeCode = code;
          endStream();
          void finish(resolve, reject);
        });
      });
    },
  };
}
