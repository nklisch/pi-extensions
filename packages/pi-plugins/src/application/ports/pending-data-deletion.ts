import { z } from "zod";
import { PluginKeySchema, type PluginKey } from "../../domain/identity.js";
import { PluginDataRefSchema, type PluginDataRef } from "../../domain/state/references.js";
import { ScopeReferenceSchema, type ScopeReference } from "../../domain/state/scope.js";
import { EpochMillisecondsSchema, type EpochMilliseconds } from "./lifecycle-clock.js";

export const PENDING_DELETE_GRACE_MS = 60 * 60 * 1_000;
export const PendingDeleteMarkerSchema = z.object({ scope: ScopeReferenceSchema, plugin: PluginKeySchema, dataRef: PluginDataRefSchema, requestedAt: EpochMillisecondsSchema }).strict().readonly();
export type PendingDeleteMarker = z.infer<typeof PendingDeleteMarkerSchema>;
export type PendingDeleteMarkerStore = Readonly<{
  root: string;
  path(marker: PendingDeleteMarker): string;
  create(marker: PendingDeleteMarker): Promise<void>;
  remove(marker: PendingDeleteMarker): Promise<void>;
  list(signal?: AbortSignal): Promise<readonly PendingDeleteMarker[]>;
}>;
export type PendingDeleteReplayResult = Readonly<{ marker: PendingDeleteMarker; outcome: "deleted" | "discarded-installed" | "retained" | "invalid" }>;
export type { EpochMilliseconds, PluginDataRef, PluginKey, ScopeReference };
