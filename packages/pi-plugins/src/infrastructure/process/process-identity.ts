import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { win32 } from "node:path";

export type ProcessIdentity = Readonly<{
  pid: number;
  startToken: string;
}>;

export type ProcessIdentityStatus = "live" | "dead" | "unknown";

// Threat model: start evidence prevents a recycled PID from taking ownership.
// If a native probe is unavailable, only this exact running process receives a
// fallback token; later processes classify its orphaned evidence as unknown and
// therefore cannot delete it as proven-dead content.
const currentProcessFallbackStartToken = `fallback:${Math.max(1, Math.trunc(Date.now() - process.uptime() * 1_000))}`;

function isFallbackToken(token: string): boolean {
  return token.startsWith("fallback:");
}

function windowsPowerShell(): string {
  const root = process.env.SystemRoot;
  return win32.join(root !== undefined && win32.isAbsolute(root) ? root : "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Read process-start evidence that remains stable for the lifetime of one PID.
 * Linux exposes a boot-relative tick in procfs; macOS/BSD and Windows expose
 * the process start timestamp through their native process tools. A missing
 * platform probe degrades to unknown rather than preventing the host from
 * starting or allocating staging content.
 */
export function readProcessStartToken(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const degradedCurrentProcessToken = (): string | undefined => pid === process.pid ? currentProcessFallbackStartToken : undefined;
  try {
    if (platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close === -1) return degradedCurrentProcessToken();
      const token = stat.slice(close + 2).trim().split(/\s+/)[19];
      return token !== undefined && /^\d+$/.test(token) ? token : degradedCurrentProcessToken();
    }
    if (platform === "win32") {
      const output = execFileSync(windowsPowerShell(), [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 }).trim();
      return /^\d+$/.test(output) ? output : degradedCurrentProcessToken();
    }
    const output = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim().replace(/\s+/g, " ");
    const startedAt = Date.parse(output);
    return Number.isFinite(startedAt) && startedAt > 0 ? String(Math.trunc(startedAt)) : degradedCurrentProcessToken();
  } catch {
    return degradedCurrentProcessToken();
  }
}

/**
 * Classify owner evidence without assigning journal-specific states such as
 * `released`. Callers retain ownership of those domain distinctions.
 */
export function classifyProcessIdentity(identity: ProcessIdentity, platform: NodeJS.Platform = process.platform): ProcessIdentityStatus {
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
  const current = readProcessStartToken(identity.pid, platform);
  if (current === undefined) return "unknown";
  if (current === identity.startToken) return "live";
  // A fallback proves only the identity of this exact process invocation. A
  // mismatch with native evidence is inconclusive, never proof that a live
  // owner died; callers must retain its data rather than reclaiming it.
  if (isFallbackToken(current) || isFallbackToken(identity.startToken)) return "unknown";
  return "dead";
}
