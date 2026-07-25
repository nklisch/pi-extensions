import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { posix, win32 } from "node:path";
import type {
  HookExecutableIdentity,
  HookExecutableResolverPort,
  ResolvedHookExecutable,
} from "../../application/ports/hook-executable-resolver.js";
import type { CommandEnvironment } from "../../application/ports/process-runner.js";

export class HookExecutableResolutionError extends Error {
  constructor() {
    super("hook executable could not be resolved");
    this.name = "HookExecutableResolutionError";
  }
}

type HookExecutableResolverPlatform = NodeJS.Platform;
type AccessExecutable = (path: string, mode?: number) => Promise<void>;
type HookExecutableResolverOptions = Readonly<{
  platform?: HookExecutableResolverPlatform;
  hostEnvironment?: Readonly<Record<string, string | undefined>>;
  access?: AccessExecutable;
}>;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function environmentPath(
  environment: CommandEnvironment,
  hostEnvironment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (Object.hasOwn(environment.values, "PATH")) return environment.values.PATH;
  if (environment.inherit === "host") return hostEnvironment.PATH;
  return undefined;
}

async function executable(
  path: string,
  signal: AbortSignal,
  accessExecutable: AccessExecutable,
  accessMode: number,
): Promise<boolean> {
  throwIfAborted(signal);
  try {
    await accessExecutable(path, accessMode);
    throwIfAborted(signal);
    return true;
  } catch {
    throwIfAborted(signal);
    return false;
  }
}

function identity(command: string, cwd: string, path: string): HookExecutableIdentity {
  const digest = createHash("sha256").update(`hook-executable-v1\0${command}\0${cwd}\0${path}`).digest("hex");
  return `hook-executable-v1:sha256:${digest}` as HookExecutableIdentity;
}

async function findOnPath(
  command: string,
  cwd: string,
  environment: CommandEnvironment,
  signal: AbortSignal,
  platform: HookExecutableResolverPlatform,
  hostEnvironment: Readonly<Record<string, string | undefined>>,
  accessExecutable: AccessExecutable,
): Promise<ResolvedHookExecutable> {
  const pathValue = environmentPath(environment, hostEnvironment);
  const windows = platform === "win32";
  const pathApi = windows ? win32 : posix;
  const entries = (pathValue ?? "").split(windows ? ";" : ":").filter((value) => value.length > 0);
  const candidates = windows && !/\.[A-Za-z0-9]+$/.test(command)
    ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
    : [command];
  const accessMode = windows ? constants.F_OK : constants.X_OK;
  for (const entry of entries) {
    for (const candidate of candidates) {
      throwIfAborted(signal);
      const value = pathApi.resolve(cwd, entry, candidate);
      if (await executable(value, signal, accessExecutable, accessMode)) return {
        executable: value,
        resolution: "path",
        identity: identity(command, cwd, value),
      };
    }
  }
  throw new HookExecutableResolutionError();
}

export function createNodeHookExecutableResolver(options: HookExecutableResolverOptions = {}): HookExecutableResolverPort {
  const platform = options.platform ?? process.platform;
  const hostEnvironment = options.hostEnvironment ?? process.env;
  const accessExecutable = options.access ?? access;
  const pathApi = platform === "win32" ? win32 : posix;
  const accessMode = platform === "win32" ? constants.F_OK : constants.X_OK;

  return Object.freeze({
    async resolve(
      request: Parameters<HookExecutableResolverPort["resolve"]>[0],
      signal: AbortSignal,
    ): Promise<ResolvedHookExecutable> {
      if (request === null || typeof request !== "object" || typeof request.command !== "string" ||
          request.command.length === 0 || request.command.includes("\0") || typeof request.cwd !== "string" ||
          request.cwd.length === 0) throw new HookExecutableResolutionError();
      throwIfAborted(signal);
      const command = request.command;
      if (pathApi.isAbsolute(command)) {
        if (!(await executable(command, signal, accessExecutable, accessMode))) throw new HookExecutableResolutionError();
        return { executable: command, resolution: "absolute", identity: identity(command, request.cwd, command) };
      }
      if (command.includes("/") || command.includes("\\")) {
        const value = pathApi.resolve(request.cwd, command);
        if (!(await executable(value, signal, accessExecutable, accessMode))) throw new HookExecutableResolutionError();
        return { executable: value, resolution: "cwd-relative", identity: identity(command, request.cwd, value) };
      }
      return findOnPath(command, request.cwd, request.environment, signal, platform, hostEnvironment, accessExecutable);
    },
  });
}

export type { HookExecutableIdentity, HookExecutableResolverPort, ResolvedHookExecutable } from "../../application/ports/hook-executable-resolver.js";
