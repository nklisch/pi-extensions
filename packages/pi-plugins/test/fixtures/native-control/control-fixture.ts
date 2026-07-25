import { vi } from "vitest";
import { createNativePluginControlService } from "../../../src/application/native-control-service.js";

export const ControlReadyStatus = Object.freeze({
  status: "ready" as const,
  local: { recovery: "settled" as const, runtime: "reconciled" as const },
  update: { state: "standby" as const, unreadCount: 0, unresolvedCount: 0, scopes: [] },
  blocked: [],
  capabilities: {
    mcp: { status: "unavailable" as const, explanation: "not configured" },
    subagents: { status: "unavailable" as const, explanation: "not configured" },
    piReload: { status: "available" as const, explanation: "available" },
    secrets: { status: "available" as const, explanation: "available" },
  },
});

export function createControlFixture() {
  let counter = 0;
  const ids = { issue: vi.fn(async () => `native-control-execution-v1:123e4567-e89b-42d3-a456-${String(426614174000 + counter++).padStart(12, "0")}` as never) };
  const applications = {
    marketplace: {
      registration: { add: vi.fn(async () => ({ kind: "rejected", code: "SOURCE_UNAVAILABLE" })), remove: vi.fn(async () => ({ kind: "unchanged", reason: "not-configured" })), list: vi.fn(async () => ({ registrations: [] })) },
      refresh: { refresh: vi.fn(async () => ({ outcomes: [], notifications: [] })) },
      catalog: { search: vi.fn(async () => ({ candidates: [], observations: [] })), detail: vi.fn() },
      adoption: { preview: vi.fn(async () => ({ candidates: [], documents: [], diagnostics: [] })), import: vi.fn(async () => ({ outcomes: [], diagnostics: [] })) },
    },
    inspection: { list: vi.fn(async () => { throw Object.assign(new Error("private canary"), { code: "ADAPTER_FAILED" }); }), detail: vi.fn(), diagnose: vi.fn() },
    trustedInstallation: { open: vi.fn(), activate: vi.fn(), recover: vi.fn(), run: vi.fn(), status: vi.fn(async () => ({ kind: "missing" })), cancel: vi.fn(async () => ({ kind: "missing" })) },
    operations: { preview: vi.fn(), apply: vi.fn(), run: vi.fn(), status: vi.fn(async () => ({ kind: "missing" })), cancel: vi.fn(async () => ({ kind: "missing" })) },
    updates: {
      previewPolicy: vi.fn(async () => ({ kind: "rejected", code: "INVALID_CHANGE" })),
      applyPolicy: vi.fn(),
      status: vi.fn(async () => ({ policy: { global: { application: "manual", cadence: "balanced" }, scopes: [], policies: [], inventoryComplete: true }, scheduler: { state: "standby", scopes: [] }, unreadCount: 0, unresolvedCount: 0 })),
      notifications: vi.fn(async () => ({ notices: [], unreadCount: 0, unresolvedCount: 0 })),
      acknowledge: vi.fn(async (request: any) => ({ acknowledged: [], alreadyRead: [], missing: request.ids, unreadCount: 0, unresolvedCount: 0 })),
      runAutomatic: vi.fn(async () => ({ outcomes: [] })),
    },
    status: { snapshot: vi.fn(() => ControlReadyStatus) },
    currentProject: { current: vi.fn(async () => ({ kind: "unavailable" })) },
  };
  const timeouts = { arm: vi.fn((_ms: number, parent: AbortSignal) => ({ signal: parent, dispose: vi.fn() })) };
  return { service: createNativePluginControlService({ applications: applications as never, ids, timeouts }), applications, ids, timeouts };
}
