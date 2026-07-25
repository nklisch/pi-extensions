import { stripVTControlCharacters } from "node:util";
import type { CleanE2ESandbox } from "./environment.js";
import { E2E_TIMEOUTS } from "./constants.js";
import { ManagedProcess, waitForCondition } from "./process.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export type PiPtyStartOptions = Readonly<{
  sandbox: CleanE2ESandbox;
  columns?: number;
  rows?: number;
  project?: string;
  env?: NodeJS.ProcessEnv;
  extraArgs?: readonly string[];
}>;

export class PiPtyProcess {
  readonly process: ManagedProcess;
  readonly columns: number;
  readonly rows: number;
  private closed = false;

  private constructor(process: ManagedProcess, columns: number, rows: number) {
    this.process = process;
    this.columns = columns;
    this.rows = rows;
  }

  static async start(options: PiPtyStartOptions): Promise<PiPtyProcess> {
    const script = options.sandbox.capabilities.script;
    const stty = options.sandbox.capabilities.stty;
    if (script === undefined || stty === undefined) {
      throw new Error(`clean E2E PTY capability unavailable: script=${String(script)} stty=${String(stty)}; Linux CI requires util-linux script and stty`);
    }
    const columns = options.columns ?? 120;
    const rows = options.rows ?? 30;
    const piArgs = [
      options.sandbox.piCli,
      "--offline", "--approve",
      "--no-prompt-templates", "--no-themes", "--no-context-files",
      ...(options.extraArgs ?? []),
      "--no-session", "--session-dir", options.sandbox.sessionDir,
    ];
    const command = `${shellQuote(stty)} cols ${columns} rows ${rows}; exec ${piArgs.map(shellQuote).join(" ")}`;
    const child = ManagedProcess.start(script, ["-qefc", command, "/dev/null"], {
      cwd: options.project ?? options.sandbox.project,
      env: options.env ?? options.sandbox.env,
      label: `Pi PTY ${options.sandbox.id} ${columns}x${rows}`,
    });
    const pty = new PiPtyProcess(child, columns, rows);
    options.sandbox.diagnostics.push({
      name: `pty-${options.sandbox.diagnostics.length + 1}`,
      capture: () => ({ columns, rows, raw: pty.rawOutput(), semantic: pty.semanticOutput() }),
    });
    options.sandbox.cleanups.push(async () => { await pty.shutdown(); });
    await waitForCondition(
      "Pi PTY startup",
      () => child.exited() === undefined && pty.semanticOutput().length > 0 ? true : undefined,
      E2E_TIMEOUTS.startup,
    );
    return pty;
  }

  rawOutput(): string { return this.process.stdout(); }
  semanticOutput(): string { return stripVTControlCharacters(this.process.stdout()).replaceAll("\r", ""); }
  mark(): number { return this.semanticOutput().length; }
  send(keys: string | Uint8Array): void { this.process.write(keys); }

  async waitFor(marker: string | RegExp, after = 0, timeoutMs: number = E2E_TIMEOUTS.read): Promise<string> {
    return waitForCondition(
      `PTY semantic marker ${String(marker)}`,
      () => {
        const output = this.semanticOutput();
        const tail = output.slice(after);
        if (typeof marker === "string" ? tail.includes(marker) : marker.test(tail)) return output;
        if (this.process.exited() !== undefined) throw new Error(`PTY exited before marker ${String(marker)}\n${this.process.output()}`);
        return undefined;
      },
      timeoutMs,
    );
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.process.exited() === undefined) {
      try {
        this.send("\u0004");
        this.process.endInput();
        const exit = await this.process.waitForExit(E2E_TIMEOUTS.shutdown);
        if (exit.code !== 0 && exit.signal !== "SIGTERM") throw new Error(`Pi PTY exited unsuccessfully: ${JSON.stringify(exit)}\n${this.process.output()}`);
      } catch {
        await this.process.terminate();
      }
    }
    this.process.assertGroupReleased();
  }
}
