import { readFile, stat, writeFile } from "node:fs/promises";
import type { CleanE2ESandbox } from "./environment.js";
import type { ManagedProcess } from "./process.js";
import { E2E_TIMEOUTS } from "./constants.js";
import { waitForCondition } from "./process.js";

export async function waitForFile(path: string, marker?: string, timeoutMs: number = E2E_TIMEOUTS.faultBoundary): Promise<string> {
  return waitForCondition(
    `fault boundary file ${path}${marker === undefined ? "" : ` containing ${marker}`}`,
    async () => {
      const text = await readFile(path, "utf8").catch(() => undefined);
      if (text === undefined || marker !== undefined && !text.includes(marker)) return undefined;
      return text;
    },
    timeoutMs,
  );
}

export function pauseProcess(process: ManagedProcess): void { process.signal("SIGSTOP"); }
export function resumeProcess(process: ManagedProcess): void { process.signal("SIGCONT"); }
export function killProcess(process: ManagedProcess): void { process.signal("SIGKILL"); }

export async function closeNextGitConnection(controlFile: string): Promise<void> {
  await writeFile(controlFile, "close-next\n", "utf8");
}

export async function pauseNextGitBackend(controlFile: string): Promise<void> {
  await writeFile(controlFile, "pause-next\n", "utf8");
}

export type PtyCapabilityDiagnosis = Readonly<{
  available: boolean;
  required: boolean;
  platform: NodeJS.Platform;
  script?: string;
  stty?: string;
  reason?: string;
}>;

export async function diagnosePtyCapability(sandbox: CleanE2ESandbox): Promise<PtyCapabilityDiagnosis> {
  const required = process.env.PI_PLUGIN_HOST_E2E_REQUIRE_PTY === "1";
  const available = sandbox.capabilities.script !== undefined && sandbox.capabilities.stty !== undefined;
  const diagnosis: PtyCapabilityDiagnosis = available
    ? Object.freeze({ available: true, required, platform: process.platform, script: sandbox.capabilities.script!, stty: sandbox.capabilities.stty! })
    : Object.freeze({
        available: false,
        required,
        platform: process.platform,
        reason: `util-linux PTY capability missing: script=${String(sandbox.capabilities.script)} stty=${String(sandbox.capabilities.stty)}; required Linux CI installs util-linux`,
      });
  await writeFile(`${sandbox.logs}/pty-capability.json`, `${JSON.stringify(diagnosis, null, 2)}\n`);
  if (required && !available) throw new Error(diagnosis.reason);
  return diagnosis;
}

export type ClockCapabilityDiagnosis = Readonly<{
  available: boolean;
  required: boolean;
  platform: NodeJS.Platform;
  library?: string;
  version?: string;
  reason?: string;
}>;

export async function diagnoseClockFault(sandbox: CleanE2ESandbox): Promise<ClockCapabilityDiagnosis> {
  const required = process.env.PI_PLUGIN_HOST_E2E_REQUIRE_LIBFAKETIME === "1";
  const capability = sandbox.capabilities.libfaketime;
  const versionAccepted = capability !== undefined && (capability.version === "unmanaged" || capability.version.startsWith("0.9.10-2.1"));
  const diagnosis: ClockCapabilityDiagnosis = capability === undefined
    ? Object.freeze({
        available: false,
        required,
        platform: process.platform,
        reason: "libfaketime was not found in the configured or Debian multiarch paths; Linux CI installs pinned 0.9.10-2.1",
      })
    : !versionAccepted
      ? Object.freeze({
          available: false,
          required,
          platform: process.platform,
          library: capability.library,
          version: capability.version,
          reason: `libfaketime ${capability.version} is not the pinned Debian bookworm 0.9.10-2.1 capability`,
        })
      : Object.freeze({ available: true, required, platform: process.platform, library: capability.library, version: capability.version });
  await writeFile(`${sandbox.logs}/clock-capability.json`, `${JSON.stringify(diagnosis, null, 2)}\n`);
  if (required && !diagnosis.available) throw new Error(diagnosis.reason);
  return diagnosis;
}

export function regressedClockEnvironment(
  sandbox: CleanE2ESandbox,
  offset = "-1d",
): NodeJS.ProcessEnv {
  const capability = sandbox.capabilities.libfaketime;
  if (capability === undefined) throw new Error("cannot construct regressed clock environment without diagnosed libfaketime");
  return {
    ...sandbox.env,
    LD_PRELOAD: capability.library,
    FAKETIME: offset,
    FAKETIME_DONT_FAKE_MONOTONIC: "1",
  };
}

export async function assertFileExists(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) throw new Error(`expected fault evidence file to exist: ${path}`);
}
