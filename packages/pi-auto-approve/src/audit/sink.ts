import {
  appendFileSync,
  existsSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";

import type { AuditEntry } from "./entry.ts";

const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

export interface AuditLogSink {
  /**
   * Synchronously append an already-redacted entry.
   *
   * Sink implementations are best-effort adapters: failures are swallowed so
   * audit logging cannot change the policy/runtime decision being recorded.
   */
  appendSync(entry: AuditEntry): void;
  /** Optional graceful shutdown hook. */
  close?(): Promise<void>;
}

export const noopAuditSink: AuditLogSink = {
  appendSync(): void {
    // Intentionally empty: callers can always install a sink without branching.
  },
};

export interface ArrayAuditSink extends AuditLogSink {
  readonly entries: readonly AuditEntry[];
  clear(): void;
}

export function createArrayAuditSink(): ArrayAuditSink {
  let entries: AuditEntry[] = [];

  return {
    get entries(): readonly AuditEntry[] {
      return entries;
    },
    appendSync(entry: AuditEntry): void {
      entries.push(entry);
    },
    clear(): void {
      entries = [];
    },
  };
}

export interface RotatingFileSinkOptions {
  readonly path: string;
  readonly maxSizeBytes?: number;
  readonly maxFiles?: number;
}

function positiveIntegerOrDefault(
  value: number | undefined,
  defaultValue: number,
): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return defaultValue;
  }

  return Math.floor(value);
}

function rotatedPath(path: string, index: number): string {
  return `${path}.${index}`;
}

function rotateFiles(path: string, maxFiles: number): void {
  const oldest = rotatedPath(path, maxFiles);
  if (existsSync(oldest)) {
    rmSync(oldest, { force: true });
  }

  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const source = rotatedPath(path, index);
    if (existsSync(source)) {
      renameSync(source, rotatedPath(path, index + 1));
    }
  }

  if (existsSync(path)) {
    renameSync(path, rotatedPath(path, 1));
  }
}

function shouldRotate(path: string, maxSizeBytes: number): boolean {
  if (!existsSync(path)) {
    return false;
  }

  return statSync(path).size > maxSizeBytes;
}

export function createRotatingFileSink(
  options: RotatingFileSinkOptions,
): AuditLogSink {
  const path = options.path;
  const maxSizeBytes = positiveIntegerOrDefault(
    options.maxSizeBytes,
    DEFAULT_MAX_SIZE_BYTES,
  );
  const maxFiles = positiveIntegerOrDefault(
    options.maxFiles,
    DEFAULT_MAX_FILES,
  );

  return {
    appendSync(entry: AuditEntry): void {
      try {
        const line = `${JSON.stringify(entry)}\n`;

        appendFileSync(path, line, "utf8");

        if (shouldRotate(path, maxSizeBytes)) {
          rotateFiles(path, maxFiles);
        }
      } catch {
        // Audit logging is best-effort. Serialization and filesystem failures
        // must never affect the runtime decision path.
      }
    },
  };
}
