import { mkdirSync } from "node:fs";
import path from "node:path";

import {
  type AuditLogSink,
  createRotatingFileSink,
  noopAuditSink,
} from "../audit/sink.ts";
import { resolveUserConfigRoot } from "../config/paths.ts";

export interface DefaultAuditSinkOptions {
  /** Defaults to `resolveUserConfigRoot()`. */
  readonly userConfigRoot?: string;
}

export function defaultAuditLogPath(
  userConfigRoot: string = resolveUserConfigRoot(),
): string {
  return path.join(userConfigRoot, "audit.log");
}

export function createDefaultAuditSink(
  options: DefaultAuditSinkOptions = {},
): AuditLogSink {
  const userConfigRoot = options.userConfigRoot ?? resolveUserConfigRoot();
  const logPath = defaultAuditLogPath(userConfigRoot);

  try {
    mkdirSync(userConfigRoot, { recursive: true });
  } catch {
    // Audit logging must not affect runtime command decisions. If the user
    // config directory is unavailable, fall back to a no-op sink instead of
    // letting filesystem state change approval behavior.
    return noopAuditSink;
  }

  return createRotatingFileSink({ path: logPath });
}
