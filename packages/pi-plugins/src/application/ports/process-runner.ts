export type CommandEnvironment = Readonly<{
  inherit: "host" | "none";
  values: Readonly<Record<string, string | undefined>>;
}>;

export type CommandCapturePolicy = Readonly<{
  stdout: Readonly<{
    mode: "capture" | "stream";
    maxBytes: number;
    overflow: "error";
  }>;
  stderr: Readonly<{
    maxBytes: number;
    overflow: "error" | "truncate";
  }>;
}>;

export type CommandRequest = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: CommandEnvironment;
  stdin?: AsyncIterable<Uint8Array>;
  timeoutMs?: number;
  capture: CommandCapturePolicy;
}>;

export type CommandResult = Readonly<{
  /** For live streams this is a provisional value; await completion. */
  exitCode: number;
  stdout: Uint8Array | AsyncIterable<Uint8Array>;
  stderr: Uint8Array;
  stderrTruncated: boolean;
  completion?: Promise<number>;
}>;

export interface CommandRunner {
  run(request: CommandRequest, signal: AbortSignal): Promise<CommandResult>;
}
