import type { AuditEntry } from "./entry.ts";
import { redactEntry } from "./redact.ts";
import type { AuditLogSink } from "./sink.ts";

export interface AuditLogger {
  /** Append the entry after redaction and return a promise that never rejects. */
  log(entry: AuditEntry): Promise<void>;
  /** Optional flush/close of the underlying sink. */
  flush?(): Promise<void>;
}

export interface AuditLoggerOptions {
  readonly sink: AuditLogSink;
}

export function createAuditLogger(options: AuditLoggerOptions): AuditLogger {
  const { sink } = options;
  const logger: AuditLogger = {
    async log(entry: AuditEntry): Promise<void> {
      try {
        sink.appendSync(redactEntry(entry));
      } catch {
        // Audit logging is advisory; callers must not observe sink failures.
      }
    },
  };

  if (sink.close !== undefined) {
    logger.flush = async (): Promise<void> => {
      try {
        await sink.close?.();
      } catch {
        // Flush/close is best-effort for the same reason append is.
      }
    };
  }

  return logger;
}
