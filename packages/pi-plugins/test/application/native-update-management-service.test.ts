import { describe, expect, it, vi } from "vitest";
import { createNativeUpdateManagementService } from "../../src/application/native-update-management-service.js";

const signal = new AbortController().signal;

describe("native update management facade", () => {
  it("joins policy, ledger counts, scheduler, acknowledgment, and automatic actions behind one surface", async () => {
    const policy = {
      preview: vi.fn(async () => ({ kind: "previewed", preview: {} })),
      apply: vi.fn(async () => ({ kind: "changed" })),
      status: vi.fn(async () => ({ global: { application: "manual", cadence: "balanced" }, scopes: [], policies: [], inventoryComplete: true })),
    };
    const notifications = {
      list: vi.fn(async () => ({ notices: [], unreadCount: 2, unresolvedCount: 3 })),
      acknowledge: vi.fn(async () => ({ acknowledged: [], alreadyRead: [], missing: [], unreadCount: 1, unresolvedCount: 3 })),
    };
    const automatic = { run: vi.fn(async () => ({ outcomes: [] })) };
    const scheduler = { status: vi.fn(async () => ({ state: "standby", scopes: [] })) };
    const onCounts = vi.fn();
    const service = createNativeUpdateManagementService({ policy, notifications, automatic, scheduler, onCounts } as any);
    await expect(service.status({ scope: "all-current" }, signal)).resolves.toMatchObject({ unreadCount: 2, unresolvedCount: 3, scheduler: { state: "standby" } });
    await service.acknowledge({ ids: [] }, signal);
    await service.runAutomatic({ limit: 1 }, signal);
    expect(notifications.acknowledge).toHaveBeenCalledOnce();
    expect(automatic.run).toHaveBeenCalledOnce();
    expect(onCounts).toHaveBeenLastCalledWith({ unreadCount: 2, unresolvedCount: 3 });
  });
});
