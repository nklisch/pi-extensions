import { readFileSync } from "node:fs";

export type ProcessIdentity = Readonly<{
  pid: number;
  startToken: string;
}>;

export type ProcessIdentityStatus = "live" | "dead" | "unknown";

/**
 * Read Linux's process-start token. The token is the stable identity evidence
 * used to distinguish a live owner from a reused PID.
 */
export function readLinuxProcessStartToken(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close === -1) return undefined;
    const token = stat.slice(close + 2).trim().split(/\s+/)[19];
    return token !== undefined && /^\d+$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify owner evidence without assigning journal-specific states such as
 * `released`. Callers retain ownership of those domain distinctions.
 */
export function classifyProcessIdentity(identity: ProcessIdentity): ProcessIdentityStatus {
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
  const current = readLinuxProcessStartToken(identity.pid);
  if (current === undefined) return "unknown";
  return current === identity.startToken ? "live" : "dead";
}
