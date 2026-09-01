/**
 * session-navigation.ts — Pure selection and transcript-sourcing for native session navigation.
 *
 * Splits the unit-testable core of the `/subagents:sessions` command from its TUI
 * wiring (`session-navigator.ts`): which subagents are navigable and how a picked
 * agent's transcript is sourced (live or a retained file snapshot).
 *
 * The `TranscriptSource` seam decouples *how messages are sourced* (live record
 * or a retained file snapshot) from *how they render* — the renderer
 * (`session-navigator.ts`, which mounts Pi's per-entry components) talks only to
 * this seam. Rendering lives in the SDK/TUI module because the per-entry
 * components require a `TUI`, `cwd`, and markdown theme. The query tool uses
 * the same JSONL adapter so file and live reads cannot drift.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { SubagentStatus } from "#src/lifecycle/subagent-state";
import type { AgentSessionEvent, SessionMessage, SubagentType, ThinkingLevel } from "#src/types";
import { formatDuration, formatModelThinking, getDisplayName } from "#src/ui/display";
import { parseSessionFileMessages } from "#src/session/query-source";

// ─────────────────────────────────────────────────────────────────────────────

/** The record fields the navigator reads to label and live-source a transcript. */
export interface NavigableSubagent {
  readonly id: string;
  readonly type: SubagentType;
  readonly description: string;
  readonly modelLabel: string;
  readonly effectiveThinkingLevel: ThinkingLevel;
  readonly status: SubagentStatus;
  readonly startedAt: number;
  readonly completedAt: number | undefined;
  readonly toolUses: number;
  readonly activeTools: ReadonlyMap<string, string>;
  readonly responseText: string;
  readonly outputFile: string | undefined;
  readonly agentMessages: readonly SessionMessage[];
  isSessionReady(): boolean;
  subscribeToUpdates(fn: (event: AgentSessionEvent) => void): (() => void) | undefined;
  /** Notifies consumers when a retained session is released and changes source. */
  subscribeToRecordUpdates?: (fn: () => void) => () => void;
  getToolDefinition(name: string): ToolDefinition | undefined;
}

/**
 * A navigable entry plus the label shown in the picker.
 *
 * A `live` entry sources its transcript from the in-memory session and can
 * transition to its retained file; an `evicted`-kind entry is a persisted
 * snapshot for a released live session.
 */
export interface RunDisplayMetadata {
  readonly modelLabel: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly startedAt: number;
  readonly completedAt: () => number | undefined;
}

export type NavigationEntry =
  | { readonly kind: "live"; readonly label: string; readonly record: NavigableSubagent; readonly run: RunDisplayMetadata }
  | { readonly kind: "evicted"; readonly label: string; readonly outputFile: string; readonly run: RunDisplayMetadata };

/** The fields `buildLabel` reads — shared by a live record and an evicted descriptor. */
interface LabelFields {
  readonly type: SubagentType;
  readonly description: string;
  readonly modelLabel: string;
  readonly effectiveThinkingLevel: ThinkingLevel;
  readonly status: SubagentStatus;
  readonly startedAt: number;
  readonly completedAt: number | undefined;
  readonly toolUses: number;
}

/** Running-agent streaming state, surfaced by a live source. */
export interface StreamingState {
  readonly activeTools: ReadonlyMap<string, string>;
  readonly responseText: string;
}

/** Source state shown when a live record is released or its snapshot cannot load. */
export type TranscriptSourceAvailability =
  | { readonly kind: "live"; readonly path?: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "unavailable"; readonly path?: string; readonly error?: string };

/** Liveness-agnostic transcript source consumed by the renderer. */
export interface TranscriptSource {
  /** Current message history. */
  getMessages(): readonly SessionMessage[];
  /** Subscribe to changes; returns an unsubscribe, or undefined for a static snapshot. */
  subscribe(onChange: () => void): (() => void) | undefined;
  /** Running-agent streaming state, or undefined when not streaming. */
  streaming(): StreamingState | undefined;
  /** Resolve a registered tool definition by name, for Pi's tool-execution components. */
  getToolDefinition(name: string): ToolDefinition | undefined;
  /** Current source state; unavailable retains the last readable messages. */
  availability?(): TranscriptSourceAvailability;
}

/**
 * Label every navigable subagent: live sessions first, then persisted snapshots
 * for released records and any legacy evicted descriptors.
 */
export function listNavigableAgents(
  agents: readonly NavigableSubagent[],
  registry: AgentConfigLookup,
): NavigationEntry[] {
  const live = agents.flatMap((record): NavigationEntry[] => {
    const run = {
      modelLabel: record.modelLabel,
      thinkingLevel: record.effectiveThinkingLevel,
      startedAt: record.startedAt,
      completedAt: () => record.completedAt,
    };
    if (record.isSessionReady()) {
      return [{ kind: "live", record, label: buildLabel(record, registry), run }];
    }
    return record.outputFile
      ? [{ kind: "evicted", outputFile: record.outputFile, label: buildLabel(record, registry, true), run }]
      : [];
  });
  return live;
}

