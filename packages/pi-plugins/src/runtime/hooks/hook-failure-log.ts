import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Debuggability seam for the best-effort hook policy. Infrastructure failures
 * no longer block prompts, tools, compaction, or subagents, so this append
 * log is the durable record that a failure happened at all. Every write is
 * fire-and-forget: logging must never break, delay, or block a hook boundary.
 */

export type HookFailurePhase = "planning" | "execution" | "decision";

export type HookFailureRecord = Readonly<{
  /** Epoch milliseconds. */
  at: number;
  event: string;
  phase: HookFailurePhase;
  code: string;
  plugin?: string;
  componentId?: string;
  detail?: string;
}>;

export interface HookFailureLog {
  record(entry: HookFailureRecord): void;
  readonly file: string;
}

const DEFAULT_MAX_BYTES = 512 * 1024;
const MAX_FIELD = 256;

function clip(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  // Control characters would break the one-record-per-line contract.
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?");
  return clean.length > MAX_FIELD ? clean.slice(0, MAX_FIELD) : clean;
}

function line(entry: HookFailureRecord): string {
  return `${JSON.stringify({
    at: entry.at,
    event: clip(entry.event) ?? "unknown",
    phase: entry.phase,
    code: clip(entry.code) ?? "UNKNOWN",
    ...(entry.plugin === undefined ? {} : { plugin: clip(entry.plugin) }),
    ...(entry.componentId === undefined ? {} : { componentId: clip(entry.componentId) }),
    ...(entry.detail === undefined ? {} : { detail: clip(entry.detail) }),
  })}\n`;
}

export function createHookFailureLog(input: Readonly<{
  file: string;
  maxBytes?: number;
  now?: () => number;
}>): HookFailureLog {
  if (typeof input.file !== "string" || input.file.length === 0) {
    throw new TypeError("hook failure log requires a file path");
  }
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  // Writes chain behind one promise so concurrent boundaries cannot
  // interleave partial lines. Size is re-checked whenever the bytes appended
  // since the last check could have crossed the bound, so a long-lived
  // session still rotates.
  let tail: Promise<void> = Promise.resolve();
  // Seed at the bound so the first write always measures any pre-existing file.
  let uncheckedBytes = maxBytes;

  async function write(text: string): Promise<void> {
    try {
      uncheckedBytes += Buffer.byteLength(text);
      if (uncheckedBytes >= maxBytes) {
        uncheckedBytes = 0;
        const current = await stat(input.file).catch(() => undefined);
        if (current !== undefined && current.size >= maxBytes) {
          await rename(input.file, `${input.file}.1`).catch(() => undefined);
        }
      }
      await mkdir(dirname(input.file), { recursive: true });
      await appendFile(input.file, text, "utf8");
    } catch {
      // The log is observability, not authority; a broken log must be silent.
    }
  }

  return Object.freeze({
    file: input.file,
    record(entry: HookFailureRecord): void {
      const stamped = entry.at > 0 ? entry : { ...entry, at: (input.now ?? Date.now)() };
      tail = tail.then(() => write(line(stamped)));
    },
  });
}

export function createNullHookFailureLog(): HookFailureLog {
  return Object.freeze({ file: "", record(): void {} });
}
