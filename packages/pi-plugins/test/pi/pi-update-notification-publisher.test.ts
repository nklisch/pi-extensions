import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiUpdateNotificationPublisher, PiUpdateNotificationUnavailableError } from "../../src/pi/pi-update-notification-publisher.js";

const noticeId = `update-notice-v1:sha256:${"a".repeat(64)}` as never;
const event = { id: noticeId, scope: { kind: "user" as const }, plugin: "demo@market" as never, installed: "1.0.0", available: "1.1.0", disposition: "manual-required" as const };

function harness(mode: ExtensionContext["mode"] = "tui", entries: unknown[] = []) {
  const notify = vi.fn();
  const appended: Array<{ type: string; data: unknown }> = [];
  const pi = { appendEntry(type: string, data: unknown) { appended.push({ type, data }); } } as unknown as ExtensionAPI;
  const context = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: { notify },
    sessionManager: { getEntries: () => entries },
  } as unknown as ExtensionContext;
  return { pi, context, notify, appended };
}

describe("Pi update notification publisher", () => {
  it("notifies once and stores only the exact notice ID", async () => {
    const h = harness();
    const publisher = createPiUpdateNotificationPublisher({ pi: h.pi });
    publisher.bind(h.context);
    await expect(publisher.publish(event, new AbortController().signal)).resolves.toBe("published");
    await expect(publisher.publish(event, new AbortController().signal)).resolves.toBe("already-published");
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.notify.mock.calls[0]![0]).toContain("demo@market 1.0.0 → 1.1.0");
    expect(h.appended).toEqual([{ type: "plugin-host:update-notified-v1", data: { noticeId } }]);
    expect(JSON.stringify(h.appended)).not.toContain("1.1.0");
  });

  it("restores replay IDs from all session entries without making them update authority", async () => {
    const h = harness("tui", [
      { type: "custom", customType: "other", data: { noticeId } },
      { type: "custom", customType: "plugin-host:update-notified-v1", data: { noticeId } },
    ]);
    const publisher = createPiUpdateNotificationPublisher({ pi: h.pi });
    publisher.bind(h.context);
    publisher.restore(h.context);
    await expect(publisher.publish(event, new AbortController().signal)).resolves.toBe("already-published");
    expect(h.notify).not.toHaveBeenCalled();
  });

  it.each(["json", "print"] as const)("does not claim publication in %s mode", async (mode) => {
    const h = harness(mode);
    const publisher = createPiUpdateNotificationPublisher({ pi: h.pi });
    publisher.bind(h.context);
    await expect(publisher.publish(event, new AbortController().signal)).rejects.toBeInstanceOf(PiUpdateNotificationUnavailableError);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.appended).toEqual([]);
  });

  it("unbinds and closes idempotently", async () => {
    const h = harness();
    const publisher = createPiUpdateNotificationPublisher({ pi: h.pi });
    publisher.bind(h.context);
    publisher.unbind("reload");
    await expect(publisher.publish(event, new AbortController().signal)).rejects.toBeInstanceOf(PiUpdateNotificationUnavailableError);
    await publisher.close();
    await publisher.close();
  });
});