/**
 * Source a transcript from a persisted child-session JSONL snapshot.
 *
 * For an agent whose live session was released, the in-memory message history is
 * gone but the terminal record and session file survive. Reads the file, drops
 * the `SessionHeader`, and resolves the
 * message list via Pi's own parser. A static snapshot — no subscription, no
 * streaming, no live tool registry. `readFile` is injected so this module makes
 * no `fs` calls.
 */
export function fileSnapshotSource(
  outputFile: string,
  readFile: (path: string) => string,
): TranscriptSource {
  const messages = parseSessionFileMessages(readFile(outputFile));
  return {
    getMessages: () => messages,
    subscribe: () => undefined,
    streaming: () => undefined,
    getToolDefinition: () => undefined,
    availability: () => ({ kind: "file", path: outputFile }),
  };
}

/** Source a transcript live from an in-memory record. */
export function liveSource(record: NavigableSubagent): TranscriptSource {
  return {
    getMessages: () => record.agentMessages,
    subscribe: (onChange) => record.subscribeToUpdates(() => onChange()),
    streaming: () =>
      record.status === "running"
        ? { activeTools: record.activeTools, responseText: record.responseText }
        : undefined,
    getToolDefinition: (name) => record.getToolDefinition(name),
    availability: () => ({ kind: "live", ...(record.outputFile ? { path: record.outputFile } : {}) }),
  };
}

/**
 * Keep a live viewer useful across retention release. The source swaps to the
 * persisted snapshot on the release notification and retains the last live
 * content when that snapshot cannot be read.
 */
export function liveFileSource(
  record: NavigableSubagent,
  readFile: (path: string) => string,
): TranscriptSource {
  let mode: "live" | "file" | "unavailable" = record.isSessionReady() ? "live" : "unavailable";
  let messages: readonly SessionMessage[] = record.agentMessages;
  let error: string | undefined;
  let fileAttempted = false;

  const swapIfReleased = (): void => {
    if (record.isSessionReady()) {
      mode = "live";
      error = undefined;
      messages = record.agentMessages;
      return;
    }
    if (fileAttempted || !record.outputFile) {
      if (!record.outputFile && mode === "live") mode = "unavailable";
      return;
    }
    fileAttempted = true;
    try {
      messages = parseSessionFileMessages(readFile(record.outputFile));
      mode = "file";
      error = undefined;
    } catch (cause) {
      mode = "unavailable";
      error = cause instanceof Error ? cause.message : String(cause);
    }
  };

  const notify = (onChange: () => void): void => {
    try {
      // Do not replace the last live snapshot with Subagent's empty post-release
      // getter before the file adapter succeeds; the degraded path must retain
      // content that was already visible.
      if (mode === "live" && record.isSessionReady()) messages = record.agentMessages;
      swapIfReleased();
      onChange();
    } catch (cause) {
      mode = "unavailable";
      error = cause instanceof Error ? cause.message : String(cause);
      onChange();
    }
  };

  return {
    getMessages: () => {
      try {
        if (mode === "live") {
          if (!record.isSessionReady()) swapIfReleased();
          else messages = record.agentMessages;
        } else swapIfReleased();
      } catch (cause) {
        mode = "unavailable";
        error = cause instanceof Error ? cause.message : String(cause);
      }
      return messages;
    },
    subscribe: (onChange) => {
      const unsubscribers: Array<() => void> = [];
      try {
        const unsubscribe = record.subscribeToUpdates(() => notify(onChange));
        if (unsubscribe) unsubscribers.push(unsubscribe);
      } catch (cause) {
        mode = "unavailable";
        error = cause instanceof Error ? cause.message : String(cause);
      }
      if (record.subscribeToRecordUpdates) {
        try {
          unsubscribers.push(record.subscribeToRecordUpdates(() => notify(onChange)));
        } catch (cause) {
          mode = "unavailable";
          error = cause instanceof Error ? cause.message : String(cause);
        }
      }
      return unsubscribers.length === 0 ? undefined : () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      };
    },
    streaming: () => mode === "live" && record.status === "running"
      ? { activeTools: record.activeTools, responseText: record.responseText }
      : undefined,
    getToolDefinition: (name) => mode === "live" ? record.getToolDefinition(name) : undefined,
    availability: () => {
      swapIfReleased();
      if (mode === "live") return { kind: "live", ...(record.outputFile ? { path: record.outputFile } : {}) };
      if (mode === "file" && record.outputFile) return { kind: "file", path: record.outputFile };
      return { kind: "unavailable", ...(record.outputFile ? { path: record.outputFile } : {}), ...(error ? { error } : {}) };
    },
  };
}

function buildLabel(fields: LabelFields, registry: AgentConfigLookup, evicted = false): string {
  const name = getDisplayName(fields.type, registry);
  const duration = formatDuration(fields.startedAt, fields.completedAt);
  const marker = evicted ? " · released (snapshot)" : "";
  return `${name} (${fields.description}) · ${formatModelThinking(fields.modelLabel, fields.effectiveThinkingLevel)} · ${fields.toolUses} tools · ${fields.status} · ${duration}${marker}`;
}
