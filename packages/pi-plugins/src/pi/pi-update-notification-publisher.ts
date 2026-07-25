import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import type {
  UpdateNotificationEvent,
  UpdateNotificationPublisherPort,
} from "../application/ports/update-notification-publisher.js";
import { UpdateNoticeIdSchema } from "../domain/update-policy.js";
import { projectTerminalText } from "./manager/pi-terminal-text.js";

const UPDATE_ENTRY = "plugin-host:update-notified-v1";

export class PiUpdateNotificationUnavailableError extends Error {
  readonly code = "PI_UPDATE_NOTIFICATION_UI_UNAVAILABLE";
  constructor() {
    super("Pi update notification UI is unavailable");
    this.name = "PiUpdateNotificationUnavailableError";
  }
}

export interface PiUpdateNotificationPublisher extends UpdateNotificationPublisherPort {
  bind(context: ExtensionContext): void;
  unbind(reason: SessionShutdownEvent["reason"]): void;
  restore(context: ExtensionContext): void;
  close(): Promise<void>;
}

function safe(value: string): string { return projectTerminalText(value, 512).text; }

/** Session-bindable notification adapter; application notice state remains authority. */
export function createPiUpdateNotificationPublisher(input: Readonly<{ pi: ExtensionAPI }>): PiUpdateNotificationPublisher {
  let context: ExtensionContext | undefined;
  let terminal = false;
  const published = new Set<string>();

  const publisher: PiUpdateNotificationPublisher = {
    bind(next): void {
      if (terminal) throw new PiUpdateNotificationUnavailableError();
      context = next;
      published.clear();
    },
    unbind(_reason): void {
      context = undefined;
      published.clear();
    },
    restore(current): void {
      if (context !== current || terminal) return;
      for (const entry of current.sessionManager.getEntries()) {
        if (entry.type !== "custom" || entry.customType !== UPDATE_ENTRY || entry.data === null || typeof entry.data !== "object") continue;
        const parsed = UpdateNoticeIdSchema.safeParse((entry.data as { noticeId?: unknown }).noticeId);
        if (parsed.success) published.add(parsed.data);
      }
    },
    async publish(event: UpdateNotificationEvent, signal: AbortSignal): Promise<"published" | "already-published"> {
      signal.throwIfAborted();
      const active = context;
      if (terminal || active === undefined || !active.hasUI || (active.mode !== "tui" && active.mode !== "rpc")) {
        throw new PiUpdateNotificationUnavailableError();
      }
      if (published.has(event.id)) return "already-published";
      const disposition = event.disposition === "automatic-applied"
        ? "applied automatically"
        : event.disposition === "manual-required" ? "manual review required" : safe(event.disposition);
      active.ui.notify(`${safe(event.plugin)} ${safe(event.installed)} → ${safe(event.available)} · ${disposition}`, "info");
      // Set before yielding so concurrent same-process retries cannot duplicate.
      published.add(event.id);
      input.pi.appendEntry(UPDATE_ENTRY, { noticeId: event.id });
      return "published";
    },
    async close(): Promise<void> {
      if (terminal) return;
      terminal = true;
      context = undefined;
      published.clear();
    },
  };
  return Object.freeze(publisher);
}
