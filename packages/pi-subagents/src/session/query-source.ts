/** Shared file adapter for query and transcript consumers. */
import {
  buildSessionContext,
  parseSessionEntries,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { SessionMessage } from "#src/types";

/** Parse exactly the same public Pi JSONL/context pipeline used by navigation. */
export function parseSessionFileMessages(
  content: string,
): readonly SessionMessage[] {
  const entries = parseSessionEntries(content);
  const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
  return buildSessionContext(sessionEntries).messages;
}

export interface SessionFileReader {
  readFile(path: string): string;
}

export function readSessionFileMessages(
  outputFile: string,
  reader: SessionFileReader | ((path: string) => string),
): readonly SessionMessage[] {
  const readFile = typeof reader === "function" ? reader : (path: string) => reader.readFile(path);
  return parseSessionFileMessages(readFile(outputFile));
}
