import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { E2E_TIMEOUTS, scaleE2ETimeout } from "./constants.js";

export type ProcessExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;

function timeoutError(label: string, milliseconds: number, detail?: () => string): Error {
  return new Error(`${label} timed out after ${milliseconds}ms${detail === undefined ? "" : `\n${detail()}`}`);
}

export async function waitForCondition<T>(
  label: string,
  condition: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number = E2E_TIMEOUTS.read,
): Promise<T> {
  const budget = scaleE2ETimeout(timeoutMs);
  const started = Date.now();
  for (;;) {
    const result = await condition();
    if (result !== undefined) return result;
    const remaining = budget - (Date.now() - started);
    if (remaining <= 0) throw timeoutError(label, budget);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(E2E_TIMEOUTS.conditionPoll, remaining));
      timer.unref?.();
    });
  }
}

export class ManagedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly label: string;
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private stdoutText = "";
  private stderrText = "";
  private exitResult: ProcessExit | undefined;
  private readonly exitPromise: Promise<ProcessExit>;

  private constructor(child: ChildProcessWithoutNullStreams, label: string) {
    this.child = child;
    this.label = label;
    this.child.stdout.on("data", (chunk: Buffer) => { this.stdoutText += this.stdoutDecoder.write(chunk); });
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderrText += this.stderrDecoder.write(chunk); });
    this.exitPromise = new Promise<ProcessExit>((resolve) => {
      child.once("exit", (code, signal) => {
        this.stdoutText += this.stdoutDecoder.end();
        this.stderrText += this.stderrDecoder.end();
        this.exitResult = Object.freeze({ code, signal });
        resolve(this.exitResult);
      });
    });
  }

  static start(
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio & Readonly<{ label?: string }> = {},
  ): ManagedProcess {
    const { label = `${command} ${args.join(" ")}`, ...spawnOptions } = options;
    const child = spawn(command, [...args], {
      ...spawnOptions,
      detached: spawnOptions.detached ?? true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new ManagedProcess(child, label);
  }

  stdout(): string { return this.stdoutText; }
  stderr(): string { return this.stderrText; }
  output(): string { return `stdout:\n${this.stdoutText}\nstderr:\n${this.stderrText}`; }
  exited(): ProcessExit | undefined { return this.exitResult; }

  write(value: string | Uint8Array): void {
    if (this.child.stdin.destroyed) throw new Error(`${this.label} stdin is closed`);
    this.child.stdin.write(value);
  }

  endInput(): void {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
  }

  async waitForOutput(
    matcher: string | RegExp,
    options: Readonly<{ after?: number; timeoutMs?: number }> = {},
  ): Promise<Readonly<{ output: string; index: number }>> {
    const after = options.after ?? 0;
    return waitForCondition(
      `${this.label} output ${String(matcher)}`,
      () => {
        const output = `${this.stdoutText}\n${this.stderrText}`;
        const tail = output.slice(after);
        const match = typeof matcher === "string" ? tail.indexOf(matcher) : tail.search(matcher);
        if (match >= 0) return Object.freeze({ output, index: after + match });
        if (this.exitResult !== undefined) throw new Error(`${this.label} exited before ${String(matcher)}\n${this.output()}`);
        return undefined;
      },
      options.timeoutMs ?? E2E_TIMEOUTS.read,
    );
  }

  async waitForExit(timeoutMs: number = E2E_TIMEOUTS.shutdown): Promise<ProcessExit> {
    if (this.exitResult !== undefined) return this.exitResult;
    const budget = scaleE2ETimeout(timeoutMs);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.exitPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timeoutError(this.label, budget, () => this.output())), budget);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  signal(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined || this.exitResult !== undefined) return;
    try { process.kill(-pid, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  async terminate(): Promise<void> {
    if (this.exitResult !== undefined) return;
    this.signal("SIGCONT");
    this.signal("SIGTERM");
    try { await this.waitForExit(E2E_TIMEOUTS.shutdown); }
    catch {
      this.signal("SIGKILL");
      await this.waitForExit(E2E_TIMEOUTS.shutdown);
    }
  }

  assertGroupReleased(): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, 0);
      throw new Error(`${this.label} process group ${pid} is still alive`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & Readonly<{ label?: string; timeoutMs?: number; input?: string }> = {},
): Promise<Readonly<ProcessExit & { stdout: string; stderr: string }>> {
  const { timeoutMs = E2E_TIMEOUTS.lifecycle, input, ...processOptions } = options;
  const child = ManagedProcess.start(command, args, processOptions);
  if (input === undefined) child.endInput();
  else {
    child.write(input);
    child.endInput();
  }
  let exit: ProcessExit;
  try { exit = await child.waitForExit(timeoutMs); }
  catch (error) {
    await child.terminate();
    throw error;
  }
  return Object.freeze({ ...exit, stdout: child.stdout(), stderr: child.stderr() });
}

export async function runChecked(
  command: string,
  args: readonly string[],
  options: Parameters<typeof runCommand>[2] = {},
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(`${options.label ?? `${command} ${args.join(" ")}`} failed: code=${String(result.code)} signal=${String(result.signal)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return Object.freeze({ stdout: result.stdout, stderr: result.stderr });
}
