import type { HookHandler, HookShell } from "../../domain/components.js";
import {
  HOOK_DEFAULT_TIMEOUT_MS,
  HOOK_MAX_TIMEOUT_MS,
} from "../../domain/hook-runtime-limits.js";
import type { ResolvedConfiguration } from "../../application/resolved-configuration.js";
import {
  isPluginLaunchRootName,
  type PluginLaunchRootValues,
} from "../plugin-launch-roots.js";
export type { HookExecutableIdentity } from "../../application/ports/hook-executable-resolver.js";

export type HookLaunchPathValues = PluginLaunchRootValues;

export type HookLaunchEnvironment = Readonly<Record<string, string | undefined>>;

export type HookLaunch = Readonly<{
  kind: "shell" | "exec";
  shell?: HookShell;
  command: string;
  args: readonly string[];
  timeoutMs: number;
  environment: HookLaunchEnvironment;
}>;

export type HookTemplateResolutionContext = Readonly<{
  paths: HookLaunchPathValues;
  configuration: ResolvedConfiguration;
  shellForm: boolean;
}>;

function exactToken(body: string): keyof HookLaunchPathValues | undefined {
  return isPluginLaunchRootName(body) ? body : undefined;
}

function matchingBrace(value: string, start: number): number {
  let depth = 0;
  for (let index = start; index < value.length - 1; index += 1) {
    if (value[index] !== "$" || value[index + 1] !== "{") continue;
    depth += 1;
    index += 1;
    for (let cursor = index + 1; cursor < value.length; cursor += 1) {
      if (value[cursor] === "{") depth += 1;
      else if (value[cursor] === "}") {
        depth -= 1;
        if (depth === 0) return cursor;
      }
    }
    return -1;
  }
  return -1;
}

/**
 * Resolve only the exact Plugin Host vocabulary. Shell parameter expansion and
 * command substitution are deliberately left intact as one opaque token so
 * shell handlers, unlike exec handlers, retain their native semantics.
 */
export function resolveHookTemplate(
  template: string,
  context: HookTemplateResolutionContext,
): string {
  if (typeof template !== "string") throw new TypeError("hook template must be a string");
  let result = "";
  let index = 0;
  while (index < template.length) {
    const start = template.indexOf("${", index);
    if (start < 0) {
      result += template.slice(index);
      break;
    }
    result += template.slice(index, start);
    const end = matchingBrace(template, start);
    if (end < 0) {
      result += template.slice(start);
      break;
    }
    const raw = template.slice(start, end + 1);
    const body = template.slice(start + 2, end);
    const pathKey = exactToken(body);
    if (pathKey !== undefined) {
      result += context.paths[pathKey];
    } else if (/^user_config\.[A-Za-z_][A-Za-z0-9_]*$/.test(body)) {
      // substitute() owns required/optional configuration semantics and never
      // exposes a getter for the backing value.
      result += context.configuration.substitute(raw);
    } else {
      result += raw;
    }
    index = end + 1;
  }
  return result;
}

export function resolveHookEnvironment(
  values: HookLaunchEnvironment,
  context: HookTemplateResolutionContext,
): HookLaunchEnvironment {
  const result: Record<string, string | undefined> = {};
  for (const key of Object.keys(values).sort()) {
    const value = values[key];
    result[key] = value === undefined ? undefined : resolveHookTemplate(value, context);
  }
  return Object.freeze(result);
}

export function resolveHookLaunch(
  handler: HookHandler,
  context: HookTemplateResolutionContext,
  environment: HookLaunchEnvironment = {},
): HookLaunch {
  const timeoutMs = handler.timeoutMs ?? HOOK_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > HOOK_MAX_TIMEOUT_MS) {
    throw new TypeError("hook timeout is outside the supported range");
  }
  const command = resolveHookTemplate(handler.command, context);
  if (handler.kind === "shell") {
    return Object.freeze({
      kind: "shell",
      ...(handler.shell === undefined ? {} : { shell: handler.shell }),
      command,
      args: [],
      timeoutMs,
      environment: resolveHookEnvironment(environment, context),
    });
  }
  return Object.freeze({
    kind: "exec",
    command,
    args: Object.freeze(handler.args.map((value) => resolveHookTemplate(value, context))),
    timeoutMs,
    environment: resolveHookEnvironment(environment, context),
  });
}
