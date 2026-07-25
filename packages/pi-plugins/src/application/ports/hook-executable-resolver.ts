import type { CommandEnvironment } from "./process-runner.js";
export type HookExecutableIdentity = string & { readonly __hookExecutableIdentity: unique symbol };

export type ResolvedHookExecutable = Readonly<{
  executable: string;
  resolution: "absolute" | "cwd-relative" | "path";
  identity: HookExecutableIdentity;
}>;

export interface HookExecutableResolverPort {
  resolve(
    request: Readonly<{
      command: string;
      cwd: string;
      environment: CommandEnvironment;
    }>,
    signal: AbortSignal,
  ): Promise<ResolvedHookExecutable>;
}
