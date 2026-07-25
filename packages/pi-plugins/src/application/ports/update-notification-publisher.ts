import type { UpdateNoticeId, UpdateNoticeDisposition } from "../../domain/update-policy.js";
import type { PluginKey } from "../../domain/identity.js";
import type { ScopeReference } from "../../domain/state/scope.js";

export type UpdateNotificationEvent = Readonly<{
  id: UpdateNoticeId;
  scope: ScopeReference;
  plugin: PluginKey;
  installed: string;
  available: string;
  disposition: UpdateNoticeDisposition;
}>;

/** Publisher must deduplicate the stable event ID across retries and restart. */
export interface UpdateNotificationPublisherPort {
  publish(event: UpdateNotificationEvent, signal: AbortSignal): Promise<"published" | "already-published">;
  close?(): Promise<void>;
}
