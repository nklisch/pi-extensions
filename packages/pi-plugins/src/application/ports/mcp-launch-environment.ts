export interface ResolvedMcpLaunchEnvironment {
  has(name: string): boolean;
  substitute(template: string): string;
  redact(text: string): string;
  toString(): "[REDACTED]";
  toJSON(): "[REDACTED]";
}

/** Requested-name-only, callback-scoped ambient environment custody. */
export interface McpLaunchEnvironmentPort {
  withResolved(
    names: readonly string[],
    signal: AbortSignal,
    use: (environment: ResolvedMcpLaunchEnvironment) => Promise<void>,
  ): Promise<void>;
}
