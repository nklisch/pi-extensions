import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AuditEntry } from "../audit/entry.ts";
import { resolveUserConfigRoot } from "../config/paths.ts";
import {
  type AuditLogSource,
  buildReplayCorpus,
  type CorpusFixtureRow,
  type CorpusFixtureSource,
  DEFAULT_HISTORY_BOUNDS,
  type HistoryBounds,
  type ReplayCorpus,
  type SessionHistorySource,
  type SessionToolCall,
  type SourceReadResult,
} from "./history.ts";
import { createFileAuditLogSource } from "./sources/audit-log.ts";
import { createFileCorpusFixtureSource } from "./sources/corpus-fixtures.ts";
import {
  createSessionFileSource,
  createSessionHistorySource,
} from "./sources/session-history.ts";

export interface ReadReplayCorpusOptions {
  readonly ctx?: ExtensionContext;
  readonly sessionFilePath?: string;
  /** Default: <userConfigRoot>/audit.log. Pass an empty string to omit audit history. */
  readonly auditLogPath?: string;
  /** Saved corpus fixture paths. Omitted by default; callers must opt in. */
  readonly corpusPaths?: readonly string[];
  readonly bounds?: HistoryBounds;
  readonly dropUnmatchedAudit?: boolean;
}

const DEFAULT_AUDIT_LOG_FILE = "audit.log";

function warningMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}

function defaultAuditLogPath(): string {
  return join(resolveUserConfigRoot(), DEFAULT_AUDIT_LOG_FILE);
}

interface SourceReader<T> {
  read(): SourceReadResult<T>;
}

function readSource<T>(
  label: string,
  source: SourceReader<T> | undefined,
): SourceReadResult<T> {
  if (source === undefined) {
    return { items: [], warnings: [] };
  }

  try {
    return source.read();
  } catch (error) {
    return {
      items: [],
      warnings: [`${label} source failed: ${warningMessage(error)}`],
    };
  }
}

function createSessionSource(
  options: ReadReplayCorpusOptions,
  bounds: HistoryBounds,
  warnings: string[],
): SessionHistorySource | undefined {
  if (options.sessionFilePath !== undefined) {
    if (options.ctx?.sessionManager !== undefined) {
      warnings.push(
        "both ctx.sessionManager and sessionFilePath were provided; using sessionFilePath",
      );
    }

    if (options.sessionFilePath.length === 0) {
      return undefined;
    }

    return createSessionFileSource({
      path: options.sessionFilePath,
      bounds,
    });
  }

  if (options.ctx?.sessionManager === undefined) {
    return undefined;
  }

  return createSessionHistorySource({
    sessionManager: options.ctx.sessionManager,
    bounds,
  });
}

function createAuditSource(
  options: ReadReplayCorpusOptions,
): AuditLogSource | undefined {
  if (options.auditLogPath === "") {
    return undefined;
  }

  return createFileAuditLogSource({
    path: options.auditLogPath ?? defaultAuditLogPath(),
  });
}

function createCorpusSource(
  options: ReadReplayCorpusOptions,
): CorpusFixtureSource | undefined {
  if (options.corpusPaths !== undefined) {
    if (options.corpusPaths.length === 0) {
      return undefined;
    }

    return createFileCorpusFixtureSource({ paths: options.corpusPaths });
  }

  return undefined;
}

export function readReplayCorpus(
  options: ReadReplayCorpusOptions = {},
): ReplayCorpus {
  const bounds = options.bounds ?? DEFAULT_HISTORY_BOUNDS;
  const warnings: string[] = [];

  const sessionSource = createSessionSource(options, bounds, warnings);
  const auditSource = createAuditSource(options);
  const corpusSource = createCorpusSource(options);

  const session = readSource<SessionToolCall>("session", sessionSource);
  const audit = readSource<AuditEntry>("audit", auditSource);
  const corpus = readSource<CorpusFixtureRow>("corpus", corpusSource);

  return buildReplayCorpus(
    {
      ...(sessionSource === undefined ? {} : { session: session.items }),
      ...(auditSource === undefined ? {} : { audit: audit.items }),
      ...(corpusSource === undefined ? {} : { corpus: corpus.items }),
    },
    {
      ...(options.dropUnmatchedAudit === undefined
        ? {}
        : { dropUnmatchedAudit: options.dropUnmatchedAudit }),
      warnings: [
        ...warnings,
        ...session.warnings,
        ...audit.warnings,
        ...corpus.warnings,
      ],
    },
  );
}
